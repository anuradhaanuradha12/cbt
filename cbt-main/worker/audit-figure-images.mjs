// ─── Figure-image audit ──────────────────────────────────────────────────────
// Cross-checks every diagram key referenced by the question bank against what
// the LOCAL R2 binding actually serves, and reports which exams are still
// affected. Read-only.
//
// Usage:
//   node audit-figure-images.mjs            # DB cross-check + 40-key HTTP sample
//   node audit-figure-images.mjs --all      # HTTP-probe every missing key

import fs from 'node:fs';

const BASE = process.env.LOCAL_BASE ?? 'http://127.0.0.1:8787';
const DB_DIR = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject';
const R2_DIR = '.wrangler/state/v3/r2/miniflare-R2BucketObject';
const ALL = process.argv.includes('--all');

const { DatabaseSync } = await import('node:sqlite');
const biggest = (dir, ext) =>
  fs
    .readdirSync(dir)
    .map((f) => dir + '/' + f)
    .filter((f) => f.endsWith(ext))
    .map((f) => ({ f, s: fs.statSync(f).size }))
    .sort((a, b) => b.s - a.s)[0]?.f;

const db = new DatabaseSync(biggest(DB_DIR, '.sqlite'), { readOnly: true });
const referenced = db
  .prepare(
    `SELECT DISTINCT k FROM (
       SELECT image_r2_key AS k FROM questions WHERE image_r2_key IS NOT NULL AND image_r2_key <> ''
       UNION ALL
       SELECT explanation_image_r2_key AS k FROM questions
        WHERE explanation_image_r2_key IS NOT NULL AND explanation_image_r2_key <> '')`
  )
  .all()
  .map((r) => r.k);

const r2 = new DatabaseSync(biggest(R2_DIR, '.sqlite'), { readOnly: true });
const index = new Map(r2.prepare('SELECT key, size FROM _mf_objects').all().map((r) => [r.key, r.size]));
r2.close();

const missing = referenced.filter((k) => !index.has(k));
const empty = referenced.filter((k) => index.has(k) && !(index.get(k) > 0));
const bytes = referenced.reduce((n, k) => n + (index.get(k) ?? 0), 0);
console.log(`figure keys referenced : ${referenced.length.toLocaleString()}`);
console.log(`present in local R2    : ${(referenced.length - missing.length).toLocaleString()}`);
console.log(`MISSING                : ${missing.length.toLocaleString()}`);
console.log(`zero-byte objects      : ${empty.length.toLocaleString()}`);
console.log(`total figure bytes     : ${(bytes / 1048576).toFixed(1)} MB`);

if (missing.length) {
  // Which exams are still showing broken diagrams?
  const rows = db
    .prepare(
      `SELECT e.id, e.title, e.status, COUNT(DISTINCT q.id) AS broken
         FROM questions q
         JOIN exam_questions eq ON eq.question_id = q.id
         JOIN exams e ON e.id = eq.exam_id
        WHERE q.image_r2_key IS NOT NULL AND q.image_r2_key <> ''
          AND q.image_r2_key NOT IN (SELECT value FROM json_each(?))
        GROUP BY e.id ORDER BY broken DESC LIMIT 15`
    )
    .all(JSON.stringify([...present]));
  console.log('\nExams still affected:');
  for (const r of rows) console.log(`  ${r.broken} broken fig  [${r.status}]  ${String(r.title).slice(0, 40)}`);
}

// ── HTTP spot-check: prove the bytes really come back ────────
// --all probes every referenced key; otherwise the missing ones (or a sample).
const probe = ALL ? (missing.length ? missing : referenced) : (missing.length ? missing : referenced.slice(0, 40));
const urls = probe.map((k) => `${BASE}/images/${k.split('/').map(encodeURIComponent).join('/')}`);

let ok = 0;
const bad = [];
const queue = [...urls];
await Promise.all(
  Array.from({ length: Number(process.env.CONCURRENCY ?? 10) }, async () => {
    while (queue.length) {
      const url = queue.shift();
      try {
        const res = await fetch(url);
        const type = res.headers.get('content-type') ?? '';
        const bytes = res.ok ? (await res.arrayBuffer()).byteLength : 0;
        if (res.ok && type.startsWith('image/') && bytes > 0) ok++;
        else bad.push({ url, status: res.status, type, bytes });
      } catch (e) {
        bad.push({ url, error: String(e?.message ?? e) });
      }
    }
  })
);

console.log(
  `\nHTTP check ${ALL ? '(every missing key)' : '(sample of ' + probe.length + ')'}: ` +
    `${ok}/${probe.length} served as a real image`
);
for (const b of bad.slice(0, 10)) console.log('  BAD', JSON.stringify(b));

db.close();
process.exit(bad.length ? 1 : 0);
