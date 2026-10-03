/**
 * test-downloads.mjs — verifies the two download features in a real browser:
 *   1. Admin → Users → "Download Template"  → student_template.csv
 *   2. QForge → "Download PDF" + "Print"     → real %PDF bytes
 * Run from worker/ with `wrangler dev` on :8787:  node test-downloads.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = 'http://localhost:8787';
const PASSWORD = 'change_me_in_production';
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ acceptDownloads: true });
const page = await ctx.newPage();

try {
  // ── Login once; both features live behind auth ────────────────────────────
  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await page.fill('#email', 'admin@example.com');
  await page.fill('#password', PASSWORD);
  await page.click('#loginBtn');
  // Admins are routed to /admin, students to /dashboard.
  await page.waitForURL(/\/(admin|dashboard)/, { timeout: 15000 });

  // ── 1. Admin CSV template download ────────────────────────────────────────
  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.locator("[data-tab='users']").click().catch(() => {});
  await page.waitForTimeout(800);

  const [csvDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
    page.locator('#btnDownloadTemplate').click(),
  ]);
  check('Admin CSV template triggers a download', !!csvDownload, csvDownload ? csvDownload.suggestedFilename() : 'no download event');
  if (csvDownload) {
    const p = await csvDownload.path();
    const body = fs.readFileSync(p, 'utf8');
    check('CSV filename is student_template.csv', csvDownload.suggestedFilename() === 'student_template.csv', csvDownload.suggestedFilename());
    check('CSV has the name,email,password header', /^name,email,password/m.test(body), body.split('\n')[0]);
    check('CSV has sample rows to fill in', body.trim().split('\n').length >= 3, `${body.trim().split('\n').length} lines`);
  }

  // ── 2. QForge PDF download + print ────────────────────────────────────────
  await page.goto(`${BASE}/question-gen`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  // The portal has its own auth overlay and its own token key (qforge_token),
  // independent of the main app's cbt_token — so log in through its own form.
  const overlay = page.locator('#login-overlay');
  const needsLogin = await overlay.count() > 0 && await overlay.isVisible().catch(() => false);
  check('QForge shows its own login overlay', needsLogin);
  if (needsLogin) {
    await page.fill('#login-email', 'admin@example.com');
    await page.fill('#login-password', PASSWORD);
    await page.click('#btn-login');
    await page.waitForTimeout(3000);
    const stillLogin = await overlay.isVisible().catch(() => false);
    check('QForge sign-in succeeds', !stillLogin, stillLogin ? await page.textContent('#login-error') : '');
  }
  const qforgeToken = await page.evaluate(() => localStorage.getItem('qforge_token'));
  check('QForge stores its own qforge_token', !!qforgeToken);

  // PDF/Print both operate on whatever is in the editor, so load a draft first.
  await page.evaluate(() => {
    const d = {
      question_text: 'Downloads check: what is $2 + 2$?',
      option_a: '3', option_b: '4', option_c: '5', option_d: '6',
      correct_answer: 'B', explanation: 'Basic arithmetic.',
      subject: 'physics', chapter: 'Downloads', exam_standard: 'JEE_MAIN', difficulty: 'medium',
    };
    loadDraftIntoEditor(null, d, d);
  });
  await page.waitForSelector('#editor-form.visible', { timeout: 8000 });
  check('Editor opens with a question loaded', (await page.inputValue('#ed-question')) !== '');
  await page.waitForTimeout(1000);

  const pdfBtn = page.locator('#btn-download-pdf');
  check('QForge Download PDF button is present', await pdfBtn.count() > 0);

  const [pdfDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }).catch(() => null),
    pdfBtn.click().catch(() => {}),
  ]);
  check('Download PDF produces a file', !!pdfDownload, pdfDownload ? pdfDownload.suggestedFilename() : 'no download event');
  if (pdfDownload) {
    const p = await pdfDownload.path();
    const head = fs.readFileSync(p).subarray(0, 4).toString();
    const size = fs.statSync(p).size;
    check('Downloaded file is a real PDF', head === '%PDF', `${head} · ${(size / 1024).toFixed(1)} KB`);
    check('Downloaded filename follows the qforge-<subject>-<chapter> pattern',
      /^qforge-.+\.pdf$/.test(pdfDownload.suggestedFilename()), pdfDownload.suggestedFilename());
  }

  // Print path
  const printBtn = page.locator('#btn-print, button:has-text("Print")').first();
  check('Print button is present', await printBtn.count() > 0);
  if (await printBtn.count()) {
    await page.evaluate(() => { window.__printed = false; window.print = () => { window.__printed = true; }; });
    await printBtn.click().catch(() => {});
    await page.waitForTimeout(500);
    check('Print button calls window.print()', await page.evaluate(() => window.__printed === true));
  }
} catch (e) {
  check('Test run completed without throwing', false, String(e.message).slice(0, 200));
} finally {
  await browser.close();
}

const passed = results.filter(r => r.pass).length;
console.log('\n' + '─'.repeat(56));
console.log(`DOWNLOADS: ${passed}/${results.length} checks passed`);
if (passed !== results.length) {
  results.filter(r => !r.pass).forEach(r => console.log(`  - ${r.name}`));
  process.exit(1);
}