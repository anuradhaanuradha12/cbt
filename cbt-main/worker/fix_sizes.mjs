import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';

const blobsDir = '.wrangler/state/v3/r2/cbt-media/blobs';
const dbPath = fs.readdirSync('.wrangler/state/v3/r2/miniflare-R2BucketObject')
  .filter(f => f.endsWith('.sqlite'))
  .map(f => path.join('.wrangler/state/v3/r2/miniflare-R2BucketObject', f))[0];

const db = new DatabaseSync(dbPath);
const rows = db.prepare('SELECT key, blob_id FROM _mf_objects').all();

let updated = 0;
for (const row of rows) {
  const blobPath = path.join(blobsDir, row.blob_id);
  if (!fs.existsSync(blobPath)) continue;
  
  const stats = fs.statSync(blobPath);
  db.prepare('UPDATE _mf_objects SET size = ? WHERE blob_id = ?').run(stats.size, row.blob_id);
  updated++;
}

db.close();
console.log(`Updated size metadata for ${updated} blobs to fix broken images.`);
