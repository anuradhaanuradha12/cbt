/**
 * make-comparison.mjs — Builds a visual before/after page from analysis-report.json.
 * Downloads each original from R2 (read-only) next to its enhanced copy and emits
 * enhanced-images/comparison.html showing both at exam display size (256px tall).
 *
 * Usage (from worker/):  node make-comparison.mjs
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'node:child_process';

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '9325072bdbc32761b8550ef602ebf81e';
process.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT_ID;
const R2_BUCKET = 'cbt-media';
const DIR = 'enhanced-images';

const report = JSON.parse(fs.readFileSync(path.join(DIR, 'analysis-report.json'), 'utf8'));
const items = report.items.filter(i => !i.error && i.enhanced);
console.log(`Building comparison for ${items.length} enhanced images…`);

const origDir = path.join(DIR, 'originals');
fs.mkdirSync(origDir, { recursive: true });

let ok = 0;
for (const item of items) {
  const hash = item.key.split('/').pop();
  const dest = path.join(origDir, hash);
  if (!fs.existsSync(dest)) {
    try {
      execSync(`npx wrangler r2 object get "${R2_BUCKET}/${item.key}" --pipe > "${dest}"`,
        { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      console.log(`SKIP ${hash} — download failed`);
      continue;
    }
  }
  ok++;
}

const rows = items.filter(i => fs.existsSync(path.join(origDir, i.key.split('/').pop()))).map(i => {
  const hash = i.key.split('/').pop();
  return `
  <div class="card">
    <div class="meta">
      <b>${hash.slice(0, 12)}…</b> · ${i.width}×${i.height}px · ${(i.bytes / 1024).toFixed(1)}KB → ${(i.enhanced_bytes / 1024).toFixed(1)}KB
      <span class="verdict">${i.verdict}</span>
    </div>
    <div class="pair">
      <figure>
        <img src="originals/${hash}" style="height:256px" />
        <figcaption>ORIGINAL (${i.width}×${i.height})</figcaption>
      </figure>
      <figure>
        <img src="${hash}" style="height:256px" />
        <figcaption>ENHANCED (lanczos ×≤4 + unsharp)</figcaption>
      </figure>
    </div>
  </div>`;
}).join('\n');

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>QForge image quality — before/after</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; padding: 24px; }
  h1 { font-size: 18px; } p { color: #94a3b8; font-size: 13px; }
  .card { background: #1e293b; border-radius: 12px; padding: 14px; margin-bottom: 16px; }
  .meta { font-size: 12px; color: #94a3b8; margin-bottom: 10px; }
  .verdict { background: #7c2d12; color: #fdba74; padding: 2px 8px; border-radius: 6px; font-size: 11px; }
  .pair { display: flex; gap: 16px; flex-wrap: wrap; }
  figure { margin: 0; text-align: center; }
  figcaption { font-size: 11px; color: #64748b; margin-top: 6px; letter-spacing: 1px; }
  img { border-radius: 8px; background: #fff; }
</style></head>
<body>
  <h1>Question images — original vs enhanced (${items.length} sampled, ${report.good} were already good)</h1>
  <p>Rendered at exam display size (256 CSS px, like the exam UI's max-height). Originals are untouched in R2.</p>
  ${rows}
</body></html>`;

fs.writeFileSync(path.join(DIR, 'comparison.html'), html);
console.log(`Done: ${ok} originals downloaded → ${DIR}/comparison.html`);
