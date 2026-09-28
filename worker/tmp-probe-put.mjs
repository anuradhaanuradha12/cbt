import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

const tomlPath = process.env.APPDATA + '/xdg.config/.wrangler/config/default.toml';
const TOKEN = fs.readFileSync(tomlPath, 'utf8').match(/oauth_token\s*=\s*"([^"]+)"/)[1];
const API = 'https://api.cloudflare.com/client/v4/accounts/9325072bdbc32761b8550ef602ebf81e/r2/buckets/cbt-media/objects';
const key = 'external/d3dfc9c1149520eb45c4e123a6adae2b6cb47183.png';
const p = 'external-images-local/external/d3dfc9c1149520eb45c4e123a6adae2b6cb47183.png';
const respFile = 'tmp-probe-resp.json';

execFile('curl', ['-sS', '--max-time', '300', '-H', `Authorization: Bearer ${TOKEN}`,
  '-X', 'PUT', '-H', 'Content-Type: image/png', '--data-binary', `@${p}`,
  '-o', respFile, '-w', '%{http_code}', `${API}/${encodeURIComponent(key)}`],
  { windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  (err, stdout, stderr) => {
    console.log('err:', err ? err.message : 'none');
    console.log('stdout (http code):', String(stdout));
    console.log('stderr:', String(stderr).slice(0, 300));
    if (fs.existsSync(respFile)) {
      console.log('resp body:', fs.readFileSync(respFile, 'utf8').slice(0, 300));
      fs.unlinkSync(respFile);
    } else console.log('no resp file');
  });
