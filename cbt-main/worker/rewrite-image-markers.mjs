// ─── Rewrite [IMAGE: url] markers to local R2 URLs ───────────────────────────
// Second half of the CDN-image fix: replaces every
//     [IMAGE: https://cdn-question-pool.getmarks.app/…]
// marker inside question text / options / explanations with
//     [IMG:/images/external/<hash>.<ext>]
//
// [IMG:…] is a compact, frontend-agnostic token: it contains no spaces or
// brackets, so it survives inside any HTML attribute and is trivially
// converted to <img> by the render helpers (exam.js / results.js / admin.js).
// The literal "[IMAGE: …]" form is left for any URL that failed to ingest, so
// missing images stay visibly broken instead of silently becoming broken <img>
// tags with a dead local URL.
//
// Usage:
//   node rewrite-image-markers.mjs            # dry run — reports only
//   node rewrite-image-markers.mjs --apply    # writes the rewrites

import fs from 'node:fs';

const { DatabaseSync } = await import('node:sqlite');

const DB_FILE = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject/82ed3d9ff502f7382874778df6ecb14db42da56def327314e2a27be609632375.sqlite';
const MAP_FILE = 'external-images-map.json';
const FIELDS = ['question_text', 'option_a', 'option_b', 'option_c', 'option_d', 'explanation'];
const APPLY = process.argv.includes('--apply');

const map = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
console.log(`url→key map: ${Object.keys(map).length.toLocaleString()} entries\n`);

const db = new DatabaseSync(DB_FILE, { readOnly: !APPLY });
const rows = db.prepare(`SELECT id, ${FIELDS.join(', ')} FROM questions`).all();

const update = APPLY
  ? db.prepare(`UPDATE questions SET ${FIELDS.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`)
  : null;

const MARKER = /\[IMAGE:\s*(https?:\/\/[^\]\s]+)\s*\]/g;
let rowsChanged = 0;
let markersReplaced = 0;
let markersUnresolved = 0;
const unresolvedSamples = [];
const samples = [];

for (const row of rows) {
  const values = [];
  let touched = false;

  for (const f of FIELDS) {
    const raw = row[f];
    if (typeof raw !== 'string' || !raw.includes('[IMAGE:')) {
      values.push(raw);
      continue;
    }

    let fieldUnresolved = 0;
    let firstUnresolvedUrl = null;
    const fixed = raw.replace(MARKER, (whole, url) => {
      const key = map[url];
      if (!key) {
        fieldUnresolved++;
        if (!firstUnresolvedUrl) firstUnresolvedUrl = url;
        return whole;   // keep the original marker — it stays visibly broken
      }
      return `[IMG:/images/${key}]`;
    });

    if (fieldUnresolved > 0) {
      markersUnresolved += fieldUnresolved;
      if (unresolvedSamples.length < 6) {
        unresolvedSamples.push({ id: row.id, field: f, url: firstUnresolvedUrl });
      }
    }

    if (fixed !== raw) {
      if (samples.length < 5) samples.push({ id: row.id, field: f, before: raw.slice(0, 90), after: fixed.slice(0, 90) });
      markersReplaced++;
      touched = true;
    }
    values.push(fixed);
  }

  if (touched) {
    rowsChanged++;
    if (update) update.run(...values, row.id);
  }
}

console.log(`questions modified     : ${rowsChanged.toLocaleString()}`);
console.log(`markers replaced       : ${markersReplaced.toLocaleString()}`);
console.log(`markers left (no image): ${markersUnresolved.toLocaleString()}`);

if (samples.length) {
  console.log('\n── Samples ──');
  for (const s of samples) {
    console.log(`  ${s.id} .${s.field}`);
    console.log(`    before: ${JSON.stringify(s.before)}`);
    console.log(`    after : ${JSON.stringify(s.after)}`);
  }
}
if (unresolvedSamples.length) {
  console.log('\n── Unresolved (CDN 403s — left as [IMAGE: …]) ──');
  for (const s of unresolvedSamples) console.log('  ' + JSON.stringify(s));
}

if (APPLY) console.log(`\nAPPLIED.`);
else console.log('\nDry run complete. Re-run with --apply to write these rewrites.');

db.close();
