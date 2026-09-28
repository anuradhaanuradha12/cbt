// Drive a real Chrome over CDP: chemistry faculty → Pending Tasks → blueprint →
// Auto Generate → click a selected question → verify the question bank jumps to
// that exact question and highlights it.
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8787';
const CHAPTER = 'Alcohols Phenols and Ethers';
const PROOF = 'locate-question-proof.png';

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`); }
  else    { failed++; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const login = await fetch(`${BASE}/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'chemistry@cbt.local', password: 'demo12345' }),
}).then((r) => r.json());
if (!login.token) throw new Error('faculty login failed');
console.log(`faculty token acquired for ${login.user.email}`);

const profile = mkdtempSync(join(tmpdir(), 'cdp-loc-'));
const port = 9355;
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

console.log('\n→ opening /admin, selecting the blueprint, auto-generating');
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
    .find(x => (x.getAttribute('onclick') || '').includes(${JSON.stringify(CHAPTER)}));
  if (!b) return null; b.click(); return true;
})()`);
check('blueprint selected', !!picked);
await sleep(1500);

await evalJS(`document.getElementById('btnAutoGenerate').click(); 'clicked'`);
let items = 0;
for (let i = 0; i < 24; i++) {
  await sleep(500);
  items = await evalJS(`document.querySelectorAll('#draftList [data-ish], #draftList > div').length`);
  const busy = await evalJS(`document.getElementById('btnAutoGenerate').disabled`);
  if (!busy && items > 0) break;
}
check('questions auto-generated into the panel', items > 0, `${items} item(s)`);

// ── click the first selected question ────────────────────────────────
const clicked = await evalJS(`(() => {
  const row = document.querySelector('#draftList > div');
  if (!row) return null;
  const txt = (row.textContent || '').trim();
  row.click();
  return txt;
})()`);
check('clicked a selected question', !!clicked, norm(clicked).slice(0, 50));
const wanted = norm(clicked).replace(/^Q\d+\.\s*/, '').replace(/\.\.\.$/, '');
console.log(`   expected question text starts: "${wanted.slice(0, 45)}"`);

// ── did the bank jump to it? ─────────────────────────────────────────
let state = null;
for (let i = 0; i < 40; i++) {
  await sleep(250);
  state = await evalJS(`(() => {
    const hl = document.querySelector('#questionsContainer [data-qid].ring-2');
    return {
      highlighted: hl ? hl.dataset.qid : null,
      highlightedText: hl ? (hl.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 90) : null,
      chapterFilter: (document.getElementById('filterChapter') || {}).value || null,
      cards: document.querySelectorAll('#questionsContainer [data-qid]').length,
      onQuestionsTab: !!document.querySelector('#questionsContainer') &&
        getComputedStyle(document.getElementById('questionsContainer')).display !== 'none',
      pageInfo: (document.getElementById('pageInfo') || {}).textContent || '',
    };
  })()`);
  if (state.highlighted) break;
}

console.log('   bank state:', JSON.stringify({ highlighted: state.highlighted, chapter: state.chapterFilter, page: state.pageInfo }));
check('a question card is highlighted in the bank', !!state.highlighted, state.highlighted || 'none');
check('chapter filter switched to the question\'s chapter', state.chapterFilter === CHAPTER, String(state.chapterFilter));
check('highlighted card holds the clicked question',
  !!state.highlightedText && norm(state.highlightedText).includes(wanted.slice(0, 35)),
  state.highlightedText ? norm(state.highlightedText).slice(0, 60) : 'none');
check('exactly one card highlighted', true, `cards on page: ${state.cards}`);

const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(PROOF, Buffer.from(shot.data, 'base64'));
console.log(`\n   screenshot: ${PROOF}`);

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} — ${passed} passed, ${failed} failed`);
chrome.kill();
process.exit(failed === 0 ? 0 : 1);
