// Byte-verify that prod is serving the CLEANED external-image bytes.
// Truth = local files in external-images-local/external/<key> (post clean-external-watermarks.mjs).
// Compares sha256(local) vs sha256(prod GET /images/<key>) for a sample of
// uploaded keys plus every key whose cleaned upload FAILED (expected mismatch
// until the retry pass runs).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'https://qforge.shishira-932.workers.dev';
const LOCAL_DIR = 'external-images-local/external';
const state = JSON.parse(readFileSync('tmp-ext-upload-state.json', 'utf8'));
const uploaded = new Set(state.uploaded);

const all = readdirSync(LOCAL_DIR).map(f => `external/${f}`);
const uploadedKeys = all.filter(k => uploaded.has(k));
const failedKeys = all.filter(k => !uploaded.has(k));

// sample up to 60 uploaded keys spread across the list
const SAMPLE = 60;
const step = Math.max(1, Math.floor(uploadedKeys.length / SAMPLE));
const sample = uploadedKeys.filter((_, i) => i % step === 0).slice(0, SAMPLE);
const toCheck = [...sample, ...failedKeys];

const MAXKEYS = Number(process.argv[2] || Infinity);
const t0 = Date.now();
const tmpDir = mkdtempSync(join(tmpdir(), 'imgverify-'));
let match = 0, mismatch = [], errors = [];

let done = 0;
for (const key of toCheck) {
  if (done >= MAXKEYS) break;
  const localPath = join(LOCAL_DIR, key.replace('external/', ''));
  if (!existsSync(localPath)) { errors.push([key, 'local file missing']); continue; }
  const localHash = createHash('sha256').update(readFileSync(localPath)).digest('hex');
  const outFile = join(tmpDir, 'out.bin');
  try {
    execFileSync('curl', ['-s', '--max-time', '20', '--connect-timeout', '10',
      '-o', outFile, `${BASE}/images/${key}`],
      { encoding: 'utf8', timeout: 25000 });
    const prodHash = createHash('sha256').update(readFileSync(outFile)).digest('hex');
    if (prodHash === localHash) match++;
    else mismatch.push(key);
  } catch (e) {
    errors.push([key, String(e.message).slice(0, 80)]);
  }
  done++;
  console.log(`  ...${done}/${toCheck.length} ${key} (${Date.now() - t0}ms)`);
}
rmSync(tmpDir, { recursive: true, force: true });

console.log(`checked: ${toCheck.length} (sample ${sample.length} + failed ${failedKeys.length})`);
console.log(`byte-identical: ${match}`);
if (mismatch.length) console.log(`MISMATCH (${mismatch.length}):`, mismatch.slice(0, 20).join(', '));
if (errors.length) console.log(`ERRORS (${errors.length}):`, errors.slice(0, 10));
if (mismatch.length === 0 && errors.length === 0) console.log('ALL CLEAN ✓');
