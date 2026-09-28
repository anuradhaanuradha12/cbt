// Drive a real Chrome over CDP and prove the Analytics tab is subject-scoped:
// a chemistry faculty's roster shows every student's CHEMISTRY marks and nothing
// from any other subject, and drilling into a student stays scoped.
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8787';
const PROOF = 'subject-analytics-proof.png';

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`); }
  else    { failed++; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const login = async (email, password = 'demo12345') => {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }).then((x) => x.json());
  if (!r.token) throw new Error(`login failed for ${email}`);
  return r;
};

const faculty = await login('chemistry@cbt.local');
const admin = await login('admin@example.com');
console.log(`chemistry faculty token acquired (${faculty.user.subject})\n`);

const profile = mkdtempSync(join(tmpdir(), 'cdp-an-'));
const port = 9394;
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

// Shared reader for whatever roster is currently on screen.
const READ_ROSTER = `(() => {
  const roster = document.getElementById('analyticsRoster');
  const content = document.getElementById('analyticsContent');
  const rows = [...document.querySelectorAll('#analyticsRosterBody tr')];
  const subjCol = document.getElementById('thRosterSubject');
  return {
    rosterVisible: !!roster && !roster.classList.contains('hidden'),
    contentVisible: !!content && !content.classList.contains('hidden'),
    renderedUser: (document.getElementById('userName') || {}).textContent || '',
    heading: (document.getElementById('analyticsStudentName') || {}).textContent || '',
    title: (document.getElementById('analyticsRosterTitle') || {}).textContent || '',
    subtitle: (document.getElementById('analyticsRosterSubtitle') || {}).textContent || '',
    count: (document.getElementById('analyticsRosterCount') || {}).textContent || '',
    subjectColumnHidden: !!subjCol && subjCol.classList.contains('hidden'),
    backToStudentsVisible: !document.getElementById('btnBackToStudents').classList.contains('hidden'),
    text: roster ? (roster.textContent || '').replace(/\\\\s+/g, ' ').trim().slice(0, 400) : '',
    rows: rows.map(tr => ({
      name: (tr.querySelector('[data-student-id]') || tr).dataset ? tr.dataset.studentName : null,
      cells: [...tr.querySelectorAll('td')].map(td => (td.textContent || '').replace(/\\\\s+/g, ' ').trim()),
    })),
  };
})()`;

// A unique URL per account forces a real document load. Without it, a hash-only
// navigation leaves the previous account's admin.js running — with the previous
// role baked in — and the wrong view can silently pass for the right one.
const openAnalyticsAs = async (account, tag) => {
  await send('Page.navigate', { url: `${BASE}/` });
  await sleep(1200);
  await evalJS(`localStorage.setItem('cbt_token', ${JSON.stringify(account.token)}); localStorage.setItem('cbt_user', ${JSON.stringify(JSON.stringify(account.user))}); 'seeded'`);
  await send('Page.navigate', { url: `${BASE}/admin?who=${tag}#analytics` });
  await openTab('analytics');
  let state = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    state = await evalJS(READ_ROSTER);
    // The roster paints a "Loading…" row before its fetch lands, and that row has
    // no marks — wait for real "scored / possible" cells instead of any row at all.
    const settled = state.rows.length > 0 && !state.contentVisible
      && state.rows.every((r) => r.cells.some((c) => /\d\s*\/\s*\d/.test(c)));
    if (settled || /No student has taken|No students/.test(state.text)) break;
  }
  return state;
};

// ── 1. Chemistry faculty ─────────────────────────────────────────────
console.log('→ opening Analytics as chemistry faculty');
const chem = await openAnalyticsAs(faculty, 'chem');
check('the page really loaded as the chemistry faculty',
  chem.renderedUser === faculty.user.name, chem.renderedUser);
console.log('   roster:', JSON.stringify({ title: chem.title, count: chem.count, rows: chem.rows.length }));
for (const r of chem.rows) console.log('     •', r.cells.join(' | '));

check('the roster is shown (no more empty placeholder)', chem.rosterVisible && !chem.contentVisible);
check('it lists students with their marks', chem.rows.length > 0, `${chem.rows.length} row(s)`);
check('the heading names the faculty\'s subject', /chemistry/i.test(chem.title), chem.title);
check('the subtitle states the subject lock', /other subjects are never included/i.test(chem.subtitle), chem.subtitle);
check('the Subject column is hidden for a single-subject faculty', chem.subjectColumnHidden);

