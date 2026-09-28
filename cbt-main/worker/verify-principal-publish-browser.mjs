// Drive a real Chrome over CDP: principal → Exam Approvals → approve.
// Proves the principal's approval is the FINAL step (no faculty round-trip):
// the dialog must say PUBLISH, and confirming it must make the exam live for
// students immediately.
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8787';
const PROOF = 'principal-publish-proof.png';
const CHAPTER = 'Alcohols Phenols and Ethers';
const TITLE = `ZZ Principal Publish Smoke ${Date.now()}`;

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`); }
  else    { failed++; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const api = async (p, { method = 'GET', body, token } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};
const login = async (email, password = 'demo12345') =>
  (await api('/auth/login', { method: 'POST', body: { email, password } })).data;

// ── 1. Arrange: get an exam to the principal's desk ──────────────────
const principal = await login('principal@example.com');
if (!principal.token) throw new Error('principal login failed');
const faculty = await login('chemistry@cbt.local');
const student = await login('student@example.com', 'change_me_in_production');
if (!student.token) throw new Error('student login failed');

const bank = await api(`/questions?subject=chemistry&chapter=${encodeURIComponent(CHAPTER)}&limit=1`, { token: faculty.token });
const qid = bank.data.data[0].id;

const created = await api('/exams', {
  method: 'POST', token: principal.token,
  body: { title: TITLE, exam_type: 'custom', duration_minutes: 60, total_marks: 4, chapter_quotas: { chemistry: { [CHAPTER]: 1 } } },
});
const examId = created.data.id;
if (!examId) throw new Error('could not create the test exam: ' + created.status);

await api(`/exams/${examId}/questions`, { method: 'PUT', token: faculty.token, body: { question_ids: [{ id: qid }] } });
const sub = await api(`/exams/${examId}/submit-for-review`, { method: 'POST', token: faculty.token });
console.log(`arranged: "${TITLE}" submitted for review (status ${sub.status})\n`);

// ── 2. Drive the real UI ─────────────────────────────────────────────
const profile = mkdtempSync(join(tmpdir(), 'cdp-prin-'));
const port = 9391;
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
  if (r.exceptionDetails) throw new Error('page JS: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
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
await evalJS(`localStorage.setItem('cbt_token', ${JSON.stringify(principal.token)}); localStorage.setItem('cbt_user', ${JSON.stringify(JSON.stringify(principal.user))}); 'seeded'`);

console.log('\n→ opening Exam Approvals as principal');
await send('Page.navigate', { url: `${BASE}/admin#approvals` });
const approvalsOpen = await openTab('approvals');
console.log('   approvals tab opened:', approvalsOpen);

let card = null;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  card = await evalJS(`(() => {
    const el = [...document.querySelectorAll('#approvalsList .p-5')]
      .find(e => e.querySelector('h3') && e.querySelector('h3').textContent.trim() === ${JSON.stringify(TITLE)});
    if (!el) return null;
    return {
      badge: (el.querySelector('span.rounded-full') || {}).textContent || '',
      buttons: [...el.querySelectorAll('button')].map(b => b.textContent.trim()),
    };
  })()`);
  if (card) break;
}

check('the submitted exam appears on the principal\'s Exam Approvals', !!card);
check('it is badged "Awaiting Principal Review"', /Awaiting Principal Review/.test(card ? card.badge : ''), card ? card.badge : 'no card');
check('the principal is offered "Approve & Publish" (not a faculty handoff)',
  !!card && card.buttons.some(b => /Approve & Publish/.test(b)), card ? card.buttons.join(' | ') : '');
check('no "Submit & Publish (legacy)" button is offered for this exam',
  !!card && !card.buttons.some(b => /legacy/.test(b)), card ? card.buttons.join(' | ') : '');

// ── 3. Click approve and inspect the confirmation copy ───────────────
console.log('\n→ clicking "Approve & Publish"');
await evalJS(`(() => {
  const el = [...document.querySelectorAll('#approvalsList .p-5')]
    .find(e => e.querySelector('h3').textContent.trim() === ${JSON.stringify(TITLE)});
  [...el.querySelectorAll('button')].find(b => /Approve & Publish/.test(b.textContent)).click();
  return 'clicked';
})()`);
await sleep(1200);

const dialogText = norm(await evalJS(`(() => {
  const box = document.querySelector('.swal2-popup') || document.querySelector('.swal-modal');
  return box ? box.textContent : '';
})()`));
console.log('   dialog:', dialogText.slice(0, 160));
check('the confirmation says the exam will be PUBLISHED', /PUBLISH/i.test(dialogText));
check('it states the principal\'s approval is the final step', /final step/i.test(dialogText));
check('it no longer says the exam goes back to faculty', !/back to faculty/i.test(dialogText));

const dialogTitle = norm(await evalJS(`((document.querySelector('.swal2-title') || {}).textContent) || ''`));
check('the dialog is titled "Final Approval"', dialogTitle === 'Final Approval', dialogTitle);

await evalJS(`(() => {
  const btn = document.querySelector('.swal2-confirm') || document.querySelector('.swal-button--confirm');
  if (btn) btn.click();
  return !!btn;
})()`);
await sleep(3000);

// ── 4. Assert the outcome ────────────────────────────────────────────
const after = await api(`/exams/${examId}`, { token: principal.token });
const status = (after.data.exam || after.data).status;
check('the exam is published by the principal\'s approval alone', status === 'published', status);

const roster = await api('/exams', { token: student.token });
const rows = Array.isArray(roster.data) ? roster.data : (roster.data.data || []);
check('students can now see the exam', rows.some((e) => e.id === examId), `${rows.length} exam(s) listed`);

const cardAfter = await evalJS(`(() => {
  const el = [...document.querySelectorAll('#approvalsList .p-5')]
    .find(e => e.querySelector('h3') && e.querySelector('h3').textContent.trim() === ${JSON.stringify(TITLE)});
  return el ? el.textContent.trim() : null;
})()`);
check('it left the principal\'s approvals queue', cardAfter === null);

const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(PROOF, Buffer.from(shot.data, 'base64'));
console.log(`\n   screenshot: ${PROOF}`);

chrome.kill();

// ── 5. Clean up the throwaway exam ───────────────────────────────────
const d1 = join(__dirname, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
const file = readdirSync(d1).filter((f) => f.endsWith('.sqlite'))
  .map((f) => ({ f, size: statSync(join(d1, f)).size }))
  .sort((a, b) => b.size - a.size)[0].f;
const db = new DatabaseSync(join(d1, file));
const ids = db.prepare("SELECT id FROM exams WHERE title LIKE 'ZZ Principal Publish Smoke%'").all().map((r) => r.id);
for (const id of ids) {
  db.prepare('DELETE FROM notifications WHERE exam_id = ?').run(id);
  db.prepare('DELETE FROM exam_questions WHERE exam_id = ?').run(id);
  db.prepare('DELETE FROM exam_attempts WHERE exam_id = ?').run(id);
  db.prepare('DELETE FROM exams WHERE id = ?').run(id);
}
console.log(`\n   cleaned up ${ids.length} test exam(s)`);

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
