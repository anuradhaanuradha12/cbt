// Drive a real Chrome over CDP: the principal's Analytics tab must show the
// whole college ranked by marks with every subject, plus a top-10 topper board —
// and a faculty account must NOT get any of it.
//
// Each account is loaded through a UNIQUE admin URL. Navigating /admin#analytics
// -> /admin#analytics is a same-document navigation, so the second account would
// silently keep running the first account's admin.js (with the first role baked
// in). The `?who=` tag forces a real document load — and the harness asserts the
// rendered user name matches, so that trap can never hide a failure again.
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8787';
const PROOF = 'class-overview-proof.png';

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

const principal = await login('principal@example.com');
const faculty = await login('chemistry@cbt.local');

const expected = await fetch(`${BASE}/analytics/overview`, {
  headers: { Authorization: `Bearer ${principal.token}` },
}).then((r) => r.json());
const nSubjects = expected.subjects.length;
const TOTAL_CELL = 2 + nSubjects;   // # | Student | subjects… | Total | Score
console.log(`api: ${expected.count} student(s), ${nSubjects} subject(s), ${expected.toppers.length} topper(s)\n`);

const profile = mkdtempSync(join(tmpdir(), 'cdp-ov-'));
const port = 9396;
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

// `\\s` inside this string becomes `\s` in the page — it is a JS template literal.
const READ = `(() => {
  const ov = document.getElementById('analyticsOverview');
  const roster = document.getElementById('analyticsRoster');
  const content = document.getElementById('analyticsContent');
  const headCells = [...document.querySelectorAll('#classRankHeadRow th')].map(th => th.textContent.trim());
  const rows = [...document.querySelectorAll('#classRankBody tr')].map(tr => ({
    rank: tr.querySelector('td') ? tr.querySelector('td').textContent.trim() : '',
    cells: [...tr.querySelectorAll('td')].map(td => (td.textContent || '').replace(/\\\\s+/g, ' ').trim()),
    hasStudentId: !!tr.dataset.studentId,
  }));
  return {
    renderedUser: (document.getElementById('userName') || {}).textContent || '',
    overviewVisible: !!ov && !ov.classList.contains('hidden'),
    rosterVisible: !!roster && !roster.classList.contains('hidden'),
    contentVisible: !!content && !content.classList.contains('hidden'),
    heading: (document.getElementById('analyticsStudentName') || {}).textContent || '',
    rankSubtitle: (document.getElementById('classRankSubtitle') || {}).textContent || '',
    counts: {
      students: (document.getElementById('classRankCount') || {}).textContent || '',
      toppers: (document.getElementById('toppersCount') || {}).textContent || '',
    },
    headCells,
    rows,
    topperCards: [...document.querySelectorAll('#toppersGrid > div')].map(d =>
      (d.textContent || '').replace(/\\\\s+/g, ' ').trim()),
  };
})()`;

// admin.html blocks its parser on CDN <script> tags in <head>, so on a cold or
// slow CDN the document sits in `loading` with no <body> at all — for seconds,
// occasionally much longer. Poll for the element instead of sleeping a fixed
// 3.5s, and reload rather than hang if a stall outlasts the budget.
const waitFor = async (expr, ms = 20000) => {
  for (let waited = 0; waited <= ms; waited += 500) {
    if (await evalJS(`!!(${expr})`)) return true;
    await sleep(500);
  }
  return false;
};

// A unique URL per account forces a real document load (see the header note).
const openAnalyticsAs = async (account, tag) => {
  await send('Page.navigate', { url: `${BASE}/` });
  await waitFor('document.body');
  await evalJS(`localStorage.setItem('cbt_token', ${JSON.stringify(account.token)}); localStorage.setItem('cbt_user', ${JSON.stringify(JSON.stringify(account.user))}); 'seeded'`);
  await send('Page.navigate', { url: `${BASE}/admin?who=${tag}#analytics` });

  // The nav <a> appears during parsing, but admin.js (last in <body>) attaches the
  // tab handlers afterwards — clicking before that silently does nothing.
  const appReady = `document.querySelector('[data-tab="analytics"]') && typeof window.showAnalyticsHome === 'function'`;
  let ready = await waitFor(appReady);
  for (let attempt = 1; !ready && attempt <= 4; attempt++) {
    console.log(`   (page still loading after 20s — reload ${attempt}/4)`);
    await send('Page.reload', {});
    ready = await waitFor(appReady);
  }
  if (!ready) throw new Error('the admin page never finished initialising');

  await evalJS(`document.querySelector('[data-tab="analytics"]').click(); 'ok'`);
  let state = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    state = await evalJS(READ);
    if (state.rows.length > 0 || state.rosterVisible) break;
  }
  return state;
};

// ── 1. Principal ─────────────────────────────────────────────────────
console.log('→ opening Analytics as principal');
const p = await openAnalyticsAs(principal, 'principal');
check('the page really reloaded as the principal', p.renderedUser === principal.user.name, p.renderedUser);
console.log('   head:', p.headCells.join(' | '));
console.log('   rows:', p.rows.length, '| topper cards:', p.topperCards.length);
for (const r of p.rows.slice(0, 4)) console.log('     •', r.cells.join(' | '));

