// Drive a real Chrome over CDP: principal → Notifications → verify the simple
// per-subject completed / not-completed summary renders.
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8787';
const PROOF = 'quota-status-proof.png';

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`); }
  else    { failed++; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const login = await fetch(`${BASE}/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'principal@example.com', password: 'demo12345' }),
}).then((r) => r.json());
if (!login.token) throw new Error('principal login failed');
console.log(`principal token acquired for ${login.user.email}`);

const profile = mkdtempSync(join(tmpdir(), 'cdp-qs-'));
const port = 9377;
const chrome = execFile(CHROME, [
  '--headless=new', '--remote-debugging-port=' + port, '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--user-data-dir=' + profile, 'about:blank',
]);
process.on('exit', () => { try { chrome.kill(); } catch {} });

let version = null;
for (let i = 0; i < 30; i++) {
  try { version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()); break; }
  catch { await sleep(500); }
}
if (!version) throw new Error('chrome CDP never came up');
console.log('chrome up:', version.Browser);

const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json());
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

let mid = 0;
const pending = new Map();
ws.on('message', (buf) => {
  const msg = JSON.parse(buf.toString());
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++mid;
    pending.set(id, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
const evalJS = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('page JS: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};

// admin.html blocks its parser on CDN <script> tags in <head>, and admin.js only
// wires the tab handlers at the end of its DOMContentLoaded run — so a fixed sleep
// both hangs on a slow CDN and can click into a page with no handlers attached.
// Click the tab until the app lights it up; only its own handler does that.
const openTab = async (name, ms = 60000) => {
  const lit = `(() => { const l = document.querySelector('[data-tab="${name}"]'); return !!l && l.classList.contains('bg-indigo-500/10'); })()`;
  const click = `(() => { const l = document.querySelector('[data-tab="${name}"]'); if (l) l.click(); return !!l; })()`;
  for (let w = 0; w <= ms; w += 500) {
    try {
      if (await evalJS(lit)) return true;
      await evalJS(click);
    } catch { /* page still parsing — keep polling */ }
    await sleep(500);
  }
  return false;
};

await send('Page.enable');
await send('Page.navigate', { url: `${BASE}/` });
await sleep(1500);
await evalJS(`localStorage.setItem('cbt_token', ${JSON.stringify(login.token)}); localStorage.setItem('cbt_user', ${JSON.stringify(JSON.stringify(login.user))}); 'seeded'`);

console.log('\n→ opening Notifications');
await send('Page.navigate', { url: `${BASE}/admin#notifications` });
const notifOpen = await openTab('notifications');
console.log('   notifications tab opened:', notifOpen);

let state = null;
for (let i = 0; i < 30; i++) {
  await sleep(500);
  state = await evalJS(`(() => {
    const box = document.getElementById('quotaStatusSummary');
    const t = box ? (box.textContent || '').replace(/\\s+/g, ' ').trim() : '';
    return {
      present: !!box,
      text: t.slice(0, 260),
      completed: (t.match(/✓ Completed/g) || []).length,
      notCompleted: (t.match(/✗ Not completed/g) || []).length,
      exams: box ? box.querySelectorAll('[data-exam-status]').length : 0,
      statusChips: box ? [...box.querySelectorAll('[data-exam-status]')].map(el => el.getAttribute('data-exam-status')) : [],
      hasCounts: /\\(\\d+\\/\\d+/.test(t),
      alerts: document.querySelectorAll('#notificationsList > div').length,
    };
  })()`);
  if (state.completed + state.notCompleted > 0) break;
}

console.log('   summary:', state.text);
check('summary panel is present on Notifications', state.present);
check('shows completed subjects', state.completed > 0, `${state.completed}`);
check('shows not-completed subjects', state.notCompleted > 0, `${state.notCompleted}`);
// Only exams that still owe quota work are listed, so the count moves as exams
// get filled and published — assert the grouping, not a fixed number.
check('groups by exam with a status chip',
  state.exams >= 1 && state.statusChips.every(s => s), `${state.exams} exam chip(s): ${state.statusChips.join(', ')}`);
check('published exams are excluded (nothing left to fill)',
  !state.statusChips.includes('published'), state.statusChips.join(', '));
check('shows selected/required counts', state.hasCounts);
check('the existing alert list still renders below it', state.alerts > 0, `${state.alerts} alert(s)`);

const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(PROOF, Buffer.from(shot.data, 'base64'));
console.log(`\n   screenshot: ${PROOF}`);

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} — ${passed} passed, ${failed} failed`);
chrome.kill();
process.exit(failed === 0 ? 0 : 1);
