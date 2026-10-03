/**
 * enhance-all.mjs — Full-batch image enhancement + production deploy (REST edition).
 *
 * Talks straight to the Cloudflare REST API using wrangler's own OAuth token
 * (the same token/endpoints wrangler uses internally) — no per-object process
 * spawns, no dev session needed.
 *
 * Phases (in order, resumable — progress in enhanced-images/all-state.json):
 *   fetch    Pull every image key (question + explanation) from production D1, dedupe by file hash.
 *   process  Download each unique image from R2 (read-only), enhance if needed, save locally.
 *   upload   PUT enhanced copies in R2 under `enhanced/<original-key>`.
 *   swap     Point D1 references at the enhanced keys (map table + set-based updates; rollback SQL saved first).
 *   verify   Count remaining unswapped references.
 *
 * Safety:
 *   - Original objects are NEVER modified or deleted.
 *   - Rollback SQL is written BEFORE the swap is applied.
 *   - Every phase checkpoints; re-running resumes.
 *
 * Usage (from worker/):  node enhance-all.mjs [--phase fetch|process|upload|swap|verify|all]
 */

import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '9325072bdbc32761b8550ef602ebf81e';
const R2_BUCKET = 'cbt-media';
const DB_ID = '220c5793-3f10-460a-b5fc-8f3223feee43';
const CF_API = 'https://api.cloudflare.com/client/v4';

const WORK = 'enhanced-images';
const ALL_DIR = path.join(WORK, 'all');
const STATE_FILE = path.join(WORK, 'all-state.json');
const ROLLBACK_DIR = path.join(WORK, 'rollback');
const CONCURRENCY = 8;
const DISPLAY_HEIGHT_PX = 768;
const ENHANCED_PREFIX = 'enhanced/';

const phaseArg = process.argv.indexOf('--phase');
const PHASE = phaseArg > -1 ? process.argv[phaseArg + 1] : 'all';

// ── state ────────────────────────────────────────────────────────────────────
let state = { keys: [], items: {}, uploaded: {}, swapped: false };
if (fs.existsSync(STATE_FILE)) state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state));

// ── Cloudflare REST helpers (wrangler's OAuth token, auto-refreshed) ─────────

function configPath() {
  const candidates = [
    path.join(process.env.APPDATA || '', 'xdg.config', '.wrangler', 'config', 'default.toml'),
    path.join(process.env.XDG_CONFIG_HOME || '', '.wrangler', 'config', 'default.toml'),
    path.join(process.env.HOME || process.env.USERPROFILE || '', '.wrangler', 'config', 'default.toml'),
  ];
  const p = candidates.find(c => fs.existsSync(c));
  if (!p) throw new Error('wrangler config not found — run `npx wrangler login` first');
  return p;
}

let cachedToken = null;

function readToken() {
  const p = configPath();
  const t = fs.readFileSync(p, 'utf8');
  return {
    oauth: t.match(/oauth_token\s*=\s*"([^"]+)"/)?.[1],
    refresh: t.match(/refresh_token\s*=\s*"([^"]+)"/)?.[1],
    expiration: t.match(/expiration_time\s*=\s*"([^"]+)"/)?.[1],
    path: p,
  };
}

async function refreshToken() {
  // Delegate to wrangler itself — it knows its own OAuth flow and rewrites the config.
  const { execSync } = await import('node:child_process');
  execSync('npx wrangler whoami', { stdio: 'ignore', timeout: 60_000 });
  const cfg = readToken();
  if (!cfg.oauth) throw new Error('token refresh failed — run `npx wrangler login`');
  cachedToken = cfg.oauth;
  console.log(`[auth] token refreshed (expires ${cfg.expiration})`);
}

async function getToken() {
  if (cachedToken) return cachedToken;
  const cfg = readToken();
  const expiresAt = cfg.expiration ? new Date(cfg.expiration).getTime() : 0;
  if (!cfg.oauth || Date.now() > expiresAt - 60_000) {
    await refreshToken();
    return cachedToken;
  }
  cachedToken = cfg.oauth;
  return cachedToken;
}

const BACKOFF_MS = [3000, 8000, 15000, 30000, 30000, 30000]; // patient 429/5xx handling

