// print.js - Printable question paper preview + browser print + OMR download
document.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const examId = urlParams.get('id');
  if (!examId) {
    showStatus('No exam ID provided.', true);
    return;
  }

  const phLoading = document.getElementById('phLoading');
  const phError = document.getElementById('phError');
  const phQuestions = document.getElementById('phQuestions');
  const phOmr = document.getElementById('phOmr');
  const printMeta = document.getElementById('printMeta');
  const statusLine = document.getElementById('statusLine');
  const btnPrint = document.getElementById('btnPrint');
  const btnPrintOmr = document.getElementById('btnPrintOmr');
  const btnScanOmr = document.getElementById('btnScanOmr');
  const btnDownloadOmr = document.getElementById('btnDownloadOmr');

  let printedPaperUrl = '';
  let printedOmrUrl = '';
  let omrMeta = null;

  btnScanOmr && (btnScanOmr.target = '_blank');

  async function loadPaper() {
    phLoading.style.display = 'block';
    phError.style.display = 'none';
    phQuestions.style.display = 'none';
    phOmr.style.display = 'none';
    statusLine.textContent = '';

    try {
      const [paperRes, metaRes] = await Promise.all([
        api.request(`/exams/${examId}/print-paper`),
        api.request(`/exams/${examId}/print-paper-omr`),
      ]);

      omrMeta = metaRes;

      const paperDoc = document.createElement('iframe');
      paperDoc.style.display = 'none';
      document.body.appendChild(paperDoc);
      paperDoc.srcdoc = paperRes;

      const omrDoc = document.createElement('iframe');
      omrDoc.style.display = 'none';
      document.body.appendChild(omrDoc);
      omrDoc.srcdoc = buildOmrOnlyHtml(paperRes);

      printedPaperUrl = paperDoc.contentWindow?.location?.href || '';
      printedOmrUrl = omrDoc.contentWindow?.location?.href || '';

      phLoading.style.display = 'none';
      phQuestions.style.display = 'block';
      phOmr.style.display = 'block';

      renderPreviewFromHtml(paperRes);

      const examMeta = paperRes.match(/<meta[^>]*>/i)?.[0] || '';
      printMeta.textContent = examMeta || '';
      showStatus(`Paper ready. ${metaRes.questionCount} questions. Download or print the OMR sheet below.`, false);
    } catch (err) {
      phLoading.style.display = 'none';
      phError.style.display = 'block';
      phError.textContent = err && err.message ? err.message : 'Failed to load paper';
      showStatus('Could not load printable paper.', true);
    }
  }

  function buildOmrOnlyHtml(fullHtml) {
    const omrMarker = 'omr-page';
    const start = fullHtml.indexOf(omrMarker);
    if (start === -1) return fullHtml;

    const before = fullHtml.slice(0, start);
    const headEnd = before.indexOf('</head>');
    const bodyStart = before.indexOf('<body');
    const head = bodyStart !== -1 && headEnd !== -1 ? fullHtml.slice(0, headEnd) : fullHtml.slice(0, fullHtml.indexOf('</body>'));

    const omrSnippet = fullHtml.slice(start);
    const endSection = omrSnippet.indexOf('</section>');
    const omrSection = endSection !== -1 ? omrSnippet.slice(0, endSection + '</section>'.length) : omrSnippet;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>OMR Sheet - ${escapeText(extractTitle(fullHtml))}</title>
<style>
  body { margin: 0; padding: 14mm; font-family: "Inter", system-ui, Arial, sans-serif; color: #111; background: #fff; }
  .omr-sheet { border: 2px solid #111; padding: 8mm 10mm; max-width: 210mm; margin: 0 auto; }
  .omr-sheet h2 { margin: 0 0 4mm 0; text-align: center; font-size: 15pt; }
  .omr-head { display: grid; grid-template-columns: 1fr 1fr; gap: 3mm 6mm; margin-bottom: 5mm; font-size: 9pt; border: 1px solid #999; padding: 3mm; }
  .omr-head .label { color: #555; }
  .omr-head .val { font-weight: 700; }
  .omr-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 2mm; }
  .omr-row { break-inside: avoid; border: 1px solid #999; padding: 2.5mm; border-radius: 3px; background: #fff; }
  .omr-row-head { display: flex; justify-content: space-between; font-size: 8.5pt; text-transform: uppercase; color: #555; letter-spacing: 0.4px; border-bottom: 1px dashed #999; margin-bottom: 1.5mm; padding-bottom: 1mm; }
  .omr-row-q { font-weight: 700; color: #2563eb; }
  .omr-row-opts { display: grid; grid-template-columns: repeat(4, auto); gap: 2mm 3mm; align-items: center; }
  .omr-bubble { display: flex; align-items: center; gap: 1.5mm; }
  .omr-bubble-mark { width: 5mm; height: 5mm; border: 1.4px solid #111; border-radius: 50%; flex: 0 0 auto; background: #fff; }
  .omr-bubble-label { font-weight: 700; font-size: 9pt; }
  .omr-foot { margin-top: 5mm; text-align: center; font-size: 8.5pt; color: #555; border-top: 1px solid #999; padding-top: 3mm; }
  @media print { body { padding: 12mm; } }
</style>
</head>
<body>
  <div class="omr-sheet">
    ${omrSection}
  </div>
</body>
</html>`;
  }

  function extractTitle(html) {
    const m = html.match(/<title>([^<]*)<\/title>/i);
    return m ? m[1] : 'OMR Sheet';
  }

  function escapeText(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderPreviewFromHtml(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    if (doc.querySelector('.columns')) {
      const items = doc.querySelectorAll('.q');
      const htmlOut = [];
      for (const q of items) {
        const num = q.getAttribute('data-q') || '';
        const textEl = q.querySelector('.q-text');
        const opts = [];
        q.querySelectorAll('.omr-opt').forEach((opt) => {
          const label = opt.querySelector('.omr-opt-label');
          const text = opt.querySelector('.omr-opt-text');
          opts.push(`
            <div class="pc-opt">
              <span class="pc-bubble"></span>
              <span class="pc-label">${escapeText(label?.textContent || '')}</span>
              <span class="pc-text">${escapeText(text?.textContent || '')}</span>
            </div>`);
        });
        htmlOut.push(`
          <div class="pc-q">
            <div class="pc-qnum">Q${num}</div>
            <div class="pc-text-block">${escapeText(textEl?.textContent || '')}</div>
            <div class="pc-opts">${opts.join('')}</div>
          </div>`);
      }
      phQuestions.innerHTML = htmlOut.join('');
    }

    if (doc.querySelector('.omr-sheet')) {
      const rows = doc.querySelectorAll('.omr-row');
      const htmlOut = [];
      for (const row of rows) {
        const head = row.querySelector('.omr-row-head')?.textContent || '';
        const bubbles = [];
        row.querySelectorAll('.omr-bubble').forEach((b) => {
          const label = b.querySelector('.omr-bubble-label');
          bubbles.push(`<span><span class="pc-bubble" style="width:9px;height:9px;border:1px solid #111;border-radius:50%;display:inline-block;"></span>${escapeText(label?.textContent || '')}</span>`);
        });
        htmlOut.push(`
          <div class="ph-omr-row">
            <div class="ph-omr-row-head">${escapeText(head)}</div>
            <div class="ph-omr-bubbles">${bubbles.join('')}</div>
          </div>`);
      }
      phOmr.innerHTML = `
        <div class="ph-omr-title">OMR Answer Sheet</div>
        <div class="ph-omr-grid">${htmlOut.join('')}</div>
        <div class="scan-tip" style="margin-top: 0.75rem; font-size: 0.82rem; color: var(--text-secondary);">
          Scan this sheet with the OMR Scanner — it will be matched to this exact exam layout automatically.
        </div>`;
    }
  }

  function showStatus(msg, isError = false) {
    statusLine.textContent = msg;
    statusLine.classList.toggle('error', isError);
  }

  btnPrint && btnPrint.addEventListener('click', () => {
    if (printedPaperUrl) {
      window.open(printedPaperUrl, '_blank')?.focus();
      return;
    }
    showStatus('Paper not loaded yet.', true);
  });

  btnPrintOmr && btnPrintOmr.addEventListener('click', () => {
    if (printedOmrUrl) {
      window.open(printedOmrUrl, '_blank')?.focus();
      return;
    }
    showStatus('OMR sheet not loaded yet.', true);
  });

  btnDownloadOmr && btnDownloadOmr.addEventListener('click', async () => {
    if (!omrMeta) {
      showStatus('OMR metadata not loaded yet.', true);
      return;
    }
    try {
      await downloadOmrAsPng(omrMeta);
      showStatus('OMR sheet downloaded as PNG.', false, true);
    } catch (err) {
      showStatus('Failed to generate OMR download: ' + (err && err.message ? err.message : 'unknown'), true);
    }
  });

  async function downloadOmrAsPng(meta) {
    const dpi = 150;
    const mmToPx = (mm) => (mm / 25.4) * dpi;
    const px = (mm) => Math.round(mmToPx(mm));

    const bubbleMm = meta.bubbleSizeMm;
    const bubblesPerQuestion = meta.bubblesPerQuestion;
    const labelWidthMm = 6;
    const bubbleGapMm = 1.5;
    const labelGapMm = 0.5;
    const optColWidthMm = bubblesPerQuestion * (labelWidthMm + labelGapMm + bubbleGapMm + bubbleMm) + bubbleGapMm;
    const rowHeightMm = bubbleMm + 5;

    const cols = meta.cols;
    const rows = meta.rows;

    const blockWidthMm = cols === 2 ? optColWidthMm * 2 + 4 : optColWidthMm;
    const sheetWidthMm = 20 + blockWidthMm + 10;
    const sheetHeightMm = 20 + 14 + 14 + (rows * (rowHeightMm + 3)) + 10;

    const canvas = document.createElement('canvas');
    canvas.width = px(sheetWidthMm);
    canvas.height = px(sheetHeightMm);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Canvas context not available');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = '#111';
    ctx.lineWidth = px(0.2);
    ctx.strokeRect(px(10), px(10), px(sheetWidthMm - 20), px(sheetHeightMm - 20));

    let y = 10 + 14;

    ctx.fillStyle = '#111';
    ctx.font = `${px(15)}px "Inter", system-ui, Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('OMR Answer Sheet', canvas.width / 2, y + px(5));

    y += 14;
    ctx.strokeStyle = '#999';
    ctx.lineWidth = px(0.15);
    const headPad = 4;
    ctx.strokeRect(px(10 + headPad), px(y), px(sheetWidthMm - 20 - headPad * 2), px(12));

    const fields = [
      { label: 'Name:', value: '' },
      { label: 'Roll No:', value: '' },
      { label: 'Exam:', value: meta.examTitle || '' },
      { label: 'Date:', value: '' },
    ];
    ctx.fillStyle = '#555';
    ctx.font = `${px(9)}px "Inter", system-ui, Arial, sans-serif`;
    ctx.textAlign = 'left';
    const colX = (i) => 10 + headPad + 4 + (i % 2) * ((sheetWidthMm - 20 - headPad * 2 - 8) / 2);
    for (let i = 0; i < 4; i++) {
      const fx = colX(i);
      const fy = y + 3 + (Math.floor(i / 2) * 6);
      ctx.fillText(fields[i].label, fx, fy);
      ctx.fillStyle = '#111';
      ctx.fillText(fields[i].value, fx + px(20), fy);
      ctx.fillStyle = '#555';
    }

    y += 12 + 4;

    for (const m of meta.marks) {
      const row = Math.floor((m.q - 1) / cols);
      const col = (m.q - 1) % cols;
      const blockX = 10 + 4 + col * (optColWidthMm + 4);
      const rowY = y + row * (rowHeightMm + 3);

      ctx.fillStyle = '#555';
      ctx.font = `${px(8.5)}px "Inter", system-ui, Arial, sans-serif`;
      ctx.textAlign = 'left';
      ctx.fillText(`Q${m.q}`, blockX, rowY + px(4));
      ctx.textAlign = 'right';
      ctx.fillText(`${m.marks} mark${m.marks === 1 ? '' : 's'}`, blockX + optColWidthMm, rowY + px(4));

      ctx.strokeStyle = '#ccc';
      ctx.lineWidth = px(0.1);
      ctx.beginPath();
      ctx.moveTo(blockX, rowY + px(6));
      ctx.lineTo(blockX + optColWidthMm, rowY + px(6));
      ctx.stroke();

      const optsY = rowY + px(8);
      for (let j = 0; j < bubblesPerQuestion; j++) {
        const cx = blockX + j * (labelWidthMm + labelGapMm + bubbleGapMm + bubbleMm) + labelWidthMm + labelGapMm + bubbleGapMm + bubbleMm / 2;
        const cy = optsY + bubbleMm / 2;

        ctx.strokeStyle = '#111';
        ctx.lineWidth = px(0.15);
        ctx.beginPath();
        ctx.arc(px(cx), px(cy), px(bubbleMm / 2 - 0.3), 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = '#111';
        ctx.font = `${px(9)}px "Inter", system-ui, Arial, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(String.fromCharCode(65 + j), px(cx), px(cy + 3));
      }
    }

    canvas.toBlob((blob) => {
      if (!blob) throw new Error('Failed to create OMR image');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `omr_sheet_${meta.examId}.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    }, 'image/png');
  }
});
