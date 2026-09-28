// ─── Convert flattened numeric options to LaTeX ──────────────────────────────
// Part of the bank was imported as plain text, so an answer reads "12×10-5 T"
// where it should be "\( 12 \times 10^{-5} \ \mathrm{T} \)". That is not a
// stripped superscript to guess at — it is a plain-text answer that needs
// converting into math.
//
// The conversion is only attempted when ALL FOUR options match the strict
// "number + unit" shape, which keeps prose answers ("Cannot be calculated",
// "Zero") and ambiguous values out of it. Anything that does not match is
// skipped and reported.
//
// Usage:
//   node fix-flattened-options.mjs            # dry run — reports only
//   node fix-flattened-options.mjs --apply    # writes the conversions

import { DatabaseSync } from 'node:sqlite';

const DB_FILE = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject/82ed3d9ff502f7382874778df6ecb14db42da56def327314e2a27be609632375.sqlite';
const OPTIONS = ['option_a', 'option_b', 'option_c', 'option_d'];
const APPLY = process.argv.includes('--apply');

// number, optional ×10-n, then a unit part made only of unit-ish characters
const SHAPE = /^(\d+(?:\.\d+)?)\s*(?:[×x·]\s*10\s*-\s*(\d+))?\s+([A-Za-zµΩ°\/\s\-0-9^{}]+)$/;

// Only convert rows that actually carry a flattened exponent ("10-5", "s-1").
// "900 N" is already correct plain text — rewriting it would be churn, not a fix.
const NEEDS_FIX = /\d\s*-\s*\d\b|\b[A-Za-zµΩ]+\s*-\s*[123]\b/;

// Unit tokens that are safe to treat as physical units.
const KNOWN_UNITS = new Set([
  'm', 'cm', 'mm', 'km', 'nm', 'µm', 'kg', 'g', 'mg', 's', 'ms', 'min', 'h',
  'k', 'mol', 'rad', 'hz', 'n', 'j', 'kj', 'c', 'v', 'w', 'kw', 'pa', 'kpa',
  't', 'a', 'ma', 'f', 'ω', 'ohm', 'ev', 'mev', 'kev', 'l', 'ml', 'db',
]);

/** "m s-1" → "\mathrm{m}\,\mathrm{s^{-1}}" — returns null if any token is unknown. */
function unitsToLatex(unitPart) {
  const parts = unitPart.trim().split(/[\s\/]+/).filter(Boolean);
  if (parts.length === 0) return null;

  const rendered = [];
  for (const raw of parts) {
    const m = raw.match(/^([A-Za-zµΩ]+)(?:-(\d+))?$/);
    if (!m) return null;
    const [, name, exponent] = m;
    if (!KNOWN_UNITS.has(name.toLowerCase())) return null;
    rendered.push(exponent ? `\\mathrm{${name}^{${exponent}}}` : `\\mathrm{${name}}`);
  }
  return rendered.join('\\,');
}

function convertOption(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(SHAPE);
  if (!m) return null;

  const [, mantissa, exponent, unitPart] = m;
  const units = unitsToLatex(unitPart);
  if (!units) return null;

  const magnitude = exponent ? `${mantissa} \\times 10^{-${exponent}}` : mantissa;
  return `\\( ${magnitude} \\ ${units} \\)`;
}

const db = new DatabaseSync(DB_FILE, { readOnly: !APPLY });
console.log(`Scanning options${APPLY ? '' : ' (dry run — no writes)'}…\n`);

const rows = db.prepare(`SELECT id, subject, ${OPTIONS.join(', ')} FROM questions`).all();

const conversions = [];
const skipped = [];

for (const row of rows) {
  const values = OPTIONS.map((o) => row[o]);
  if (values.some((v) => !v)) continue;
  if (values.some((v) => v.includes('\\(') || v.includes('$'))) continue;   // already LaTeX
  if (!values.some((v) => NEEDS_FIX.test(v))) continue;                      // nothing to fix

  const converted = values.map(convertOption);
  if (converted.every((c) => c !== null)) {
    conversions.push({ row, converted });
  } else if (values.some((v) => /\d\s*-\s*\d|\bs\s*-\s*1\b/.test(v))) {
    skipped.push({ id: row.id, values });
  }
}

console.log(`rows fully convertible : ${conversions.length.toLocaleString()}`);
console.log(`rows skipped (shape not uniform): ${skipped.length.toLocaleString()}`);

console.log('\n── Conversion samples ──');
for (const c of conversions.slice(0, 6)) {
  console.log(`  ${c.row.id} (${c.row.subject})`);
  for (let i = 0; i < OPTIONS.length; i++) {
    console.log(`    ${c.row[OPTIONS[i]]}   →   ${c.converted[i]}`);
  }
}

if (skipped.length) {
  console.log('\n── Skipped samples (left untouched) ──');
  for (const s of skipped.slice(0, 6)) console.log(`  ${s.id}: ${JSON.stringify(s.values)}`);
}

if (APPLY && conversions.length > 0) {
  const update = db.prepare(`UPDATE questions SET ${OPTIONS.map((o) => `${o} = ?`).join(', ')} WHERE id = ?`);
  for (const c of conversions) update.run(...c.converted, c.row.id);
  console.log(`\nAPPLIED — ${conversions.length.toLocaleString()} rows converted.`);
} else if (!APPLY) {
  console.log('\nDry run complete. Re-run with --apply to write these conversions.');
}

db.close();
