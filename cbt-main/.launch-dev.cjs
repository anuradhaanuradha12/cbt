// Detached launcher for `wrangler dev`.
// Spawns: node <worker>/node_modules/wrangler/bin/wrangler.js dev
// New process group, no inherited console handles -> survives the calling shell.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const workerDir = path.join(root, 'worker');
const wranglerJs = path.join(workerDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const logFd = fs.openSync(path.join(workerDir, 'dev-server.log'), 'a');

const child = spawn(process.execPath, [wranglerJs, 'dev'], {
  cwd: workerDir,
  detached: true,
  windowsHide: true,
  stdio: ['ignore', logFd, logFd],
  env: { ...process.env, CLOUDFLARE_TELEMETRY: '0' },
});

child.unref();
console.log('launched detached wrangler dev (pid', child.pid + ')');
setTimeout(() => process.exit(0), 500);
