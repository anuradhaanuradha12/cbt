// Drive a real Chrome through the 5-minute outage policy:
//   A. exam page boots, attempt starts, student answers
//   B. draft snapshot is written to localStorage after answering
//   C. connection probe detects outage (dev server stopped) → overlay + countdown
//   D. server restarted → probe succeeds → outage auto-clears (resume path)
//   E. answers from before the outage are still in place afterwards
// (The >5 min auto-submit path is covered by the code path shared with the
// timer-driven submitExam; driving a real 5-minute outage in CI is too slow.)
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8787';
const PORT = 9347;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
  if (ok) { pass++; console.log(`  PASS  ${label}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); }
};

// ── login & exam setup (via API) ─────────────────────────────
const login = async (email, password) => {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }).then((r) => r.json());
  if (!res.token) throw new Error(`${email} login failed: ` + JSON.stringify(res));
  return res;
};
const apiGet = (token, path) =>
  fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());

// Principal creates an exam window that's open right now so the student can start.
console.log('Setting up a live exam…');
const principal = await login('principal@example.com', 'demo12345');
const student = await login('student@example.com', 'change_me_in_production');
const now = Math.floor(Date.now() / 1000);
const created = await fetch(`${BASE}/exams`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${principal.token}` },
  body: JSON.stringify({
    title: `OUTAGE-TEST-${Date.now()}`,
    duration_minutes: 60,
    total_marks: 4,
    difficulty: 'medium',
    starts_at: now - 30,
    ends_at: now + 61 * 60, // guard: window must cover the full 60-min duration
    chapter_quotas: { physics: { 'Electromagnetic Induction': 2 } },
  }),
}).then((r) => r.json());
if (!created.id) throw new Error('exam creation failed: ' + JSON.stringify(created));
const examId = created.id;

