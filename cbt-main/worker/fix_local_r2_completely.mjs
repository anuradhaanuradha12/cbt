import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

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
  
  const fileBuffer = fs.readFileSync(blobPath);
  const size = fileBuffer.length;
  
  // Calculate MD5 for ETag and checksums
  const md5Hash = crypto.createHash('md5').update(fileBuffer).digest('hex');
  const checksums = JSON.stringify({ md5: md5Hash });
  
  db.prepare('UPDATE _mf_objects SET size = ?, etag = ?, checksums = ? WHERE blob_id = ?')
    .run(size, md5Hash, checksums, row.blob_id);
    
  updated++;
}

db.close();
console.log(`Completely fixed metadata (size, etag, md5) for ${updated} local R2 blobs.`);
