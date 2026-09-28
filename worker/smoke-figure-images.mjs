// ─── Diagram-image serving smoke test ────────────────────────────────────────
// The bug: question-bank cards and exam pages rendered a broken-image glyph
// ("Question Image") because the referenced R2 object was absent locally.
// This asserts the local R2 binding now serves real decodable image bytes for
// the bank's diagram keys — including the exact question from the report.
//
// Usage: node smoke-figure-images.mjs

import fs from 'node:fs';

const BASE = process.env.LOCAL_BASE ?? 'http://127.0.0.1:8787';
const DB_DIR = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject';
// The question in the bug report: physics / Electromagnetic Induction / medium
const REPORTED_QID = 'cd9a3459-f9a8-451e-83d1-20b153aa28f5';

let pass = 0;
let fail = 0;
const check = (ok, label, detail = '') => {
  if (ok) { pass++; console.log(`PASS  ${label}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
};

const { DatabaseSync } = await import('node:sqlite');
const dbFile = fs
  .readdirSync(DB_DIR)
  .map((f) => DB_DIR + '/' + f)
  .filter((f) => f.endsWith('.sqlite'))
  .map((f) => ({ f, s: fs.statSync(f).size }))
  .sort((a, b) => b.s - a.s)[0].f;
const db = new DatabaseSync(dbFile, { readOnly: true });

const keyOf = (id, col) => db.prepare(`SELECT ${col} k FROM questions WHERE id = ?`).get(id)?.k;

const url = (key) => `${BASE}/images/${key.split('/').map(encodeURIComponent).join('/')}`;
const MAGIC = {
  webp: (b) => b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP',
  png: (b) => b[0] === 0x89 && b.slice(1, 4).toString('ascii') === 'PNG',
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8,
};

async function probe(key) {
  const res = await fetch(url(key));
  if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = (key.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
  const magic = MAGIC[ext] ?? (() => buf.length > 0);
  if (buf.length === 0) return { ok: false, why: 'empty body' };
  if (!/^image\//.test(res.headers.get('content-type') ?? '')) return { ok: false, why: `type ${res.headers.get('content-type')}` };
  if (!magic(buf)) return { ok: false, why: `not a real ${ext || 'image'} (magic bytes)` };
  return { ok: true, bytes: buf.length, ext };
}

// ── the reported question ────────────────────────────────────
console.log('— the question from the bug report —');
const reportedKey = keyOf(REPORTED_QID, 'image_r2_key');
check(!!reportedKey, 'reported question still has a figure key', reportedKey ? reportedKey.slice(0, 44) + '…' : 'none');
if (reportedKey) {
  const r = await probe(reportedKey);
  check(r.ok, 'its diagram serves as a real image', r.ok ? `${r.bytes} bytes ${r.ext}` : r.why);
}

// ── a spread of diagram keys across the bank ─────────────────
console.log('\n— 40 diagram keys sampled across subjects —');
const rows = db
  .prepare(
    `SELECT image_r2_key k, subject FROM questions
      WHERE image_r2_key IS NOT NULL AND image_r2_key <> ''
      ORDER BY RANDOM() LIMIT 40`
  )
  .all();
const keys = rows.map((r) => r.k);
console.log(`   subjects covered: ${[...new Set(rows.map((r) => r.subject))].sort().join(', ') || '(none)'}`);

let okCount = 0;
const bad = [];
const queue = [...keys];
await Promise.all(
  Array.from({ length: 10 }, async () => {
    while (queue.length) {
      const key = queue.shift();
      const r = await probe(key);
      if (r.ok) okCount++;
      else bad.push({ key, why: r.why });
    }
  })
);
check(okCount === keys.length, `all ${keys.length} sampled diagrams serve real image bytes`, `${okCount} ok`);
for (const b of bad.slice(0, 5)) console.log(`   BAD ${b.why} ${b.key}`);

// ── explanation figures too ──────────────────────────────────
console.log('\n— explanation figures —');
const explKeys = db
  .prepare(
    `SELECT explanation_image_r2_key k FROM questions
      WHERE explanation_image_r2_key IS NOT NULL AND explanation_image_r2_key <> ''
      ORDER BY RANDOM() LIMIT 15`
  )
  .all()
  .map((r) => r.k);
let explOk = 0;
const badExpl = [];
for (const key of explKeys) {
  const r = await probe(key);
  if (r.ok) explOk++;
  else badExpl.push({ key, why: r.why });
}
check(explOk === explKeys.length, `all ${explKeys.length} sampled explanation figures decode`, `${explOk} ok`);
for (const b of badExpl.slice(0, 5)) console.log(`   BAD ${b.why} ${b.key}`);

// ── the route still 404s cleanly for a key that isn't there ──
const ghost = await fetch(url('questions/00000000-0000-0000-0000-000000000000/q_deadbeef.webp'));
check(ghost.status === 404, 'a genuinely absent key still returns 404', `HTTP ${ghost.status}`);

db.close();
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
