/**
 * Playwright test: QForge "Download PDF" and "Print" features
 * Run:  node test-pdf-features.mjs   (from worker/, server must be on :8787)
 */
import { chromium } from 'playwright';
import fs from 'fs';

const BASE = 'http://localhost:8787';
const OUT = 'test-results';
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ acceptDownloads: true });

const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));

try {
  // ── 1. Load portal & login ─────────────────────────────────────────────
  await page.goto(BASE + '/question-gen', { waitUntil: 'networkidle' });
  check('Portal loads', (await page.title()).includes('QForge'), await page.title());

  await page.fill('#login-email', 'admin@example.com');
  await page.fill('#login-password', 'change_me_in_production');
  await page.click('#btn-login');
  await page.waitForSelector('#login-overlay', { state: 'hidden', timeout: 15000 });
  check('Login as admin works', true);

  // ── 2. Populate the editor with a sample question ──────────────────────
  const draft = {
    question_text: 'A ball is thrown upward at $20\\,\\mathrm{m/s}$. Find the maximum height. $(g = 10\\,\\mathrm{m/s^2})$',
    option_a: '10 m', option_b: '20 m', option_c: '40 m', option_d: '80 m',
    correct_answer: 'B',
    explanation: 'At max height $v = 0$, so $s = u^2 / 2g = 400/20 = 20$ m.',
    subject: 'physics', chapter: 'Kinematics', exam_standard: 'JEE_MAIN', difficulty: 'medium',
  };
  await page.evaluate(d => loadDraftIntoEditor(null, d, d), draft);
  await page.waitForSelector('#editor-form.visible', { timeout: 5000 });
  check('Editor opens with sample question', await page.inputValue('#ed-question') !== '');

  // ── 3. FEATURE 1: Download PDF ─────────────────────────────────────────
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    page.click('#btn-download-pdf'),
  ]);
  const pdfPath = `${OUT}/qforge-test.pdf`;
  await download.saveAs(pdfPath);
  const buf = fs.readFileSync(pdfPath);
  check('Download PDF triggers a file download', true, download.suggestedFilename());
  check('File is a real PDF (%PDF magic bytes)', buf.subarray(0, 5).toString() === '%PDF-');
  check('PDF has substantial content', buf.length > 1000, `${(buf.length / 1024).toFixed(1)} KB`);
  check('Suggested filename matches', download.suggestedFilename() === 'qforge-physics-kinematics.pdf', download.suggestedFilename());

  // ── 4. FEATURE 2: Print ────────────────────────────────────────────────
  await page.evaluate(() => {
    window.__printCalled = false;
    window.__bodyHadPrintMode = false;
    window.print = () => {
      window.__printCalled = true;
      window.__bodyHadPrintMode = document.body.classList.contains('print-mode');
    };
  });
  await page.click('#btn-print');
  await page.waitForFunction('window.__printCalled === true', { timeout: 15000 });
  const printState = await page.evaluate(() => ({
    called: window.__printCalled, printMode: window.__bodyHadPrintMode,
    doc: document.getElementById('print-root').innerText,
  }));
  check('Print button calls window.print()', printState.called);
  check('Body gets print-mode class (app UI hidden during print)', printState.printMode);
  check('Print document contains the question', printState.doc.includes('maximum height'));
  // List letters are CSS-generated (list-style-type: upper-alpha), so check the DOM
  const optLis = await page.evaluate(() =>
    [...document.querySelectorAll('#print-root .pd-options li')].map(li => li.textContent.trim()));
  check('Options A–D rendered in document (4 items)', optLis.length === 4 && optLis.includes('10 m') && optLis.includes('80 m'), optLis.join(' | '));
  const optLetters = await page.evaluate(() =>
    getComputedStyle(document.querySelector('#print-root .pd-options')).listStyleType);
  check('Options use A–D lettering style', optLetters === 'upper-alpha', optLetters);
  check('Correct answer B is marked in document', printState.doc.includes('Correct Answer: B'));
  // MathJax re-renders math, so use textContent (includes rendered-math text) for explanation
  const docText = await page.evaluate(() => document.getElementById('print-root').textContent);
  const hasExplLabel = await page.evaluate(() => document.querySelectorAll('#print-root .pd-expl-label').length === 1);
  check('Explanation section present in document', hasExplLabel && docText.includes('400/20'));

  // ── 5. Visual: print-media layout screenshot ───────────────────────────
  await page.emulateMedia({ media: 'print' });
  await page.waitForTimeout(500);
  await page.locator('#print-root').screenshot({ path: `${OUT}/print-layout.png` });
  await page.emulateMedia({ media: 'screen' });
  check('Print-layout screenshot saved', fs.existsSync(`${OUT}/print-layout.png`), `${OUT}/print-layout.png`);

  // ── 6. Edge case: empty editor → friendly error, no crash ──────────────
  await page.evaluate(() => { document.getElementById('ed-question').value = ''; });
  await page.click('#btn-print').catch(() => {});
  await page.waitForTimeout(300);
  const toastShown = await page.evaluate(() => document.querySelector('.toast-error') !== null);
  check('Empty question shows friendly error toast', toastShown);

  // ── Summary ────────────────────────────────────────────────────────────
  const passed = results.filter(r => r.pass).length;
  console.log(`\n${'═'.repeat(50)}\nRESULT: ${passed}/${results.length} checks passed\n${'═'.repeat(50)}`);
  if (pageErrors.length) console.log('Page errors:', pageErrors.slice(0, 3));
  process.exit(passed === results.length ? 0 : 1);
} catch (e) {
  console.error('💥 Test crashed:', e.message);
  await page.screenshot({ path: `${OUT}/crash.png`, fullPage: true }).catch(() => {});
  process.exit(1);
} finally {
  await browser.close();
}
