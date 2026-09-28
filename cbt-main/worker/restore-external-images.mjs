// ─── Restore external CDN images into local R2 ───────────────────────────────
// The external/<sha40>.<ext> images referenced inline by question text were
// lost from local R2. external-images-map.json maps url → key, so we can
// re-download each from the origin CDN and re-ingest via the dev-only route
// (PUT /images/ingest/<key>). Downloaded bytes are also kept in
// external-images-local/<key> for the subsequent production upload.
//
// Internet downloads use node fetch (fine for public CDNs); the local PUT to
// workerd uses curl (node fetch hangs against workerd on Windows).
//
// Usage:
//   node restore-external-images.mjs            # full run, resumes on rerun
//   node restore-external-images.mjs --probe    # 10 images, then stop

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

const BASE = 'http://127.0.0.1:8787';
const MAP_FILE = 'external-images-map.json';
const KEEP_DIR = 'external-images-local';
const PROBE = process.argv.includes('--probe');
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 10);

const secret = fs.readFileSync('.dev.vars', 'utf8')
  .split('\n')
  .find((l) => l.startsWith('INGEST_SECRET='))
  ?.split('=')[1]?.trim();
if (!secret) {
  console.error('INGEST_SECRET not found in worker/.dev.vars');
  process.exit(1);
}

const map = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
let entries = Object.entries(map); // [url, key]
console.log(`map entries: ${entries.length}`);

// resume: skip keys already present locally (kept copy = source of truth)
entries = entries.filter(([, key]) => {
  const p = path.join(KEEP_DIR, key);
  return !(fs.existsSync(p) && fs.statSync(p).size > 0);
});
console.log(`to download now: ${entries.length}`);
if (PROBE) entries = entries.slice(0, 10);

const EXT_TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

function curlPut(file, key, type) {
  return new Promise((resolve) => {
    execFile('curl', ['-sS', '--max-time', '60', '-X', 'PUT',
      '-H', `X-Ingest-Secret: ${secret}`, '-H', `Content-Type: ${type}`,
      '--data-binary', `@${file}`, '-o', '/dev/null', '-w', '%{http_code}',
      `${BASE}/images/ingest/${encodeURIComponent(key)}`],
      { windowsHide: true }, (err, stdout) => resolve({ err, code: String(stdout).trim() }));
  });
}

const R2_SQLITE = '.wrangler/state/v3/r2/miniflare-R2BucketObject/194bbc29de3b4694bd639ccc09e5475cd2776490ad3555e45c5b55096bc5b020.sqlite';
function landedInR2(key, expectedSize) {
  const Database = require('better-sqlite3');
  const r2 = new Database(R2_SQLITE, { readonly: true });
  const row = r2.prepare('SELECT size FROM _mf_objects WHERE key = ?').get(key);
  r2.close();
  return row !== undefined && row.size === expectedSize;
}

let done = 0, ok = 0, failed = 0;
const failures = [];
let idx = 0;

async function one([url, key]) {
  const dest = path.join(KEEP_DIR, key);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const dl = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!dl.ok) throw new Error(`dl ${dl.status}`);
      const type = dl.headers.get('content-type') ?? '';
      if (!type.startsWith('image/')) throw new Error(`not image (${type})`);
      const buf = Buffer.from(await dl.arrayBuffer());
      if (buf.length === 0) throw new Error('empty body');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      const ext = key.split('.').pop();
      const { code } = await curlPut(dest, key, EXT_TYPES[ext] ?? 'application/octet-stream');
      if (code !== '200' && code !== '000') throw new Error(`ingest ${code}`);
      // curl may report a write error on the (truncated) response body while
      // the PUT itself succeeded — verify via the R2 index instead
      await new Promise((r) => setTimeout(r, 150));
      if (!landedInR2(key, buf.length)) throw new Error('ingest did not land in R2 index');
      ok++;
      return;
    } catch (e) {
      if (attempt === 3) {
        failed++;
        failures.push({ url, key, error: e.message });
      } else {
        await new Promise((r) => setTimeout(r, 600 * attempt));
      }
    }
  }
}

async function worker() {
  while (idx < entries.length) {
    const item = entries[idx++];
    await one(item);
    done++;
    if (done % 100 === 0) console.log(`  ${done}/${entries.length}  ok=${ok} fail=${failed}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

console.log(`\nRESTORE DONE: ${ok} restored, ${failed} failed (of ${entries.length})`);
if (failures.length) {
  fs.writeFileSync('external-restore-failures.json', JSON.stringify(failures, null, 2));
  console.log(`failure details → external-restore-failures.json (first 5):`);
  for (const f of failures.slice(0, 5)) console.log('  ', JSON.stringify(f));
  process.exit(1);
}
