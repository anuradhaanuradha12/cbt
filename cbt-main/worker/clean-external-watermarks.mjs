// ─── Clean MARKS watermark from external CDN images ──────────────────────────
// The external/*.png option images carry a light gray/blue "U MARKS" watermark
// baked into the source. Diagram strokes are near-black, the watermark is
// near-white (>200 brightness) — so pixels where ALL channels > THRESHOLD are
// pushed to pure white. Everything darker is preserved.
//
// Processes external-images-local/<key> in place (kept as the upload source),
// then re-ingests changed images into local R2 via the dev-server route.
//
// Usage:
//   node clean-external-watermarks.mjs --probe    # 1 image, stats only
//   node clean-external-watermarks.mjs            # full run

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const SRC_DIR = 'external-images-local';
const MAP_FILE = 'external-images-map.json';
const THRESHOLD = Number(process.env.WM_THRESHOLD ?? 205);
const PROBE = process.argv.includes('--probe');
const PROBE_KEY = process.env.PROBE_KEY ?? '';

const secret = fs.readFileSync('.dev.vars', 'utf8')
  .split('\n')
  .find((l) => l.startsWith('INGEST_SECRET='))
  ?.split('=')[1]?.trim();

const R2_SQLITE = '.wrangler/state/v3/r2/miniflare-R2BucketObject/194bbc29de3b4694bd639ccc09e5475cd2776490ad3555e45c5b55096bc5b020.sqlite';
function landedInR2(key, expectedSize) {
  const Database = require('better-sqlite3');
  const r2 = new Database(R2_SQLITE, { readonly: true });
  const row = r2.prepare('SELECT size FROM _mf_objects WHERE key = ?').get(key);
  r2.close();
  return row !== undefined && row.size === expectedSize;
}

function curlPut(file, key, type) {
  return new Promise((resolve) => {
    execFile('curl', ['-sS', '--max-time', '60', '-X', 'PUT',
      '-H', `X-Ingest-Secret: ${secret}`, '-H', `Content-Type: ${type}`,
      '--data-binary', `@${file}`, '-o', 'tmp-clean-resp.json', '-w', '%{http_code}',
      `http://127.0.0.1:8787/images/ingest/${encodeURIComponent(key)}`],
      { windowsHide: true }, (err, stdout) => resolve({ err, code: String(stdout).trim() }));
  });
}

const EXT_TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

const map = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
let entries = Object.values(map);
if (PROBE_KEY) entries = entries.filter((k) => k === PROBE_KEY);
else if (PROBE) entries = entries.slice(0, 1);
console.log(`processing ${entries.length} images (threshold ${THRESHOLD})...`);

let cleaned = 0, unchanged = 0, errors = 0, ingested = 0;
let i = 0;

for (const key of entries) {
  i++;
  const p = path.join(SRC_DIR, key);
  if (!fs.existsSync(p)) { errors++; continue; }
  const ext = key.split('.').pop();
  const type = EXT_TYPES[ext] ?? 'application/octet-stream';

  try {
    const img = sharp(p);
    const { width, height, channels } = await img.metadata();
    const raw = await img.raw().toBuffer();

    let changed = 0;
    for (let x = 0; x < raw.length; x += channels) {
      if (raw[x] > THRESHOLD && raw[x + 1] > THRESHOLD && raw[x + 2] > THRESHOLD) {
        raw[x] = 255; raw[x + 1] = 255; raw[x + 2] = 255;
        if (channels === 4) raw[x + 3] = 255;
        changed++;
      }
    }
    const changedPct = (changed / (width * height)) * 100;

    if (PROBE) {
      console.log(`probe ${key}: ${width}x${height}, ${changedPct.toFixed(1)}% pixels lightened`);
      const out = await sharp(raw, { raw: { width, height, channels } })[ext === 'jpg' ? 'jpeg' : ext === 'gif' ? 'png' : ext]().toBuffer();
      fs.writeFileSync('tmp-probe-cleaned.' + ext, out);
      console.log('cleaned sample → tmp-probe-cleaned.' + ext);
      process.exit(0);
    }

    if (changed === 0) { unchanged++; continue; }

    let out;
    if (ext === 'jpg' || ext === 'jpeg') out = await sharp(raw, { raw: { width, height, channels } }).jpeg({ quality: 92 }).toBuffer();
    else out = await sharp(raw, { raw: { width, height, channels } }).png().toBuffer();

    fs.writeFileSync(p, out);
    cleaned++;

    // re-ingest into local R2
    const { code } = await curlPut(p, key, type);
    if (code !== '200') throw new Error(`ingest ${code}`);
    await new Promise((r) => setTimeout(r, 120));
    if (!landedInR2(key, out.length)) throw new Error('did not land in R2');
    ingested++;
  } catch (e) {
    errors++;
    console.error(`ERROR ${key}: ${e.message.slice(0, 80)}`);
  }

  if (i % 200 === 0) console.log(`  ${i}/${entries.length} — cleaned ${cleaned}, unchanged ${unchanged}, errors ${errors}`);
}

console.log(`\nDONE: ${cleaned} cleaned+reingested, ${unchanged} already clean, ${errors} errors`);
if (errors > 10) process.exit(1);
