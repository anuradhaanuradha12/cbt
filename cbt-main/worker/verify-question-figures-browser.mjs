// Drive a real Chrome to prove diagram images actually render (not just return
// 200 from the API) in the two places the bank shows them:
//
//   A. Question Bank cards — img[alt="Question Image"] and, inside the solution
//      block, img[alt="Solution Image"]  ← the surface in the bug screenshot
//   B. Exam page — the same figure inside a live attempt
//
// A 404 renders as a broken-image glyph whose naturalWidth is 0, so decoding
// (complete === true && naturalWidth > 0) is the assertion that matters.
//
// Faculty are subject-locked, so each faculty account sweeps its own subject
// (and only the chapters its blueprints assign, which is what the UI offers).
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8787';
const ADMIN_PAGE = `${BASE}/admin`;
const EXAM_ID = 'd5565f01-943a-49d7-954a-2be12336d699'; // has 2 figure questions
const CHAPTERS_PER_FACULTY = 3;

const FACULTIES = [
  { email: 'physics@cbt.local', password: 'demo12345' },
  { email: 'chemistry@cbt.local', password: 'demo12345' },
];
const WANT = { subject: 'physics', chapter: 'Electromagnetic Induction', text: 'induced current in loop' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
  if (ok) { pass++; console.log(`  PASS  ${label}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); }
};

const login = async (email, password) => {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const j = await res.json();
  if (!j.token) throw new Error(`${email} login failed: ${JSON.stringify(j)}`);
  return j;
};
const apiGet = (token, path) =>
  fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());

// ── chrome ───────────────────────────────────────────────────
const profile = mkdtempSync(join(tmpdir(), 'cdp-'));
const port = 9341;
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
const waitFor = async (expr, ms = 25000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if (await evalJS(expr)) return true; } catch {}
    await sleep(250);
  }
  return false;
};

await send('Page.enable');

// Sign in as a role, then hard-load a page as that user. Going through
// about:blank guarantees the new session isn't a same-URL no-op navigation.
async function open(page, creds, readyExpr) {
  const { token, user } = creds.token ? creds : await login(creds.email, creds.password);
  await send('Page.navigate', { url: 'about:blank' });
  await sleep(300);
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(1200);
  await evalJS(
    `localStorage.setItem('cbt_token', ${JSON.stringify(token)});` +
    `localStorage.setItem('cbt_user', ${JSON.stringify(JSON.stringify(user))}); 'ok'`
  );
  await send('Page.navigate', { url: `${page}${page.includes('?') ? '&' : '?'}t=${Date.now()}` });
  return waitFor(readyExpr, 30000);
}

// ── which chapters will this faculty's UI offer? ────────────
async function chaptersFor(creds) {
  const { token, user } = await login(creds.email, creds.password);
  const subject = String(user.subject || '').toLowerCase();
  const real = new Set((await apiGet(token, `/questions/chapters?subject=${encodeURIComponent(subject)}`)).chapters || []);
  const drafts = await apiGet(token, '/exams?status=draft');
  const assigned = new Set();
  for (const e of Array.isArray(drafts) ? drafts : []) {
    if (!e.chapter_quotas) continue;
    try {
      const q = JSON.parse(e.chapter_quotas);
      if (q && q[subject]) Object.keys(q[subject]).forEach((c) => assigned.add(c));
    } catch {}
  }
  return { token, user, subject, chapters: [...assigned].filter((c) => real.has(c)) };
}

// The default bank ordering buries diagram questions at the very end of each
// chapter (page 20+), which is why a plain first-page search shows none. Filter
// to a difficulty that actually contains diagrams, discovered from the API the
// same way the UI would ask for it.
const DIFFICULTIES = ['medium', 'hard'];
async function sweepsFor(plan) {
  const combos = [];
  const ordered = [WANT.chapter, ...plan.chapters.filter((c) => c !== WANT.chapter)];
  for (const chapter of ordered) {
    for (const difficulty of DIFFICULTIES) {
      const res = await apiGet(
        plan.token,
        `/questions?page=1&limit=20&subject=${encodeURIComponent(plan.subject)}` +
          `&chapter=${encodeURIComponent(chapter)}&difficulty=${difficulty}`
      );
      if (res.error || !Array.isArray(res.data)) continue;
      const figs = res.data.filter((q) => q.image_r2_key).length;
      if (figs > 0) combos.push({ chapter, difficulty, figs, total: res.total });
    }
    if (combos.length >= CHAPTERS_PER_FACULTY) break;
  }
  return combos;
}

const BANK_READY = `!!document.querySelector('.nav-link.bg-indigo-500\\\\/10') && !!document.getElementById('filterSubject')`;
const EXAM_READY = `!!document.getElementById('questionNumber') || !!document.getElementById('instructionScreen') || !!document.getElementById('questionText')`;

// ═══ A. Question Bank cards ═════════════════════════════════
console.log('\n── A. Question Bank cards ──────────────────────────');
const sampled = [];

for (const fac of FACULTIES) {
  const plan = await chaptersFor(fac);
  const sweeps = await sweepsFor(plan);
  console.log(
    `\n  [${plan.user.role} ${plan.user.email} · subject=${plan.subject}] ` +
    `diagram-bearing searches: ${sweeps.map((s) => `${s.chapter}/${s.difficulty}(${s.figs})`).join(', ') || '(none found)'}`
  );

  const booted = await open(ADMIN_PAGE, plan, BANK_READY);
  check(booted, `${fac.email}: admin page boots`);
  if (!booted) continue;

  await evalJS(`document.querySelector('[data-tab="questions"]').click(); 'ok'`);
  // Faculty get the subject locked + chapters repopulated from their blueprints.
  const chaptersListed = await waitFor(
    `document.getElementById('filterChapter') && Array.from(document.getElementById('filterChapter').options).length > 1`,
    20000
  );
  check(chaptersListed, `${fac.email}: chapter filter is populated from assigned chapters`);

  for (const sweep of sweeps) {
    const { chapter, difficulty } = sweep;
    const has = await evalJS(`Array.from(document.getElementById('filterChapter').options).some(o => o.value === ${JSON.stringify(chapter)})`);
    if (!has) { check(false, `${fac.email}: "${chapter}" offered in the chapter filter`); continue; }

    await evalJS(`(function(){
      const c = document.getElementById('filterChapter');
      c.value = ${JSON.stringify(chapter)};
      c.dispatchEvent(new Event('change', { bubbles: true }));
      const d = document.getElementById('filterDifficulty');
      d.value = ${JSON.stringify(difficulty)};
      d.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('btnSearch').click();
      return 'ok';
    })()`);

    const rendered = await waitFor(`document.querySelectorAll('#questionsContainer > div').length > 0`, 30000);
    if (!rendered) { check(false, `${fac.email} · ${chapter}/${difficulty}: cards rendered`); continue; }
    await sleep(1500); // let <img> requests settle

    // Open the collapsed solution blocks so explanation figures load too.
    await evalJS(`Array.from(document.querySelectorAll('#questionsContainer .toggle-solution')).forEach(b => {
      const s = b.querySelector('span'); if (s && s.textContent === 'Show Solution') b.click();
    }); 'ok'`);
    await sleep(1500);

    const stats = JSON.parse(await evalJS(`(function(){
      const grabbed = (sel) => Array.from(document.querySelectorAll(sel)).map(i => ({
        src: i.getAttribute('src'), complete: i.complete, naturalWidth: i.naturalWidth,
      }));
      const cards = Array.from(document.querySelectorAll('#questionsContainer > div'));
      return JSON.stringify({
        cards: cards.length,
        figures: grabbed('#questionsContainer img[alt="Question Image"]'),
        solutions: grabbed('#questionsContainer img[alt="Solution Image"]'),
        snippet: cards.map(c => c.textContent || '').join(' | '),
      });
    })()`));

    const broken = (list) => list.filter((i) => !i.complete || i.naturalWidth === 0);
    const bf = broken(stats.figures);
    const bs = broken(stats.solutions);
    sampled.push({ fac: fac.email, chapter, difficulty, ...stats });

    console.log(
      `    ${chapter}/${difficulty}: ${stats.cards} cards, ${stats.figures.length} figure img (${bf.length} broken),` +
      ` ${stats.solutions.length} solution img (${bs.length} broken)`
    );
    check(stats.figures.length > 0, `${fac.email} · ${chapter}/${difficulty}: figure images present`, `${stats.figures.length} img`);
    check(bf.length === 0, `${fac.email} · ${chapter}/${difficulty}: every figure decodes`,
      stats.figures.length ? `widths ${stats.figures.map((f) => f.naturalWidth).join(',')}` : 'no figures to check');
    if (stats.solutions.length) check(bs.length === 0, `${fac.email} · ${chapter}/${difficulty}: explanation figures decode`);

    if (plan.subject === WANT.subject && chapter === WANT.chapter) {
      const card = stats.figures.find((f) => /^\/images\/questions\//.test(f.src || ''));
      check(!!card && card.naturalWidth > 0, 'a diagram on the screenshot question\'s chapter decodes',
        card ? `${card.src.slice(0, 56)}… ${card.naturalWidth}px` : 'no /images/questions img found');
    }
  }
}

// capture the bank while it is showing diagram cards
{
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync('verify-question-figures-proof.png', Buffer.from(shot.data, 'base64'));
  console.log('\n  bank screenshot → worker/verify-question-figures-proof.png');
}

const allFigs = sampled.flatMap((s) => s.figures);
const allSols = sampled.flatMap((s) => s.solutions);
const brokenAll = [...allFigs, ...allSols].filter((i) => !i.complete || i.naturalWidth === 0);
check(allFigs.length >= 10, 'sampled enough diagrams to be meaningful', `${allFigs.length} figure + ${allSols.length} solution imgs over ${sampled.length} chapter searches`);
check(brokenAll.length === 0, 'zero broken diagrams across the whole sweep', `broken ${brokenAll.length} / ${allFigs.length + allSols.length}`);

// ═══ B. Exam page ═══════════════════════════════════════════
console.log('\n── B. Exam page (live attempt) ─────────────────────');
const student = { email: 'student@example.com', password: 'change_me_in_production' };
check(await open(`${BASE}/exam?id=${EXAM_ID}`, student, EXAM_READY), 'exam page boots as the student');

const begun = await evalJS(`(function(){
  const b = document.getElementById('btnBeginExam');
  if (b && b.offsetParent !== null) { b.click(); return 'clicked'; }
  return 'no-instructions';
})()`);
await sleep(2500);
console.log(`  begin: ${begun}`);

let examFig = null;
for (let i = 0; i < 20; i++) {
  await sleep(350);
  const page = JSON.parse(await evalJS(`(function(){
    const qt = document.getElementById('questionText');
    const ol = document.getElementById('optionsList');
    const all = Array.from((qt || document).querySelectorAll('img')).concat(
      Array.from((ol || document).querySelectorAll('img')));
    return JSON.stringify({
      n: (document.getElementById('questionNumber') || {}).textContent || '?',
      imgs: all.map(i => ({ src: i.getAttribute('src'), complete: i.complete, naturalWidth: i.naturalWidth })),
    });
  })()`));
  const real = page.imgs.filter((im) => im.src && im.src.includes('/images/'));
  if (real.length) { examFig = { q: page.n, imgs: real }; break; }
  const advanced = await evalJS(`(function(){
    const b = document.getElementById('btnSaveNext'); if (!b) return 'none'; b.click(); return 'next';
  })()`);
  if (advanced === 'none') break;
}

if (examFig) {
  const broken = examFig.imgs.filter((im) => !im.complete || im.naturalWidth === 0);
  console.log(`  ${examFig.q}: ${examFig.imgs.length} image(s) — widths ${examFig.imgs.map((i) => i.naturalWidth).join(',')}`);
  check(broken.length === 0, 'exam question figure decodes', `${examFig.q}, ${examFig.imgs.length} img`);
} else {
  check(false, 'found a question with a rendered figure in the exam');
}

// ── proof screenshot ─────────────────────────────────────────
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync('verify-question-figures-exam-proof.png', Buffer.from(shot.data, 'base64'));
console.log('\nexam screenshot → worker/verify-question-figures-exam-proof.png');

console.log(`\n${pass}/${pass + fail} checks passed`);
ws.close();
process.exit(fail ? 1 : 0);
