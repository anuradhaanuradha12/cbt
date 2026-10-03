/**
 * test-downloads-page.mjs — Playwright UI test for the Downloads & Export hub page.
 * Run from worker/ with `wrangler dev` on :8787:  node test-downloads-page.mjs
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

try {
  // ── 1. Unauthenticated visitors are sent to the login page ────────────────
  {
    const anon = await browser.newContext();
    const anonPage = await anon.newPage();
    await anonPage.goto(`${BASE}/downloads`, { waitUntil: 'domcontentloaded' });
    await anonPage.waitForTimeout(1200);
    check('Downloads page redirects anonymous visitors to login',
      anonPage.url().replace(/\/$/, '') === BASE, anonPage.url());
    await anon.close();
  }

  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e).slice(0, 140)));

  // ── 2. Logged in, the page renders ────────────────────────────────────────
  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await page.fill('#email', 'admin@example.com');
  await page.fill('#password', PASSWORD);
  await page.click('#loginBtn');
  await page.waitForURL(/\/(admin|dashboard)/, { timeout: 15000 });

  await page.goto(`${BASE}/downloads`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.dl-card', { timeout: 10000 });
  check('Downloads page renders for a signed-in user', page.url().includes('/downloads'), page.url());

  const heading = (await page.textContent('h1').catch(() => '')) ?? '';
  check('Page has a title', heading.trim().length > 0, heading.trim());

  const cardCount = await page.locator('.dl-card').count();
  check('Export cards are listed', cardCount >= 4, `${cardCount} card(s)`);

  check('User name is shown in the header',
    (((await page.textContent('#userName').catch(() => '')) ?? '').trim().length > 0));

  // ── 3. Links point at the real features ───────────────────────────────────
  const forgeHref = await page.getAttribute('#btnOpenForge', 'href');
  check('PDF card links to the Question Forge', forgeHref === '/question-gen', forgeHref ?? '');

  const adminHref = await page.getAttribute('#btnOpenAdmin', 'href');
  check('CSV card links to the admin panel', adminHref === '/admin', adminHref ?? '');

  // ── 4. CSV template downloads straight from this page ─────────────────────
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
    page.locator('#btnDownloadCsv').click(),
  ]);
  check('CSV template downloads from the hub page', !!download, download ? download.suggestedFilename() : 'no download event');
  if (download) {
    const body = fs.readFileSync(await download.path(), 'utf8');
    check('CSV is named student_template.csv', download.suggestedFilename() === 'student_template.csv', download.suggestedFilename());
    check('CSV has the expected header', /^name,email,password/m.test(body), body.split('\n')[0]);
  }

  // ── 5. API status strip reports honestly ──────────────────────────────────
  await page.waitForTimeout(1500);
  const statusText = ((await page.textContent('#statusText').catch(() => '')) ?? '').trim();
  check('API status is reported', statusText.length > 0 && !/checking/i.test(statusText), statusText);
  const offline = await page.locator('#statusStrip.offline').count();
  check('Status strip matches the real API state', offline === 0, offline ? 'flagged offline' : 'connected');

  check('No uncaught JS errors on the page', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

} catch (e) {
  check('Test run completed without throwing', false, String(e.message).slice(0, 200));
} finally {
  await browser.close();
}

const passed = results.filter(r => r.pass).length;
console.log('\n' + '─'.repeat(56));
console.log(`DOWNLOADS PAGE: ${passed}/${results.length} checks passed`);
if (passed !== results.length) {
  results.filter(r => !r.pass).forEach(r => console.log(`  - ${r.name}`));
  process.exit(1);
}