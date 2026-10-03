/**
 * analyze-images.mjs — Inventory, quality-analyse and enhance question images.
 *
 * Images live in production R2 (`cbt-media`), referenced by D1 keys like:
 *   questions/<uuid>/<hash>.webp
 * They are served publicly at https://cbt-worker.shishira-932.workers.dev/images/<key>
 *
 * What this script does:
 *   1. Pulls distinct image keys from production D1 (dedupes by file hash — the same
 *      physical file is shared by many questions).
 *   2. Downloads each unique image via the public /images/ endpoint (read-only).
 *   3. Analyses each: format, dimensions, bytes, sharpness (variance of Laplacian on a
 *      512px-wide grayscale render — comparable across images) and whether it is big
 *      enough for the exam UI (question images display at up to 256 CSS px height,
 *      phone DPR 3 ⇒ need ≥768px height to stay crisp).
 *   4. Enhances only what needs it: upscale ×2 (lanczos3) + mild unsharp, saved to
 *      enhanced-images/. Originals are NEVER modified. Nothing is uploaded anywhere.
 *
 * Usage (from worker/):
 *   node analyze-images.mjs                # analyse 40 unique sample images
 *   node analyze-images.mjs --limit 200    # bigger sample
 *   node analyze-images.mjs --report out.json
 */

import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '9325072bdbc32761b8550ef602ebf81e';
process.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT_ID;
const R2_BUCKET = 'cbt-media';
const DB = 'cbt-platform';
const ENHANCED_DIR = 'enhanced-images';
const DISPLAY_HEIGHT_PX = 768; // exam UI max-h-64 (256px) × DPR 3

// ── Get image keys from production D1 (read-only), deduped by physical file ─
async function fetchKeys(limit) {
  const { execSync } = await import('node:child_process');
  const sql = `SELECT image_r2_key AS k FROM questions WHERE image_r2_key IS NOT NULL LIMIT ${limit * 4}`;
  const out = execSync(
    `npx wrangler d1 execute ${DB} --remote --json --command "${sql}"`,
    { encoding: 'utf8' }
  );
  const parsed = JSON.parse(out.slice(out.indexOf('[')));
  const seen = new Set();
  const unique = [];
  for (const r of parsed[0].results) {
    const hash = r.k.split('/').pop(); // physical file identity
    if (!seen.has(hash)) { seen.add(hash); unique.push(r.k); }
    if (unique.length >= limit) break;
  }
  return unique;
}

// ── Download one image straight from R2 (read-only) ─────────────────────────
async function download(key) {
  const { execSync } = await import('node:child_process');
  const tmp = path.join(ENHANCED_DIR, '.tmp-download');
  execSync(`npx wrangler r2 object get "${R2_BUCKET}/${key}" --pipe > "${tmp}"`, { stdio: ['ignore', 'ignore', 'pipe'] });
  const buf = fs.readFileSync(tmp);
  fs.rmSync(tmp, { force: true });
  return buf;
}

// ── Sharpness: variance of Laplacian on a 512px-wide grayscale render ───────
// Higher = sharper. Roughly: >80 crisp, 30–80 acceptable, <30 soft/blurry.
async function laplacianVariance(buf) {
  const { data, info } = await sharp(buf)
    .resize({ width: 512, withoutEnlargement: true })
    .greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  let sum = 0, sumSq = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = 4 * data[i] - data[i - 1] - data[i + 1] - data[i - w] - data[i + w];
      sum += lap; sumSq += lap * lap; n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

function verdict(a) {
  const problems = [];
  if (a.height < DISPLAY_HEIGHT_PX) problems.push(`low-res for exam UI (${a.height}px < ${DISPLAY_HEIGHT_PX}px)`);
  if (a.sharpness < 30) problems.push('soft/blurry');
  if (a.bytes > 400_000) problems.push('heavy file');
  if (!problems.length) return { ok: true, label: 'GOOD' };
  return { ok: false, label: problems.join(' + ') };
}

// ── Enhancement: only when it helps ─────────────────────────────────────────
async function enhance(buf, analysis) {
  const needsUpscale = analysis.height < DISPLAY_HEIGHT_PX;
  const needsSharpen = analysis.sharpness < 80;
  if (!needsUpscale && !needsSharpen) return null;

  let img = sharp(buf);
  if (needsUpscale) {
    // Cap at 4x — beyond that we're just interpolating mush, not adding detail.
    const targetH = Math.min(DISPLAY_HEIGHT_PX, analysis.height * 4);
    img = img.resize({ height: targetH, kernel: 'lanczos3' });
  }
  if (needsSharpen) img = img.sharpen({ sigma: 0.8, m1: 0.5, m2: 1.5 }); // mild unsharp
  const out = await img.webp({ quality: 88, smartSubsample: true }).toBuffer();
  return out;
}

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg > -1 ? parseInt(process.argv[limitArg + 1]) : 40;

  console.log(`Fetching keys for ${limit} unique images from production D1…`);
  const keys = await fetchKeys(limit);
  console.log(`Got ${keys.length} unique files (deduped by physical file hash).\n`);

  fs.mkdirSync(ENHANCED_DIR, { recursive: true });
  const report = [];
  let good = 0, enhanced = 0, failed = 0;

  for (const key of keys) {
    const fileName = key.split('/').pop();
    try {
      const buf = await download(key);
      const meta = await sharp(buf).metadata();
      const sharpness = Math.round(await laplacianVariance(buf) * 10) / 10;
      const analysis = {
        key, format: meta.format, width: meta.width, height: meta.height,
        bytes: buf.length, sharpness,
      };
      const v = verdict(analysis);
      if (v.ok) good++; else {
        const out = await enhance(buf, analysis);
        if (out) {
          fs.writeFileSync(path.join(ENHANCED_DIR, fileName), out);
          const outSharpness = Math.round(await laplacianVariance(out) * 10) / 10;
          report.push({ ...analysis, verdict: v.label, enhanced: true,
            enhanced_bytes: out.length, enhanced_sharpness: outSharpness });
          enhanced++;
          console.log(`FIXED  ${fileName}  ${meta.width}×${meta.height}  sharp ${sharpness} → ${outSharpness}  ${(buf.length/1024).toFixed(0)}KB → ${(out.length/1024).toFixed(0)}KB  [${v.label}]`);
          continue;
        }
      }
      report.push({ ...analysis, verdict: v.label, enhanced: false });
      console.log(`${v.ok ? 'GOOD ' : 'SKIP '}  ${fileName}  ${meta.width}×${meta.height}  sharp ${sharpness}  ${(buf.length/1024).toFixed(0)}KB  [${v.label}]`);
    } catch (e) {
      failed++;
      report.push({ key, error: String(e.message ?? e) });
      console.log(`ERROR  ${fileName} — ${e.message}`);
    }
  }

  const outFile = 'enhanced-images/analysis-report.json';
  fs.writeFileSync(outFile, JSON.stringify({ generated: new Date().toISOString(), good, enhanced, failed, items: report }, null, 2));
  console.log(`\n════════════════════════════════════════`);
  console.log(`Analysed: ${keys.length}  |  good: ${good}  |  enhanced: ${enhanced}  |  failed: ${failed}`);
  console.log(`Enhanced copies: ./${ENHANCED_DIR}/  (originals untouched, nothing uploaded)`);
  console.log(`Report: ${outFile}`);
})();