// Fill quotas as physics faculty and publish via principal approve.
const faculty = await login('physics@cbt.local', 'demo12345');
const draftExams = await apiGet(faculty.token, '/exams?status=draft');
const draft = (Array.isArray(draftExams) ? draftExams : []).find((e) => e.id === examId);
if (!draft) throw new Error('faculty cannot see the new draft');
const preview = await fetch(`${BASE}/exams/${examId}/auto-select-preview`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${faculty.token}` },
  body: JSON.stringify({ subject: 'physics', chapters: ['Electromagnetic Induction'], count: 2, difficulty: 'medium' }),
}).then((r) => r.json());
if (!Array.isArray(preview) || preview.length === 0) throw new Error('no questions auto-selected');
await fetch(`${BASE}/exams/${examId}/questions`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${faculty.token}` },
  body: JSON.stringify({ question_ids: preview.map((q) => ({ id: q.id, marks: 4, negative_marks: 1 })) }),
}).then((r) => r.json());
await fetch(`${BASE}/exams/${examId}/submit-for-review`, { method: 'POST', headers: { Authorization: `Bearer ${faculty.token}` } });
await fetch(`${BASE}/exams/${examId}/principal-review`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${principal.token}` },
  body: JSON.stringify({ decision: 'approve' }),
});
// Student must see it now.
const visible = await apiGet(student.token, `/exams/${examId}`);
if (visible.error) throw new Error('exam not visible to student: ' + JSON.stringify(visible));
console.log('Exam published with', visible.questions.length, 'questions.');

// ── chrome ───────────────────────────────────────────────────
const profile = mkdtempSync(join(tmpdir(), 'cdp-'));
const chrome = execFile(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--user-data-dir=' + profile, 'about:blank',
]);
process.on('exit', () => { try { chrome.kill(); } catch {} });

let version = null;
for (let i = 0; i < 30; i++) {
  try { version = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json()); break; }
  catch { await sleep(500); }
}
if (!version) throw new Error('chrome CDP never came up');

const target = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json());
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
const waitFor = async (expr, ms = 25000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if (await evalJS(expr)) return true; } catch {}
    await sleep(250);
  }
  return false;
};

await send('Page.enable');

// Student session → exam page
await send('Page.navigate', { url: 'about:blank' });
await sleep(300);
await send('Page.navigate', { url: BASE + '/' });
await sleep(1200);
await evalJS(
  `localStorage.setItem('cbt_token', ${JSON.stringify(student.token)});` +
  `localStorage.setItem('cbt_user', ${JSON.stringify(JSON.stringify(student.user))});` +
  `localStorage.setItem('cbt_disable_anticheat', '1'); 'ok'`
);
await send('Page.navigate', { url: `${BASE}/exam?id=${examId}&t=${Date.now()}` });
const booted = await waitFor(`!!document.getElementById('questionText') && !!document.getElementById('timer')`, 30000);
check(booted, 'exam page boots into the question view');

// A. answer the first question
const answered = await evalJS(`(() => {
  const opt = document.querySelector('.option-item');
  if (!opt) return false;
  opt.click();
  return !!document.querySelector('.option-item.selected');
})()`);
check(answered, 'student answers Q1 (option selected)');

// B. snapshot exists in localStorage
const snap1 = await evalJS(`(() => {
  const raw = localStorage.getItem('cbt_exam_draft_${examId}');
  if (!raw) return null;
  const s = JSON.parse(raw);
  return { answered: Object.values(s.responses).filter(Boolean).length, hasTime: s.time_remaining_seconds > 0 };
})()`);
check(!!snap1 && snap1.answered >= 1, 'draft snapshot written to localStorage', JSON.stringify(snap1));
check(!!snap1 && snap1.hasTime, 'snapshot carries remaining time');

// C. simulate outage — CDP offline emulation kills every request at the
// network level (api.request reads a closure URL, so property hacks lie).
await send('Network.enable');
await send('Network.emulateNetworkConditions', {
  offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
});
const overlayAppeared = await waitFor(`!!document.getElementById('outageOverlay')`, 20000);
check(overlayAppeared, 'outage overlay appears when connection drops');
const countdown = await evalJS(`document.getElementById('outageCountdown')?.textContent || ''`);
check(/^\d:\d{2}$/.test(countdown) || countdown === '4:59' || countdown === '5:00',
  'countdown is running', countdown);

// D. connectivity returns → probe succeeds → overlay auto-clears
await send('Network.emulateNetworkConditions', {
  offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
});
const overlayGone = await waitFor(`!document.getElementById('outageOverlay')`, 15000);
check(overlayGone, 'overlay auto-clears when connection returns (resume path)');

// E. answers survived the outage
const stillAnswered = await evalJS(`(() => {
  return {
    selected: !!document.querySelector('.option-item.selected'),
    snap: JSON.parse(localStorage.getItem('cbt_exam_draft_${examId}') || 'null'),
  };
})()`);
check(stillAnswered.selected, 'answer still selected after outage');
check(!!stillAnswered.snap && Object.values(stillAnswered.snap.responses).filter(Boolean).length >= 1,
  'snapshot still present after outage');

// ── F. outage > 5 min → auto-submit with retry until reconnect ──
// Fast-forwarded: go genuinely offline (CDP), shrink the countdown to 2s via
// the test hook — the retry loop must hold the submission until connectivity
// returns, then land it and redirect to /results.
await send('Network.emulateNetworkConditions', {
  offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
});
await waitFor(`!!document.getElementById('outageOverlay')`, 20000);
await evalJS(`window.__examTestHooks.setOutageSecondsLeft(2); 'ok'`);
const submittingState = await waitFor(
  `document.getElementById('outageCountdown')?.textContent === 'Submitting…'`, 20000
);
check(submittingState, 'countdown reaching 0:00 switches to auto-submit state');

await send('Network.emulateNetworkConditions', {
  offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
});
const redirected = await waitFor(`location.pathname === '/results'`, 30000);
check(redirected, 'auto-submitted and redirected to results once internet returned');

// Draft snapshot must be cleared after a successful submit.
if (redirected) {
  const draftGone = await evalJS(`localStorage.getItem('cbt_exam_draft_${examId}') === null`);
  check(draftGone, 'draft snapshot cleared after successful auto-submit');
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log('CLEANUP_ID=' + examId);
process.exit(fail === 0 ? 0 : 1);
