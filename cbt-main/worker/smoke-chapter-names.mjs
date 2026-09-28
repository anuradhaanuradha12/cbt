// ─── Smoke test: blueprint chapter names match the question bank ─────────────
// Regression test for the bug where the exam-creation UI merged a hardcoded
// syllabus list with the real bank chapters, letting a principal save a chapter
// (e.g. "Alcohols, Phenols and Ethers") that no faculty could ever fill because
// the bank only has "Alcohols Phenols and Ethers".
//
// Verifies:
//   1. the chapters endpoint returns only real bank chapters
//   2. a real chapter name containing a comma is not split into dead chapters,
//      while a comma-separated list still unions
//   3. every chapter in an existing faculty blueprint exists in the bank
//   4. creating an exam canonicalises blueprint chapter names on write
//
// Usage:  node smoke-chapter-names.mjs      (dev server must be running on :8787)

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://127.0.0.1:8787';
const PASSWORD = 'demo12345';

let passed = 0;
let failed = 0;

function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`); }
  else    { failed++; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
}

async function api(p, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${p}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function login(email) {
  const { status, data } = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  if (status !== 200) throw new Error(`login failed for ${email} (${status})`);
  return data.token;
}

const COMMA_NAME = 'Alcohols, Phenols and Ethers';   // syllabus spelling, not in the bank
const REAL_NAME  = 'Alcohols Phenols and Ethers';    // actual bank chapter
const COMMA_REAL = 'Aldehydes, Ketones and Carboxylic Acids'; // real chapter that HAS a comma
const COMMA_CHAP = 'Aldehydes Ketones and Carboxylic Acids';  // same chapter, comma removed
const q = (token, chapter) =>
  api(`/questions?subject=chemistry&chapter=${encodeURIComponent(chapter)}&limit=1`, { token });

async function run() {
  console.log('QForge — blueprint chapter-name smoke test\n');

  const principalToken = await login('principal@example.com');
  const chemistryToken = await login('chemistry@cbt.local');

  // ── 1. Chapters endpoint returns only real bank chapters ─────
  console.log('1. GET /questions/chapters (chemistry)');
  const chaptersRes = await api('/questions/chapters?subject=chemistry', { token: chemistryToken });
  const chapters = chaptersRes.data.chapters || [];
  console.log(`   ${chapters.length} chapters`);
  check('chapters endpoint responds 200', chaptersRes.status === 200, `status ${chaptersRes.status}`);
  check(`bank chapter "${REAL_NAME}" is listed`, chapters.includes(REAL_NAME));
  check(`phantom chapter "${COMMA_NAME}" is NOT listed`, !chapters.includes(COMMA_NAME));

  // ── 2. Comma handling in the chapter filter ──────────────────
  console.log('\n2. GET /questions chapter filter');
  const realQ     = await q(chemistryToken, REAL_NAME);
  const commaReal = await q(chemistryToken, COMMA_REAL);
  const [amineQ, polymerQ, listQ] = await Promise.all([
    q(chemistryToken, 'Amines'),
    q(chemistryToken, 'Polymers'),
    q(chemistryToken, 'Amines,Polymers'),
  ]);
  check('real chapter name returns questions', realQ.data.total > 0, `total ${realQ.data.total}`);
  check('chapter name containing a comma is NOT split', commaReal.data.total > 0, `total ${commaReal.data.total}`);
  check('comma-separated chapter list still unions',
    listQ.data.total === amineQ.data.total + polymerQ.data.total,
    `${listQ.data.total} vs ${amineQ.data.total}+${polymerQ.data.total}`);

  // ── 3. Existing faculty blueprints have no phantom chapters ──
  console.log('\n3. Faculty blueprints vs the bank');
  const drafts = await api('/exams?status=draft', { token: chemistryToken });
  const chemBlueprints = [];
  for (const e of drafts.data || []) {
    if (!e.chapter_quotas) continue;
    try {
      const parsed = JSON.parse(e.chapter_quotas);
      if (parsed.chemistry) chemBlueprints.push({ exam: e.title, chapters: Object.keys(parsed.chemistry) });
    } catch {}
  }
  const phantomKeys = chemBlueprints.flatMap(b => b.chapters.filter(c => !chapters.includes(c)).map(c => `${b.exam}: ${c}`));
  console.log(`   ${chemBlueprints.length} chemistry blueprint(s), keys: ${chemBlueprints.flatMap(b => b.chapters).join(', ') || '(none)'}`);
  check('every blueprint chapter exists in the bank', phantomKeys.length === 0, phantomKeys.join('; ') || 'none');

  // Each assigned chapter must actually return questions — this is what the
  // faculty's "Assigned Chapters" dropdown relies on to fill a quota.
  const allKeys = [...new Set(chemBlueprints.flatMap(b => b.chapters))];
  for (const key of allKeys) {
    const res = await q(chemistryToken, key);
    check(`assigned chapter "${key}" returns questions`, res.data.total > 0, `total ${res.data.total}`);
  }

  // ── 4. Canonicalisation on write ─────────────────────────────
  console.log('\n4. POST /exams canonicalises chapter names');
  const title = `ZZ Chapter Canonicalisation Smoke ${Date.now()}`;
  const created = await api('/exams', {
    method: 'POST', token: principalToken,
    body: {
      title,
      exam_type: 'custom',
      duration_minutes: 60,
      total_marks: 20,
      subject_quotas: { chemistry: 5, physics: 5 },
      chapter_quotas: {
        chemistry: { [COMMA_CHAP]: 3, [COMMA_REAL]: 3 },
        physics: { 'Atoms': 2 },
      },
    },
  });
  check('exam created', created.status === 201, `status ${created.status}`);

  const after = await api('/exams?status=draft', { token: principalToken });
  const mine = (after.data || []).find(e => e.title === title);
  let stored = {};
  try { stored = JSON.parse(mine?.chapter_quotas || '{}'); } catch {}
  const chemKeys = Object.keys(stored.chemistry || {});
  const physKeys = Object.keys(stored.physics || {});
  console.log(`   stored: chemistry=${JSON.stringify(chemKeys)} physics=${JSON.stringify(physKeys)}`);
  check('punctuation variant stored under the real bank name', chemKeys.includes(COMMA_REAL), chemKeys.join(', '));
  check('quotas collapsing onto one chapter are summed',
    stored.chemistry?.[COMMA_REAL] === 6, `qty ${stored.chemistry?.[COMMA_REAL]}`);
  check('unrecognised chapter name is preserved as-is', physKeys.includes('Atoms'), physKeys.join(', '));

  // ── Cleanup ──────────────────────────────────────────────────
  if (mine) {
    const d1 = path.join(__dirname, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
    const file = fs.readdirSync(d1).filter(f => f.endsWith('.sqlite'))
      .map(f => ({ f, size: fs.statSync(path.join(d1, f)).size }))
      .sort((a, b) => b.size - a.size)[0].f;
    const db = new DatabaseSync(path.join(d1, file));
    db.prepare('DELETE FROM exam_questions WHERE exam_id = ?').run(mine.id);
    db.prepare('DELETE FROM exams WHERE id = ?').run(mine.id);
    console.log(`\n   cleaned up test exam ${mine.id}`);
  }

  console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch(err => { console.error('smoke test crashed:', err); process.exit(1); });
