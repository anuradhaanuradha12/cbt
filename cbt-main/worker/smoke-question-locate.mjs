// ─── Smoke test: /questions/locate + pagination determinism ──────────────────
// The Active Blueprint panel jumps to a selected question by asking the server
// which page holds it. That only works if the list ordering is stable, so this
// checks both:
//
//   1. locate(q) returns a page that really contains q
//   2. walking every page yields each question exactly once (no repeats/skips)
//
// Usage:  node smoke-question-locate.mjs     (dev server must be running on :8787)

const BASE = 'http://127.0.0.1:8787';
const SUBJECT = 'chemistry';
const CHAPTER = 'Alcohols Phenols and Ethers';
const PER_PAGE = 20;

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`); }
  else    { failed++; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
};

const api = async (p, token) => {
  const res = await fetch(`${BASE}${p}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

const login = await fetch(`${BASE}/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'chemistry@cbt.local', password: 'demo12345' }),
}).then(r => r.json());
const token = login.token;
if (!token) throw new Error('faculty login failed');

const chapterQ = (page, limit = PER_PAGE) =>
  api(`/questions?subject=${SUBJECT}&chapter=${encodeURIComponent(CHAPTER)}&page=${page}&limit=${limit}`, token);

async function run() {
  console.log('QForge — question locate smoke test\n');

  const first = await chapterQ(1);
  const total = first.data.total;
  console.log(`chapter "${CHAPTER}": ${total} questions`);
  check('chapter has questions to locate', total > 0, `total ${total}`);

  // ── 1. locate() must point at a page that contains the question ──
  console.log('\n1. locate() accuracy');
  const sample = [];
  const seen = new Set();
  while (sample.length < 25 && sample.length < total) {
    const p = 1 + Math.floor(Math.random() * Math.ceil(total / PER_PAGE));
    const res = await chapterQ(p);
    for (const q of res.data.data || []) {
      if (!seen.has(q.id) && sample.length < 25) { seen.add(q.id); sample.push(q); }
    }
  }

  let wrong = 0, notFound = 0;
  for (const q of sample) {
    const loc = await api(`/questions/locate?id=${encodeURIComponent(q.id)}&per_page=${PER_PAGE}`, token);
    if (loc.status !== 200 || !loc.data.page) { notFound++; continue; }
    const page = await chapterQ(loc.data.page);
    if (!(page.data.data || []).some(x => x.id === q.id)) {
      wrong++;
      if (wrong <= 3) console.log(`     wrong page for ${q.id.slice(0, 8)} → page ${loc.data.page} (index ${loc.data.index})`);
    }
  }
  check(`locate resolves ${sample.length} sampled questions`, notFound === 0, `${notFound} unresolved`);
  check('every located page actually contains the question', wrong === 0, `${wrong} wrong`);

  // ── 2. pagination must not repeat or skip rows ──
  console.log('\n2. Pagination determinism');
  const limit = 100;
  const pages = Math.ceil(total / limit);
  const ids = [];
  for (let p = 1; p <= pages; p++) {
    const res = await chapterQ(p, limit);
    for (const q of res.data.data || []) ids.push(q.id);
  }
  const unique = new Set(ids);
  check('no question appears on two pages', unique.size === ids.length,
    `${ids.length} rows, ${unique.size} unique`);
  check('every question is reachable across pages', unique.size === total,
    `${unique.size} of ${total}`);

  console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch(e => { console.error('crashed:', e); process.exit(1); });