async function cfFetch(url, init = {}) {
  for (let t = 0; ; t++) {
    try {
      const token = await getToken();
      const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
      if (res.status === 401 && t < 2) { cachedToken = null; await refreshToken(); continue; } // expired mid-run
      if (res.status === 429 || res.status >= 500) {
        if (t >= BACKOFF_MS.length) throw new Error(`HTTP ${res.status} after ${t} retries`);
        await new Promise(r => setTimeout(r, BACKOFF_MS[t]));
        continue;
      }
      return res;
    } catch (e) {
      if (t >= BACKOFF_MS.length) throw e;
      await new Promise(r => setTimeout(r, BACKOFF_MS[t]));
    }
  }
}

async function r2Get(key) {
  const res = await cfFetch(`${CF_API}/accounts/${ACCOUNT_ID}/r2/buckets/${R2_BUCKET}/objects/${encodeURIComponent(key)}`);
  if (res.status === 404) throw new Error(`missing in R2: ${key}`);
  if (!res.ok) throw new Error(`R2 GET ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function r2Put(key, body) {
  const res = await cfFetch(`${CF_API}/accounts/${ACCOUNT_ID}/r2/buckets/${R2_BUCKET}/objects/${encodeURIComponent(key)}`, {
    method: 'PUT', headers: { 'content-type': 'image/webp' }, body,
  });
  if (!res.ok) throw new Error(`R2 PUT ${res.status}`);
}

async function d1Query(sql, params = []) {
  const res = await cfFetch(`${CF_API}/accounts/${ACCOUNT_ID}/d1/database/${DB_ID}/query`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  });
  const j = await res.json();
  if (!j.success) throw new Error('D1: ' + JSON.stringify(j.errors));
  return j.result?.[0]?.results ?? [];
}

// ── async pool ───────────────────────────────────────────────────────────────
async function pool(items, worker, n = CONCURRENCY) {
  const queue = [...items];
  let failed = 0;
  const workers = Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try { await worker(item); } catch (e) { failed++; console.error(`  item failed: ${e.message?.slice(0, 140)}`); }
    }
  });
  await Promise.all(workers);
  return failed;
}

// ── image math ───────────────────────────────────────────────────────────────
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

async function enhance(buf, width, height) {
  if (height >= DISPLAY_HEIGHT_PX) return null; // big enough — leave it alone
  const targetH = Math.min(DISPLAY_HEIGHT_PX, height * 4); // cap 4x
  return sharp(buf)
    .resize({ height: targetH, kernel: 'lanczos3' })
    .sharpen({ sigma: 0.8, m1: 0.5, m2: 1.5 })
    .webp({ quality: 88, smartSubsample: true })
    .toBuffer();
}

// ── phases ───────────────────────────────────────────────────────────────────
async function phaseFetch() {
  if (state.keys.length) { console.log(`fetch: already have ${state.keys.length} keys (cached)`); return; }
  console.log('fetch: pulling image keys from production D1…');
  const rows = await d1Query(
    'SELECT image_r2_key AS a, explanation_image_r2_key AS b FROM questions WHERE image_r2_key IS NOT NULL OR explanation_image_r2_key IS NOT NULL LIMIT 30000'
  );
  const seen = new Set();
  const keys = [];
  for (const r of rows) {
    for (const k of [r.a, r.b]) {
      if (!k) continue;
      const hash = k.split('/').pop();
      if (!seen.has(hash)) { seen.add(hash); keys.push(k); }
    }
  }
  state.keys = keys;
  saveState();
  console.log(`fetch: ${rows.length} referencing rows → ${keys.length} unique physical files`);
}

async function phaseProcess() {
  fs.mkdirSync(ALL_DIR, { recursive: true });
  const todo = state.keys.filter(k => !state.items[k]);
  console.log(`process: ${state.keys.length} unique, ${todo.length} to process (×${CONCURRENCY})`);
  let done = 0;
  const failed = await pool(todo, async (key) => {
    const hash = key.split('/').pop();
    const buf = await r2Get(key);
    const meta = await sharp(buf).metadata();
    const enhanced = await enhance(buf, meta.width, meta.height);
    if (!enhanced) {
      state.items[key] = { status: 'good', width: meta.width, height: meta.height };
    } else {
      fs.writeFileSync(path.join(ALL_DIR, hash), enhanced);
      state.items[key] = { status: 'enhanced', width: meta.width, height: meta.height, bytes: enhanced.length };
    }
    if (++done % 100 === 0) { saveState(); console.log(`process: ${done}/${todo.length}`); }
  });
  saveState();
  const counts = Object.values(state.items).reduce((a, i) => { a[i.status] = (a[i.status] || 0) + 1; return a; }, {});
  console.log(`process done:`, counts, failed ? `(${failed} failed — re-run to retry)` : '');
}

async function phaseUpload() {
  const todo = Object.entries(state.items).filter(([, v]) => v.status === 'enhanced').map(([k]) => k);
  console.log(`upload: ${todo.length} enhanced files → R2 ${ENHANCED_PREFIX}* (×${CONCURRENCY})`);
  let done = 0;
  const failed = await pool(todo, async (key) => {
    if (state.uploaded[key]) return;
    const hash = key.split('/').pop();
    await r2Put(ENHANCED_PREFIX + key, fs.readFileSync(path.join(ALL_DIR, hash)));
    state.uploaded[key] = true;
    if (++done % 100 === 0) { saveState(); console.log(`upload: ${done}/${todo.length}`); }
  });
  saveState();
  console.log(`upload done: ${Object.keys(state.uploaded).length} objects in R2`, failed ? `(${failed} failed — re-run to retry)` : '');
}

async function phaseSwap() {
  if (state.swapped) { console.log('swap: already applied (cached)'); return; }
  const enhancedKeys = Object.keys(state.uploaded);
  console.log(`swap: ${enhancedKeys.length} keys via map table + set-based updates…`);
  fs.mkdirSync(ROLLBACK_DIR, { recursive: true });

  // Manual rollback SQL on disk BEFORE touching D1.
  for (let i = 0, c = 0; i < enhancedKeys.length; i += 500, c++) {
    const sql = enhancedKeys.slice(i, i + 500).map(k =>
      `UPDATE questions SET image_r2_key = '${k}' WHERE image_r2_key = '${ENHANCED_PREFIX}${k}';\n` +
      `UPDATE questions SET explanation_image_r2_key = '${k}' WHERE explanation_image_r2_key = '${ENHANCED_PREFIX}${k}';`
    ).join('\n');
    fs.writeFileSync(path.join(ROLLBACK_DIR, `swap-back-${String(c).padStart(3, '0')}.sql`), sql);
  }
  console.log(`swap: rollback chunks written to ${ROLLBACK_DIR}/`);

  await d1Query('DROP TABLE IF EXISTS _enhance_map');
  await d1Query('CREATE TABLE _enhance_map (orig TEXT PRIMARY KEY, enhanced TEXT NOT NULL)');

  // INSERT with multiple VALUES rows — 40 rows = 80 params (< D1's 100 param limit)
  for (let i = 0; i < enhancedKeys.length; i += 40) {
    const chunk = enhancedKeys.slice(i, i + 40);
    const placeholders = chunk.map(() => '(?, ?)').join(', ');
    const params = chunk.flatMap(k => [k, ENHANCED_PREFIX + k]);
    await d1Query(`INSERT OR REPLACE INTO _enhance_map (orig, enhanced) VALUES ${placeholders}`, params);
    if ((i / 40) % 25 === 0) console.log(`swap: map ${Math.min(i + 40, enhancedKeys.length)}/${enhancedKeys.length}`);
  }

  await d1Query(
    "UPDATE questions SET image_r2_key = (SELECT enhanced FROM _enhance_map WHERE orig = questions.image_r2_key) WHERE image_r2_key IN (SELECT orig FROM _enhance_map)"
  );
  await d1Query(
    "UPDATE questions SET explanation_image_r2_key = (SELECT enhanced FROM _enhance_map WHERE orig = questions.explanation_image_r2_key) WHERE explanation_image_r2_key IN (SELECT orig FROM _enhance_map)"
  );

  state.swapped = true;
  saveState();
  console.log('swap: applied (map table _enhance_map kept in D1 for rollback)');
}

async function phaseVerify() {
  const remaining = await d1Query(
    "SELECT COUNT(*) AS n FROM questions WHERE (image_r2_key IS NOT NULL AND image_r2_key NOT LIKE 'enhanced/%') OR (explanation_image_r2_key IS NOT NULL AND explanation_image_r2_key NOT LIKE 'enhanced/%')"
  );
  const swapped = await d1Query(
    "SELECT COUNT(*) AS n FROM questions WHERE image_r2_key LIKE 'enhanced/%' OR explanation_image_r2_key LIKE 'enhanced/%'"
  );
  console.log(`verify: ${remaining[0].n} rows still on original keys; ${swapped[0].n} rows on enhanced keys`);
  if (remaining[0].n > 0) console.log('  ⚠ some references were not swapped — re-run swap phase');
  else console.log('  ✔ all references swapped');
}

// ── remap phase ──────────────────────────────────────────────────────────────
// The same physical image is stored under MANY keys (questions/<uuid>/<hash>.webp,
// 14,417 distinct keys vs 9,992 unique hashes). The swap only mapped the one key
// per hash we uploaded. This maps every remaining key to the enhanced object that
// already exists for its hash — no re-uploading, originals stay untouched.
async function phaseRemap() {
  console.log('remap: pulling every distinct image key from D1…');
  const rows = await d1Query(
    'SELECT image_r2_key AS a, explanation_image_r2_key AS b FROM questions WHERE image_r2_key IS NOT NULL OR explanation_image_r2_key IS NOT NULL LIMIT 30000'
  );
  const keyByHash = new Map(); // hash → canonical processed key (status enhanced)
  for (const [k, v] of Object.entries(state.items)) {
    if (v.status === 'enhanced') keyByHash.set(k.split('/').pop(), k);
  }
  const mappings = new Map(); // origKey → enhancedKey
  for (const row of rows) {
    for (const k of [row.a, row.b]) {
      if (!k) continue;
      const hash = k.split('/').pop();
      const canonical = keyByHash.get(hash);
      if (canonical) mappings.set(k, ENHANCED_PREFIX + canonical);
    }
  }
  console.log(`remap: ${mappings.size} keys to map (${keyByHash.size} enhanced hashes)`);

  // Rollback SQL for these mappings, before applying.
  fs.mkdirSync(ROLLBACK_DIR, { recursive: true });
  const entries = [...mappings.entries()];
  for (let i = 0, c = 20; i < entries.length; i += 500, c++) {
    const sql = entries.slice(i, i + 500).map(([orig, enh]) =>
      `UPDATE questions SET image_r2_key = '${orig}' WHERE image_r2_key = '${enh}';\n` +
      `UPDATE questions SET explanation_image_r2_key = '${orig}' WHERE explanation_image_r2_key = '${enh}';`
    ).join('\n');
    fs.writeFileSync(path.join(ROLLBACK_DIR, `swap-back-${String(c).padStart(3, '0')}.sql`), sql);
  }

  const entriesArr = entries;
  await d1Query('DELETE FROM _enhance_map');
  for (let i = 0; i < entriesArr.length; i += 40) {
    const chunk = entriesArr.slice(i, i + 40);
    const placeholders = chunk.map(() => '(?, ?)').join(', ');
    const params = chunk.flatMap(([orig, enh]) => [orig, enh]);
    await d1Query(`INSERT OR REPLACE INTO _enhance_map (orig, enhanced) VALUES ${placeholders}`, params);
    if ((i / 40) % 50 === 0) console.log(`remap: map ${Math.min(i + 40, entriesArr.length)}/${entriesArr.length}`);
  }

  await d1Query(
    "UPDATE questions SET image_r2_key = (SELECT enhanced FROM _enhance_map WHERE orig = questions.image_r2_key) WHERE image_r2_key IN (SELECT orig FROM _enhance_map)"
  );
  await d1Query(
    "UPDATE questions SET explanation_image_r2_key = (SELECT enhanced FROM _enhance_map WHERE orig = questions.explanation_image_r2_key) WHERE explanation_image_r2_key IN (SELECT orig FROM _enhance_map)"
  );
  console.log('remap: applied');
}

// ── run ──────────────────────────────────────────────────────────────────────
(async () => {
  await getToken(); // fail fast if not logged in / refresh if expired
  const order = ['fetch', 'process', 'upload', 'swap', 'remap', 'verify'];
  const phases = PHASE === 'all' ? order : [PHASE];
  const runners = { fetch: phaseFetch, process: phaseProcess, upload: phaseUpload, swap: phaseSwap, remap: phaseRemap, verify: phaseVerify };
  for (const p of phases) {
    console.log(`\n══ PHASE ${p.toUpperCase()} ══`);
    await runners[p]();
  }
  console.log('\nAll requested phases complete.');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
