// ─── Audit: production D1 referenced image keys vs production R2 objects ─────
// Finds every image key that production D1 references but production R2 does
// not have (i.e., the actually-broken images users see), and checks whether
// local R2 can supply them.
//
// Usage: node audit-prod-image-keys.mjs

import fs from 'node:fs';
import { execFile } from 'node:child_process';

const ACCOUNT_ID = '9325072bdbc32761b8550ef602ebf81e';
const DB_ID = '220c5793-3f10-460a-b5fc-8f3223feee43';
const R2_API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/cbt-media/objects`;
const D1_API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DB_ID}/query`;
const LOCAL_R2_SQLITE = '.wrangler/state/v3/r2/miniflare-R2BucketObject/194bbc29de3b4694bd639ccc09e5475cd2776490ad3555e45c5b55096bc5b55096bc5b020.sqlite';

const tomlPath = process.env.APPDATA + '/xdg.config/.wrangler/config/default.toml';
const TOKEN = fs.readFileSync(tomlPath, 'utf8').match(/oauth_token\s*=\s*"([^"]+)"/)[1];

function curlJson(url, body = null) {
  return new Promise((resolve, reject) => {
    const args = ['-sS', '--max-time', '120', '-H', `Authorization: Bearer ${TOKEN}`];
    if (body) args.push('-X', 'POST', '-H', 'Content-Type: application/json', '--data', JSON.stringify(body));
    args.push(url);
    execFile('curl', args, { windowsHide: true, maxBuffer: 256 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error('bad json: ' + stdout.slice(0, 200))); }
    });
  });
}

// ── 1. All image keys referenced by production D1 ────────────────────────────
console.log('querying production D1 for referenced keys...');
const q = await curlJson(D1_API, {
  sql: `SELECT image_r2_key AS k FROM questions WHERE image_r2_key IS NOT NULL AND image_r2_key <> ''
        UNION SELECT explanation_image_r2_key FROM questions WHERE explanation_image_r2_key IS NOT NULL AND explanation_image_r2_key <> ''`,
});
if (q.errors?.length) throw new Error('D1 error: ' + JSON.stringify(q.errors));
const referenced = new Set(q.result[0].results.map((r) => r.k));
console.log('production D1 references', referenced.size, 'distinct image keys');

// inline external/* refs in text fields
const q2 = await curlJson(D1_API, {
  sql: `SELECT question_text, explanation FROM questions
        WHERE question_text LIKE '%/images/external/%' OR explanation LIKE '%/images/external/%'`,
});
if (q2.errors?.length) throw new Error('D1 error: ' + JSON.stringify(q2.errors));
const re = /\/images\/(external\/[0-9a-f]{40}\.(?:png|jpg|jpeg|gif|webp))/gi;
const inline = new Set();
for (const r of q2.result[0].results) {
  for (const v of [r.question_text, r.explanation]) {
    if (typeof v !== 'string') continue;
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(v)) !== null) inline.add(m[1]);
  }
}
console.log('plus', inline.size, 'distinct inline external/* keys');
const all = new Set([...referenced, ...inline]);
console.log('total referenced:', all.size);

// ── 2. All keys in production R2 ─────────────────────────────────────────────
console.log('listing production R2...');
const remote = new Set();
let cursor = '';
do {
  const url = `${R2_API}?per_page=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
  const j = await curlJson(url);
  if (j.errors?.length) throw new Error('R2 error: ' + JSON.stringify(j.errors));
  for (const o of j.result) remote.add(o.key);
  const info = j.result_info ?? {};
  cursor = info.is_truncated ? info.cursor : '';
  process.stdout.write(`  ${remote.size}\r`);
} while (cursor);
console.log('\nproduction R2 has', remote.size, 'objects');

// ── 3. Diff ──────────────────────────────────────────────────────────────────
const missing = [...all].filter((k) => !remote.has(k));
console.log('\nMISSING FROM PRODUCTION R2:', missing.length);
for (const k of missing.slice(0, 20)) console.log('  ', k);

// ── 4. Can local R2 supply them? ─────────────────────────────────────────────
if (missing.length) {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database('.wrangler/state/v3/r2/miniflare-R2BucketObject/194bbc29de3b4694bd639ccc09e5475cd2776490ad3555e45c5b55096bc5b020.sqlite', { readonly: true });
  const stmt = db.prepare('SELECT key FROM _mf_objects WHERE key = ?');
  const repairable = missing.filter((k) => stmt.get(k));
  console.log('repairable from local R2:', repairable.length, '/', missing.length);
  fs.writeFileSync('tmp-prod-missing-keys.json', JSON.stringify({ missing, repairable }, null, 2));
  console.log('details → tmp-prod-missing-keys.json');
  db.close();
} else {
  console.log('✅ every referenced key exists in production R2');
}
