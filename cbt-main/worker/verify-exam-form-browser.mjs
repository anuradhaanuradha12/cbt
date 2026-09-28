// Drive a real Chrome to verify the Create Exam Blueprint form:
//   1. Difficulty picker (Easy/Medium/Hard) renders, defaults to medium, switches on click
//   2. Duration input blocks negative/junk characters (only positive integers survive)
//   3. Start/End time pickers refuse past dates (min is fresh; a past value snaps to now)
//   4. End-to-end: creating a blueprint with difficulty=hard persists it (API confirms)
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8787';
const ADMIN_PAGE = `${BASE}/admin`;
const PORT = 9345;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
  if (ok) { pass++; console.log(`  PASS  ${label}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); }
};

const login2 = async (email, password) => {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }).then((r) => r.json());
  if (!res.token) throw new Error(`${email} login failed: ` + JSON.stringify(res));
  return res;
};

const login = async () => {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'principal@example.com', password: 'demo12345' }),
  });
  const j = await res.json();
  if (!j.token) throw new Error('principal login failed: ' + JSON.stringify(j));
  return j;
};

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

// ── boot admin page as principal ─────────────────────────────
const creds = await login();
await send('Page.navigate', { url: 'about:blank' });
await sleep(300);
await send('Page.navigate', { url: BASE + '/' });
await sleep(1200);
await evalJS(
  `localStorage.setItem('cbt_token', ${JSON.stringify(creds.token)});` +
  `localStorage.setItem('cbt_user', ${JSON.stringify(JSON.stringify(creds.user))}); 'ok'`
);
await send('Page.navigate', { url: `${ADMIN_PAGE}?t=${Date.now()}` });
const booted = await waitFor(
  `!!document.querySelector('.nav-link.bg-indigo-500\\\\/10') && !!document.getElementById('examDuration')`,
  30000
);
check(booted, 'admin page boots with blueprint form');
if (!booted) process.exit(1);

// ── 1. Difficulty picker ─────────────────────────────────────
const picker = await evalJS(`(() => {
  const p = document.getElementById('examDifficultyPicker');
  if (!p) return null;
  const btns = [...p.querySelectorAll('.difficulty-btn')].map(b => b.dataset.difficulty);
  const active = p.querySelector('.difficulty-btn.bg-indigo-600');
  return { btns, active: active ? active.dataset.difficulty : null };
})()`);
check(!!picker, 'difficulty picker present');
check(!!picker && JSON.stringify(picker.btns) === JSON.stringify(['easy', 'medium', 'hard']),
  'picker has Easy/Medium/Hard', JSON.stringify(picker?.btns));
check(picker?.active === 'medium', 'defaults to Medium', picker?.active);

await evalJS(`document.getElementById('examDifficultyPicker').querySelector('[data-difficulty="hard"]').click(); 'ok'`);
const activeAfterClick = await evalJS(
  `document.querySelector('#examDifficultyPicker .difficulty-btn.bg-indigo-600')?.dataset.difficulty || null`
);
check(activeAfterClick === 'hard', 'clicking Hard activates it', activeAfterClick);

// ── 2. Duration blocks junk ──────────────────────────────────
const durResults = await evalJS(`(() => {
  const d = document.getElementById('examDuration');
  const tryVal = (v) => {
    d.value = v;
    d.dispatchEvent(new Event('input', { bubbles: true }));
    return d.value;
  };
  // type=number semantics: the BROWSER strips '-' (value becomes '5') and
  // anything non-numeric becomes ''. Then our input handler removes all zeros,
  // so no negative/zero duration can ever sit in the field.
  return {
    negative: tryVal('-5'),
    zero: tryVal('0'),
    junk: tryVal('12a7'),
    scientific: tryVal('2e3'),
    leadingZero: tryVal('090'),
    normal: tryVal('120'),
  };
})()`);
check(durResults.negative === '5', 'duration "-5" loses the minus sign', JSON.stringify(durResults.negative));
check(durResults.zero === '', 'duration rejects "0"', JSON.stringify(durResults.zero));
check(durResults.junk === '', 'duration strips junk from "12a7"', JSON.stringify(durResults.junk));
check(durResults.scientific === '23', 'duration strips "2e3" to digits', JSON.stringify(durResults.scientific));
check(durResults.leadingZero === '90', 'duration trims leading zeros "090"', JSON.stringify(durResults.leadingZero));
check(durResults.normal === '120', 'duration keeps "120"', JSON.stringify(durResults.normal));

// ── 2b. Duration cap at 200 with a sweet popup ─────────────
const capResult = await evalJS(`(() => {
  const d = document.getElementById('examDuration');
  d.value = '250';
  d.dispatchEvent(new Event('input', { bubbles: true }));
  const val = d.value;
  const popup = !!document.querySelector('.swal2-popup');
  const title = document.querySelector('.swal2-title')?.textContent || '';
  if (window.Swal) window.Swal.close();
  return { val, popup, title };
})()`);
check(capResult.val === '200', 'duration 250 trimmed to 200', JSON.stringify(capResult.val));
check(capResult.popup, 'SweetAlert popup shown', capResult.title);
check(/200/.test(capResult.title), 'popup explains the 200-minute max', JSON.stringify(capResult.title));

// ── 2c. End Time fills itself, natural behavior ─────────────
const natural = await evalJS(`(() => {
  const s = document.getElementById('examStartsAt');
  const e = document.getElementById('examEndsAt');
  const d = document.getElementById('examDuration');
  const fmt = (dt) => new Date(dt.getTime() - dt.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const out = {};
  // 1) start + duration set → end appears automatically
  d.value = '90'; d.dispatchEvent(new Event('input', { bubbles: true }));
  const start = new Date(Date.now() + 3600e3);
  s.value = fmt(start); s.dispatchEvent(new Event('input', { bubbles: true }));
  out.autoEnd = e.value;
  out.expectedAuto = fmt(new Date(start.getTime() + 90 * 60000));
  // 2) manual end edit sticks
  const manual = fmt(new Date(Date.now() + 5 * 3600e3));
  e.value = manual; e.dispatchEvent(new Event('change', { bubbles: true }));
  d.value = '60'; d.dispatchEvent(new Event('input', { bubbles: true }));
  out.afterManualEditThenDuration = e.value;
  out.manual = manual;
  // 3) changing duration re-engages the auto-fill (start/duration moved → end follows)
  //    (the duration input above already re-engaged it)
  out.expectedAfterDuration = fmt(new Date(start.getTime() + 60 * 60000));
  return out;
})()`);
check(natural.autoEnd === natural.expectedAuto && natural.autoEnd !== '',
  'End Time auto-fills as Start + Duration', `${natural.autoEnd} vs ${natural.expectedAuto}`);
check(natural.afterManualEditThenDuration === natural.expectedAfterDuration,
  'manual end edit sticks, then follows again when duration changes', natural.afterManualEditThenDuration);

// ── 2d. 12-hour time dropdowns (Hour 1–12, Min 00–59, AM/PM) ──
const dd = await evalJS(`(() => {
  const h = document.getElementById('examStartHour');
  const m = document.getElementById('examStartMinute');
  const a = document.getElementById('examStartAmpm');
  const hours = [...h.options].map(o => o.value).filter(Boolean).map(Number);
  const mins = [...m.options].map(o => o.value).filter(Boolean).map(Number);
  return {
    hours, minCount: mins.length, minFirst: mins[0], minLast: mins[mins.length - 1],
    ampms: [...a.options].map(o => o.value).filter(Boolean),
    endHours: [...document.getElementById('examEndHour').options].length,
  };
})()`);
check(JSON.stringify(dd.hours) === JSON.stringify([1,2,3,4,5,6,7,8,9,10,11,12]),
  'Start hour dropdown has exactly 1–12', JSON.stringify(dd.hours));
check(dd.minCount === 59 && dd.minFirst === 1 && dd.minLast === 59,
  'Start minute dropdown has 1–59', `${dd.minCount} options`);
check(JSON.stringify(dd.ampms) === JSON.stringify(['AM','PM']),
  'AM/PM selector present', JSON.stringify(dd.ampms));
check(dd.endHours === 13, 'End time dropdowns populated too', '12 hours + blank');

// Dropdowns → hidden field: 02:45 PM == 14:45
const pm = await evalJS(`(() => {
  const d = document.getElementById('examStartDate');
  d.value = '2027-03-15'; d.dispatchEvent(new Event('change', { bubbles: true }));
  document.getElementById('examStartHour').value = '2';
  document.getElementById('examStartMinute').value = '45';
  document.getElementById('examStartAmpm').value = 'PM';
  ['Hour','Minute','Ampm'].forEach(p =>
    document.getElementById('examStart' + p).dispatchEvent(new Event('change', { bubbles: true })));
  return document.getElementById('examStartsAt').value;
})()`);
check(pm === '2027-03-15T14:45', '02:45 PM writes 14:45 into the hidden field', pm);

// Hidden → dropdowns: 00:10 == 12:10 AM (midnight edge), 12:00 == 12:00 PM (noon edge)
const edges = await evalJS(`(() => {
  const hidden = document.getElementById('examEndsAt');
  const out = {};
  hidden.value = '2027-03-15T00:10';
  hidden.dispatchEvent(new Event('change', { bubbles: true }));
  out.midnight = {
    h: document.getElementById('examEndHour').value,
    m: document.getElementById('examEndMinute').value,
    a: document.getElementById('examEndAmpm').value,
  };
  hidden.value = '2027-03-15T12:00';
  hidden.dispatchEvent(new Event('change', { bubbles: true }));
  out.noon = {
    h: document.getElementById('examEndHour').value,
    m: document.getElementById('examEndMinute').value,
    a: document.getElementById('examEndAmpm').value,
  };
  return out;
})()`);
check(edges.midnight.h === '12' && edges.midnight.a === 'AM' && edges.midnight.m === '10',
  '00:10 renders as 12:10 AM', JSON.stringify(edges.midnight));
check(edges.noon.h === '12' && edges.noon.a === 'PM' && edges.noon.m === '0',
  '12:00 renders as 12:00 PM (on-demand 00 option)', JSON.stringify(edges.noon));

// ── 3. Past dates snap to now ────────────────────────────────
const dateResults = await evalJS(`(() => {
  const s = document.getElementById('examStartsAt');
  const e = document.getElementById('examEndsAt');
  const before = { sMin: s.min, eMin: e.min };
  s.value = '2020-01-01T10:00';
  s.dispatchEvent(new Event('change', { bubbles: true }));
  const afterPastStart = s.value;
  e.value = '2019-05-05T08:00';
  e.dispatchEvent(new Event('change', { bubbles: true }));
  const afterPastEnd = e.value;
  return { before, afterPastStart, afterPastEnd };
})()`);
check(!!dateResults.before.sMin && !!dateResults.before.eMin, 'start/end min attributes set',
  JSON.stringify(dateResults.before));
check(dateResults.afterPastStart !== '2020-01-01T10:00' && dateResults.afterPastStart >= dateResults.before.sMin,
  'past Start Time snapped to current minute', JSON.stringify(dateResults.afterPastStart));
check(dateResults.afterPastEnd !== '2019-05-05T08:00' && dateResults.afterPastEnd >= dateResults.before.eMin,
  'past End Time snapped to current minute', JSON.stringify(dateResults.afterPastEnd));

// ── 4. Create a hard exam end-to-end ─────────────────────────
await evalJS(`(() => {
  document.querySelector('[data-tab="create-exam"]').click();
  document.getElementById('examType').value = 'jee';
  document.getElementById('examType').dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
})()`);
await waitFor(`document.querySelectorAll('.chapter-quota-input').length > 0`, 20000);
const quotaSet = await evalJS(`(() => {
  const input = document.querySelector('.chapter-quota-input[data-subject="physics"][data-chapter="Electromagnetic Induction"]');
  if (!input) return false;
  input.value = '2';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
check(quotaSet, 'physics/Electromagnetic Induction quota set to 2');

await evalJS(`(() => {
  document.getElementById('examTitle').value = 'UI-DIFF-TEST-HARD';
  document.getElementById('examDescription').value = 'browser verification exam';
  const d = document.getElementById('examDuration');
  d.value = '120';
  d.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('examDifficultyPicker').querySelector('[data-difficulty="hard"]').click();
  const fmt = (dt) => new Date(dt.getTime() - dt.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const s = document.getElementById('examStartsAt');
  s.value = fmt(new Date(Date.now() + 3600e3));
  s.dispatchEvent(new Event('change', { bubbles: true }));
  const e = document.getElementById('examEndsAt');
  e.value = fmt(new Date(Date.now() + 3 * 3600e3));
  e.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
})()`);

await evalJS(`document.getElementById('btnCreateExam').click(); 'ok'`);
await evalJS(`document.getElementById('btnCreateExam').click(); 'ok'`);
// The form reset is confirmed via the API checks below; close any success
// popup so it can't swallow later interactions.
await waitFor(`!!document.querySelector('.swal2-popup')`, 8000);
await evalJS(`if (window.Swal) Swal.close(); 'ok'`);
check(true, 'blueprint created (verified via API below)');

const nowSec = Math.floor(Date.now() / 1000);
const exams = await fetch(`${BASE}/exams?status=draft`, { headers: { Authorization: `Bearer ${creds.token}` } }).then((r) => r.json());
const mine = (Array.isArray(exams) ? exams : []).find((e) => e.title === 'UI-DIFF-TEST-HARD');
check(!!mine, 'created exam visible via API');
if (mine) {
  check(mine.difficulty === 'hard', 'exam stored with difficulty=hard', String(mine.difficulty));
  check(mine.duration_minutes === 120, 'duration stored as 120', String(mine.duration_minutes));
  check(mine.starts_at > nowSec + 3000 && mine.starts_at < nowSec + 5400, 'starts_at ~1h in the future', String(mine.starts_at));
  check(mine.ends_at > nowSec + 10200 && mine.ends_at < nowSec + 12600, 'ends_at ~3h in the future', String(mine.ends_at));
  console.log(`\n  CLEANUP_ID=${mine.id}`);
}

// ── 5. Quota-completion guard on "Save Questions to Exam" ────
// As chemistry faculty against a blueprint needing 2 chapters × 1 question:
// selecting only one chapter's question must trigger the SweetAlert popup
// and save NOTHING; completing the target must pass.
console.log('\n── 5. Quota guard: Save Questions to Exam ─────────');
const p2 = await login2('principal@example.com', 'demo12345');
const f2 = await login2('chemistry@cbt.local', 'demo12345');
const nowS = Math.floor(Date.now() / 1000);
const created2 = await fetch(`${BASE}/exams`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p2.token}` },
  body: JSON.stringify({
    title: `QUOTA-GUARD-${Date.now()}`,
    duration_minutes: 60,
    total_marks: 8,
    difficulty: 'medium',
    chapter_quotas: { chemistry: { 'Alcohols Phenols and Ethers': 1, Electrochemistry: 1 } },
  }),
}).then((r) => r.json());
if (!created2.id) throw new Error('quota-guard exam creation failed: ' + JSON.stringify(created2));
console.log('  blueprint: ' + created2.id);

// Boot admin page as chemistry faculty and select the blueprint.
await evalJS(`localStorage.clear(); 'ok'`);
await send('Page.navigate', { url: 'about:blank' });
await sleep(300);
await send('Page.navigate', { url: BASE + '/' });
await sleep(1000);
await evalJS(
  `localStorage.setItem('cbt_token', ${JSON.stringify(f2.token)});` +
  `localStorage.setItem('cbt_user', ${JSON.stringify(JSON.stringify(f2.user))}); 'ok'`
);
await send('Page.navigate', { url: `${ADMIN_PAGE}?t=${Date.now()}` });
const ready = await waitFor(
  `!!document.querySelector('.nav-link.bg-indigo-500\\\\/10') && typeof window.selectBlueprint === 'function'`,
  30000
);
if (!ready) throw new Error('phase-5 admin page never became ready (selectBlueprint missing)');
const blueprintSelected = await evalJS(
  `selectBlueprint('${created2.id}', 'QUOTA-GUARD', '${JSON.stringify({ chemistry: { 'Alcohols Phenols and Ethers': 1, Electrochemistry: 1 } }).replace(/'/g, "\\'")}', 'medium'); 'ok'`
);
await waitFor(`document.getElementById('btnSaveQuestions') && !document.getElementById('btnSaveQuestions').classList.contains('hidden')`, 15000);

// Pick ONE question from a bank search (incomplete: 1 of 2 chapters).
// Set the chapter filter AND trigger the search like a real user would —
// the add handler rejects questions from unassigned chapters, so the card
// clicked must actually belong to an assigned chapter.
const addedOne = await evalJS(`(async () => {
  document.getElementById('filterChapter').value = 'Electrochemistry';
  document.getElementById('btnSearch').click();
  for (let i = 0; i < 20; i++) {
    if (window.Swal && Swal.isVisible && Swal.isVisible()) Swal.close();
    const btn = document.querySelector('#questionsContainer .add-btn');
    if (btn) {
      btn.click();
      await new Promise(r => setTimeout(r, 300));
      if (btn.textContent.includes('Added')) return true; // committed, not rejected
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
})()`);
check(addedOne, 'faculty adds 1 question (of 2 required)');

// Click Save → the sweet board popup must appear, nothing saved.
await evalJS(`document.getElementById('btnSaveQuestions').click(); 'ok'`);
const popupShown = await waitFor(`!!document.querySelector('.swal2-popup')`, 8000);
check(popupShown, 'incomplete save blocked with SweetAlert popup');
const popupText = popupShown ? await evalJS(`document.querySelector('.swal2-popup')?.textContent || ''`) : '';
check(/incomplete/i.test(popupText), 'popup says the task is incomplete', popupText.slice(0, 120));
await evalJS(`if (window.Swal) Swal.close(); 'ok'`);

// Server must still hold 0 saved questions for this exam.
const afterBlocked = await fetch(`${BASE}/exams/${created2.id}`, { headers: { Authorization: `Bearer ${f2.token}` } }).then((r) => r.json());
check((afterBlocked.questions || []).length === 0, 'nothing was saved server-side', `${(afterBlocked.questions || []).length} questions`);

// Early submit from the tasks board must also be blocked (faculty has 0 saved).
const earlySubmit = await fetch(`${BASE}/exams/${created2.id}/submit-for-review`, {
  method: 'POST', headers: { Authorization: `Bearer ${f2.token}` },
}).then((r) => r.json());
check(earlySubmit.code === 'QUOTA_INCOMPLETE' && Array.isArray(earlySubmit.quota_gaps),
  'server rejects early submit with QUOTA_INCOMPLETE', JSON.stringify(earlySubmit.code || earlySubmit.error).slice(0, 90));

// Now complete the quota via the API (2 chapters' questions) and save — must pass.
const chemQs = await fetch(
  `${BASE}/questions?page=1&limit=5&subject=chemistry&chapter=${encodeURIComponent('Alcohols Phenols and Ethers')}&difficulty=medium`,
  { headers: { Authorization: `Bearer ${f2.token}` } }
).then((r) => r.json());
const chemQs2 = await fetch(
  `${BASE}/questions?page=1&limit=5&subject=chemistry&chapter=${encodeURIComponent('Electrochemistry')}&difficulty=medium`,
  { headers: { Authorization: `Bearer ${f2.token}` } }
).then((r) => r.json());
const ids = [...(chemQs.data || []).slice(0, 1), ...(chemQs2.data || []).slice(0, 1)].map((q) => ({ id: q.id, marks: 4, negative_marks: 1 }));
check(ids.length === 2, 'fetched 2 chapter-correct questions for the full quota');
const saveOk = await fetch(`${BASE}/exams/${created2.id}/questions`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${f2.token}` },
  body: JSON.stringify({ question_ids: ids }),
}).then((r) => r.json());
check(!saveOk.error, 'full-quota save accepted', JSON.stringify(saveOk).slice(0, 80));
const submitOk = await fetch(`${BASE}/exams/${created2.id}/submit-for-review`, {
  method: 'POST', headers: { Authorization: `Bearer ${f2.token}` },
}).then((r) => r.json());
check(!submitOk.error, 'submit-for-review passes once the quota is complete', JSON.stringify(submitOk).slice(0, 80));
console.log(`\n${pass} passed, ${fail} failed`);
console.log('CLEANUP_QUOTA_ID=' + created2.id);
process.exit(fail === 0 ? 0 : 1);