// every row must be chemistry, and no other subject may appear anywhere
const otherSubjects = ['physics', 'maths', 'mathematics', 'biology'];
const leakedInText = otherSubjects.filter((s) => new RegExp(s, 'i').test(chem.text));
check('no other subject appears anywhere in the roster', leakedInText.length === 0, leakedInText.join(', ') || 'clean');
check('every row reports chemistry marks',
  chem.rows.every((r) => r.cells.some((c) => /chemistry/i.test(c))),
  chem.rows.map((r) => r.cells.join('|')).join(' ;; ').slice(0, 140) || 'no rows');
check('each row shows marks out of a maximum', chem.rows.every((r) => r.cells.some((c) => /\/\s*\d+/.test(c))));

// cross-check the numbers against the API for the same faculty
const apiRoster = await fetch(`${BASE}/analytics/subject`, {
  headers: { Authorization: `Bearer ${faculty.token}` },
}).then((r) => r.json());
check('the UI row count matches the API', chem.rows.length === apiRoster.count,
  `ui=${chem.rows.length} api=${apiRoster.count}`);
check('the API served only chemistry rows',
  (apiRoster.students || []).every((s) => s.subject === 'chemistry'),
  JSON.stringify([...new Set((apiRoster.students || []).map((s) => s.subject))]));

// faculty asking for another subject must be refused
const crossed = await fetch(`${BASE}/analytics/subject?subject=physics`, {
  headers: { Authorization: `Bearer ${faculty.token}` },
}).then((r) => r.status);
check('the API refuses a faculty request for another subject', crossed === 403, `status ${crossed}`);

// ── 2. Drill into a student ──────────────────────────────────────────
console.log('\n→ clicking a student row');
await evalJS(`document.querySelector('#analyticsRosterBody tr[data-student-id]').click(); 'clicked'`);
let detail = null;
for (let i = 0; i < 20; i++) {
  await sleep(500);
  detail = await evalJS(READ_ROSTER);
  if (detail.contentVisible) break;
}
check('the per-student breakdown opens', detail.contentVisible && !detail.rosterVisible);
check('the heading switches to that student', /'s Analytics$/.test(detail.heading), detail.heading);
check('a way back to the roster appears', detail.backToStudentsVisible);

const detailScoped = await evalJS(`(() => {
  const bar = document.getElementById('analyticsSubjects');
  const rows = document.getElementById('analyticsChapters');
  return {
    subjects: bar ? (bar.textContent || '').replace(/\\\\s+/g, ' ').trim() : '',
    chapters: rows ? (rows.textContent || '').replace(/\\\\s+/g, ' ').trim() : '',
  };
})()`);
const leakedInDetail = otherSubjects.filter((s) =>
  new RegExp('\\\\b' + s + '\\\\b', 'i').test(detailScoped.subjects + ' ' + detailScoped.chapters));
check('the per-student breakdown leaks no other subject', leakedInDetail.length === 0,
  leakedInDetail.join(', ') || detailScoped.subjects.slice(0, 90));

console.log('\n→ clicking "All students"');
await evalJS(`document.getElementById('btnBackToStudents').click(); 'ok'`);
let back = null;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  back = await evalJS(READ_ROSTER);
  const settled = back.rosterVisible && !back.contentVisible && back.rows.length > 0
    && back.rows.every((r) => r.cells.some((c) => /\d\s*\/\s*\d/.test(c)));
  if (settled) break;
}
check('the roster comes back', back.rosterVisible && !back.contentVisible, `${back.rows.length} row(s)`);

const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(PROOF, Buffer.from(shot.data, 'base64'));
console.log(`\n   screenshot: ${PROOF}`);

// ── 3. Admin sees every subject ──────────────────────────────────────
console.log('\n→ opening Analytics as admin');
const adm = await openAnalyticsAs(admin, 'admin');
check('the page really loaded as the admin', adm.renderedUser === admin.user.name, adm.renderedUser);
const admSubjects = [...new Set(adm.rows.flatMap((r) => r.cells.filter((c) =>
  /^(physics|chemistry|maths|biology)$/i.test(c))))].map((s) => s.toLowerCase()).sort();
console.log('   admin subjects:', admSubjects.join(', ') || 'none');
check('admin sees the Subject column', !adm.subjectColumnHidden);
check('admin sees more than one subject', admSubjects.length > 1, admSubjects.join(', '));

chrome.kill();

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
