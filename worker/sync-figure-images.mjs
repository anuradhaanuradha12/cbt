// ─── Figure-image sync (remote → local R2) ───────────────────────────────────
// The question bank references 14k+ diagram images as
//     questions/<uuid>/q_<sha>.webp        (figure)
//     questions/<uuid>/e_<sha>.webp        (explanation figure)
// Those objects live in the DEPLOYED `cbt-media` R2 bucket, but the LOCAL dev
// R2 binding starts empty — so every diagram 404s in local dev
// (see SETUP.md §8). This script copies them down.
//
// It reads the keys straight from local D1, skips anything already present in
// local R2, fetches the bytes from the public deployed Worker
// (GET /images/<key>) and stores them locally through the dev-only ingest route
// (PUT /images/ingest/<key>) — no Cloudflare auth required.
//
// Usage:
//   node sync-figure-images.mjs --probe     # 20 images, then verify one back
//   node sync-figure-images.mjs             # full run; re-run to resume
//
// Optional: SOURCE_BASE=https://<worker>.workers.dev node sync-figure-images.mjs

import fs from 'node:fs';

const BASE = process.env.LOCAL_BASE ?? 'http://127.0.0.1:8787';
const SOURCE_BASE = process.env.SOURCE_BASE ?? 'https://cbt-worker.shishira-932.workers.dev';
const DB_DIR = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject';
const R2_DIR = '.wrangler/state/v3/r2/miniflare-R2BucketObject';
const MAP_FILE = 'figure-images-map.json';
const PROBE = process.argv.includes('--probe');
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 10);

const { DatabaseSync } = await import('node:sqlite');

const secret = fs
  .readFileSync('.dev.vars', 'utf8')
  .split('\n')
  .find((l) => l.startsWith('INGEST_SECRET='))
  ?.split('=')[1]
  ?.trim();
if (!secret) {
  console.error('INGEST_SECRET not found in worker/.dev.vars');
  process.exit(1);
}

const biggest = (dir, ext) =>
  fs
    .readdirSync(dir)
    .map((f) => dir + '/' + f)
    .filter((f) => f.endsWith(ext))
    .map((f) => ({ f, s: fs.statSync(f).size }))
    .sort((a, b) => b.s - a.s)[0]?.f;

// ── 1. Keys referenced by the question bank ──────────────────
const db = new DatabaseSync(biggest(DB_DIR, '.sqlite'), { readOnly: true });
const rows = db.prepare(
  `SELECT image_r2_key AS k FROM questions WHERE image_r2_key IS NOT NULL AND image_r2_key <> ''
   UNION
   SELECT explanation_image_r2_key AS k FROM questions
    WHERE explanation_image_r2_key IS NOT NULL AND explanation_image_r2_key <> ''`
).all();
db.close();

const allKeys = rows.map((r) => r.k);
console.log(`figure keys referenced:  ${allKeys.length.toLocaleString()}`);

// ── 2. What local R2 already has ────────────────────────────
// Read miniflare's R2 metadata directly — far cheaper than 14k HTTP HEADs.
let present = new Set();
try {
  const r2 = new DatabaseSync(biggest(R2_DIR, '.sqlite'), { readOnly: true });
  present = new Set(r2.prepare('SELECT key FROM _mf_objects').all().map((r) => r.key));
  r2.close();
} catch (e) {
  console.warn(`(could not read local R2 index: ${e.message} — will probe over HTTP)`);
}

let todo = allKeys.filter((k) => !present.has(k));
console.log(`already local:           ${(allKeys.length - todo.length).toLocaleString()}`);
console.log(`to fetch:                ${todo.length.toLocaleString()}\n`);

if (PROBE) todo = todo.slice(0, 20);

// ── 3. Copy down ────────────────────────────────────────────
const map = fs.existsSync(MAP_FILE) ? JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')) : {};
const failures = [];
let done = 0;
let ok = 0;

async function syncOne(key) {
  const url = `${SOURCE_BASE}/images/${key.split('/').map(encodeURIComponent).join('/')}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) return { key, status: 'source_fail', code: res.status };

  const buf = await res.arrayBuffer();
  if (buf.byteLength === 0) return { key, status: 'empty' };

  const type = res.headers.get('content-type') ?? '';
  if (!type.startsWith('image/')) return { key, status: 'not_image', type };

  const put = await fetch(`${BASE}/images/ingest/${key.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'PUT',
    headers: { 'X-Ingest-Secret': secret, 'Content-Type': type },
    body: buf,
  });
  if (!put.ok) return { key, status: 'put_fail', code: put.status };

  map[key] = buf.byteLength;
  return { key, status: 'ok', size: buf.byteLength };
}

const started = Date.now();
async function worker(queue) {
  while (queue.length > 0) {
    const key = queue.shift();
    try {
      const r = await syncOne(key);
      if (r.status === 'ok') ok++;
      else failures.push(r);
    } catch (e) {
      failures.push({ key, status: 'error', error: String(e?.message ?? e) });
    }
    done++;
    if (done % 250 === 0) {
      const rate = done / ((Date.now() - started) / 1000);
      console.log(`  ${done}/${todo.length}  ok=${ok} fail=${failures.length}  (${rate.toFixed(1)}/s)`);
      fs.writeFileSync(MAP_FILE, JSON.stringify(map));
    }
  }
}

// One shared queue — passing a copy per worker would duplicate every fetch.
const queue = [...todo];
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length || 1) }, () => worker(queue)));
fs.writeFileSync(MAP_FILE, JSON.stringify(map));

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\ncopied: ${ok.toLocaleString()}  failures: ${failures.length.toLocaleString()}  (${secs}s)`);
if (failures.length) {
  fs.writeFileSync('figure-images-failures.json', JSON.stringify(failures, null, 2));
  console.log('failure details → figure-images-failures.json (first 5):');
  for (const f of failures.slice(0, 5)) console.log('  ', JSON.stringify(f));
}

// ── 4. Verify one image back through the public route ───────
const sample = Object.keys(map)[0];
if (sample) {
  const res = await fetch(`${BASE}/images/${sample.split('/').map(encodeURIComponent).join('/')}`);
  console.log(`\nverify GET /images/${sample}`);
  console.log(
    `  status=${res.status} type=${res.headers.get('content-type')} bytes=${(await res.arrayBuffer()).byteLength}`
  );
}

process.exit(failures.length > 20 ? 1 : 0);
