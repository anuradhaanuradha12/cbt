// Compare prod ORIGINALS (not-yet-re-uploaded = pre-regeneration vintage)
// vs local REGENERATED blobs for figure keys. Flags over-cleaning:
// dark-pixel fraction (px < 180) local vs original, dims, and blanks.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import sharp from 'sharp';
import { DatabaseSync } from 'node:sqlite';

const BLOBS = '.wrangler/state/v3/r2/cbt-media/blobs';
const R2DB = '.wrangler/state/v3/r2/miniflare-R2BucketObject/194bbc29de3b4694bd639ccc09e5475cd2776490ad3555e45c5b55096bc5b020.sqlite';
const BASE = 'https://qforge.shishira-932.workers.dev';

const r2 = new DatabaseSync(R2DB, { readOnly: true });
const state = JSON.parse(fs.readFileSync('tmp-upload-state.json', 'utf8'));
const done = new Set(state.uploaded);

const all = r2.prepare("SELECT key FROM _mf_objects WHERE key LIKE 'questions/%'").all().map(r => r.key);
const pending = all.filter(k => !done.has(k));

const N = Number(process.argv[2] || 40);
const step = Math.max(1, Math.floor(pending.length / N));
const sample = pending.filter((_, i) => i % step === 0).slice(0, N);

async function darkFrac(buf) {
  const { data, info } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
  let dark = 0;
  for (const v of data) if (v < 180) dark++;
  return dark / (info.width * info.height);
}

function fetchProd(key) {
  for (let a = 1; a <= 3; a++) {
    try {
      execFileSync('curl', ['-s', '--max-time', '20', '-o', 'tmp-probe.bin', `${BASE}/images/${key}`]);
      return fs.readFileSync('tmp-probe.bin');
    } catch (e) {
      if (a === 3) return null;
    }
  }
}

let blanks = 0, dimMismatch = 0, heavyLoss = 0, checked = 0, fetchErrs = 0;
const report = [];

for (const key of sample) {
  const row = r2.prepare('SELECT blob_id FROM _mf_objects WHERE key=?').get(key);
  if (!row) continue;
  const localBuf = fs.readFileSync(`${BLOBS}/${row.blob_id}`);
  const prodBuf = fetchProd(key);
  if (!prodBuf) { fetchErrs++; report.push(`${key} FETCH-FAIL`); continue; }
  try {
    const lm = await sharp(localBuf).metadata();
    const pm = await sharp(prodBuf).metadata();
    const lf = await darkFrac(localBuf);
    const pf = await darkFrac(prodBuf);
    checked++;
    const fname = key.split('/')[2] || '(none)';
    const short = fname.slice(0, 2) + ':' + fname.slice(2, 8);
    const flags = [];
    if (lf < 0.001) { flags.push('BLANK'); blanks++; }
    if (lm.width !== pm.width || lm.height !== pm.height) { flags.push('DIMS'); dimMismatch++; }
    if (pf > 0.01 && lf < pf * 0.25) { flags.push(`LOSS ${((1 - lf / pf) * 100).toFixed(0)}%`); heavyLoss++; }
    if (flags.length) report.push(`${short} ${pm.width}x${pm.height}->${lm.width}x${lm.height} dark ${((pf) * 100).toFixed(2)}%->${((lf) * 100).toFixed(2)}% ${flags.join(',')}`);
  } catch (e) {
    report.push(`${key} ERR ${e.message.slice(0, 60)}`);
  }
}

console.log(`checked: ${checked} (fetch errors: ${fetchErrs})`);
console.log(`blank regenerated: ${blanks}`);
console.log(`dimension mismatches: ${dimMismatch}`);
console.log(`heavy stroke loss (>75% of dark px removed where orig had >1%): ${heavyLoss}`);
if (report.length) console.log('\n' + report.join('\n'));
if (!blanks && !dimMismatch && !heavyLoss) console.log('REGENERATION QUALITY OK ✓');
