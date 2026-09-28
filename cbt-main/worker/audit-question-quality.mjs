// ─── Question quality audit ──────────────────────────────────────────────────
// Read-only. Scans the whole question bank for equation / image data problems
// and prints counts + samples. Run before (and after) any repair pass:
//
//   node audit-question-quality.mjs
//
// Detects:
//   1. mojibake      — UTF-8 bytes decoded as Latin-1 ("Ã—" instead of "×",
//                      "Î»" instead of "λ"). Repairable losslessly.
//   2. control chars — raw \t \r \n \f \b \v \a left over from LaTeX commands
//                      such as \times, \right, \neq, \frac, \beta
//   3. lost LaTeX    — backslashes stripped, e.g. "10-4" / "m s-1" instead of
//                      10^{-4} / m s^{-1}
//   4. broken math   — "\( ... " with no closing "\)"
//   5. images        — question image references, and whether they are
//                      reachable in the LOCAL R2 simulation

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DB_FILE = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject/82ed3d9ff502f7382874778df6ecb14db42da56def327314e2a27be609632375.sqlite';
const TEXT_FIELDS = ['question_text', 'option_a', 'option_b', 'option_c', 'option_d', 'explanation'];

const db = new DatabaseSync(DB_FILE, { readOnly: true });

/** Latin-1 → UTF-8 reversal. Returns null when the bytes aren't valid UTF-8. */
function undouble(s) {
  if (!s) return null;
  let out;
  try {
    out = Buffer.from(s, 'latin1').toString('utf8');
  } catch {
    return null;
  }
  if (out.includes('\uFFFD')) return null;   // not a UTF-8 byte sequence
  if (out === s) return null;                // nothing changed
  return out;
}

const MOJIBAKE_SIGNATURE = /[\u00C2-\u00C3\u00CE\u00CF\u00E2\u00E3\u00E0\u00E1\u00E9\u00ED\u00F3\u00FA\u00FB\u00F1\u00D0\u00D1]/;

function hasMojibake(s) {
  if (!s || typeof s !== 'string') return false;
  if (!MOJIBAKE_SIGNATURE.test(s)) return false;
  return undouble(s) !== null;
}

function hasControlChars(s) {
  // Any C0 control other than \n (which legitimately separates explanation lines)
  return typeof s === 'string' && /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/.test(s);
}

function hasLostLatex(s) {
  if (typeof s !== 'string') return false;
  // "10-4", "10-27", "m s-1", "cm s-1" — exponents flattened to plain digits
  return /\d\s*-\s*\d/.test(s) || /\bs\s*-\s*1\b/.test(s);
}

function hasBrokenMath(s) {
  if (typeof s !== 'string' || !s.includes('\\(')) return false;
  const open = (s.match(/\\\(/g) || []).length;
  const close = (s.match(/\\\)/g) || []).length;
  return open !== close;
}

// ── Scan ─────────────────────────────────────────────────────
console.log('Reading question bank…');
const rows = db.prepare(`SELECT id, ${TEXT_FIELDS.join(', ')}, image_r2_key, explanation_image_r2_key FROM questions`).all();
console.log(`Total questions: ${rows.length.toLocaleString()}\n`);

const counts = {
  mojibake: 0, control: 0, lostLatex: 0, brokenMath: 0,
  anyEquationIssue: 0,
  withImage: 0, withExplanationImage: 0, malformedImageKey: 0,
};
const samples = { mojibake: [], control: [], lostLatex: [], brokenMath: [], malformedImageKey: [] };

for (const row of rows) {
  let moji = false, ctrl = false, lost = false, broken = false;

  for (const f of TEXT_FIELDS) {
    const v = row[f];
    if (!v) continue;
    if (hasMojibake(v)) { moji = true; if (samples.mojibake.length < 5) samples.mojibake.push({ id: row.id, field: f, before: v.slice(0, 110), after: undouble(v).slice(0, 110) }); }
    if (hasControlChars(v)) { ctrl = true; if (samples.control.length < 5) samples.control.push({ id: row.id, field: f, value: JSON.stringify(v).slice(0, 110) }); }
    if (hasLostLatex(v) && !v.includes('^{-')) { lost = true; if (samples.lostLatex.length < 5) samples.lostLatex.push({ id: row.id, field: f, value: v.slice(0, 110) }); }
    if (hasBrokenMath(v)) { broken = true; if (samples.brokenMath.length < 5) samples.brokenMath.push({ id: row.id, field: f, value: v.slice(0, 110) }); }
  }

  if (moji) counts.mojibake++;
  if (ctrl) counts.control++;
  if (lost) counts.lostLatex++;
  if (broken) counts.brokenMath++;
  if (moji || ctrl || lost || broken) counts.anyEquationIssue++;

  // ── Images ──
  const img = row.image_r2_key;
  const expImg = row.explanation_image_r2_key;
  if (img) {
    counts.withImage++;
    if (!String(img).startsWith('questions/') && samples.malformedImageKey.length < 5) {
      counts.malformedImageKey++;
      samples.malformedImageKey.push({ id: row.id, key: String(img) });
    }
  }
  if (expImg) counts.withExplanationImage++;
}

// ── Local R2 contents ────────────────────────────────────────
function countFiles(dir) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1;
  }
  return n;
}
const r2Root = '.wrangler/state/v3/r2';
const localR2Objects = countFiles(r2Root);

// ── Report ───────────────────────────────────────────────────
const pct = (n) => `${((n / rows.length) * 100).toFixed(1)}%`;

console.log('── Equation quality ─────────────────────────────────────────');
console.log(`  mojibake (double-encoded UTF-8) : ${counts.mojibake.toLocaleString().padStart(8)}  ${pct(counts.mojibake)}`);
console.log(`  raw control chars (\\t \\r \\n …)  : ${counts.control.toLocaleString().padStart(8)}  ${pct(counts.control)}`);
console.log(`  lost LaTeX (10-4, m s-1)        : ${counts.lostLatex.toLocaleString().padStart(8)}  ${pct(counts.lostLatex)}`);
console.log(`  unbalanced \\( \\)               : ${counts.brokenMath.toLocaleString().padStart(8)}  ${pct(counts.brokenMath)}`);
console.log(`  ANY equation issue             : ${counts.anyEquationIssue.toLocaleString().padStart(8)}  ${pct(counts.anyEquationIssue)}`);

console.log('\n── Images ───────────────────────────────────────────────────');
console.log(`  questions with image_r2_key            : ${counts.withImage.toLocaleString()}`);
console.log(`  questions with explanation_image_r2_key: ${counts.withExplanationImage.toLocaleString()}`);
console.log(`  malformed image keys                   : ${counts.malformedImageKey.toLocaleString()}`);
console.log(`  objects present in LOCAL R2 (${r2Root}): ${localR2Objects.toLocaleString()}`);

for (const [label, list] of Object.entries(samples)) {
  if (list.length === 0) continue;
  console.log(`\n── Samples: ${label} ──`);
  for (const s of list) console.log('  ' + JSON.stringify(s));
}

console.log('\nAudit complete (read-only — nothing was modified).');
db.close();
