/**
 * debug-drafts.mjs — reproduce "Failed to load drafts" in the QForge portal.
 * Run from worker/ with wrangler dev on :8787:  node debug-drafts.mjs [email]
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:8787';
const PASSWORD = 'change_me_in_production';
const who = process.argv[2] || 'intern@example.com';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.on('requestfailed', r => console.log('[reqfail]', r.url(), r.failure()?.errorText));
page.on('console', m => { if (m.type()==='error') console.log('[console]', m.text().slice(0,160)); });
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
page.on('response', async r => {
  const p = new URL(r.url()).pathname;
  if (r.status() >= 400) console.log('[HTTP FAIL]', r.status(), r.request().method(), p,
    (await r.text().catch(() => '')).slice(0, 200));
  else if (/forge/.test(p)) console.log('[ok]', r.status(), p);
});

await page.goto(`${BASE}/question-gen`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.fill('#login-email', who);
await page.fill('#login-password', PASSWORD);
await page.click('#btn-login');
await page.waitForTimeout(3000);

const errorShown = async () =>
  ((await page.textContent('#draft-list').catch(() => '')) ?? '').includes('Failed to load drafts');

// Walk every tab and every filter chip, checking the queue after each click.
const steps = [
  ['tab: My Drafts', "[data-tab='drafts'], .queue-tab:has-text('My Drafts')"],
  ['tab: Approved', "[data-tab='approved'], .queue-tab:has-text('Approved')"],
  ['chip: All', ".filter-chip:has-text('All')"],
  ['chip: Pending AI', ".filter-chip:has-text('Pending AI')"],
  ['chip: Flagged', ".filter-chip:has-text('Flagged')"],
  ['chip: Awaiting', ".filter-chip:has-text('Awaiting')"],
  ['chip: Approved', ".filter-chip:has-text('Approved')"],
];

for (const [label, sel] of steps) {
  const loc = page.locator(sel).first();
  if (!(await loc.count())) { console.log(`SKIP  ${label} (not found)`); continue; }
  await loc.click().catch(e => console.log(`  click failed: ${e.message.slice(0, 80)}`));
  await page.waitForTimeout(1200);
  const shown = await errorShown();
  const inList = await page.evaluate(() => {
    const el = document.getElementById('draft-list');
    return el ? el.textContent.replace(/\s+/g,' ').trim().slice(0,120) : '(no #draft-list)';
  });
  console.log(`${shown ? 'FAIL ' : 'OK   '} ${label}  | #draft-list: ${inList}`);
}

// ── Stale / expired token scenario ──────────────────────────────────────────
// The portal renders from localStorage without revalidating, so an expired or
// revoked token should ideally bounce to the login screen instead of silently
// showing "Failed to load drafts".
await page.evaluate(() => localStorage.setItem('qforge_token', 'not.a.valid.jwt'));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const overlayVisible = await page.locator('#login-overlay').isVisible().catch(() => false);
const listText = ((await page.textContent('#draft-list').catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
console.log(`
STALE TOKEN -> login overlay shown: ${overlayVisible}`);
console.log(`STALE TOKEN -> #draft-list: ${listText.slice(0, 90)}`);
console.log(`STALE TOKEN -> user can retry: ${overlayVisible ? 'yes, sign in again' : 'NO - stuck with an error, no way back to login'}`);

await browser.close();