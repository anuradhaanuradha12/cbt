import { DatabaseSync } from 'node:sqlite';
import { execSync } from 'node:child_process';
import path from 'path';
import fs from 'fs';

const dbPath = fs.readdirSync('.wrangler/state/v3/r2/miniflare-R2BucketObject')
  .filter(f => f.endsWith('.sqlite'))
  .map(f => path.join('.wrangler/state/v3/r2/miniflare-R2BucketObject', f))[0];

const blobsDir = '.wrangler/state/v3/r2/cbt-media/blobs';

if (!dbPath) {
  console.error("Local R2 SQLite database not found.");
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
// Use the latest blob_id for each key
const rows = db.prepare('SELECT key, blob_id FROM _mf_objects ORDER BY rowid ASC').all();
db.close();

const latestBlobs = new Map();
for (const row of rows) {
    latestBlobs.set(row.key, row.blob_id);
}

console.log(`Found ${latestBlobs.size} unique objects mapped in local state.`);

let success = 0;
let errors = 0;

for (const [key, blob_id] of latestBlobs.entries()) {
  const blobPath = path.join(blobsDir, blob_id);
  if (!fs.existsSync(blobPath)) {
    console.log(`Skipping ${key} (blob missing: ${blob_id})`);
    continue;
  }
  
  const cmd = `npx wrangler r2 object put "cbt-media/${key}" --file "${blobPath}"`;
  
  try {
    console.log(`Uploading ${key}...`);
    execSync(cmd, { stdio: 'ignore' });
    success++;
  } catch (e) {
    console.error(`Error uploading ${key}`);
    errors++;
  }
}

console.log(`\nUpload complete! Successfully uploaded: ${success}, Errors: ${errors}`);