check('the principal sees the class overview', p.overviewVisible && !p.rosterVisible && !p.contentVisible);
check('the ranked table lists every student',
  p.rows.length === expected.count, `ui=${p.rows.length} api=${expected.count}`);
check('there is a rank column', /^#\d+$/.test(p.rows[0] ? p.rows[0].rank : ''), p.rows[0] ? p.rows[0].rank : 'none');
check('every row can be drilled into', p.rows.every((r) => r.hasStudentId));

const subjectHeads = p.headCells.slice(2, 2 + nSubjects).map((h) => h.toLowerCase());
check('every subject has its own column',
  JSON.stringify(subjectHeads) === JSON.stringify(expected.subjects),
  `ui=[${subjectHeads.join(', ')}] api=[${expected.subjects.join(', ')}]`);
check('the last two columns are Total then Score',
  /total/i.test(p.headCells[p.headCells.length - 2] || '') && /score/i.test(p.headCells[p.headCells.length - 1] || ''),
  p.headCells.slice(-2).join(' | '));

const shownTotal = (r) => Number((String(r.cells[TOTAL_CELL] || '').match(/^(-?\d+(?:\.\d+)?)/) || [])[1]);
const totalsMatch = p.rows.every((r, i) =>
  expected.students[i] && Math.abs(shownTotal(r) - Number(expected.students[i].total_scored)) < 0.05);
check('each row shows the same total as the API', totalsMatch,
  p.rows.slice(0, 3).map((r, i) => `ui=${shownTotal(r)} api=${expected.students[i] && expected.students[i].total_scored}`).join(' | '));

const uiRankOrder = p.rows.map((r) => String(r.rank).replace('#', ''));
const apiRankOrder = expected.students.map((s) => String(s.rank));
check('the rank column matches the API ranking',
  JSON.stringify(uiRankOrder) === JSON.stringify(apiRankOrder),
  `ui=[${uiRankOrder.slice(0, 6).join(',')}] api=[${apiRankOrder.slice(0, 6).join(',')}]`);

// ── 2. Topper board ──────────────────────────────────────────────────
check('the topper board renders one card per topper',
  p.topperCards.length === expected.toppers.length, `${p.topperCards.length} card(s)`);
check('the board is capped at ten', p.topperCards.length <= 10, `${p.topperCards.length}`);
check('the board header counts them', p.counts.toppers === `top ${expected.toppers.length}`,
  `${p.counts.toppers}`);
check('the top card is the highest scorer',
  expected.toppers.length === 0 || p.topperCards[0].includes(String(expected.toppers[0].total_scored)),
  (p.topperCards[0] || '').slice(0, 80));
check('the subtitle explains the ordering', /highest marks first/i.test(p.rankSubtitle), p.rankSubtitle);
check('every card names a rank and marks',
  p.topperCards.every((c) => /#\d+/.test(c) && /marks/.test(c)));

// ── 3. Drill into a student, then come back ──────────────────────────
console.log('\n→ clicking the top-ranked student');
await evalJS(`document.querySelector('#classRankBody tr[data-student-id]').click(); 'clicked'`);
let detail = null;
for (let i = 0; i < 20; i++) {
  await sleep(500);
  detail = await evalJS(READ);
  if (detail.contentVisible) break;
}
check('the per-student breakdown opens', detail.contentVisible && !detail.overviewVisible);
check('the heading switches to that student', /'s Analytics$/.test(detail.heading), detail.heading);

await evalJS(`document.getElementById('btnBackToStudents').click(); 'ok'`);
let back = null;
for (let i = 0; i < 20; i++) {
  await sleep(500);
  back = await evalJS(READ);
  if (back.overviewVisible && back.rows.length > 0) break;
}
check('going back returns to the class overview', back.overviewVisible && !back.contentVisible,
  `${back.rows.length} row(s)`);

const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(PROOF, Buffer.from(shot.data, 'base64'));
console.log(`\n   screenshot: ${PROOF}`);

// ── 4. Faculty must be denied all of it ──────────────────────────────
console.log('\n→ opening Analytics as chemistry faculty');
const f = await openAnalyticsAs(faculty, 'faculty');
check('the page really reloaded as the faculty member', f.renderedUser === faculty.user.name, f.renderedUser);
check('faculty do NOT get the class overview', !f.overviewVisible);
check('faculty get their own subject roster instead', f.rosterVisible);
check('no topper board for faculty', f.topperCards.length === 0, `${f.topperCards.length} card(s)`);
check('the ranked table is empty for faculty', f.rows.length === 0, `${f.rows.length} row(s)`);
check('no other subject name leaks onto the faculty page',
  !/topper|ranked by marks/i.test(f.heading + ' ' + f.counts.toppers),
  `${f.heading} | ${f.counts.toppers}`);

chrome.kill();
console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
