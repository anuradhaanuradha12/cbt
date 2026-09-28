// ─── Smoke test: saving questions is idempotent, quota guard still holds ─────
// Regression test for "Failed to save questions: Exceeded quota for 'Circle'.
// Allowed: 5, Attempted total: 10" — the faculty panel preloads the questions an
// exam already has, so re-saving them used to be counted twice.
//
// Uses a throwaway exam and deletes it afterwards.
//
// Usage:  node smoke-quota-save.mjs      (dev server must be running on :8787)

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://127.0.0.1:8787';
const CHAPTER = 'Alcohols Phenols and Ethers';
const QUOTA = 3;

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`); }
  else    { failed++; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
};

const api = async (p, { method = 'GET', body, token } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

const login = async (email) => (await api('/auth/login', {
  method: 'POST', body: { email, password: 'demo12345' },
})).data.token;

const pToken = await login('principal@example.com');
const cToken = await login('chemistry@cbt.local');
if (!pToken || !cToken) throw new Error('login failed');

async function run() {
  console.log('QForge — quota save smoke test\n');

  // four real questions from the chapter (3 for the quota, 1 spare)
  const bank = await api(`/questions?subject=chemistry&chapter=${encodeURIComponent(CHAPTER)}&limit=4`, { token: cToken });
  const ids = (bank.data.data || []).map(q => q.id);
  if (ids.length < 4) throw new Error('not enough questions in the chapter');
  const three = ids.slice(0, 3).map(id => ({ id, marks: 4, negative_marks: 1 }));
  const four = ids.slice(0, 4).map(id => ({ id, marks: 4, negative_marks: 1 }));

  const title = `ZZ Quota Save Smoke ${Date.now()}`;
  const created = await api('/exams', {
    method: 'POST', token: pToken,
    body: {
      title, exam_type: 'custom', duration_minutes: 60, total_marks: 12,
      subject_quotas: { chemistry: QUOTA },
      chapter_quotas: { chemistry: { [CHAPTER]: QUOTA } },
    },
  });
  const examId = created.data.id;
  check('exam created', created.status === 201 && !!examId, `status ${created.status}`);

  try {
    // ── 1. first save fills the quota ───────────────────────────
    console.log('\n1. First save (3 of 3)');
    const first = await api(`/exams/${examId}/questions`, { method: 'PUT', token: cToken, body: { question_ids: three } });
    check('first save accepted', first.status === 200, `status ${first.status} ${JSON.stringify(first.data)}`);
    check('reports 3 added', first.data.added === 3, `added ${first.data.added}`);

    // ── 2. re-saving the same list must be a no-op, not a 403 ───
    console.log('\n2. Re-save the identical list (the reported bug)');
    const again = await api(`/exams/${examId}/questions`, { method: 'PUT', token: cToken, body: { question_ids: three } });
    check('re-save is accepted (was 403 "Exceeded quota … Attempted total 6")',
      again.status === 200, `status ${again.status} ${JSON.stringify(again.data)}`);
    check('reports 0 added', again.data.added === 0, `added ${again.data.added}`);

    // ── 3. the quota guard must still fire on a real overrun ────
    console.log('\n3. Genuine overrun still rejected');
    const over = await api(`/exams/${examId}/questions`, { method: 'PUT', token: cToken, body: { question_ids: four } });
    check('adding a 4th question to a 3-question quota is rejected',
      over.status === 403, `status ${over.status} ${JSON.stringify(over.data)}`);
    check('rejection names the chapter and the limit',
      /Circle|Alcohols/.test(over.data.error || '') && /Allowed/.test(over.data.error || ''),
      over.data.error || '');

    // ── 4. exam still holds exactly the quota ───────────────────
    const payload = await api(`/exams/${examId}`, { token: cToken });
    const count = (payload.data.questions || []).length;
    check('exam holds exactly the quota, no duplicates', count === QUOTA, `${count} question(s)`);
  } finally {
    const d1 = path.join(__dirname, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
    const file = fs.readdirSync(d1).filter(f => f.endsWith('.sqlite'))
      .map(f => ({ f, size: fs.statSync(path.join(d1, f)).size }))
      .sort((a, b) => b.size - a.size)[0].f;
    const db = new DatabaseSync(path.join(d1, file));
    db.prepare('DELETE FROM exam_questions WHERE exam_id = ?').run(examId);
    db.prepare('DELETE FROM exams WHERE id = ?').run(examId);
    console.log(`\n   cleaned up test exam ${examId}`);
  }

  console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch(e => { console.error('crashed:', e); process.exit(1); });
