import { DatabaseSync } from 'node:sqlite';
import { execSync } from 'node:child_process';
import path from 'path';
import fs from 'fs';

const dbPath = fs.readdirSync('.wrangler/state/v3/r2/miniflare-R2BucketObject')
  .filter(f => f.endsWith('.sqlite'))
  .map(f => path.join('.wrangler/state/v3/r2/miniflare-R2BucketObject', f))[0];

const db = new DatabaseSync(dbPath, { readOnly: true });
const row = db.prepare('SELECT key, blob_id FROM _mf_objects LIMIT 1').get();
db.close();

const blobPath = path.join('.wrangler/state/v3/r2/cbt-media/blobs', row.blob_id);
const cmd = `npx wrangler r2 object put "cbt-media/${row.key}" --file "${blobPath}"`;
console.log(cmd);
try {
  execSync(cmd, { stdio: 'inherit' });
} catch (e) {
  console.error("Failed");
}
