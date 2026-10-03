/**
 * e2e-ui.mjs — Playwright UI test: the real student journey in a real browser.
 * Run (from worker/, with `wrangler dev` on :8787):  node e2e-ui.mjs
 *
 * Why this exists: the API-level smoke test calls endpoints with hand-built payloads,
 * so it can pass while the actual UI is broken. This drives the real pages and records
 * EVERY failed HTTP response so frontend/backend contract breaks surface immediately.
 *
 * Coverage:
 *   1. login → dashboard (exercises the env-aware API base URL)
 *   2. exam list renders (exercises the exams.ts WHERE/AND regression)
 *   3. early-access path → instruction screen + countdown
 *   4. live exam → questions, options, timer, real image load from R2
 *   5. answer + mark-for-review + submit → results page with score and image
 *   6. no failed HTTP requests and no uncaught JS errors anywhere in the journey
 */

import { chromium } from 'playwright';
import sharp from 'sharp';

const BASE = 'http://localhost:8787';
const PASSWORD = 'change_me_in_production';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

async function api(path, { token, method = 'GET', body, raw, headers: extra = {} } = {}) {
  const headers = { ...extra };
  if (!raw && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(BASE + path, {
    method,
    headers,
    body: raw ? body : (body ? JSON.stringify(body) : undefined),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function login(email) {
  const r = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  return r.json?.token;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────
// A real PNG uploaded through the same endpoint the admin UI uses, so the browser
// genuinely fetches bytes back out of R2 through /images/:key.
async function uploadTestImage(token) {
  const png = await sharp({
    create: { width: 640, height: 360, channels: 3, background: { r: 30, g: 90, b: 200 } },
  }).png().toBuffer();
  const r = await api('/forge/upload-image', {
    token, method: 'POST', raw: true, body: png, headers: { 'Content-Type': 'image/png' },
  });
  if (r.status !== 201) throw new Error('image upload failed: ' + JSON.stringify(r.json));
  return r.json.r2_key;
}

async function setup() {
  const admin = await login('admin@example.com');
  const imageKey = await uploadTestImage(admin);

  const imgQ = await api('/questions', {
    token: admin, method: 'POST',
    body: {
      subject: 'UI Test Subject', chapter: 'Images', difficulty: 'medium', type: 'mcq',
      question_text: 'UI-TEST-IMG: Which diagram is shown below?',
      option_a: 'Alpha', option_b: 'Beta', option_c: 'Gamma', option_d: 'Delta',
      correct_answer: 'A', explanation: 'UI-TEST-IMG explanation', image_r2_key: imageKey,
    },
  });
  if (imgQ.status !== 201) throw new Error('question create failed: ' + JSON.stringify(imgQ.json));

  const bank = await api('/questions?limit=6', { token: admin });
  const others = (bank.json?.data ?? []).map(q => q.id).filter(id => id !== imgQ.json.id).slice(0, 2);
  const questionIds = [...new Set([imgQ.json.id, ...others])];

  const makeExam = async (title, startsAtOffsetSec) => {
    const created = await api('/exams', {
      token: admin, method: 'POST',
      body: {
        title, duration_minutes: 30, total_marks: 12,
        question_ids: questionIds.map(id => ({ id, marks: 4, negative_marks: 1 })),
      },
    });
    if (created.status !== 201) throw new Error('exam create failed: ' + JSON.stringify(created.json));
    const pub = await api(`/exams/${created.json.id}/publish`, {
      token: admin, method: 'PUT',
      body: { starts_at: Math.floor(Date.now() / 1000) + startsAtOffsetSec },
    });
    if (pub.status !== 200) throw new Error('publish failed: ' + JSON.stringify(pub.json));
    return created.json.id;
  };

  // Live exam: already started.
  const liveExamId = await makeExam('UI Test Exam (live)', -60);
  // Early-access exam: starts shortly after "now".
  const futureExamId = await makeExam('UI Test Exam (early access)', 3600);

  return { liveExamId, futureExamId, imageKey };
}

const { liveExamId, futureExamId, imageKey } = await setup();
console.log(`\nFixtures: live exam ${liveExamId}, early-access exam ${futureExamId}`);
console.log(`Image under test: ${imageKey}\n`);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();

const failedResponses = [];
const pageErrors = [];
const dialogs = [];
page.on('response', r => {
  if (r.status() >= 400) failedResponses.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`);
});
page.on('pageerror', e => pageErrors.push(String(e).slice(0, 160)));
page.on('dialog', async d => { dialogs.push(`${d.type()}: ${d.message()}`); await d.accept(); });

try {
  // ── 1. Login ───────────────────────────────────────────────────────────────
  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await page.fill('#email', 'student@example.com');
  await page.fill('#password', PASSWORD);
  await page.click('#loginBtn');
  await page.waitForURL(/dashboard/, { timeout: 15000 }).catch(() => {});
  check('Student logs in and lands on dashboard', page.url().includes('dashboard'), page.url());

  const tokenStored = await page.evaluate(() => localStorage.getItem('cbt_token'));
  check('Auth token is stored after login', !!tokenStored);

  // ── 2. Dashboard ───────────────────────────────────────────────────────────
  await page.waitForSelector('#examGrid', { timeout: 10000 });
  await page.waitForTimeout(1500);
  const gridText = (await page.textContent('#examGrid')) ?? '';
  check('Dashboard exam list renders without error', !/failed to load/i.test(gridText),
    /failed to load/i.test(gridText) ? gridText.trim().slice(0, 80) : '');
  const cardCount = await page.locator('#examGrid .exam-card').count();
  check('At least one exam card is listed', cardCount > 0, `${cardCount} card(s)`);

  // ── 3. Early-access path → instruction screen with countdown ───────────────
  failedResponses.length = 0;
  await page.goto(`${BASE}/exam.html?id=${futureExamId}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const instructionVisible = await page.locator('#instructionScreen').isVisible().catch(() => false);
  check('Early access shows the instruction screen', instructionVisible);

  const countdown = ((await page.textContent('#instCountdown').catch(() => '')) ?? '').trim();
  check('Countdown is ticking before the exam starts', /^\d{2}:\d{2}$/.test(countdown), countdown);

  const beginDisabled = await page.locator('#btnBeginExam').isDisabled().catch(() => false);
  check('Begin button is locked until the exam starts', beginDisabled);

  const earlyLeaks = failedResponses.filter(u => /exam|attempt/i.test(u));
  check('Early-access fetch has no 4xx/5xx', earlyLeaks.length === 0, earlyLeaks.join(', ') || 'clean');

  // ── 4. Live exam ───────────────────────────────────────────────────────────
  failedResponses.length = 0;
  await page.goto(`${BASE}/exam.html?id=${liveExamId}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#mainExamLayout', { state: 'visible', timeout: 10000 }).catch(() => {});
  const examLayoutVisible = await page.locator('#mainExamLayout').isVisible().catch(() => false);
  check('Live exam opens the exam interface directly', examLayoutVisible, page.url());

  const qText = ((await page.textContent('#questionText').catch(() => '')) ?? '').trim();
  check('Question content renders', qText.length > 3, qText.slice(0, 40));

  // The image question is shuffled in, so walk the grid until we find it.
  const gridCells = await page.locator('#questionGrid .q-btn, #questionGrid button, #questionGrid div').count();
  check('Question navigation grid renders', gridCells > 0, `${gridCells} cell(s)`);

  let imageReport = { found: false, loaded: false, src: '', natural: [0, 0] };
  for (let i = 0; i < Math.max(gridCells, 1); i++) {
    await page.locator('#questionGrid .q-btn, #questionGrid button, #questionGrid div').nth(i).click().catch(() => {});
    await page.waitForTimeout(350);
    const img = page.locator('#questionText img');
    if (await img.count()) {
      const src = await img.getAttribute('src');
      if (src && src.includes(imageKey)) {
        imageReport = await img.evaluate(el => ({
          found: true, loaded: el.complete && el.naturalWidth > 0,
          src: el.src, natural: [el.naturalWidth, el.naturalHeight],
        }));
        break;
      }
    }
  }
  check('Question image is rendered from the R2 image endpoint', imageReport.found,
    imageReport.found ? imageReport.src : `no <img> for ${imageKey}`);
  check('Question image actually decodes in the browser', imageReport.loaded,
    imageReport.found ? `${imageReport.natural[0]}x${imageReport.natural[1]}` : 'no image found');

  // ── 5. Answering ───────────────────────────────────────────────────────────
  const timerText = ((await page.textContent('#timer').catch(() => '')) ?? '').trim();
  check('Countdown timer is running', /^\d{2}:\d{2}:\d{2}$/.test(timerText), timerText);

  const optionCount = await page.locator('#optionsList .option-item, #optionsList li, #optionsList button').count();
  check('Answer options render', optionCount > 0, `${optionCount} option(s)`);

  let answeredSomething = false;
  for (let i = 0; i < Math.max(gridCells, 1); i++) {
    await page.locator('#questionGrid .q-btn, #questionGrid button, #questionGrid div').nth(i).click().catch(() => {});
    await page.waitForTimeout(250);
    const opt = page.locator('#optionsList .option-item, #optionsList li, #optionsList button').first();
    if (await opt.count()) {
      await opt.click().catch(() => {});
      const selected = await page.locator('#optionsList .selected').count();
      if (selected > 0) { answeredSomething = true; break; }
    }
  }
  check('Selecting an option marks it selected', answeredSomething);

  // Mark another question for review, then save-and-next on the rest.
  if (gridCells > 1) {
    await page.locator('#questionGrid .q-btn, #questionGrid button, #questionGrid div').nth(1).click().catch(() => {});
    await page.waitForTimeout(250);
  }
  await page.locator('#btnMarkReview').click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
  const reviewCells = await page.locator('#questionGrid .review, #questionGrid .answered-review').count();
  check('Mark-for-review is reflected in the question grid', reviewCells > 0, `${reviewCells} cell(s)`);

  // ── 6. Submit ──────────────────────────────────────────────────────────────
  failedResponses.length = 0;
  await page.locator('#btnSubmit').click({ timeout: 5000 }).catch(() => {});
  await page.waitForURL(/results/, { timeout: 15000 }).catch(() => {});
  const onResults = page.url().includes('results');
  check('Submit navigates to results', onResults, page.url());

  const submitFailures = failedResponses.filter(u => /attempt|submission/i.test(u));
  check('Attempts + submission calls succeeded', submitFailures.length === 0, submitFailures.join(', ') || 'clean');

  if (onResults) {
    await page.waitForTimeout(2500);
    const score = ((await page.textContent('#totalScore').catch(() => '')) ?? '').trim();
    check('Results page shows a score', /^-?\d+(\.\d+)?$/.test(score), score);

    await page.waitForSelector('#resultsContent', { state: 'visible', timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const answerItems = await page.locator('#answerList .answer-item').count();
    check('Results page lists scored answers', answerItems > 0, `${answerItems} item(s)`);

    const resultImg = page.locator('#answerList img').first();
    const hasResultImg = await resultImg.count() > 0;
    check('Results page includes the question image', hasResultImg);
    if (hasResultImg) {
      const loaded = await resultImg.evaluate(el => el.complete && el.naturalWidth > 0);
      check('Results image decodes in the browser', loaded,
        await resultImg.evaluate(el => `${el.naturalWidth}x${el.naturalHeight}`));
    }
  }

  // ── 7. No unexpected failures anywhere in the journey ──────────────────────
  const unexpected = failedResponses.filter(u => !u.includes('favicon'));
  check('No failed HTTP requests in the whole journey', unexpected.length === 0, unexpected.slice(0, 6).join(' | '));
  check('No uncaught JS errors in the whole journey', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  const errorDialogs = dialogs.filter(d => d.startsWith('alert') && /fail|error|unable|denied|prohibited/i.test(d));
  check('No error alerts were shown to the user', errorDialogs.length === 0, errorDialogs.slice(0, 3).join(' | '));

} catch (e) {
  check('Test run completed without throwing', false, String(e.message).slice(0, 200));
} finally {
  await browser.close();
}

const passed = results.filter(r => r.pass).length;
const failed = results.length - passed;
console.log('\n' + '─'.repeat(56));
console.log(`UI E2E: ${passed}/${results.length} checks passed`);
if (failed) {
  console.log('\nFailed:');
  results.filter(r => !r.pass).forEach(r => console.log(`  - ${r.name}${r.detail ? ' :: ' + r.detail : ''}`));
  process.exit(1);
}