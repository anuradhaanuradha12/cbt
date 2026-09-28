// Diagnostic: find chapter names in exam blueprints (chapter_quotas) that do not
// exist as real chapters in the question bank for that subject.
//
// Usage: node diag-chapter-mismatch.mjs
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(__dirname, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject');

const fs = await import('node:fs');
const sqliteFile = fs.readdirSync(DB)
  .filter(f => f.endsWith('.sqlite'))
  .map(f => ({ f, size: fs.statSync(path.join(DB, f)).size }))
  .sort((a, b) => b.size - a.size)[0].f;
const db = new DatabaseSync(path.join(DB, sqliteFile));
console.log('DB file:', sqliteFile);

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Real chapters per subject from the bank
const realRows = db.prepare(
  `SELECT LOWER(subject) AS subject, chapter, COUNT(*) AS n
     FROM questions
    WHERE chapter IS NOT NULL AND chapter != ''
    GROUP BY LOWER(subject), chapter`
).all();

const realBySubject = {};
const realNorm = {};
for (const r of realRows) {
  (realBySubject[r.subject] ||= []).push({ chapter: r.chapter, n: r.n });
  (realNorm[r.subject] ||= new Map()).set(norm(r.chapter), r.chapter);
}
for (const s of Object.keys(realBySubject)) realBySubject[s].sort((a, b) => a.chapter.localeCompare(b.chapter));

console.log('=== real chapters in bank ===');
for (const s of Object.keys(realBySubject).sort()) {
  console.log(`  ${s}: ${realBySubject[s].length} chapters, ${realBySubject[s].reduce((a, b) => a + b.n, 0)} questions`);
}

// Blueprint chapters across all exams
const exams = db.prepare(`SELECT id, title, exam_type, chapter_quotas, subject_quotas FROM exams`).all();
console.log(`\n=== blueprint audit (${exams.length} exams) ===`);
const phantoms = new Map(); // "subject|||chapter" -> {exams:Set, count}
let examsWithPhantom = 0;

for (const e of exams) {
  let cq = {};
  try { cq = JSON.parse(e.chapter_quotas || '{}'); } catch { cq = {}; }
  const bad = [];
  for (const [sub, chapters] of Object.entries(cq)) {
    const subj = sub.toLowerCase();
    for (const ch of Object.keys(chapters || {})) {
      const real = realNorm[subj]?.get(norm(ch));
      if (!real) {
        bad.push(`${sub}/${ch}`);
        const key = `${subj}|||${ch}`;
        if (!phantoms.has(key)) phantoms.set(key, { subject: subj, chapter: ch, exams: new Set(), count: 0 });
        phantoms.get(key).exams.add(e.title);
        phantoms.get(key).count += 1;
      } else if (real !== ch) {
        console.log(`  [alias] "${ch}" -> real "${real}"  (exam: ${e.title})`);
      }
    }
  }
  if (bad.length) {
    examsWithPhantom++;
    console.log(`  PHANTOM  ${e.title} (${e.exam_type}) -> ${bad.join(', ')}`);
  }
}
console.log(`\n  exams with at least one phantom chapter: ${examsWithPhantom}/${exams.length}`);

// Hardcoded STANDARD_CHAPTERS vs bank
const fs2 = await import('node:fs');
const adminSrc = fs2.readFileSync(path.join(__dirname, '../frontend/js/admin.js'), 'utf8');
const m = adminSrc.match(/const STANDARD_CHAPTERS = (\{[\s\S]*?\n    \});/);
if (m) {
  const std = eval('(' + m[1] + ')');
  console.log(`\n=== hardcoded STANDARD_CHAPTERS vs bank ===`);
  for (const [sub, list] of Object.entries(std)) {
    const missing = list.filter(ch => !realNorm[sub]?.get(norm(ch)));
    const near = missing.map(ch => {
      const n = norm(ch);
      const cand = (realBySubject[sub] || []).find(r => norm(r.chapter) === n)
        || (realBySubject[sub] || []).find(r => norm(r.chapter).replace(/ /g, '') === n.replace(/ /g, ''));
      return cand ? `${ch} ~> ${cand.chapter}` : ch;
    });
    console.log(`  ${sub}: ${missing.length}/${list.length} not in bank`);
    if (near.length) console.log(`     ${near.join('\n     ')}`);
  }
}

console.log(`\n=== phantom chapter names seen in blueprints ===`);
for (const [k, v] of phantoms) {
  console.log(`  ${v.subject}: "${v.chapter}"  (in ${v.exams.size} exam(s))`);
  // suggest real chapter
  const n = norm(v.chapter);
  const sug = (realBySubject[v.subject] || []).find(r => norm(r.chapter) === n)
    || (realBySubject[v.subject] || []).find(r => norm(r.chapter).replace(/[,]/g, '') === n.replace(/[,]/g, ''));
  console.log(`      → suggested real chapter: ${sug ? `"${sug.chapter}" (${sug.n} qs)` : 'NONE FOUND'}`);
}
