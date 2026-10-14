// ocr-tesseract.js - Production-grade OCR using Tesseract.js
// Provides accurate text recognition from scanned images
// Check if Tesseract is available (loaded from CDN)
let Tesseract = null;
async function loadTesseract() {
    if (Tesseract)
        return Tesseract;
    try {
        // Dynamically load Tesseract.js from CDN
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
        script.async = true;
        await new Promise((resolve, reject) => {
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
        // Tesseract becomes available as window.Tesseract
        Tesseract = window.Tesseract;
        if (!Tesseract) {
            throw new Error('Tesseract.js loaded but Tesseract not found on window');
        }
        return Tesseract;
    }
    catch (err) {
        console.warn('Failed to load Tesseract.js:', err);
        return null;
    }
}
let ocrEngine = { name: null };
/**
 * Perform OCR on an image using Tesseract.js (production-grade)
 */
async function recognizeTextWithTesseract(imageSrc, options) {
    const T = await loadTesseract();
    if (!T) {
        throw new Error('Tesseract.js not available');
    }
    const config = {
        logger: m => {
            if (m.status === 'recognizing text') {
                // Could update progress UI here
                const statusEl = document.getElementById('ocrProgress');
                if (statusEl) {
                    statusEl.textContent = `Recognizing: ${Math.round(m.progress * 100)}%`;
                }
            }
        }
    };
    if (options?.lang)
        config.lang = options.lang;
    if (options?.PSM)
        config.psm = options.PSM;
    if (options?.OEM)
        config.oem = options.OEM;
    let image = imageSrc;
    // If rectangle provided, crop the image first
    if (options?.rectangle) {
        image = await cropImageToRect(imageSrc, options.rectangle);
    }
    const result = await T.recognize(image, config);
    const words = (result.data.words || []).map((word) => ({
        text: word.text,
        confidence: word.confidence,
        bbox: {
            x0: word.bbox.x0,
            y0: word.bbox.y0,
            x1: word.bbox.x1,
            y1: word.bbox.y1
        }
    }));
    // Calculate average confidence
    const confidence = words.length > 0
        ? words.reduce((sum, w) => sum + w.confidence, 0) / words.length
        : result.data.confidence;
    return {
        text: result.data.text,
        confidence,
        words
    };
}
/**
 * Crop image to a rectangle region
 */
async function cropImageToRect(imageSrc, rect) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = rect.w;
            canvas.height = rect.h;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                reject(new Error('Canvas context not available'));
                return;
            }
            ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
            resolve(canvas.toDataURL('image/png'));
        };
        img.onerror = () => reject(new Error('Failed to load image for cropping'));
        img.src = imageSrc;
    });
}
/**
 * Perform OCR with options for different use cases
 */
async function performOCR(imageSrc, options) {
    // Try Tesseract first
    try {
        ocrEngine = { name: 'tesseract' };
        let psm = 3; // Fully automatic page segmentation
        let lang = options?.lang || 'eng';
        if (options?.mode === 'number') {
            psm = 7; // Treat image as single text line
        }
        else if (options?.mode === 'sparse') {
            psm = 11; // Sparse text
        }
        const rect = options?.region;
        const result = await recognizeTextWithTesseract(imageSrc, {
            lang,
            PSM: psm,
            rectangle: rect
        });
        return {
            text: result.text,
            confidence: result.confidence,
            engine: 'tesseract'
        };
    }
    catch (err) {
        console.warn('Tesseract OCR failed, falling back to basic OCR:', err);
        // Fall back to basic OCR
        ocrEngine = { name: 'basic' };
        const basicText = await extractTextFromImageBasic(imageSrc);
        return {
            text: basicText,
            confidence: basicText.length > 0 ? 30 : 0,
            engine: 'basic'
        };
    }
}
/**
 * Fallback basic OCR using canvas-based character detection
 */
function extractTextFromImageBasic(imageSrc) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) {
                resolve('');
                return;
            }
            // Scale down for processing
            const maxDim = 1200;
            let w = img.width;
            let h = img.height;
            if (w > maxDim || h > maxDim) {
                const s = Math.min(maxDim / w, maxDim / h);
                w = Math.round(w * s);
                h = Math.round(h * s);
            }
            canvas.width = w;
            canvas.height = h;
            ctx.drawImage(img, 0, 0, w, h);
            const imageData = ctx.getImageData(0, 0, w, h);
            const textLines = ((window).extractTextFromImageCanvas
                ? (window).extractTextFromImageCanvas(imageData, w, h)
                : []);
            resolve(textLines.join('\n'));
        };
        img.onerror = () => resolve('');
        img.src = imageSrc;
    });
}
/**
 * OCR a specific region of the image (for question text extraction)
 */
async function ocrQuestionRegion(imageSrc, region, options) {
    const result = await performOCR(imageSrc, {
        region,
        lang: options?.lang || 'eng',
        mode: 'text'
    });
    return {
        text: result.text.trim(),
        confidence: result.confidence
    };
}
/**
 * Get OCR engine status
 */
function getOcrEngineStatus() {
    return { ...ocrEngine };
}
/**
 * Check if Tesseract is loaded and available
 */
async function isTesseractAvailable() {
    const T = await loadTesseract();
    return T !== null;
}
/**
 * Show OCR progress in UI
 */
function updateOcrProgress(percent, status) {
    const progressEl = document.getElementById('ocrProgress');
    const statusEl = document.getElementById('ocrStatus');
    if (progressEl) {
        progressEl.style.display = 'block';
        progressEl.textContent = `${status}: ${percent}%`;
    }
    if (statusEl) {
        statusEl.textContent = status;
    }
}
/**
 * Hide OCR progress when done
 */
function hideOcrProgress() {
    const progressEl = document.getElementById('ocrProgress');
    const statusEl = document.getElementById('ocrStatus');
    if (progressEl)
        progressEl.style.display = 'none';
    if (statusEl)
        statusEl.textContent = '';
}
export { recognizeTextWithTesseract, performOCR, ocrQuestionRegion, getOcrEngineStatus, isTesseractAvailable, updateOcrProgress, hideOcrProgress, cropImageToRect };
