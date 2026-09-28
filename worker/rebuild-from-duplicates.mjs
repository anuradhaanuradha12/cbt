// ─── Rebuild damaged questions from their clean duplicates ───────────────────
// The bank was imported more than once, so many questions exist as TWO rows:
// one with proper LaTeX ("\( 2 \times 10^{-2} \mathrm{~m} / \mathrm{s} \)") and
// one flattened to plain text ("2×10-2 m s-1"). For those pairs the correct
// content already exists — no guessing required — so the damaged row is
// rebuilt from its clean twin.
//
// Matching is deliberately conservative. Two rows pair up only when ALL hold:
//   * question_text is near-identical (Jaccard >= 0.90 on word tokens,
//     after stripping LaTeX commands and punctuation)
//   * same subject
//   * same correct_answer
//   * exactly one side carries LaTeX; the other is flattened
//
// Nothing is deleted. Only the text fields of the damaged row are replaced.
//
// Usage:
//   node rebuild-from-duplicates.mjs            # dry run — reports only
//   node rebuild-from-duplicates.mjs --apply    # writes the rebuilds

import { DatabaseSync } from 'node:sqlite';

const DB_FILE = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject/82ed3d9ff502f7382874778df6ecb14db42da56def327314e2a27be609632375.sqlite';
const TEXT_FIELDS = ['question_text', 'option_a', 'option_b', 'option_c', 'option_d', 'explanation'];
const APPLY = process.argv.includes('--apply');
const SIMILARITY_THRESHOLD = 0.9;

/** Remove LaTeX commands so a LaTeX string compares with its plain-text twin. */
const LATEX_COMMANDS = /\\(?:left|right|mathrm|mathit|mathbf|text|textrm|frac|dfrac|times|cdot|approx|simeq|circ|sqrt|begin|end|array|hline|displaystyle|rm|it|bf|quad|qquad)/g;
// LaTeX punctuation / delimiters: "\\(", "\\)", "\,", "\\%" …
const LATEX_PUNCT = /\\[,;:!~()]/g;

/** Strip LaTeX to lowercase alphanumerics, for comparison only. */
function stripLatex(value) {
  return String(value ?? '')
    .toLowerCase()
    // Leading labels differ between the two import passes ("Question: …" vs
    // "…"), and would otherwise stop near-identical rows from blocking together.
    .replace(/^\s*(?:question|ques|q)\s*[:.\-)]\s*/, '')
    .replace(/^\s*\d+\s*[.)]\s*/, '')
    .replace(LATEX_COMMANDS, '')
    .replace(LATEX_PUNCT, '')
    .replace(/\\([a-z]+)/g, '$1');
}

function normText(value) {
  return stripLatex(value).replace(/[^a-z0-9]/g, '');
}

function tokens(value) {
  return stripLatex(value).split(/[^a-z0-9]+/).filter(Boolean);
}

function jaccard(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  return inter / (setA.size + setB.size - inter);
}

const HAS_LATEX = /\\\(|\\times|\\frac|\^\{|\\mathrm/;
function hasLatex(row) {
  return TEXT_FIELDS.some((f) => typeof row[f] === 'string' && HAS_LATEX.test(row[f]));
}

const FLAT_EXPONENT = /\d\s*-\s*\d|\bs\s*-\s*1\b/;
function isFlattened(row) {
  return TEXT_FIELDS.some((f) => typeof row[f] === 'string' && FLAT_EXPONENT.test(row[f]));
}

// ── Load ─────────────────────────────────────────────────────
const db = new DatabaseSync(DB_FILE, { readOnly: !APPLY });
console.log(`Loading questions${APPLY ? '' : ' (dry run — no writes)'}…`);

const rows = db.prepare(`SELECT id, subject, chapter, ${TEXT_FIELDS.join(', ')} FROM questions`).all();
console.log(`  ${rows.length.toLocaleString()} rows\n`);

// ── Block, then pair ─────────────────────────────────────────
// Blocking on a 26-char normalised prefix keeps this linear-ish instead of
// comparing all 3.7 billion possible pairs.
const blocks = new Map();
for (const row of rows) {
  const key = normText(row.question_text).slice(0, 22);
  if (!key) continue;
  if (!blocks.has(key)) blocks.set(key, []);
  blocks.get(key).push(row);
}

const pairs = [];
let candidatePairs = 0;

for (const list of blocks.values()) {
  if (list.length < 2 || list.length > 40) continue;   // skip huge/unique blocks

  const clean = list.filter(hasLatex);
  const flat = list.filter((r) => !hasLatex(r) && isFlattened(r));
  if (clean.length === 0 || flat.length === 0) continue;

  for (const damaged of flat) {
    let best = null;
    let bestScore = 0;

    for (const good of clean) {
      if (good.id === damaged.id) continue;
      if (good.subject !== damaged.subject) continue;
      if (good.correct_answer !== damaged.correct_answer) continue;

      candidatePairs++;
      const score = jaccard(tokens(damaged.question_text), tokens(good.question_text));
      if (score > bestScore) { bestScore = score; best = good; }
    }

    if (best && bestScore >= SIMILARITY_THRESHOLD) {
      pairs.push({ damaged, good: best, score: bestScore });
    }
  }
}

console.log(`blocks scanned              : ${blocks.size.toLocaleString()}`);
console.log(`candidate pairs compared    : ${candidatePairs.toLocaleString()}`);
console.log(`damaged rows with a clean twin: ${pairs.length.toLocaleString()}`);

// ── Show what would change ───────────────────────────────────
console.log('\n── Samples ──');
for (const p of pairs.slice(0, 4)) {
  console.log(`  similarity ${p.score.toFixed(3)}`);
  console.log(`    damaged ${p.damaged.id}`);
  console.log(`      option_a: ${JSON.stringify(p.damaged.option_a)}`);
  console.log(`    clean   ${p.good.id}`);
  console.log(`      option_a: ${JSON.stringify(p.good.option_a)}`);
}

// ── Apply ────────────────────────────────────────────────────
if (APPLY && pairs.length > 0) {
  const update = db.prepare(`UPDATE questions SET ${TEXT_FIELDS.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`);
  let rebuilt = 0;
  for (const p of pairs) {
    update.run(...TEXT_FIELDS.map((f) => p.good[f]), p.damaged.id);
    rebuilt++;
  }
  console.log(`\nAPPLIED — ${rebuilt.toLocaleString()} damaged rows rebuilt from their clean twins.`);
} else if (!APPLY) {
  console.log('\nDry run complete. Re-run with --apply to write these rebuilds.');
}

db.close();
