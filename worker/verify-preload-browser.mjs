// Drive a real Chrome over CDP: maths faculty → JEE $ → verify the Active
// Blueprint panel preloads the questions already saved in the exam, shows the
// quota as progress, and that Auto Generate refuses to double-fill.
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8787';
const EXAM_TITLE = 'JEE $';
const PROOF = 'preload-quota-proof.png';

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`); }
  else    { failed++; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const login = await fetch(`${BASE}/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'maths@cbt.local', password: 'demo12345' }),
}).then((r) => r.json());
if (!login.token) throw new Error('maths faculty login failed');
console.log(`faculty token acquired for ${login.user.email} (${login.user.subject})`);

const profile = mkdtempSync(join(tmpdir(), 'cdp-pre-'));
const port = 9366;
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

console.log(`\n→ opening /admin and selecting the "${EXAM_TITLE}" blueprint`);
await send('Page.navigate', { url: `${BASE}/admin` });
const tasksOpen = await openTab('tasks');
console.log('   tasks tab opened:', tasksOpen);

let blueprints = 0;
for (let i = 0; i < 20; i++) {
  blueprints = await evalJS(`document.querySelectorAll('#tasksList button').length`);
  if (blueprints > 0) break;
  await sleep(500);
}
check('blueprint(s) listed', blueprints > 0, `${blueprints}`);

const picked = await evalJS(`(() => {
  const b = [...document.querySelectorAll('#tasksList button')]
    .find(x => (x.getAttribute('onclick') || '').includes(${JSON.stringify(EXAM_TITLE)}));
  if (!b) return null; b.click(); return true;
})()`);
check(`selected the "${EXAM_TITLE}" blueprint`, !!picked);

// wait for the preload to land
let state = null;
for (let i = 0; i < 30; i++) {
  await sleep(500);
  state = await evalJS(`(() => {
    const items = [...document.querySelectorAll('#draftList > div')];
    return {
      count: (document.getElementById('draftCount') || {}).textContent || '',
      items: items.length,
      savedBadges: items.filter(el => /\\bsaved\\b/.test(el.textContent || '')).length,
      quota: (document.getElementById('facultyTargetQuota') || {}).textContent || '',
      ticks: ((document.getElementById('facultyTargetQuota') || {}).textContent || '').split('✓').length - 1,
      removeButtons: items.filter(el => el.querySelector('.remove-btn')).length,
    };
  })()`);
  if (state.items > 0) break;
}

console.log('   panel:', JSON.stringify(state));
check('panel preloads the questions already saved in the exam', state.items > 0, `${state.items} item(s)`);
check('all preloaded items are marked "saved"', state.savedBadges === state.items, `${state.savedBadges}/${state.items}`);
check('counter reflects the real total', /^([1-9]\d*)\s*Qs/.test(state.count.trim()), state.count.trim());
check('quota shows progress for Circle', state.quota.includes('Circle: 5/5'), state.quota.replace(/\s+/g, ' ').trim());
check('quota shows progress for Complex Number', state.quota.includes('Complex Number: 5/5'));
check('both chapters show as complete', state.ticks >= 2, `${state.ticks} ✓`);
check('saved questions are not offered a bogus remove', state.removeButtons === 0, `${state.removeButtons} remove button(s)`);

// ── Auto Generate must refuse to double-fill ─────────────────────────
console.log('\n→ clicking Auto Generate (quota already complete)');
const before = state.items;
await evalJS(`document.getElementById('btnAutoGenerate').click(); 'clicked'`);
await sleep(4000);
const after = await evalJS(`(() => ({
  items: document.querySelectorAll('#draftList > div').length,
  count: (document.getElementById('draftCount') || {}).textContent || '',
}))()`);
console.log('   panel:', JSON.stringify(after));
check('Auto Generate adds nothing when the quota is full', after.items === before, `${before} → ${after.items}`);

const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(PROOF, Buffer.from(shot.data, 'base64'));
console.log(`\n   screenshot: ${PROOF}`);

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} — ${passed} passed, ${failed} failed`);
chrome.kill();
process.exit(failed === 0 ? 0 : 1);
