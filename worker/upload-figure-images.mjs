// ─── Upload regenerated figure images to production cbt-media ────────────────
// Source of truth: local miniflare R2 blob files, keyed via the sqlite index
// (.wrangler/state/v3/r2/miniflare-R2BucketObject/194bbc29...sqlite).
// (sqlite.size + figure-images-map.json hold STALE pre-regeneration sizes —
// do not trust them for validation; the blob files are the real bytes.)
//
// Sync algorithm:
//   1. List all remote objects in cbt-media (paginated, 1000/page).
//   2. For each local key: skip if remote exists with same size AND
//      (etag == md5hex  OR  --deep verifies remote md5 == local md5).
//   3. Otherwise PUT via curl (Content-Type: image/webp), retry x5.
//   4. --verify: re-list everything and md5-check every uploaded key.
//
// Usage:
//   node upload-figure-images.mjs --dry        # report planned changes only
//   node upload-figure-images.mjs              # upload what differs
//   node upload-figure-images.mjs --verify     # full remote md5 verification
//   node upload-figure-images.mjs --deep       # md5-compare before skipping

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';

const ACCOUNT_ID = '9325072bdbc32761b8550ef602ebf81e';
const BUCKET = 'cbt-media';
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${BUCKET}/objects`;
const SQLITE = '.wrangler/state/v3/r2/miniflare-R2BucketObject/194bbc29de3b4694bd639ccc09e5475cd2776490ad3555e45c5b55096bc5b020.sqlite';
const BLOB_DIR = '.wrangler/state/v3/r2/cbt-media/blobs';
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 4);
const DRY = process.argv.includes('--dry');
const VERIFY = process.argv.includes('--verify');
const DEEP = process.argv.includes('--deep');
const STATE_FILE = 'tmp-upload-state.json';

const tomlPath = process.env.APPDATA + '/xdg.config/.wrangler/config/default.toml';
let TOKEN = fs.readFileSync(tomlPath, 'utf8').match(/oauth_token\s*=\s*"([^"]+)"/)[1];

function curl(args) {
  // re-read token on every request so a background `wrangler login`-driven
  // refresh (which rewrites default.toml) is picked up mid-run
  try {
    TOKEN = fs.readFileSync(tomlPath, 'utf8').match(/oauth_token\s*=\s*"([^"]+)"/)[1];
  } catch {}
  return new Promise((resolve) => {
    execFile('curl', ['-sS', '--max-time', '300', '-H', `Authorization: Bearer ${TOKEN}`, ...args], {
      windowsHide: true,
      maxBuffer: 256 * 1024 * 1024,
    }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  });
}

async function listAllRemote() {
  const remote = new Map(); // key -> {size, etag}
  let cursor = '';
  let pages = 0;
  do {
    const url = `${API}?per_page=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const { err, stdout } = await curl(['-o', '-', url]);
    if (err) throw new Error(`list failed: ${err.message}`);
    const j = JSON.parse(stdout);
    if (!j.success) throw new Error(`list API error: ${JSON.stringify(j.errors)}`);
    for (const o of j.result) remote.set(o.key, { size: o.size, etag: o.etag });
    const info = j.result_info ?? {};
    cursor = info.is_truncated ? info.cursor : '';
    pages++;
    if (pages % 5 === 0) console.log(`  listed ${remote.size} objects (${pages} pages)...`);
  } while (cursor);
  return remote;
}

// ── load local objects ──────────────────────────────────────────────────────
const Database = (await import('better-sqlite3')).default;
const db = new Database(SQLITE, { readonly: true });
const rows = db.prepare('SELECT key, blob_id, size FROM _mf_objects ORDER BY key').all();
db.close();

const local = new Map();
let noBlob = 0;
for (const r of rows) {
  const p = path.join(BLOB_DIR, r.blob_id);
  if (!fs.existsSync(p)) { noBlob++; continue; }
  const buf = fs.readFileSync(p);
  local.set(r.key, { buf, md5: crypto.createHash('md5').update(buf).digest('hex') });
}
console.log(`local: ${local.size} objects with blobs (${noBlob} missing blob files)`);
if (noBlob > 0 && !VERIFY) process.exit(1);

// ── verify mode ──────────────────────────────────────────────────────────────
if (VERIFY) {
  console.log('listing remote...');
  const remote = await listAllRemote();
  const uploadedKeys = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).uploaded;
  console.log(`remote has ${remote.size} objects; verifying ${uploadedKeys.length} uploaded keys by md5...`);
  let ok = 0, bad = 0, missing = 0, errors = 0;
  let i = 0;
  for (const key of uploadedKeys) {
    i++;
    const enc = encodeURIComponent(key);
    const tmp = `tmp-verify-${i}.bin`;
    const { err, stdout } = await curl(['-o', tmp, '-w', '%{http_code}', `${API}/${enc}`]);
    const code = String(stdout).trim();
    if (code === '404') { missing++; console.log(`MISSING ${key}`); fs.unlinkSync(tmp); continue; }
    if (code !== '200' || err) { errors++; console.log(`ERROR ${code} ${key}`); if (fs.existsSync(tmp)) fs.unlinkSync(tmp); continue; }
    const buf = fs.readFileSync(tmp);
    fs.unlinkSync(tmp);
    const localMd5 = local.get(key)?.md5;
    if (crypto.createHash('md5').update(buf).digest('hex') === localMd5) ok++;
    else { bad++; console.log(`MISMATCH ${key} remote=${buf.length}B`); }
    if (i % 500 === 0) console.log(`  verified ${i}/${uploadedKeys.length}`);
  }
  console.log(`\nVERIFY RESULT: ${ok} ok, ${bad} mismatched, ${missing} missing, ${errors} errors (of ${uploadedKeys.length} uploaded)`);
  if (bad || missing || errors) process.exit(1);
  process.exit(0);
}

