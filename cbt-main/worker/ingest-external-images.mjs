// ─── CDN image ingest ────────────────────────────────────────────────────────
// Downloads every image referenced by an "[IMAGE: https://…]" marker in the
// question bank from the public CDN and stores it in the LOCAL R2 bucket via
// the Worker's dev-only ingest route (PUT /images/ingest/<key>).
//
// Keys are content-addressed (sha-256 of the URL), extension preserved, all
// under the "external/" prefix so they never collide with native
// "questions/<uuid>/…" objects. The url→key map is written to
// external-images-map.json so the marker-rewrite pass can run offline later.
//
// Usage:
//   node ingest-external-images.mjs --probe     # 10 images, then verify
//   node ingest-external-images.mjs             # full run, resumes on rerun
//
// Requires the dev server on :8787 with INGEST_SECRET in worker/.dev.vars.

import crypto from 'node:crypto';
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:8787';
const DB_FILE = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject/82ed3d9ff502f7382874778df6ecb14db42da56def327314e2a27be609632375.sqlite';
const MAP_FILE = 'external-images-map.json';
const PROBE = process.argv.includes('--probe');
const CONCURRENCY = 12;

const { DatabaseSync } = await import('node:sqlite');
const secret = fs.readFileSync('.dev.vars', 'utf8')
  .split('\n')
  .find((l) => l.startsWith('INGEST_SECRET='))
  ?.split('=')[1]?.trim();
if (!secret) {
  console.error('INGEST_SECRET not found in worker/.dev.vars');
  process.exit(1);
}

// ── Collect URLs from the DB ─────────────────────────────────
const db = new DatabaseSync(DB_FILE, { readOnly: true });
const FIELDS = ['question_text', 'option_a', 'option_b', 'option_c', 'option_d', 'explanation'];
const rows = db.prepare(`SELECT id, ${FIELDS.join(', ')} FROM questions`).all();
db.close();

const urls = new Set();
const MARKER = /\[IMAGE:\s*(https?:\/\/[^\]\s]+)\s*\]/g;
for (const row of rows) {
  for (const f of FIELDS) {
    const v = row[f];
    if (typeof v !== 'string') continue;
    let m;
    MARKER.lastIndex = 0;
    while ((m = MARKER.exec(v)) !== null) urls.add(m[1]);
  }
}

const all = [...urls];
console.log(`unique CDN images referenced: ${all.length.toLocaleString()}`);

// ── Resume support ───────────────────────────────────────────
const map = fs.existsSync(MAP_FILE) ? JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')) : {};
console.log(`already ingested (map):       ${Object.keys(map).length.toLocaleString()}`);

const urlToKey = (url) => {
  const hash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 40);
  const extMatch = url.match(/\.(png|jpe?g|gif|webp)(?:\?|$)/i);
  const ext = extMatch ? extMatch[1].toLowerCase().replace('jpeg', 'jpg') : 'png';
  return `external/${hash}.${ext}`;
};

const EXT_TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

async function ingestOne(url) {
  const key = urlToKey(url);
  if (map[url] === key) return { url, key, status: 'skipped' };

  // 1. Download from the CDN.
  const dl = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!dl.ok) return { url, key, status: 'dl_fail', code: dl.status };
  const buf = await dl.arrayBuffer();
  if (buf.byteLength === 0) return { url, key, status: 'dl_empty' };

  // 2. Sanity: must actually be an image, not an error page.
  const type = dl.headers.get('content-type') ?? '';
  if (!type.startsWith('image/')) return { url, key, status: 'not_image', type };

  // 3. Push into local R2 through the ingest route.
  const put = await fetch(`${BASE}/images/ingest/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'X-Ingest-Secret': secret, 'Content-Type': type },
    body: buf,
  });
  if (!put.ok) return { url, key, status: 'put_fail', code: put.status };

  map[url] = key;
  return { url, key, status: 'ok', size: buf.byteLength };
}

// ── Runner with bounded concurrency ──────────────────────────
async function run(list) {
  const failures = [];
  let done = 0;
  let ok = 0;
  const started = Date.now();

  async function worker(queue) {
    while (queue.length > 0) {
      const url = queue.shift();
      try {
        const r = await ingestOne(url);
        if (r.status === 'ok') ok++;
        if (['dl_fail', 'dl_empty', 'not_image', 'put_fail'].includes(r.status)) {
          failures.push(r);
        }
      } catch (e) {
        failures.push({ url, status: 'error', error: String(e.message || e) });
      }
      done++;
      if (done % 100 === 0) {
        const rate = done / ((Date.now() - started) / 1000);
        console.log(`  ${done}/${list.length}  ok=${ok} fail=${failures.length}  (${rate.toFixed(1)}/s)`);
        fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 2));
      }
    }
  }

  const queue = [...list];
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));

  fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 2));
  return { done, ok, failures };
}

const target = PROBE ? all.slice(0, 10) : all.filter((u) => !map[u]);
console.log(`to ingest now: ${target.length.toLocaleString()}\n`);

const { ok, failures } = await run(target);

console.log(`\ningested: ${ok.toLocaleString()}, failures: ${failures.length.toLocaleString()}`);
if (failures.length > 0) {
  fs.writeFileSync('external-images-failures.json', JSON.stringify(failures, null, 2));
  console.log(`failure details → external-images-failures.json (first 5):`);
  for (const f of failures.slice(0, 5)) console.log('  ', JSON.stringify(f));
}

// ── Verify: read one image back through the public route ─────
if (ok > 0 || PROBE) {
  const sample = Object.entries(map)[0];
  if (sample) {
    const res = await fetch(`${BASE}/images/${sample[1]}`);
    console.log(`\nverify GET /images/${sample[1]}`);
    console.log(`  status=${res.status} type=${res.headers.get('content-type')} bytes=${(await res.arrayBuffer()).byteLength}`);
  }
}

process.exit(failures.length > 5 ? 1 : 0);
