// Drive a real Chrome over CDP: login state → demo exam → Q11 → verify the
// two diagram options actually render as <img> elements.
import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8787';
const EXAM_ID = 'd5565f01-943a-49d7-954a-2be12336d699';
const QID = '4adc294d-48a1-410a-9c8f-46493280e530';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── get a student token ──────────────────────────────────────────────
const login = await fetch(`${BASE}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  // Students are seeded with a different password than staff (see seed.sql).
  body: JSON.stringify({ email: 'student@example.com', password: 'change_me_in_production' }),
}).then((r) => r.json());
if (!login.token) throw new Error('student login failed: ' + JSON.stringify(login));
console.log('student token acquired');

// ── launch chrome ────────────────────────────────────────────────────
const profile = mkdtempSync(join(tmpdir(), 'cdp-'));
const port = 9333;
const chrome = execFile(CHROME, [
  '--headless=new', '--remote-debugging-port=' + port, '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--user-data-dir=' + profile, 'about:blank',
]);
process.on('exit', () => { try { chrome.kill(); } catch {} });

// wait for CDP
let version = null;
for (let i = 0; i < 30; i++) {
  try { version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()); break; }
  catch { await sleep(500); }
}
if (!version) throw new Error('chrome CDP never came up');
console.log('chrome up:', version.Browser);

// ── open a tab ───────────────────────────────────────────────────────
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
  if (r.exceptionDetails) throw new Error('page JS error: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};

// ── seed auth, then walk the flow ────────────────────────────────────
await send('Page.enable');

// localStorage needs a real origin — land on the app root first
await send('Page.navigate', { url: `${BASE}/` });
await sleep(1500);
await evalJS(`localStorage.setItem('cbt_token', ${JSON.stringify(login.token)}); localStorage.setItem('cbt_user', ${JSON.stringify(JSON.stringify(login.user))}); 'seeded'`);

console.log('→ navigating to exam page');
await send('Page.navigate', { url: `${BASE}/exam?id=${EXAM_ID}` });
await sleep(3500); // let instructions screen + attempt boot

const phase = await evalJS(`({
  instructionVisible: !!document.getElementById('instructionScreen') && getComputedStyle(document.getElementById('instructionScreen')).display !== 'none',
  mainVisible: !!document.getElementById('mainExamLayout') && getComputedStyle(document.getElementById('mainExamLayout')).display !== 'none',
  title: (document.getElementById('instExamTitle') || document.getElementById('examTitle') || {}).textContent || null,
})`);
console.log('page phase:', JSON.stringify(phase));

if (phase.instructionVisible) {
  console.log('→ clicking Begin Exam');
  await evalJS(`document.getElementById('btnBeginExam').click(); 'clicked'`);
  await sleep(2500);
}

// Q11 is the image question — jump straight to it via the grid buttons
// The attempt shuffles question order, so walk EVERY question and stop at the
// first one whose options render <img> elements (the diagram-option question).
console.log('→ scanning all questions for the diagram-option one');
let found = null;
for (let i = 0; i < 15; i++) {
  await sleep(400);
  const imgs = await evalJS(`(function(){
    const ol = document.getElementById('optionsList');
    const list = Array.from((ol || document).querySelectorAll('.option-item img'));
    return JSON.stringify(list.map(i => ({
      src: i.getAttribute('src'),
      complete: i.complete,
      naturalWidth: i.naturalWidth, // >0 only if decoded successfully
      visible: i.offsetWidth > 20 && i.offsetHeight > 20,
    })));
  })()`);
  const parsed = JSON.parse(imgs);
  const onQ = await evalJS(`(document.getElementById('questionNumber') || {}).textContent || '?'`);
  const hasRawMarker = await evalJS(`document.body.innerHTML.includes('[IMAGE:') || document.body.innerHTML.includes('[IMG:')`);
  if (parsed.length > 0) {
    const qt = await evalJS(`(document.getElementById('questionText') || {}).textContent || ''`);
    found = { questionNumber: onQ, snippet: qt.slice(0, 80), imgs: parsed, rawMarkerInDom: hasRawMarker };
    break;
  }
  console.log(`  ${onQ}: no option imgs${hasRawMarker ? ' (RAW MARKER VISIBLE!)' : ''} → next`);
  const more = await evalJS(`(function(){
    const btn = document.getElementById('btnSaveNext');
    if (!btn) return 'no-btn';
    btn.click();
    return 'next';
  })()`);
  if (more === 'no-btn') { console.log('  no Save&Next button'); break; }
}

if (!found) {
  console.log('FAILED: never found the diagram-option question');
  ws.close();
  process.exit(1);
}
console.log('FOUND on ' + found.questionNumber + ':', JSON.stringify(found, null, 2));

// ── the verification ─────────────────────────────────────────────────
const check = await evalJS(`(function(){
  const qt = document.getElementById('questionText');
  const ol = document.getElementById('optionsList');
  const imgs = Array.from((ol || document).querySelectorAll('.option-item img'));
  const imgsInfo = imgs.map(i => ({
    src: i.getAttribute('src'),
    complete: i.complete,
    naturalWidth: i.naturalWidth,  // >0 only if decoded OK
    visible: i.offsetWidth > 20 && i.offsetHeight > 20,
  }));
  return {
    questionNumber: (document.getElementById('questionNumber') || {}).textContent || null,
    questionTextSnippet: qt ? qt.textContent.slice(0, 80) : null,
    optionsWithImgTag: imgsInfo.length,
    imgsInfo,
    rawMarkerInDom: (qt ? qt.textContent : '').includes('[IMAGE:') || (ol ? ol.textContent : '').includes('[IMG:'),
  };
})()`);
console.log('verify:', JSON.stringify(check, null, 2));

// ── screenshot ───────────────────────────────────────────────────────
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(600);
const shot = await send('Page.captureScreenshot', { format: 'png' });
const { writeFileSync } = await import('node:fs');
writeFileSync('exam-img-question-proof.png', Buffer.from(shot.data, 'base64'));
console.log('screenshot: worker/exam-img-question-proof.png');

ws.close();
process.exit(0);
