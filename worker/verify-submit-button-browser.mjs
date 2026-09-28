// Drive a real Chrome over CDP: faculty → Pending Tasks → verify each task card
// shows per-subject completion, that "Submit to Principal" appears ONLY on the
// completed one, and that clicking it moves the exam into principal review.
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8787';
const PROOF = 'submit-button-proof.png';

// This test genuinely submits a real exam, so it must put it back afterwards —
// leaving a faculty task stuck in "awaiting principal review" every run would
// quietly wreck the board it is meant to be checking.
const d1Dir = join(__dirname, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
const openDb = () => {
  const file = readdirSync(d1Dir).filter((f) => f.endsWith('.sqlite'))
    .map((f) => ({ f, size: statSync(join(d1Dir, f)).size }))
    .sort((a, b) => b.size - a.size)[0].f;
  return new DatabaseSync(join(d1Dir, file));
};
const examStatus = (title) => {
  const row = openDb().prepare('SELECT status FROM exams WHERE title = ? LIMIT 1').get(title);
  return row ? row.status : null;
};

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`); }
  else    { failed++; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const login = await fetch(`${BASE}/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'maths@cbt.local', password: 'demo12345' }),
}).then((r) => r.json());
if (!login.token) throw new Error('maths faculty login failed');
console.log(`faculty token acquired for ${login.user.email} (${login.user.subject})`);

const profile = mkdtempSync(join(tmpdir(), 'cdp-sub-'));
const port = 9388;
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
const pendingMap = new Map();
ws.on('message', (buf) => {
  const msg = JSON.parse(buf.toString());
  if (msg.id && pendingMap.has(msg.id)) { pendingMap.get(msg.id)(msg); pendingMap.delete(msg.id); }
});
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++mid;
    pendingMap.set(id, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
const evalJS = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('page JS: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};

// admin.html blocks its parser on CDN <script> tags in <head> (headless Chrome can
// sit in `loading` with no <body> for 10s+), and admin.js only wires the tab
// handlers at the very end of its DOMContentLoaded run. A fixed 3–4s sleep both
// hangs on a slow CDN and can click into a page whose handlers do not exist yet.
// So: click the tab until the app itself lights it up — only its handler does that.
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

console.log('\n→ opening Pending Tasks');
await send('Page.navigate', { url: `${BASE}/admin#tasks` });
const tasksOpen = await openTab('tasks');
check('the Pending Tasks tab opens', tasksOpen);

let cards = null;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  cards = await evalJS(`(() => {
    const els = [...document.querySelectorAll('#tasksList .p-5')];
    return els.map(el => ({
      title: ((el.querySelector('h3') || {}).textContent || '').trim(),
      done: /Task completed/.test(el.textContent || ''),
      progress: (el.textContent.match(/\\d+\\/\\d+ filled/) || [null])[0],
      hasSubmit: !!([...el.querySelectorAll('button')].find(b => /Submit to Principal/.test(b.textContent || ''))),
      hasFulfill: !!([...el.querySelectorAll('button')].find(b => /Fulfill Quota/.test(b.textContent || ''))),
    }));
  })()`);
  if (cards.length && cards.every(c => c.progress || c.done)) break;
}

console.log('   cards:', JSON.stringify(cards, null, 2).slice(0, 400));
check('task cards render with completion state', cards.length > 0, `${cards.length} card(s)`);
check('the completed task shows "✓ Task completed"', cards.some(c => c.done));
check('an incomplete task shows its fill progress', cards.some(c => !c.done && c.progress));
check('"Submit to Principal" appears ONLY on completed tasks',
  cards.every(c => c.hasSubmit === c.done));
check('"Submit to Principal" is present on at least one task', cards.some(c => c.hasSubmit));
check('every task still offers "Fulfill Quota"', cards.every(c => c.hasFulfill));

// ── click Submit on the completed task ───────────────────────────────
const submitCard = cards.find(c => c.hasSubmit);
const statusBefore = examStatus(submitCard.title);
console.log(`\n→ clicking "Submit to Principal" on "${submitCard.title}" (was: ${statusBefore})`);
// notify.confirm uses SweetAlert2 — confirm it
await evalJS(`(() => {
  const b = [...document.querySelectorAll('#tasksList button')].find(x =>
    /Submit to Principal/.test(x.textContent) &&
    x.closest('.p-5').querySelector('h3').textContent.trim() === ${JSON.stringify(submitCard.title)});
  if (b) { b.click(); return 'clicked'; }
  return 'not found';
})()`);
await sleep(1200);
await evalJS(`(() => {
  const btn = document.querySelector('.swal2-confirm') || document.querySelector('.swal-button--confirm');
  if (btn) btn.click();
  return !!btn;
})()`);
await sleep(2500);

// exam should now be in pending_principal_review → check via API and card list
const status = await fetch(`${BASE}/exams?status=pending_principal_review`, {
  headers: { Authorization: `Bearer ${login.token}` },
}).then((r) => r.json());
const submitted = (status || []).find(e => e.title === submitCard.title);
check('submitted exam is now awaiting principal review', !!submitted, submitted ? submitted.title : 'not found');

// The task stays listed until it is published (it is still in flight), but it
// must stop offering the submit action — otherwise the same exam could be
// resubmitted, re-sending the audit notifications to the principal.
const cardAfterSubmit = await evalJS(`(() => {
  const el = [...document.querySelectorAll('#tasksList .p-5')]
    .find(e => e.querySelector('h3').textContent.trim() === ${JSON.stringify(submitCard.title)});
  if (!el) return null;
  return {
    text: (el.textContent || '').replace(/\\s+/g, ' ').trim(),
    stillHasSubmit: !![...el.querySelectorAll('button')].find(b => /Submit to Principal/.test(b.textContent || '')),
  };
})()`);
check('the submitted task still shows on the board as in flight', !!cardAfterSubmit, submitCard.title);
check('it shows "awaiting principal review"',
  !!cardAfterSubmit && /awaiting principal review/i.test(cardAfterSubmit.text),
  cardAfterSubmit ? cardAfterSubmit.text.slice(0, 120) : 'card gone');
check('the submit button is withdrawn after submitting (no double-submit)',
  !!cardAfterSubmit && !cardAfterSubmit.stillHasSubmit);
// Regression: the progress chip used to read "0/n filled" after submitting,
// because the count only looked at 'draft' exams — a submitted task reported no
// questions at all.
check('the completion chip still reflects the real filled quota',
  !!cardAfterSubmit && /Task completed/.test(cardAfterSubmit.text),
  cardAfterSubmit ? cardAfterSubmit.text.slice(0, 120) : 'card gone');
check('it no longer reads as unfilled',
  !!cardAfterSubmit && !/0\/\d+ filled/.test(cardAfterSubmit.text));

const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(PROOF, Buffer.from(shot.data, 'base64'));
console.log(`\n   screenshot: ${PROOF}`);

// ── put the exam back exactly as we found it ─────────────────────────
if (statusBefore && statusBefore !== 'pending_principal_review') {
  const restored = openDb()
    .prepare("UPDATE exams SET status = ? WHERE title = ? AND status = 'pending_principal_review'")
    .run(statusBefore, submitCard.title);
  console.log(`   restored "${submitCard.title}" to ${statusBefore} (${restored.changes} row)`);
  const after = examStatus(submitCard.title);
  check('the exam was restored to its original status', after === statusBefore, `${after}`);
}

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} — ${passed} passed, ${failed} failed`);
chrome.kill();
process.exit(failed === 0 ? 0 : 1);