// ── upload mode ──────────────────────────────────────────────────────────────
console.log('listing remote...');
const remote = await listAllRemote();
console.log(`remote: ${remote.size} objects`);

let alreadyOk = 0, sizeDiff = 0, notOnRemote = 0, deepCheckSkipped = 0, deepCheckChanged = 0;
const toUpload = [];

for (const [key, { buf, md5 }] of local) {
  const r = remote.get(key);
  if (!r) {
    notOnRemote++;
    toUpload.push(key);
    continue;
  }
  if (r.size !== buf.length) {
    sizeDiff++;
    toUpload.push(key);
    continue;
  }
  if (DEEP && r.etag !== md5) {
    // same size, different etag — could be multipart etag; verify real md5
    const tmp = `tmp-deepcheck.bin`;
    const { stdout } = await curl(['-o', tmp, '-w', '%{http_code}', `${API}/${encodeURIComponent(key)}`]);
    const code = String(stdout).trim();
    if (code === '200') {
      const remoteMd5 = crypto.createHash('md5').update(fs.readFileSync(tmp)).digest('hex');
      fs.unlinkSync(tmp);
      if (remoteMd5 !== md5) { deepCheckChanged++; toUpload.push(key); continue; }
    } else {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
    deepCheckSkipped++;
  }
  alreadyOk++;
}

console.log(`\nPLAN: ${toUpload.length} to upload (${notOnRemote} new, ${sizeDiff} size-diff, ${deepCheckChanged} deep-check-diff), ${alreadyOk} already identical${DEEP ? '' : ' (size-only check; run --verify after for full md5 proof)'}`);
if (DRY) process.exit(0);

// resume support (load BEFORE initializing the state file)
let uploaded = [];
if (fs.existsSync(STATE_FILE)) {
  try { uploaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).uploaded ?? []; } catch { uploaded = []; }
} else {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ uploaded: [] }));
}
const uploadedSet = new Set(uploaded);
const queue = toUpload.filter((k) => !uploadedSet.has(k));
console.log(`uploading ${queue.length} objects (skipping ${uploadedSet.size} already uploaded this run)...`);

let done = 0, failed = 0;
const failures = [];
let idx = 0;

// global pacing: minimum interval between PUT starts (429 prevention)
let lastStart = 0;
const MIN_GAP = Number(process.env.MIN_GAP_MS ?? 150);
async function pace() {
  const now = Date.now();
  const wait = lastStart + MIN_GAP - now;
  if (wait > 0) {
    lastStart += MIN_GAP;
    await new Promise((r) => setTimeout(r, wait));
  } else {
    lastStart = now;
  }
}

async function uploadOne(key) {
  const { buf } = local.get(key);
  const tmp = `tmp-put-${crypto.randomBytes(4).toString('hex')}.bin`;
  fs.writeFileSync(tmp, buf);
  const enc = encodeURIComponent(key);
  let attempt = 0;
  let rateHits = 0;
  while (attempt < 9) {
    attempt++;
    await pace();
    const { err, stdout } = await curl(['-X', 'PUT', '-H', 'Content-Type: image/webp', '--data-binary', `@${tmp}`, '-o', tmp + '.resp', '-w', '%{http_code}', `${API}/${enc}`]);
    const code = String(stdout).trim();
    if (!err && code === '200') {
      try {
        const j = JSON.parse(fs.readFileSync(tmp + '.resp', 'utf8'));
        const remoteSize = Number(j.result?.size ?? -1);
        fs.unlinkSync(tmp); fs.unlinkSync(tmp + '.resp');
        if (remoteSize === buf.length) return true;
        // size mismatch after put — fall through to retry
      } catch {
        fs.unlinkSync(tmp); fs.unlinkSync(tmp + '.resp');
        return true; // 200 but unparsable body; accept, verify pass will catch
      }
    } else {
      if (fs.existsSync(tmp + '.resp')) fs.unlinkSync(tmp + '.resp');
    }
    if (code === '429') {
      rateHits++;
      if (rateHits > 5) break;
      const waitMs = Math.min(300000, 30000 * Math.pow(2, rateHits - 1));
      console.log(`429 rate-limited on ${key.slice(-40)} — backing off ${waitMs / 1000}s`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    if (attempt >= 5) break; // generic failure budget
    await new Promise((r) => setTimeout(r, 800 * attempt));
  }
  try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  failed++;
  failures.push(key);
  console.error(`FAILED after ${attempt} attempts: ${key}`);
  return false;
}

async function worker() {
  while (idx < queue.length) {
    const key = queue[idx++];
    const ok = await uploadOne(key);
    if (ok) {
      uploaded.push(key);
      uploadedSet.add(key);
      if (uploaded.length % 25 === 0) {
        fs.writeFileSync(STATE_FILE, JSON.stringify({ uploaded }));
        console.log(`progress: ${uploaded.length}/${toUpload.length} uploaded (${failed} failed)`);
      }
    }
    done++;
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

fs.writeFileSync(STATE_FILE, JSON.stringify({ uploaded }));
console.log(`\nUPLOAD DONE: ${uploaded.length} uploaded, ${failed} failed`);
if (failures.length) {
  console.log('failed keys:');
  for (const f of failures.slice(0, 50)) console.log('  ' + f);
  process.exit(1);
}
console.log('run `node upload-figure-images.mjs --verify` for full md5 verification');
