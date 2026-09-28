// exact copy of the script's uploadOne for one key, with verbose logging
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';

const API = 'https://api.cloudflare.com/client/v4/accounts/9325072bdbc32761b8550ef602ebf81e/r2/buckets/cbt-media/objects';
const SRC_DIR = 'external-images-local';
const EXT_TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const tomlPath = process.env.APPDATA + '/xdg.config/.wrangler/config/default.toml';
let TOKEN = fs.readFileSync(tomlPath, 'utf8').match(/oauth_token\s*=\s*"([^"]+)"/)[1];

function curl(args) {
  try { TOKEN = fs.readFileSync(tomlPath, 'utf8').match(/oauth_token\s*=\s*"([^"]+)"/)[1]; } catch {}
  return new Promise((resolve) => {
    execFile('curl', ['-sS', '--max-time', '300', '-H', `Authorization: Bearer ${TOKEN}`, ...args],
      { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => resolve({ err, stdout }));
  });
}

const key = 'external/8ce92d2ce6f3a84ea31a8dbd66a66cad0f898597.png';
const p = path.join(SRC_DIR, key);
console.log('path used:', JSON.stringify(p));
const buf = fs.readFileSync(p);
const type = EXT_TYPES[key.split('.').pop()];
const respFile = 'tmp-probe2-resp.json';
const { err, stdout } = await curl(['-X', 'PUT', '-H', `Content-Type: ${type}`, '--data-binary', `@${p}`, '-o', respFile, '-w', '%{http_code}', `${API}/${encodeURIComponent(key)}`]);
console.log('curl err:', err ? err.message : 'none');
console.log('http code:', String(stdout).trim());
if (fs.existsSync(respFile)) {
  const body = fs.readFileSync(respFile, 'utf8');
  console.log('resp body:', body.slice(0, 250));
  try { const j = JSON.parse(body); console.log('parsed size:', Number(j.result?.size), 'expected:', buf.length); } catch (e) { console.log('parse error:', e.message); }
  fs.unlinkSync(respFile);
} else console.log('NO resp file written');
