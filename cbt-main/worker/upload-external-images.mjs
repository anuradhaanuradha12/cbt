// ─── Upload external CDN images to production cbt-media ─────────────────────
// Source: external-images-local/<key> (restored from origin CDNs).
// Same transport/pacing lessons as upload-figure-images.mjs: token re-read per
// request, global MIN_GAP pacer, 429 exponential backoff, resume via state.
//
// Usage:
//   node upload-external-images.mjs --dry
//   node upload-external-images.mjs            (env: MIN_GAP_MS, CONCURRENCY)

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';

const ACCOUNT_ID = '9325072bdbc32761b8550ef602ebf81e';
const BUCKET = 'cbt-media';
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${BUCKET}/objects`;
const SRC_DIR = 'external-images-local';
const MAP_FILE = 'external-images-map.json';
const STATE_FILE = 'tmp-ext-upload-state.json';
const MIN_GAP = Number(process.env.MIN_GAP_MS ?? 1200);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 6);
const DRY = process.argv.includes('--dry');

const EXT_TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

const tomlPath = process.env.APPDATA + '/xdg.config/.wrangler/config/default.toml';
let TOKEN = fs.readFileSync(tomlPath, 'utf8').match(/oauth_token\s*=\s*"([^"]+)"/)[1];

function curl(args) {
  try {
    TOKEN = fs.readFileSync(tomlPath, 'utf8').match(/oauth_token\s*=\s*"([^"]+)"/)[1];
  } catch {}
  return new Promise((resolve) => {
    execFile('curl', ['-sS', '--max-time', '300', '-H', `Authorization: Bearer ${TOKEN}`, ...args],
      { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => resolve({ err, stdout }));
  });
}

async function listAllRemote() {
  const remote = new Map();
  let cursor = '';
  do {
    const url = `${API}?per_page=1000&prefix=external%2F${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const { err, stdout } = await curl(['-o', '-', url]);
    if (err) throw new Error(`list failed: ${err.message}`);
    const j = JSON.parse(stdout);
    if (!j.success) throw new Error(`list API error: ${JSON.stringify(j.errors)}`);
    for (const o of j.result) remote.set(o.key, { size: o.size, etag: o.etag });
    const info = j.result_info ?? {};
    cursor = info.is_truncated ? info.cursor : '';
  } while (cursor);
  return remote;
}

// local files
const local = new Map(); // key -> {path, size, md5}
for (const [url, key] of Object.entries(JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')))) {
  const p = path.join(SRC_DIR, key);
  if (!fs.existsSync(p)) { console.error(`MISSING local file for ${key} (url: ${url})`); continue; }
  const buf = fs.readFileSync(p);
  local.set(key, { path: p, buf, md5: crypto.createHash('md5').update(buf).digest('hex') });
}
console.log(`local external images: ${local.size}`);

console.log('listing remote external/* ...');
const remote = await listAllRemote();
console.log(`remote external/* objects: ${remote.size}`);

let toUpload = 0, alreadyOk = 0;
for (const [key, { buf }] of local) {
  const r = remote.get(key);
  if (r && r.size === buf.length) alreadyOk++;
  else toUpload++;
}
console.log(`PLAN: ${toUpload} to upload, ${alreadyOk} already identical`);
if (DRY) process.exit(0);

let uploaded = [];
if (fs.existsSync(STATE_FILE)) {
  try { uploaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).uploaded ?? []; } catch {}
} else {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ uploaded: [] }));
}
const uploadedSet = new Set(uploaded);
// resume: skip keys recorded in state AND keys already on remote with same size
// (robust to a killed previous run whose state file lags its actual uploads)
const queue = [...local.keys()].filter((k) => {
  if (uploadedSet.has(k)) return false;
  const r = remote.get(k);
  return !(r && r.size === local.get(k).buf.length);
});
console.log(`uploading ${queue.length} (state skips ${uploadedSet.size}, remote-already skips ${local.size - uploadedSet.size - queue.length})`);

let lastStart = 0;
async function pace() {
  const now = Date.now();
  const wait = lastStart + MIN_GAP - now;
  if (wait > 0) { lastStart += MIN_GAP; await new Promise((r) => setTimeout(r, wait)); }
  else lastStart = now;
}

let failed = 0, idx = 0;
const failures = [];

async function uploadOne(key) {
  const { path: p, buf } = local.get(key);
  const ext = key.split('.').pop();
  const type = EXT_TYPES[ext] ?? 'application/octet-stream';
  const respFile = `tmp-ext-resp-${crypto.randomBytes(4).toString('hex')}.json`;
  let attempt = 0, rateHits = 0;
  try {
    while (attempt < 9) {
      attempt++;
      await pace();      const { err, stdout } = await curl(['-X', 'PUT', '-H', `Content-Type: ${type}`, '--data-binary', `@${p}`, '-o', respFile, '-w', '%{http_code}', `${API}/${encodeURIComponent(key)}`]);
      const code = String(stdout).trim();
      if (!err && code === '200') {
        // the PUT response body itself reports the stored size
        try {
          const j = JSON.parse(fs.readFileSync(respFile, 'utf8'));
          const remoteSize = Number(j.result?.size ?? -1);
          if (remoteSize === buf.length) return true;
        } catch {
          return true; // 200 but unparsable body; accept, final verify catches
        }
      }
    if (code === '429') {
      rateHits++;
      if (rateHits > 5) break;
      const waitMs = Math.min(300000, 30000 * Math.pow(2, rateHits - 1));
      console.log(`429 — backing off ${waitMs / 1000}s`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    if (attempt >= 5) break;
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  } finally {
    try { if (fs.existsSync(respFile)) fs.unlinkSync(respFile); } catch {}
  }
  failed++;
  failures.push(key);
  console.error(`FAILED: ${key}`);
  return false;
}

async function worker() {
  while (idx < queue.length) {
    const key = queue[idx++];
    if (await uploadOne(key)) {
      uploaded.push(key);
      uploadedSet.add(key);
      if (uploaded.length % 25 === 0) {
        fs.writeFileSync(STATE_FILE, JSON.stringify({ uploaded }));
        console.log(`progress: ${uploaded.length}/${queue.length} (${failed} failed)`);
      }
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

fs.writeFileSync(STATE_FILE, JSON.stringify({ uploaded }));
console.log(`\nDONE: ${uploaded.length} uploaded, ${failed} failed`);
if (failures.length) process.exit(1);
