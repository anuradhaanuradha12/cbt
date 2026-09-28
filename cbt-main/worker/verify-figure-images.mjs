// ─── Verify figure images: local blobs vs remote cbt-media ──────────────────
// Lists the whole bucket once (paginated) and, for every local key, checks:
//   - object exists remotely
//   - remote size == local blob size
//   - remote etag == local md5 hex (R2 single-part PUT etag is the MD5)
// Much cheaper than GET-per-key: ~31 API calls total.
//
// Usage: node verify-figure-images.mjs

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';

const ACCOUNT_ID = '9325072bdbc32761b8550ef602ebf81e';
const BUCKET = 'cbt-media';
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${BUCKET}/objects`;
const SQLITE = '.wrangler/state/v3/r2/miniflare-R2BucketObject/194bbc29de3b4694bd639ccc09e5475cd2776490ad3555e45c5b55096bc5b020.sqlite';
const BLOB_DIR = '.wrangler/state/v3/r2/cbt-media/blobs';

const tomlPath = process.env.APPDATA + '/xdg.config/.wrangler/config/default.toml';
const TOKEN = fs.readFileSync(tomlPath, 'utf8').match(/oauth_token\s*=\s*"([^"]+)"/)[1];

function curl(url) {
  return new Promise((resolve) => {
    execFile('curl', ['-sS', '--max-time', '120', '-H', `Authorization: Bearer ${TOKEN}`, url],
      { windowsHide: true, maxBuffer: 256 * 1024 * 1024 },
      (err, stdout) => resolve({ err, stdout }));
  });
}

// local
const Database = (await import('better-sqlite3')).default;
const db = new Database(SQLITE, { readonly: true });
const rows = db.prepare('SELECT key, blob_id FROM _mf_objects ORDER BY key').all();
db.close();
const local = new Map();
for (const r of rows) {
  const buf = fs.readFileSync(path.join(BLOB_DIR, r.blob_id));
  local.set(r.key, { size: buf.length, md5: crypto.createHash('md5').update(buf).digest('hex') });
}
console.log(`local objects: ${local.size}`);

// remote (paginated)
const remote = new Map();
let cursor = '';
let pages = 0;
do {
  const url = `${API}?per_page=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
  const { err, stdout } = await curl(url);
  if (err) throw new Error(`list failed: ${err.message}`);
  const j = JSON.parse(stdout);
  if (!j.success) throw new Error(`list API error: ${JSON.stringify(j.errors)}`);
  for (const o of j.result) remote.set(o.key, { size: o.size, etag: o.etag });
  const info = j.result_info ?? {};
  cursor = info.is_truncated ? info.cursor : '';
  pages++;
  if (pages % 10 === 0) console.log(`  listed ${remote.size} (${pages} pages)...`);
} while (cursor);
console.log(`remote objects: ${remote.size} (${pages} pages)\n`);

let ok = 0, missing = 0, sizeDiff = 0, etagDiff = 0;
const problems = [];
for (const [key, { size, md5 }] of local) {
  const r = remote.get(key);
  if (!r) { missing++; problems.push(`MISSING ${key}`); continue; }
  if (r.size !== size) { sizeDiff++; problems.push(`SIZE local=${size} remote=${r.size} ${key}`); continue; }
  if (r.etag !== md5) { etagDiff++; problems.push(`ETAG local=${md5.slice(0, 8)} remote=${r.etag.slice(0, 8)} ${key}`); continue; }
  ok++;
}

console.log(`VERIFY: ${ok} ok, ${missing} missing, ${sizeDiff} size-diff, ${etagDiff} etag-diff (of ${local.size})`);
if (problems.length) {
  fs.writeFileSync('tmp-verify-problems.txt', problems.join('\n'));
  console.log(`${problems.length} problems written to tmp-verify-problems.txt (first 20):`);
  for (const p of problems.slice(0, 20)) console.log('  ' + p);
  process.exit(1);
}
console.log('ALL FIGURE IMAGES VERIFIED ✅');
