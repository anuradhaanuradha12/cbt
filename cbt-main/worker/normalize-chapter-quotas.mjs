// ─── Normalise blueprint chapter names ───────────────────────────────────────
// Rewrites exams.chapter_quotas so every chapter key matches a chapter that
// actually exists in the question bank for that subject.
//
// Why: the exam-creation UI used to merge a hardcoded syllabus list with the
// real bank chapters, so the principal could save a chapter like
// "Alcohols, Phenols and Ethers" while the bank only has
// "Alcohols Phenols and Ethers". The faculty's Pending Task then showed a
// chapter that returned zero questions and the quota could never be filled.
//
// Two matching passes:
//   1. Case/punctuation-insensitive equality — fixes the comma variants.
//   2. A small explicit alias map for syllabus-style names whose bank
//      equivalent is named differently (documented below).
//
// Dry run by default; pass --apply to write. A JSON snapshot of the original
// values is saved next to the script before any write.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const D1_DIR = path.join(__dirname, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
const APPLY = process.argv.includes('--apply');

// Keyed by chapterKey(). Only names with exactly one sensible bank target belong
// here — anything ambiguous is left untouched and reported instead.
const EXPLICIT_ALIASES = {
  physics: {
    'atoms': 'Atomic Physics',              // bank has no "Atoms" chapter
  },
  maths: {
    'sets': 'Sets and Relations',           // bank has no bare "Sets" chapter
  },
};

const chapterKey = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const sqliteFile = fs.readdirSync(D1_DIR)
  .filter(f => f.endsWith('.sqlite'))
  .map(f => ({ f, size: fs.statSync(path.join(D1_DIR, f)).size }))
  .sort((a, b) => b.size - a.size)[0].f;
const db = new DatabaseSync(path.join(D1_DIR, sqliteFile));
console.log(`DB file: ${sqliteFile}`);
console.log(APPLY ? 'Mode: APPLY' : 'Mode: DRY RUN (pass --apply to write)');

// ── Real chapters per subject ────────────────────────────────────────────────
const realRows = db.prepare(
  `SELECT LOWER(subject) AS subject, chapter, COUNT(*) AS n
     FROM questions
    WHERE chapter IS NOT NULL AND chapter != ''
    GROUP BY LOWER(subject), chapter`
).all();

const bySubjectKey = {};   // subject -> Map(chapterKey -> real chapter)
const counts = {};         // "subject|||chapter" -> n
for (const r of realRows) {
  (bySubjectKey[r.subject] ||= new Map()).set(chapterKey(r.chapter), r.chapter);
  counts[`${r.subject}|||${r.chapter}`] = r.n;
}

const resolve = (subject, chapter) => {
  const map = bySubjectKey[subject.toLowerCase()];
  if (!map) return null;
  const key = chapterKey(chapter);
  if (map.has(key)) return map.get(key);
  const alias = EXPLICIT_ALIASES[subject.toLowerCase()]?.[key];
  if (alias && map.has(chapterKey(alias))) return map.get(chapterKey(alias));
  return null;
};

// ── Audit + rewrite every exam blueprint ─────────────────────────────────────
const exams = db.prepare('SELECT id, title, chapter_quotas FROM exams').all();
const changes = [];
const unresolved = [];
const snapshots = [];

for (const exam of exams) {
  let quotas;
  try { quotas = JSON.parse(exam.chapter_quotas || '{}'); } catch { continue; }
  if (!quotas || typeof quotas !== 'object') continue;

  const next = {};
  let touched = false;

  for (const [subject, chapters] of Object.entries(quotas)) {
    if (!chapters || typeof chapters !== 'object') { next[subject] = chapters; continue; }
    const bucket = {};
    for (const [chapter, value] of Object.entries(chapters)) {
      const canonical = resolve(subject, chapter);
      if (!canonical) {
        unresolved.push({ exam: exam.title, subject, chapter });
        bucket[chapter] = (bucket[chapter] ?? 0) + (Number(value) || 0);
        continue;
      }
      if (canonical !== chapter) {
        touched = true;
        changes.push({
          exam: exam.title, subject, from: chapter, to: canonical,
          qty: Number(value) || 0, bank: counts[`${subject.toLowerCase()}|||${canonical}`] ?? 0,
        });
      }
      bucket[canonical] = (bucket[canonical] ?? 0) + (Number(value) || 0);
    }
    next[subject] = bucket;
  }

  if (touched) {
    snapshots.push({ id: exam.id, title: exam.title, before: exam.chapter_quotas, after: JSON.stringify(next) });
    if (APPLY) {
      db.prepare('UPDATE exams SET chapter_quotas = ? WHERE id = ?').run(JSON.stringify(next), exam.id);
    }
  }
}

console.log(`\n=== ${changes.length} chapter name(s) to normalise in ${snapshots.length} exam(s) ===`);
for (const c of changes) {
  console.log(`  ${c.exam} | ${c.subject}: "${c.from}" -> "${c.to}"  (${c.qty} qs, ${c.bank} available in bank)`);
}

if (unresolved.length) {
  console.log(`\n=== ${unresolved.length} chapter name(s) with no safe bank match (left as-is) ===`);
  for (const u of unresolved) console.log(`  ${u.exam} | ${u.subject}: "${u.chapter}"`);
}

if (APPLY && snapshots.length) {
  const backup = path.join(__dirname, `.wrangler/backup/chapter-quotas-backup-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.writeFileSync(backup, JSON.stringify(snapshots, null, 2));
  console.log(`\nBackup of original values: ${path.relative(__dirname, backup)}`);
  console.log(`Applied to ${snapshots.length} exam(s).`);
} else if (!APPLY) {
  console.log('\nDry run only — nothing written.');
}
