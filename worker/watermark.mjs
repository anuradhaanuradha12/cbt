/**
 * watermark.mjs — Diagnose and remove the source watermark from question images.
 *
 * The images in the bank were scraped from a branded question-bank site, so every
 * diagram carries the same faint "MARKS" logo baked into the pixels. Because it is
 * a low-opacity overlay (not content), it can be removed by alpha-division — which
 * restores the underlying strokes instead of smearing them, unlike AI inpainting.
 *
 *   node watermark.mjs template   → average N images into a watermark template PNG
 *   node watermark.mjs test      → remove the watermark from the local originals + compare
 */

import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const DIR = 'enhanced-images/originals';
const W = 320, H = 260;
const mode = process.argv[2] || 'template';

async function toGrey(buf) {
  return sharp(buf)
    .resize(W, H, { fit: 'contain', background: { r: 255, g: 255, b: 255 } })
    .greyscale().raw().toBuffer({ resolveWithObject: true });
}

/** Average many images → anything consistently darker than white is the shared overlay. */
async function template() {
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.webp'));
  const acc = new Float64Array(W * H);
  let n = 0;
  for (const f of files) {
    try {
      const { data } = await toGrey(fs.readFileSync(path.join(DIR, f)));
      for (let i = 0; i < W * H; i++) acc[i] += data[i];
      n++;
    } catch (e) { console.log('skip', f, e.message); }
  }
  if (!n) throw new Error('no images read');

  let min = 255, max = 0;
  const out = Buffer.alloc(W * H);
  for (let i = 0; i < W * H; i++) {
    const m = acc[i] / n;
    if (m < min) min = m;
    if (m > max) max = m;
    out[i] = Math.max(0, Math.min(255, 255 - m)); // darkness map
  }
  fs.mkdirSync('enhanced-images/watermark', { recursive: true });
  await sharp(out, { raw: { width: W, height: H, channels: 1 } })
    .png().toFile('enhanced-images/watermark/template.png');

  let below = 0;
  for (let i = 0; i < W * H; i++) if (out[i] > 12) below++;
  console.log(`averaged ${n} images → enhanced-images/watermark/template.png`);
  console.log(`mean luminance ${min.toFixed(1)}..${max.toFixed(1)} (255=white)`);
  console.log(`pixels darker than white in ${(100 * below / (W * H)).toFixed(1)}% of the frame`);
}

/**
 * Alpha-division removal.
 * The overlay is roughly I = a*C + (1-a)*255, so C = (I - (1-a)*255) / a.
 * `alpha` is the estimated opacity; 1.0 = untouched, lower = stronger correction.
 */
async function remove(buf, alpha) {
  const lift = (1 - alpha) * 255;
  const img = sharp(buf).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  for (let i = 0; i < data.length; i += ch) {
    for (let c = 0; c < 3; c++) {
      const v = (data[i + c] - lift) / alpha;
      data[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: ch } }).webp({ quality: 92 }).toBuffer();
}

async function test() {
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.webp')).slice(0, 8);
  const outDir = 'enhanced-images/watermark';
  fs.mkdirSync(outDir, { recursive: true });
  const cards = [];
  for (const f of files) {
    const orig = fs.readFileSync(path.join(DIR, f));
    const cleaned = await remove(orig, 0.90); // gentle
    fs.writeFileSync(path.join(outDir, `clean-${f}`), cleaned);
    cards.push({ f, orig, clean: cleaned });
  }
  // side-by-side HTML at true exam display size
  const rows = cards.map(c => `
    <div class="card">
      <div class="pair">
        <figure><img src="originals/${c.f}" style="height:256px"><figcaption>ORIGINAL (watermarked)</figcaption></figure>
        <figure><img src="watermark/clean-${c.f}" style="height:256px"><figcaption>CLEANED (alpha-divide, no smearing)</figcaption></figure>
      </div>
    </div>`).join('');
  fs.writeFileSync(outDir + '/comparison.html', `<!doctype html><meta charset="utf-8">
  <body style="font-family:system-ui;background:#0f172a;color:#e2e8f0;padding:20px">
  <h2>Watermark removal — before / after (256px, exam display size)</h2>${rows}
  <style>.card{background:#1e293b;border-radius:12px;padding:12px;margin:12px 0}
  .pair{display:flex;gap:16px}figure{margin:0;text-align:center}
  figcaption{font-size:11px;color:#94a3b8;margin-top:6px}img{border-radius:6px;background:#fff}</style></body>`);
  console.log(`wrote ${files.length} cleaned copies + ${outDir}/comparison.html`);
}

(mode === 'template' ? template() : test()).catch(e => { console.error(e); process.exit(1); });