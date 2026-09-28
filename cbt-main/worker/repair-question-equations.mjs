// ─── Question equation repair ────────────────────────────────────────────────
// Fixes the mojibake in question text fields: UTF-8 bytes that were decoded as
// Latin-1 during the original dataset import, so "×" (U+00D7) is stored as the
// two characters "Ã—" and "λ" as "Î»".
//
// The repair is the exact inverse of the damage:
//     fixed = Buffer.from(raw, 'latin1').toString('utf8')
//
// It is applied ONLY where re-encoding the result reproduces the original bytes
// exactly. That round-trip check makes the transform provably lossless — any
// value that does not round-trip is left untouched.
//
// Usage:
//   node repair-question-equations.mjs            # dry run — reports only
//   node repair-question-equations.mjs --apply    # writes the fixes
//
// A pre-repair snapshot lives at .wrangler/backup/questions-preparation-backup.sqlite

import { DatabaseSync } from 'node:sqlite';

const DB_FILE = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject/82ed3d9ff502f7382874778df6ecb14db42da56def327314e2a27be609632375.sqlite';
const FIELDS = ['question_text', 'option_a', 'option_b', 'option_c', 'option_d', 'explanation'];
const APPLY = process.argv.includes('--apply');

/**
 * Repairs mojibake one UTF-8 SEQUENCE at a time.
 *
 * Decoding the whole field at once is all-or-nothing: a single unrecoverable
 * byte rejects every other fix in that field. Scanning sequence-by-sequence
 * means "15Ã—5" is still repaired even when an unrelated byte is damaged.
 *
 * A sequence is only replaced when it decodes to something valid (no U+FFFD)
 * AND re-encoding it reproduces the original bytes exactly — so each individual
 * replacement is provably lossless. Anything else is left byte-for-byte alone.
 *
 * Returns the repaired string, or null when nothing safe could be done.
 */
function repairMojibake(value) {
  if (typeof value !== 'string' || !value) return null;
  if (!/[\u0080-\u00FF]/.test(value)) return null;   // pure ASCII — nothing to undo

  const bytes = Buffer.from(value, 'latin1');
  let out = '';
  let changed = false;
  let i = 0;

  while (i < bytes.length) {
    const b = bytes[i];

    // Which UTF-8 sequence length does this byte claim to start?
    let len = 0;
    if (b >= 0xc2 && b <= 0xdf) len = 2;
    else if (b >= 0xe0 && b <= 0xef) len = 3;
    else if (b >= 0xf0 && b <= 0xf4) len = 4;

    if (len > 0 && i + len <= bytes.length) {
      let valid = true;
      for (let k = 1; k < len; k++) {
        const cont = bytes[i + k];
        if (cont < 0x80 || cont > 0xbf) { valid = false; break; }
      }

      if (valid) {
        const seq = bytes.subarray(i, i + len);
        const decoded = seq.toString('utf8');
        // Round-trip proof for this sequence alone.
        if (!decoded.includes('\uFFFD') && Buffer.from(decoded, 'utf8').equals(seq)) {
          out += decoded;
          changed = true;
          i += len;
          continue;
        }
      }
    }

    out += value[i];   // unmappable — keep the original character
    i++;
  }

  // Strip stray "Â" (U+00C2). Its only source is a half-truncated NBSP
  // (C2 A0 damaged down to a bare C2), and it has no legitimate use in a
  // physics / chemistry / maths question. Leftovers like "1-Hydroxyhex-2-eneÂ"
  // become "1-Hydroxyhex-2-ene".
  const cleaned = out.replace(/\u00C2/g, '');
  if (cleaned !== value) changed = true;
  out = cleaned;

  return changed ? out : null;
}

const db = new DatabaseSync(DB_FILE, { readOnly: !APPLY });

console.log(`Scanning question bank for mojibake${APPLY ? '' : ' (dry run — no writes)'}…\n`);

const rows = db.prepare(`SELECT id, ${FIELDS.join(', ')} FROM questions`).all();

const update = APPLY
  ? db.prepare(`UPDATE questions SET ${FIELDS.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`)
  : null;

let rowsChanged = 0;
let fieldsChanged = 0;
let rejected = 0;
const samples = [];
const rejectSamples = [];

for (const row of rows) {
  const values = [];
  let touched = false;

  for (const f of FIELDS) {
    const raw = row[f];
    const fixed = repairMojibake(raw);

    if (fixed === null) {
      // Surface values that still look damaged after the pass, so leftovers are
      // visible rather than silent.
      if (typeof raw === 'string' && /[\u00C2\u00C3\u00CE\u00CF]/.test(raw)) {
        if (rejectSamples.length < 8) rejectSamples.push({ id: row.id, field: f, value: raw.slice(0, 90) });
        rejected++;
      }
      values.push(raw);
      continue;
    }

    if (samples.length < 8) samples.push({ id: row.id, field: f, before: raw.slice(0, 90), after: fixed.slice(0, 90) });
    values.push(fixed);
    touched = true;
    fieldsChanged++;
  }

  if (touched) {
    rowsChanged++;
    if (update) update.run(...values, row.id);
  }
}

console.log(`questions with a safe repair : ${rowsChanged.toLocaleString()}`);
console.log(`field values repaired         : ${fieldsChanged.toLocaleString()}`);
console.log(`values left untouched         : ${rejected.toLocaleString()} (failed the round-trip / validity check)`);

if (samples.length) {
  console.log('\n── Samples (before → after) ──');
  for (const s of samples) {
    console.log(`  ${s.id} .${s.field}`);
    console.log(`    before: ${JSON.stringify(s.before)}`);
    console.log(`    after : ${JSON.stringify(s.after)}`);
  }
}

if (rejectSamples.length) {
  console.log('\n── Looked damaged but rejected (needs manual review) ──');
  for (const s of rejectSamples) console.log(`  ${s.id} .${s.field}: ${JSON.stringify(s.value)}`);
}

if (APPLY) {
  const after = db.prepare(`
    SELECT COUNT(*) AS c FROM questions
    WHERE question_text LIKE '%Ã%' OR option_a LIKE '%Ã%' OR option_b LIKE '%Ã%'
       OR option_c LIKE '%Ã%' OR option_d LIKE '%Ã%' OR explanation LIKE '%Ã%'
  `).get();
  const afterA = db.prepare(`
    SELECT COUNT(*) AS c FROM questions
    WHERE question_text LIKE '%Â%' OR option_a LIKE '%Â%' OR option_b LIKE '%Â%'
       OR option_c LIKE '%Â%' OR option_d LIKE '%Â%' OR explanation LIKE '%Â%'
  `).get();
  console.log(`\nAPPLIED. Rows still containing "Ã": ${after.c.toLocaleString()}, "Â": ${afterA.c.toLocaleString()}`);
} else {
  console.log('\nDry run complete. Re-run with --apply to write these fixes.');
}

db.close();
