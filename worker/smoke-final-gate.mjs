// ─── Smoke test: the principal's approval is the final gate ──────────────────
// Regression test for the current workflow:
//
//   principal creates blueprint  ->  faculty fills quota  ->  faculty submits
//   ->  principal reviews  ->  principal approves  ==  PUBLISHED
//
// Two things this guards:
//   1. Principal approval publishes DIRECTLY. There is no faculty round-trip,
//      so no exam may be left stranded at 'pending_final_confirmation'.
//   2. Only the principal (or an admin) may approve — faculty cannot.
//   3. Submitting also notifies the principal, including the 'task_completed'
//      type (which the notifications CHECK constraint must accept).
//
// Uses a throwaway exam and deletes it afterwards.
//
// Usage:  node smoke-final-gate.mjs      (dev server must be running on :8787)

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://127.0.0.1:8787';
const CHAPTER = 'Alcohols Phenols and Ethers';

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
const login = async (email) => {
  const { data } = await api('/auth/login', { method: 'POST', body: { email, password: 'demo12345' } });
  return data.token;
};

const detailStatus = (data) => (data.exam || data).status;

// `GET /exams` answers with a bare array (the role-scoped rows).
const listOf = (data) => (Array.isArray(data) ? data : (data.data || data.exams || []));

async function run() {
  console.log('QForge — principal-final-publish smoke test\n');

  const pToken = await login('principal@example.com');
  const chemToken = await login('chemistry@cbt.local');    // subject faculty
  const chem2Token = await login('faculty2@example.com');  // other chemistry faculty

  // Students were seeded with a different default password than staff.
  let sToken;
  for (const pw of ['change_me_in_production', 'demo12345']) {
    const { data } = await api('/auth/login', { method: 'POST', body: { email: 'student@example.com', password: pw } });
    if (data.token) { sToken = data.token; break; }
  }
  check('a student account can sign in', Boolean(sToken));

  const bank = await api(`/questions?subject=chemistry&chapter=${encodeURIComponent(CHAPTER)}&limit=1`, { token: chemToken });
  const qid = bank.data.data[0].id;

  const created = await api('/exams', {
    method: 'POST', token: pToken,
    body: {
      title: `ZZ Final Gate Smoke ${Date.now()}`,
      exam_type: 'custom', duration_minutes: 60, total_marks: 4,
      chapter_quotas: { chemistry: { [CHAPTER]: 1 } },
    },
  });
  const examId = created.data.id;
  check('principal created the blueprint', created.status === 201, `status ${created.status}`);
  if (created.status !== 201) { console.log('\nABORTED — could not create test exam'); process.exit(1); }

  try {
    const put = await api(`/exams/${examId}/questions`, { method: 'PUT', token: chemToken, body: { question_ids: [{ id: qid }] } });
    check('faculty filled the assigned quota', put.status === 200, `status ${put.status}`);

    const sub = await api(`/exams/${examId}/submit-for-review`, { method: 'POST', token: chemToken });
    // Regression: this used to 500 when 'task_completed' was not an allowed
    // notifications type — the status change landed but the response blew up.
    check('faculty submitted for review (was 500)', sub.status === 200, `status ${sub.status}`);

    const notes = await api('/notifications', { token: pToken });
    const mine = (notes.data.notifications || notes.data.data || [])
      .filter(n => n.exam_id === examId);
    check('the principal was notified of the submission', mine.length > 0, `${mine.length} notification(s)`);
    check('a task_completed notification was written (constraint allows it)',
      mine.some(n => n.type === 'task_completed'),
      mine.map(n => n.type).join(', ') || 'none');

    const atReview = await api(`/exams/${examId}`, { token: pToken });
    check('exam is awaiting principal review',
      detailStatus(atReview.data) === 'pending_principal_review', detailStatus(atReview.data));

    // ── only the principal may approve ──
    const facultyTry = await api(`/exams/${examId}/principal-review`, { method: 'PUT', token: chemToken, body: { decision: 'approve' } });
    check('faculty cannot approve', facultyTry.status === 403, `status ${facultyTry.status}`);

    const otherFacultyTry = await api(`/exams/${examId}/principal-review`, { method: 'PUT', token: chem2Token, body: { decision: 'approve' } });
    check('another faculty cannot approve either', otherFacultyTry.status === 403, `status ${otherFacultyTry.status}`);

    // ── principal approval IS publication ──
    const appr = await api(`/exams/${examId}/principal-review`, { method: 'PUT', token: pToken, body: { decision: 'approve' } });
    check('principal approved', appr.status === 200, `status ${appr.status}`);

    const after = await api(`/exams/${examId}`, { token: pToken });
    check('approval published it — no faculty round-trip',
      detailStatus(after.data) === 'published', detailStatus(after.data));

    const live = await api('/exams', { token: sToken });
    const rows = listOf(live.data);
    check('the exam is now visible to students',
      rows.some(e => e.id === examId), `${rows.length} exam(s) listed`);

    // ── reject path still returns the exam to the faculty ──
    const created2 = await api('/exams', {
      method: 'POST', token: pToken,
      body: {
        title: `ZZ Final Gate Reject ${Date.now()}`,
        exam_type: 'custom', duration_minutes: 60, total_marks: 4,
        chapter_quotas: { chemistry: { [CHAPTER]: 1 } },
      },
    });
    const examId2 = created2.data.id;
    await api(`/exams/${examId2}/questions`, { method: 'PUT', token: chemToken, body: { question_ids: [{ id: qid }] } });
    await api(`/exams/${examId2}/submit-for-review`, { method: 'POST', token: chemToken });
    const rej = await api(`/exams/${examId2}/principal-review`, { method: 'PUT', token: pToken, body: { decision: 'reject', reason: 'needs work' } });
    check('principal rejected the second exam', rej.status === 200, `status ${rej.status}`);
    const rejState = await api(`/exams/${examId2}`, { token: pToken });
    check('rejected exam goes back to the faculty',
      detailStatus(rejState.data) === 'rejected', detailStatus(rejState.data));
    const live2 = await api('/exams', { token: sToken });
    const rows2 = listOf(live2.data);
    check('rejected exam is NOT visible to students',
      rows2.length > 0 && !rows2.some(e => e.id === examId2), `${rows2.length} exam(s) listed`);

    await api(`/exams/${examId2}`, { method: 'DELETE', token: pToken }).catch(() => {});
  } finally {
    const d1 = path.join(__dirname, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
    const file = fs.readdirSync(d1).filter(f => f.endsWith('.sqlite'))
      .map(f => ({ f, size: fs.statSync(path.join(d1, f)).size }))
      .sort((a, b) => b.size - a.size)[0].f;
    const db = new DatabaseSync(path.join(d1, file));
    // Sweep every throwaway exam this test can create, plus their notifications.
    const ids = db.prepare("SELECT id FROM exams WHERE title LIKE 'ZZ Final Gate%'").all().map(r => r.id);
    for (const id of ids) {
      db.prepare('DELETE FROM notifications WHERE exam_id = ?').run(id);
      db.prepare('DELETE FROM exam_questions WHERE exam_id = ?').run(id);
      db.prepare('DELETE FROM exam_attempts WHERE exam_id = ?').run(id);
      db.prepare('DELETE FROM exams WHERE id = ?').run(id);
    }
    console.log(`\n   cleaned up ${ids.length} test exam(s)`);
  }

  console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch(e => { console.error('crashed:', e); process.exit(1); });
