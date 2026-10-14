// scan.js - Client-side OMR scanner with rotation/warp-aware grid detection
// Includes: visual overlay showing detected bubbles, confidence scores, PDF export
document.addEventListener('DOMContentLoaded', () => {
    const fileInput = document.getElementById('scanFileInput');
    const scanImage = document.getElementById('scanImage');
    const scanEmpty = document.getElementById('scanEmpty');
    const scanResultList = document.getElementById('scanResultList');
    const scanStatus = document.getElementById('scanStatus');
    const scanCountBadge = document.getElementById('scanCountBadge');
    const scanTip = document.getElementById('scanTip');
    const btnClearScan = document.getElementById('btnClearScan');
    const btnExportScan = document.getElementById('btnExportScan');
    const btnExportPdf = document.getElementById('btnExportPdf');
    const btnShowOverlay = document.getElementById('btnShowOverlay');
    const examIdInput = document.getElementById('examIdInput');
    const overlayCanvas = document.getElementById('overlayCanvas');
    let lastResult = null;
    let loadedImage = null;
    let lastOverlayData = null;
    if (fileInput) {
        fileInput.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file)
                return;
            await runScan(file);
        });
    }
    if (btnClearScan) {
        btnClearScan.addEventListener('click', () => {
            fileInput.value = '';
            scanImage.style.display = 'none';
            scanImage.src = '';
            scanEmpty.style.display = 'block';
            scanResultList.innerHTML = '<li style="color: var(--text-secondary); border-bottom: none;">No sheet scanned yet.</li>';
            scanCountBadge.textContent = '0';
            scanStatus.textContent = '';
            scanTip.textContent = 'Shade exactly one bubble per question for best results.';
            lastResult = null;
            loadedImage = null;
            lastOverlayData = null;
            if (overlayCanvas) {
                overlayCanvas.style.display = 'none';
                overlayCanvas.getContext('2d')?.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
            }
        });
    }
    if (btnExportScan) {
        btnExportScan.addEventListener('click', () => {
            if (!lastResult?.length) {
                setStatus('No results to export.', true);
                return;
            }
            const text = lastResult.map(r => {
                const conf = r.confidence != null ? ` (${r.confidence.toFixed(0)}%)` : '';
                return `Q${r.q}: ${r.answer}${conf}`;
            }).join('\n');
            try {
                navigator.clipboard.writeText(text);
                setStatus('Results with confidence copied to clipboard.', false, true);
            }
            catch {
                const blob = new Blob([text], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = 'omr_results_with_confidence.txt';
                link.click();
                URL.revokeObjectURL(url);
                setStatus('Results downloaded as text file.', false, true);
            }
        });
    }
    if (btnExportPdf) {
        btnExportPdf.addEventListener('click', async () => {
            if (!lastResult?.length) {
                setStatus('No results to export as PDF.', true);
                return;
            }
            try {
                await exportResultsAsPdf(lastResult);
                setStatus('PDF with results downloaded.', false, true);
            }
            catch (err) {
                setStatus('Failed to generate PDF: ' + (err && err.message ? err.message : 'unknown'), true);
            }
        });
    }
    if (btnShowOverlay && overlayCanvas) {
        btnShowOverlay.addEventListener('click', () => {
            if (!lastOverlayData || !loadedImage) {
                setStatus('No scan data to show overlay. Scan an image first.', true);
                return;
            }
            drawOverlay(overlayCanvas, lastOverlayData, loadedImage);
            overlayCanvas.style.display = 'block';
            setStatus('Overlay shown. Green = detected bubble, Red = low confidence.', false);
        });
    }
    async function runScan(file) {
        setStatus('Reading image…', false);
        scanResultList.innerHTML = '<li style="color: var(--text-secondary); border-bottom: none;">Processing…</li>';
        scanCountBadge.textContent = '?';
        if (overlayCanvas)
            overlayCanvas.style.display = 'none';
        try {
            const img = await loadImage(file);
            loadedImage = img;
            scanEmpty.style.display = 'none';
            scanImage.style.display = 'block';
            scanImage.src = img.src;
            await new Promise((resolve) => {
                if (img.complete)
                    return resolve(undefined);
                img.onload = resolve;
                img.onerror = () => resolve(undefined);
            });
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) {
                throw new Error('Canvas 2d context not supported in this browser');
            }
            const maxDim = 2000;
            let w = img.naturalWidth || img.width;
            let h = img.naturalHeight || img.height;
            if (w > maxDim || h > maxDim) {
                const s = Math.min(maxDim / w, maxDim / h);
                w = Math.round(w * s);
                h = Math.round(h * s);
            }
            canvas.width = w;
            canvas.height = h;
            ctx.drawImage(img, 0, 0, w, h);
            const imageData = ctx.getImageData(0, 0, w, h);
            let detected;
            let overlayData = null;
            let ocrText = [];
            // Try OCR text extraction (Tesseract if available, else basic)
            try {
                const imgDataUrl = canvas.toDataURL('image/png');
                // Try Tesseract first
                try {
                    const tesseractResult = await window.performOCR?.(imgDataUrl, {
                        mode: 'text'
                    });
                    if (tesseractResult && tesseractResult.text) {
                        ocrText = tesseractResult.text.split('\n').filter(line => line.trim());
                    }
                }
                catch (tesseractErr) {
                    console.warn('Tesseract OCR failed, using basic OCR:', tesseractErr);
                    // Fall back to basic OCR
                    ocrText = extractTextFromImage(imageData, w, h);
                }
            }
            catch (ocrErr) {
                console.warn('OCR extraction failed:', ocrErr);
                ocrText = [];
            }
            if (examIdInput && examIdInput.value.trim()) {
                const meta = await fetchOmrMeta(examIdInput.value.trim());
                const result = scanWithKnownGrid(imageData, w, h, meta);
                detected = result.detected;
                overlayData = result.overlay;
            }
            else {
                const result = scanWithAutoGrid(imageData, w, h);
                detected = result.detected;
                overlayData = result.overlay;
            }
            lastOverlayData = overlayData;
            if (!detected || detected.length === 0) {
                scanResultList.innerHTML = '<li style="color: var(--danger); border-bottom: none;">No OMR bubbles detected. Try a clearer, straight-on scan.</li>';
                scanCountBadge.textContent = '0';
                setStatus('Could not locate bubble grid.', true);
                lastResult = [];
                return;
            }
            renderResultsWithConfidence(detected);
            setStatus(`Recognized ${detected.length} question(s). Review the shaded marks below.`, false, true);
            lastResult = detected;
            // Show OCR results if available
            if (ocrText.length > 0) {
                displayOcrResults(ocrText);
            }
        }
        catch (err) {
            scanResultList.innerHTML = `<li style="color: var(--danger); border-bottom: none;">Scan failed: ${err && err.message ? err.message : 'unknown error'}</li>`;
            scanCountBadge.textContent = '0';
            setStatus('Scan failed.', true);
            lastResult = [];
        }
    }
    function displayOcrResults(textLines) {
        const ocrContainer = document.getElementById('ocrResults');
        if (!ocrContainer)
            return;
        if (textLines.length === 0) {
            ocrContainer.innerHTML = '<div class="ocr-no-text">No text detected in image</div>';
            return;
        }
        ocrContainer.innerHTML = textLines
            .map(line => `<div class="ocr-line">${line}</div>`)
            .join('');
        ocrContainer.style.display = 'block';
    }
    async function fetchOmrMeta(examId) {
        try {
            const token = api?.getToken?.() || '';
            const res = await fetch(`/exams/${examId}/print-paper-omr`, {
                headers: token ? { Authorization: `Bearer ${token}` } : {},
            });
            if (!res.ok)
                throw new Error(`Meta fetch failed: ${res.status}`);
            return await res.json();
        }
        catch {
            throw new Error('Could not load OMR grid metadata. Enter exam ID or scan without it.');
        }
    }
    function loadImage(file) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('Failed to read image'));
            img.src = URL.createObjectURL(file);
        });
    }
    // ─── Auto grid detection (no metadata) ──────────────────────────────────────
    function scanWithAutoGrid(imageData, width, height) {
        const gray = toGrayscale(imageData, width, height);
        const binary = thresholdOtsu(gray, width, height);
        const corners = detectSheetCorners(binary, width, height);
        let overlay = { corners: null, bubbles: [], warped: false };
        if (corners) {
            overlay.corners = corners;
            const warped = warpToRectangular(gray, width, height, corners);
            if (warped) {
                const [ww, wh] = warped.size;
                const wbinary = thresholdOtsu(warped.data, ww, wh);
                const grid = detectGridFromWarped(wbinary, ww, wh);
                if (grid && grid.rows >= 2) {
                    const results = extractAnswersFromGrid(warped.data, ww, wh, grid);
                    overlay.warped = true;
                    overlay.bubbles = grid.bubblePositions.map(bp => ({
                        q: bp.q,
                        opt: bp.opt,
                        x: bp.x,
                        y: bp.y,
                        w: bp.w,
                        h: bp.h,
                        score: 0,
                    }));
                    return { detected: results, overlay };
                }
            }
        }
        // Fallback: detect bubbles directly from original image
        const grid = detectGridFromBinary(binary, width, height);
        if (grid && grid.rows >= 2) {
            const results = extractAnswersFromGrid(binary, width, height, grid);
            overlay.bubbles = grid.bubblePositions.map(bp => ({
                q: bp.q,
                opt: bp.opt,
                x: bp.x,
                y: bp.y,
                w: bp.w,
                h: bp.h,
                score: 0,
            }));
            return { detected: results, overlay };
        }
        return { detected: [], overlay };
    }
    function scanWithKnownGrid(imageData, width, height, meta) {
        const gray = toGrayscale(imageData, width, height);
        const binary = thresholdOtsu(gray, width, height);
        const corners = detectSheetCorners(binary, width, height);
        let overlay = { corners: null, bubbles: [], warped: false };
        if (corners) {
            overlay.corners = corners;
            const warped = warpToRectangular(gray, width, height, corners);
            if (warped) {
                const [ww, wh] = warped.size;
                const grid = estimateGridFromMetadata(ww, wh, meta.rows, meta.cols, meta.bubblesPerQuestion || 4);
                if (grid) {
                    const results = extractAnswersFromGrid(warped.data, ww, wh, grid);
                    overlay.warped = true;
                    overlay.bubbles = grid.bubblePositions.map(bp => ({
                        q: bp.q,
                        opt: bp.opt,
                        x: bp.x,
                        y: bp.y,
                        w: bp.w,
                        h: bp.h,
                        score: 0,
                    }));
                    return { detected: results, overlay };
                }
            }
        }
        // Fallback: try without warping
        const grid = estimateGridFromMetadata(width, height, meta.rows, meta.cols, meta.bubblesPerQuestion || 4);
        if (grid) {
            const results = extractAnswersFromGrid(binary, width, height, grid);
            overlay.bubbles = grid.bubblePositions.map(bp => ({
                q: bp.q,
                opt: bp.opt,
                x: bp.x,
                y: bp.y,
                w: bp.w,
                h: bp.h,
                score: 0,
            }));
            return { detected: results, overlay };
        }
        return { detected: [], overlay };
    }
    // ─── Image processing helpers ────────────────────────────────────────────────
    function toGrayscale(imageData, width, height) {
        const data = imageData.data;
        const out = new Float32Array(width * height);
        for (let i = 0; i < out.length; i++) {
            const p = i * 4;
            out[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
        }
        return out;
    }
    function thresholdOtsu(gray, width, height) {
        const hist = new Uint32Array(256);
        for (let i = 0; i < gray.length; i++) {
            const v = Math.round(Math.min(255, Math.max(0, gray[i])));
            hist[v]++;
        }
        let total = gray.length;
        let sumAll = 0;
        for (let i = 0; i < 256; i++)
            sumAll += i * hist[i];
        let sumB = 0, wB = 0, maxVar = 0, threshold = 128;
        for (let t = 0; t < 256; t++) {
            wB += hist[t];
            if (wB === 0)
                continue;
            const wF = total - wB;
            if (wF === 0)
                break;
            sumB += t * hist[t];
            const mB = sumB / wB;
            const mF = (sumAll - sumB) / wF;
            const varBetween = wB * wF * (mB - mF) * (mB - mF);
            if (varBetween > maxVar) {
                maxVar = varBetween;
                threshold = t;
            }
        }
        const out = new Uint8Array(gray.length);
        for (let i = 0; i < gray.length; i++) {
            out[i] = gray[i] < threshold ? 1 : 0;
        }
        return out;
    }
    // ─── Corner detection for sheet alignment ────────────────────────────────────
    function detectSheetCorners(binary, width, height) {
        const contours = findContours(binary, width, height);
        if (contours.length === 0)
            return null;
        let bestContour = null;
        let bestScore = -Infinity;
        for (const contour of contours) {
            if (contour.length < 4)
                continue;
            const approx = approximatePolygon(contour, width, height);
            if (approx.length !== 4)
                continue;
            const area = polygonArea(approx);
            const perimeter = polygonPerimeter(approx);
            if (perimeter === 0)
                continue;
            const rectangularity = (area * 10000) / (perimeter * perimeter);
            const score = area * rectangularity;
            if (score > bestScore) {
                bestScore = score;
                bestContour = approx;
            }
        }
        if (!bestContour)
            return null;
        return orderCorners(bestContour);
    }
    function findContours(binary, width, height) {
        const visited = new Uint8Array(width * height);
        const contours = [];
        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                const idx = y * width + x;
                if (visited[idx] || binary[idx] === 0)
                    continue;
                const neighbors = [
                    [x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1],
                    [x - 1, y - 1], [x + 1, y - 1], [x - 1, y + 1], [x + 1, y + 1],
                ];
                let isBoundary = false;
                for (const [nx, ny] of neighbors) {
                    if (nx < 0 || nx >= width || ny < 0 || ny >= height)
                        continue;
                    if (binary[ny * width + nx] !== binary[idx]) {
                        isBoundary = true;
                        break;
                    }
                }
                if (!isBoundary)
                    continue;
                const contour = traceContour(binary, width, height, x, y, visited);
                if (contour.length >= 4) {
                    contours.push(contour);
                }
            }
        }
        return contours;
    }
    function traceContour(binary, width, height, startX, startY, visited) {
        const points = [];
        let x = startX, y = startY;
        let maxSteps = width * height;
        const directions = [
            [0, -1], [1, -1], [1, 0], [1, 1],
            [0, 1], [-1, 1], [-1, 0], [-1, -1],
        ];
        while (maxSteps-- > 0) {
            const idx = y * width + x;
            if (visited[idx])
                break;
            visited[idx] = 1;
            if (binary[idx] !== 1)
                break;
            points.push([x, y]);
            let found = false;
            for (let d = 0; d < 8; d++) {
                const nx = x + directions[d][0];
                const ny = y + directions[d][1];
                if (nx < 0 || nx >= width || ny < 0 || ny >= height)
                    continue;
                const nidx = ny * width + nx;
                if (!visited[nidx] && binary[nidx] === 1) {
                    x = nx;
                    y = ny;
                    found = true;
                    break;
                }
            }
            if (!found)
                break;
            if (points.length > 1) {
                const [lx, ly] = points[points.length - 2];
                const [cx, cy] = points[points.length - 1];
                if (cx === lx && cy === ly)
                    break;
            }
        }
        return points.map(p => [p[0], p[1]]);
    }
    function approximatePolygon(points, width, height) {
        if (points.length < 3)
            return points;
        const epsilon = Math.max(width, height) * 0.005;
        return douglasPeucker(points, epsilon);
    }
    function douglasPeucker(points, epsilon) {
        if (points.length <= 2)
            return points;
        let maxDist = 0;
        let maxIdx = 0;
        const first = points[0];
        const last = points[points.length - 1];
        for (let i = 1; i < points.length - 1; i++) {
            const dist = pointToLineDistance(points[i], first, last);
            if (dist > maxDist) {
                maxDist = dist;
                maxIdx = i;
            }
        }
        if (maxDist > epsilon) {
            const left = douglasPeucker(points.slice(0, maxIdx + 1), epsilon);
            const right = douglasPeucker(points.slice(maxIdx), epsilon);
            return left.slice(0, -1).concat(right);
        }
        else {
            return [first, last];
        }
    }
    function pointToLineDistance(p, a, b) {
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len === 0)
            return Math.sqrt((p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2);
        const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (len * len);
        const projX = a[0] + t * dx;
        const projY = a[1] + t * dy;
        return Math.sqrt((p[0] - projX) ** 2 + (p[1] - projY) ** 2);
    }
    function polygonArea(pts) {
        let area = 0;
        for (let i = 0; i < pts.length; i++) {
            const j = (i + 1) % pts.length;
            area += pts[i][0] * pts[j][1];
            area -= pts[j][0] * pts[i][1];
        }
        return Math.abs(area) / 2;
    }
    function polygonPerimeter(pts) {
        let perim = 0;
        for (let i = 0; i < pts.length; i++) {
            const j = (i + 1) % pts.length;
            perim += Math.sqrt((pts[j][0] - pts[i][0]) ** 2 + (pts[j][1] - pts[i][1]) ** 2);
        }
        return perim;
    }
    function orderCorners(pts) {
        if (pts.length !== 4)
            return null;
        const sum = pts.map(p => p[0] + p[1]);
        const diff = pts.map(p => p[0] - p[1]);
        const tl = pts[sum.indexOf(Math.min(...sum))];
        const br = pts[sum.indexOf(Math.max(...sum))];
        const tr = pts[diff.indexOf(Math.max(...diff))];
        const bl = pts[diff.indexOf(Math.min(...diff))];
        return { tl, tr, br, bl };
    }
    // ─── Perspective warp ────────────────────────────────────────────────────────
    function warpToRectangular(gray, width, height, corners) {
        const { tl, tr, br, bl } = corners;
        const srcW = Math.max(Math.abs(tr[0] - tl[0]), Math.abs(br[0] - bl[0]));
        const srcH = Math.max(Math.abs(bl[1] - tl[1]), Math.abs(br[1] - tr[1]));
        const dstW = Math.round(srcW);
        const dstH = Math.round(srcH);
        if (dstW < 100 || dstH < 100)
            return null;
        const out = {
            data: new Float32Array(dstW * dstH),
            size: [dstW, dstH],
        };
        const m = computeHomography(tl, tr, br, bl, dstW, dstH);
        if (!m)
            return null;
        for (let dy = 0; dy < dstH; dy++) {
            for (let dx = 0; dx < dstW; dx++) {
                const src = applyHomography(m, dx, dy);
                if (src) {
                    const sx = Math.round(src.x);
                    const sy = Math.round(src.y);
                    if (sx >= 0 && sx < width && sy >= 0 && sy < height) {
                        out.data[dy * dstW + dx] = gray[sy * width + sx];
                    }
                }
            }
        }
        return out;
    }
    function computeHomography(tl, tr, br, bl, dstW, dstH) {
        const x0 = tl[0], y0 = tl[1];
        const x1 = tr[0], y1 = tr[1];
        const x2 = br[0], y2 = br[1];
        const x3 = bl[0], y3 = bl[1];
        const a = ((x1 - x0) + (x2 - x3)) / (2 * dstW);
        const b = ((x1 - x0) - (x2 - x3)) / (2 * dstH);
        const c = (x0 + x1 - x2 - x3) / 4 - a * dstW / 2 - b * dstH / 2;
        const d = ((y1 - y0) + (y2 - y3)) / (2 * dstW);
        const e = ((y1 - y0) - (y2 - y3)) / (2 * dstH);
        const f = (y0 + y1 - y2 - y3) / 4 - d * dstW / 2 - e * dstH / 2;
        return { a, b, c, d, e, f };
    }
    function applyHomography(m, dx, dy) {
        const sx = m.a * dx + m.b * dy + m.c;
        const sy = m.d * dx + m.e * dy + m.f;
        return { x: sx, y: sy };
    }
    function detectGridFromWarped(binary, width, height) {
        const hProfile = new Float32Array(height);
        const vProfile = new Float32Array(width);
        for (let y = 0; y < height; y++) {
            let sum = 0;
            for (let x = 0; x < width; x++) {
                sum += binary[y * width + x];
            }
            hProfile[y] = sum / width;
        }
        for (let x = 0; x < width; x++) {
            let sum = 0;
            for (let y = 0; y < height; y++) {
                sum += binary[y * width + x];
            }
            vProfile[x] = sum / height;
        }
        const rowPositions = findPeaks(hProfile, 0.02, 10);
        if (rowPositions.length < 2)
            return null;
        const colPositions = findPeaks(vProfile, 0.02, 10);
        if (colPositions.length < 4)
            return null;
        const qCols = [];
        for (let i = 0; i < colPositions.length; i += 4) {
            const group = [];
            for (let j = 0; j < 4 && i + j < colPositions.length; j++) {
                group.push(colPositions[i + j]);
            }
            if (group.length === 4) {
                qCols.push(group);
            }
        }
        if (qCols.length === 0)
            return null;
        const rows = rowPositions.length;
        const cols = qCols.length;
        const cellBounds = [];
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const cellX = qCols[c][0] - 10;
                const cellY = rowPositions[r] - 5;
                const cellW = qCols[c][3] - qCols[c][0] + 20;
                const cellH = rowPositions[Math.min(r + 1, rows - 1)] - rowPositions[r] + 10;
                cellBounds.push({ row: r, col: c, x: cellX, y: cellY, w: cellW, h: cellH });
            }
        }
        const bubblePositions = [];
        let qIdx = 0;
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const cb = cellBounds[r * cols + c];
                if (!cb)
                    continue;
                for (let o = 0; o < 4; o++) {
                    const bubbleX = cb.x + (o * cb.w) / 4;
                    const bubbleY = cb.y;
                    const bubbleW = cb.w / 4;
                    const bubbleH = cb.h;
                    bubblePositions.push({ q: ++qIdx, opt: o, x: bubbleX, y: bubbleY, w: bubbleW, h: bubbleH });
                }
            }
        }
        return { rows, cols, bubblePositions, cellBounds };
    }
    function detectGridFromBinary(binary, width, height) {
        const hProfile = new Float32Array(height);
        const vProfile = new Float32Array(width);
        for (let y = 0; y < height; y++) {
            let sum = 0;
            for (let x = 0; x < width; x++) {
                sum += binary[y * width + x];
            }
            hProfile[y] = sum / width;
        }
        for (let x = 0; x < width; x++) {
            let sum = 0;
            for (let y = 0; y < height; y++) {
                sum += binary[y * width + x];
            }
            vProfile[x] = sum / height;
        }
        const rowPositions = findPeaks(hProfile, 0.015, 8);
        const colPositions = findPeaks(vProfile, 0.015, 8);
        if (rowPositions.length < 2 || colPositions.length < 4)
            return null;
        const qCols = [];
        for (let i = 0; i < colPositions.length; i += 4) {
            const group = [];
            for (let j = 0; j < 4 && i + j < colPositions.length; j++) {
                group.push(colPositions[i + j]);
            }
            if (group.length === 4)
                qCols.push(group);
        }
        if (qCols.length === 0)
            return null;
        const rows = rowPositions.length;
        const cols = qCols.length;
        const cellBounds = [];
        const bubblePositions = [];
        let qIdx = 0;
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const cellX = qCols[c][0] - 10;
                const cellY = rowPositions[r] - 5;
                const cellW = qCols[c][3] - qCols[c][0] + 20;
                const cellH = rowPositions[Math.min(r + 1, rows - 1)] - rowPositions[r] + 10;
                cellBounds.push({ row: r, col: c, x: cellX, y: cellY, w: cellW, h: cellH });
                for (let o = 0; o < 4; o++) {
                    bubblePositions.push({
                        q: ++qIdx,
                        opt: o,
                        x: cellX + (o * cellW) / 4,
                        y: cellY,
                        w: cellW / 4,
                        h: cellH,
                    });
                }
            }
        }
        return { rows, cols, bubblePositions, cellBounds };
    }
    function findPeaks(profile, minVal, minSpacing) {
        const peaks = [];
        for (let i = 2; i < profile.length - 2; i++) {
            if (profile[i] > minVal && profile[i] > profile[i - 1] && profile[i] >= profile[i + 1]) {
                if (peaks.length === 0 || i - peaks[peaks.length - 1] >= minSpacing) {
                    peaks.push(i);
                }
            }
        }
        return peaks;
    }
    function estimateGridFromMetadata(width, height, expectedRows, expectedCols, bubblesPerQ) {
        const margin = Math.min(width, height) * 0.05;
        const usableW = width - margin * 2;
        const usableH = height - margin * 2;
        const colW = usableW / expectedCols;
        const rowH = usableH / expectedRows;
        const cellBounds = [];
        const bubblePositions = [];
        let qIdx = 0;
        for (let r = 0; r < expectedRows; r++) {
            for (let c = 0; c < expectedCols; c++) {
                const cellX = margin + c * colW;
                const cellY = margin + r * rowH;
                const cellW = colW;
                const cellH = rowH;
                cellBounds.push({ row: r, col: c, x: cellX, y: cellY, w: cellW, h: cellH });
                const bubbleW = cellW / bubblesPerQ;
                for (let o = 0; o < bubblesPerQ; o++) {
                    bubblePositions.push({
                        q: ++qIdx,
                        opt: o,
                        x: cellX + o * bubbleW,
                        y: cellY + cellH * 0.2,
                        w: bubbleW,
                        h: cellH * 0.6,
                    });
                }
            }
        }
        return { rows: expectedRows, cols: expectedCols, bubblePositions, cellBounds };
    }
    function extractAnswersFromGrid(gray, width, height, grid) {
        const results = [];
        const seen = new Set();
        for (const bp of grid.bubblePositions) {
            const score = computeBubbleScore(gray, width, height, bp);
            const confidence = computeConfidence(score);
            const q = bp.q;
            if (!seen.has(q)) {
                seen.add(q);
                results.push({ q, answer: '', confidence: 0 });
            }
            const existing = results.find(r => r.q === q);
            if (existing && score < 200 && confidence > existing.confidence) {
                existing.answer = optionLabel(bp.opt);
                existing.confidence = confidence;
            }
        }
        return results.filter(r => r.answer !== '');
    }
    function computeBubbleScore(gray, width, height, bubble) {
        const cx = bubble.x + bubble.w / 2;
        const cy = bubble.y + bubble.h / 2;
        const radius = Math.min(bubble.w, bubble.h) / 2 * 0.8;
        let sum = 0;
        let count = 0;
        const step = 2;
        for (let dy = -radius; dy <= radius; dy += step) {
            for (let dx = -radius; dx <= radius; dx += step) {
                if (dx * dx + dy * dy > radius * radius)
                    continue;
                const px = Math.round(cx + dx);
                const py = Math.round(cy + dy);
                if (px >= 0 && px < width && py >= 0 && py < height) {
                    sum += gray[py * width + px];
                    count++;
                }
            }
        }
        return count > 0 ? sum / count : 255;
    }
    function computeConfidence(score) {
        // Score is average gray value in bubble (0=black, 255=white)
        // Lower score = darker = more likely filled
        // Map to 0-100% confidence
        if (score >= 200)
            return 0;
        if (score <= 50)
            return 100;
        // Linear interpolation
        return Math.round((200 - score) / 150 * 100);
    }
    function optionLabel(idx) {
        return String.fromCharCode(65 + idx);
    }
    // ─── Basic OCR text extraction (experimental) ────────────────────────────────
    // Extract text from scanned image using connected component analysis
    // This is a simplified OCR that detects dark text regions
    function extractTextFromImage(imageData, width, height) {
        const gray = toGrayscaleFromImageData(imageData, width, height);
        const binary = thresholdOtsu(gray, width, height);
        // Invert for text (text is dark on light background)
        const textBinary = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            textBinary[i] = binary[i] === 1 ? 0 : 1;
        }
        // Find connected components (potential characters)
        const components = findTextComponents(textBinary, width, height);
        // Filter by size (ignore very small/large components)
        const chars = components.filter(c => c.width >= 5 && c.width <= 30 &&
            c.height >= 8 && c.height <= 40);
        // Sort by position (left-to-right, top-to-bottom)
        chars.sort((a, b) => {
            if (Math.abs(a.y - b.y) < 10) {
                return a.x - b.x; // Same row, sort by x
            }
            return a.y - b.y; // Different rows, sort by y
        });
        // Group into words
        const words = [];
        let currentWord = [];
        for (const char of chars) {
            if (currentWord.length > 0 &&
                char.x - currentWord[currentWord.length - 1].x > 15) {
                words.push(currentWord);
                currentWord = [];
            }
            currentWord.push(char);
        }
        if (currentWord.length > 0) {
            words.push(currentWord);
        }
        // Convert word positions to text representation
        const textLines = [];
        let lastY = -100;
        let lineWords = [];
        for (const word of words) {
            const avgY = word.reduce((s, c) => s + c.y, 0) / word.length;
            if (Math.abs(avgY - lastY) > 20) {
                if (lineWords.length > 0) {
                    textLines.push(lineWords.join(' '));
                }
                lineWords = [];
                lastY = avgY;
            }
            lineWords.push(`[char]`);
        }
        if (lineWords.length > 0) {
            textLines.push(lineWords.join(' '));
        }
        return textLines;
    }
    // Expose for ocr-tesseract.js's basic-OCR fallback (loaded before scan.js
    // runs its DOM work, reads it lazily at scan time via window).
    (window).extractTextFromImageCanvas = extractTextFromImage;
    function toGrayscaleFromImageData(imageData, width, height) {
        const data = imageData.data;
        const out = new Float32Array(width * height);
        for (let i = 0; i < out.length; i++) {
            const p = i * 4;
            out[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
        }
        return out;
    }
    function findTextComponents(binary, width, height) {
        const visited = new Uint8Array(binary.length);
        const components = [];
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = y * width + x;
                if (visited[idx] || binary[idx] === 0)
                    continue;
                // Start flood fill
                const pixels = [];
                const minX = x, minY = y;
                let maxX = x, maxY = y;
                const queue = [[x, y]];
                visited[idx] = 1;
                while (queue.length > 0) {
                    const [cx, cy] = queue.shift();
                    pixels.push(cx, cy);
                    minX = Math.min(minX, cx);
                    minY = Math.min(minY, cy);
                    maxX = Math.max(maxX, cx);
                    maxY = Math.max(maxY, cy);
                    const neighbors = [
                        [cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1],
                    ];
                    for (const [nx, ny] of neighbors) {
                        if (nx < 0 || nx >= width || ny < 0 || ny >= height)
                            continue;
                        const nidx = ny * width + nx;
                        if (!visited[nidx] && binary[nidx] === 1) {
                            visited[nidx] = 1;
                            queue.push([nx, ny]);
                        }
                    }
                }
                const compWidth = maxX - minX + 1;
                const compHeight = maxY - minY + 1;
                components.push({
                    x: minX,
                    y: minY,
                    width: compWidth,
                    height: compHeight,
                    area: pixels.length / 2,
                    pixels
                });
            }
        }
        return components;
    }
    // ─── Overlay rendering ───────────────────────────────────────────────────────
    function drawOverlay(canvas, overlayData, img) {
        const ctx = canvas.getContext('2d');
        if (!ctx)
            return;
        const maxDim = 1200;
        let w = img.naturalWidth || img.width;
        let h = img.naturalHeight || img.height;
        if (w > maxDim || h > maxDim) {
            const s = Math.min(maxDim / w, maxDim / h);
            w = Math.round(w * s);
            h = Math.round(h * s);
        }
        canvas.width = w;
        canvas.height = h;
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        // Draw detected corners
        if (overlayData.corners) {
            const { tl, tr, br, bl } = overlayData.corners;
            ctx.strokeStyle = '#00ff00';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(tl[0] * (w / img.naturalWidth), tl[1] * (h / img.naturalHeight));
            ctx.lineTo(tr[0] * (w / img.naturalWidth), tr[1] * (h / img.naturalHeight));
            ctx.lineTo(br[0] * (w / img.naturalWidth), br[1] * (h / img.naturalHeight));
            ctx.lineTo(bl[0] * (w / img.naturalWidth), bl[1] * (h / img.naturalHeight));
            ctx.closePath();
            ctx.stroke();
        }
        // Draw bubbles with confidence coloring
        if (overlayData.bubbles) {
            for (const bubble of overlayData.bubbles) {
                const x = bubble.x * (w / img.naturalWidth);
                const y = bubble.y * (h / img.naturalHeight);
                const bw = bubble.w * (w / img.naturalWidth);
                const bh = bubble.h * (h / img.naturalHeight);
                const cx = x + bw / 2;
                const cy = y + bh / 2;
                const radius = Math.min(bw, bh) / 2;
                // Color based on confidence
                const conf = bubble.score != null ? bubble.score : 50;
                let color;
                if (conf > 70)
                    color = 'rgba(0, 255, 0, 0.5)'; // high confidence - green
                else if (conf > 40)
                    color = 'rgba(255, 255, 0, 0.5)'; // medium - yellow
                else
                    color = 'rgba(255, 0, 0, 0.5)'; // low - red
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.arc(cx, cy, radius * 0.8, 0, Math.PI * 2);
                ctx.fill();
                ctx.strokeStyle = '#333';
                ctx.lineWidth = 1;
                ctx.stroke();
            }
        }
        // If warped, show correction indicator
        if (overlayData.warped) {
            ctx.fillStyle = 'rgba(0, 255, 0, 0.8)';
            ctx.font = '16px Arial';
            ctx.textAlign = 'left';
            ctx.fillText('✓ Perspective corrected', 10, 25);
        }
    }
    // ─── PDF export using enhanced PDFGenerator library ───────────────────────
    async function exportResultsAsPdf(results) {
        try {
            // Check available options
            const includeChart = document.getElementById('optChart')?.checked;
            const colors = {
                high: '#28a745',
                medium: '#ffc107',
                low: '#dc3545'
            };
            const pdfBytes = PDFGenerator.generateOmrResultsPdf(results, examIdInput?.value || 'OMR Scan Results', examIdInput?.value || '', {
                includeChart,
                colors
            });
            const blob = new Blob([pdfBytes], { type: 'application/pdf' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `omr_results_${Date.now()}.pdf`;
            link.click();
            URL.revokeObjectURL(url);
            const engine = window.getOcrEngineStatus?.();
            const engineName = engine?.name || 'basic';
            setStatus(`PDF with results downloaded (OCR engine: ${engineName}).`, false, true);
        }
        catch (err) {
            setStatus('Failed to generate PDF: ' + (err && err.message ? err.message : 'unknown'), true);
            throw err;
        }
    }
    function generatePdfText(results) {
        // Legacy text export (kept for fallback)
        let text = 'OMR Scan Results\n';
        text += '='.repeat(50) + '\n\n';
        text += `Exam: ${examIdInput?.value || 'Unknown'}\n`;
        text += `Date: ${new Date().toLocaleString()}\n`;
        text += `Questions: ${results.length}\n\n`;
        text += '-'.repeat(50) + '\n';
        text += 'Question'.padEnd(10) + 'Answer'.padEnd(10) + 'Confidence\n';
        text += '-'.repeat(50) + '\n';
        for (const r of results) {
            const confStr = r.confidence != null ? `${r.confidence}%` : 'N/A';
            text += `Q${r.q}`.padEnd(10) + r.answer.padEnd(10) + confStr + '\n';
        }
        text += '\n' + '='.repeat(50) + '\n';
        text += `Total: ${results.length} questions scanned\n`;
        const highConf = results.filter(r => r.confidence >= 70).length;
        const medConf = results.filter(r => r.confidence >= 40 && r.confidence < 70).length;
        const lowConf = results.filter(r => r.confidence < 40).length;
        text += `\nConfidence breakdown:\n`;
        text += `  High (≥70%): ${highConf}\n`;
        text += `  Medium (40-69%): ${medConf}\n`;
        text += `  Low (<40%): ${lowConf}\n`;
        return text;
    }
    // ─── Result rendering with confidence ────────────────────────────────────────
    function renderResultsWithConfidence(detected) {
        scanResultList.innerHTML = detected
            .map(r => {
            const conf = r.confidence != null ? r.confidence : 0;
            const confClass = conf >= 70 ? 'conf-high' : conf >= 40 ? 'conf-med' : 'conf-low';
            const confColor = conf >= 70 ? 'var(--success)' : conf >= 40 ? 'var(--warning)' : 'var(--danger)';
            return `<li class="${confClass}">
          <span>Q${r.q}</span>
          <span style="font-weight: 600;">${r.answer || '—'}</span>
          <span style="color: ${confColor}; font-size: 0.75rem;">${conf}%</span>
        </li>`;
        })
            .join('');
        scanCountBadge.textContent = String(detected.length);
        const avgConf = detected.reduce((sum, r) => sum + (r.confidence || 0), 0) / detected.length;
        const highConf = detected.filter(r => (r.confidence || 0) >= 70).length;
        const lowConf = detected.filter(r => (r.confidence || 0) < 40).length;
        scanTip.innerHTML = `
      <strong>Average confidence: ${avgConf.toFixed(0)}%</strong> |
      High: ${highConf} | Low: ${lowConf} |
      ${detected.length ? 'Review marks below. Hover for details.' : 'No clear marks found.'}
    `;
    }
    function setStatus(msg, isError = false, isGood = false) {
        scanStatus.textContent = msg;
        scanStatus.classList.toggle('error', isError);
        scanStatus.classList.toggle('ok', isGood && !isError);
    }
});
