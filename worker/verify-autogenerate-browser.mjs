// Drive a real Chrome over CDP: sign in as chemistry faculty → Pending Tasks →
// select the blueprint → click "Auto Generate" → verify the questions are
// actually selected and displayed in the Active Blueprint panel.
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8787';
const CHAPTER = 'Alcohols Phenols and Ethers';
const PROOF = 'autogenerate-proof.png';

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`); }
  else    { failed++; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── faculty token ────────────────────────────────────────────────────
const login = await fetch(`${BASE}/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'chemistry@cbt.local', password: 'demo12345' }),
}).then((r) => r.json());
if (!login.token) throw new Error('faculty login failed: ' + JSON.stringify(login));
console.log(`faculty token acquired for ${login.user.email} (${login.user.subject})`);

// ── chrome ───────────────────────────────────────────────────────────
const profile = mkdtempSync(join(tmpdir(), 'cdp-ag-'));
const port = 9344;
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

// localStorage needs a real origin — land on the app root first
await send('Page.navigate', { url: `${BASE}/` });
await sleep(1500);
await evalJS(`localStorage.setItem('cbt_token', ${JSON.stringify(login.token)}); localStorage.setItem('cbt_user', ${JSON.stringify(JSON.stringify(login.user))}); 'seeded'`);

console.log('\n→ opening /admin as chemistry faculty');
await send('Page.navigate', { url: `${BASE}/admin` });
const tasksOpen = await openTab('tasks');
console.log('   tasks tab opened:', tasksOpen);

// ── Pending Tasks tab ────────────────────────────────────────────────
const openTasks = await evalJS(`(() => {
  const tab = document.querySelector('[data-tab="tasks"]');
  if (tab) tab.click();
  return !!tab;
})()`);
check('Pending Tasks tab found', openTasks);

// wait for the blueprint list to render
let blueprints = 0;
for (let i = 0; i < 20; i++) {
  blueprints = await evalJS(`document.querySelectorAll('#tasksList button').length`);
  if (blueprints > 0) break;
  await sleep(500);
}
check('blueprint(s) listed in Pending Tasks', blueprints > 0, `${blueprints} button(s)`);

// pick the blueprint whose quota includes our chapter
const picked = await evalJS(`(() => {
  const btns = [...document.querySelectorAll('#tasksList button')];
  const b = btns.find(x => (x.getAttribute('onclick') || '').includes(${JSON.stringify(CHAPTER)}));
  if (!b) return null;
  b.click();
  return b.getAttribute('onclick').slice(0, 70);
})()`);
check('blueprint with the chemistry quota selected', !!picked, picked || 'not found');
await sleep(2000);

// ── panel state before generating ────────────────────────────────────
const before = await evalJS(`(() => {
  const box = document.getElementById('autoGenerateBox');
  return {
    boxVisible: !!box && !box.classList.contains('hidden'),
    quota: (document.getElementById('facultyTargetQuota') || {}).textContent || '',
    count: (document.getElementById('draftCount') || {}).textContent || '',
    btn: !!document.getElementById('btnAutoGenerate'),
    preloaded: [...document.querySelectorAll('#draftList > div')].length,
    savedBadges: [...document.querySelectorAll('#draftList > div')]
      .filter(el => /Already saved in this exam/.test(el.innerHTML)).length,
  };
})()`);
console.log('   panel:', JSON.stringify(before));
check('Auto Generate section is visible for an active blueprint', before.boxVisible);
check('target quota shows the chemistry chapter', before.quota.includes(CHAPTER), before.quota.trim());
// The quota renders as progress — "<chapter>: <selected>/<required>" — and the
// panel preloads whatever the exam already holds, so quotas count from reality.
const qm = before.quota.match(/(\d+)\s*\/\s*(\d+)/);
const preloaded = qm ? Number(qm[1]) : 0;
const required = qm ? Number(qm[2]) : Number(before.quota.match(/:\s*(\d+)/)?.[1] || 0);
check('panel preloads the questions already saved in the exam',
  before.preloaded === preloaded && before.savedBadges === preloaded,
  `${before.preloaded} row(s), ${before.savedBadges} marked saved, quota shows ${preloaded} selected`);

// ── click Auto Generate ──────────────────────────────────────────────
console.log('\n→ clicking Auto Generate');
await evalJS(`document.getElementById('btnAutoGenerate').click(); 'clicked'`);

let after = null;
for (let i = 0; i < 24; i++) {
  await sleep(500);
  after = await evalJS(`(() => {
    const btn = document.getElementById('btnAutoGenerate');
    const items = [...document.querySelectorAll('#draftList > div')];
    return {
      busy: btn.disabled || /generat/i.test(btn.textContent || ''),
      count: (document.getElementById('draftCount') || {}).textContent || '',
      items: items.length,
      previews: items.map(el => (el.textContent || '').trim().slice(0, 46)),
      addedBadges: [...document.querySelectorAll('#questionsContainer .add-btn')].filter(b => /added/i.test(b.textContent)).length,
    };
  })()`);
  if (!after.busy && after.items > 0) break;
}

console.log('   panel:', JSON.stringify({ count: after.count, items: after.items, addedBadges: after.addedBadges }));
if (after.previews?.length) after.previews.slice(0, 5).forEach(p => console.log('     •', p));

check('questions were selected and displayed', after.items > 0, `${after.items} item(s) in the panel`);
check('Auto Generate tops up to the full chapter quota',
  required === 0 || after.items === required, `${after.items} vs required ${required}`);
check('counter updated', /^([1-9]\d*)\s*Qs/.test(after.count.trim()), after.count.trim());
check('selected items show question text', (after.previews || []).some(p => p.length > 10));

// ── screenshot ───────────────────────────────────────────────────────
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(PROOF, Buffer.from(shot.data, 'base64'));
console.log(`\n   screenshot: ${PROOF} (${Math.round(shot.data.length * 0.75 / 1024)} KB)`);

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} — ${passed} passed, ${failed} failed`);
chrome.kill();
process.exit(failed === 0 ? 0 : 1);
