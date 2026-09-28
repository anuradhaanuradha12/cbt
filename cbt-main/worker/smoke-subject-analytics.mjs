// ─── Smoke test: subject-scoped analytics ────────────────────────────────────
// A faculty member may only ever see THEIR OWN subject's numbers — in the
// Analytics roster (GET /analytics/subject) and in the student list
// (GET /users, whose avg_score used to be computed across every subject).
//
// Cross-checks the API against an independent SQL computation over the local D1
// file, and proves the faculty figure actually differs from the unrestricted one.
//
// Usage:  node smoke-subject-analytics.mjs     (dev server must be running on :8787)

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://127.0.0.1:8787';
const STAFF_PASSWORD = 'demo12345';

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
  const { data } = await api('/auth/login', { method: 'POST', body: { email, password: STAFF_PASSWORD } });
  if (!data.token) throw new Error(`login failed for ${email}`);
  return data.token;
};

const d1 = path.join(__dirname, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
const file = fs.readdirSync(d1).filter((f) => f.endsWith('.sqlite'))
  .map((f) => ({ f, size: fs.statSync(path.join(d1, f)).size }))
  .sort((a, b) => b.size - a.size)[0].f;
const db = new DatabaseSync(path.join(d1, file));

// Subject-scoped per-exam mean, computed independently of the endpoint.
const EXPECTED_AVG_SQL = `
  SELECT sub.student_id AS id,
         COUNT(*) AS exams_taken,
         AVG(CASE WHEN sub.possible > 0 THEN sub.scored * 100.0 / sub.possible END) AS avg_score
  FROM (
    SELECT s.id AS sid, s.student_id AS student_id,
           SUM(COALESCE(sa.marks_awarded, 0)) AS scored,
           SUM(COALESCE(eq.marks, 4))         AS possible
    FROM submissions s
    JOIN submission_answers sa ON sa.submission_id = s.id
    JOIN questions q ON q.id = sa.question_id
    LEFT JOIN exam_questions eq ON eq.exam_id = s.exam_id AND eq.question_id = sa.question_id
    WHERE q.subject = ?
    GROUP BY s.id
  ) sub
  GROUP BY sub.student_id
`;

async function run() {
  console.log('QForge — subject-scoped analytics smoke test\n');

  const chemToken = await login('chemistry@cbt.local');
  const physToken = await login('physics@cbt.local');
  const adminToken = await login('admin@example.com');
  const principalToken = await login('principal@example.com');

  // ── 1. The roster is single-subject for faculty ──
  const chem = await api('/analytics/subject', { token: chemToken });
  check('chemistry faculty get the roster', chem.status === 200, `status ${chem.status}`);
  check('the response names their subject', chem.data.subject === 'chemistry', String(chem.data.subject));
  check('every roster row is their subject',
    (chem.data.students || []).length > 0 &&
      chem.data.students.every((s) => s.subject === 'chemistry'),
    `${(chem.data.students || []).length} row(s): ${[...new Set((chem.data.students || []).map((s) => s.subject))].join(',')}`);

  const phys = await api('/analytics/subject', { token: physToken });
  check('physics faculty see only physics',
    (phys.data.students || []).length > 0 &&
      phys.data.students.every((s) => s.subject === 'physics'),
    `${(phys.data.students || []).length} row(s): ${[...new Set((phys.data.students || []).map((s) => s.subject))].join(',')}`);

  // ── 2. Subjects cannot be crossed or browsed ──
  check('a faculty request for another subject is refused',
    (await api('/analytics/subject?subject=physics', { token: chemToken })).status === 403);
  check('the same-subject request is allowed',
    (await api('/analytics/subject?subject=chemistry', { token: chemToken })).status === 200);
  check('students cannot read the roster',
    (await fetch(`${BASE}/analytics/subject`).then((r) => r.status)) === 401,
    'unauthenticated');

  const student = await api('/auth/login', {
    method: 'POST', body: { email: 'student@example.com', password: 'change_me_in_production' },
  });
  check('students are refused too',
    (await api('/analytics/subject', { token: student.data.token })).status === 403);
  check('principals are outside this endpoint (analytics is admin/faculty)',
    (await api('/analytics/subject', { token: principalToken })).status === 403);

  // ── 3. Admin sees the whole picture, clearly labelled ──
  const adm = await api('/analytics/subject', { token: adminToken });
  const adminSubjects = [...new Set((adm.data.students || []).map((s) => s.subject))];
  check('admin gets subject = null (unrestricted)', adm.data.subject === null, String(adm.data.subject));
  check('admin sees multiple subjects', adminSubjects.length > 1, adminSubjects.join(', '));
  check('the admin response lists its subjects',
    Array.isArray(adm.data.subjects) && adm.data.subjects.length === adminSubjects.length,
    JSON.stringify(adm.data.subjects));

  // ── 4. The marks themselves are right ──
  const withData = (chem.data.students || []).filter((s) => Number(s.marks_possible) > 0);
  check('chemistry rows carry a marks maximum', withData.length > 0, `${withData.length} row(s) with data`);
  check('marks_scored is not blank',
    withData.every((s) => s.marks_scored !== null && s.marks_scored !== undefined));
  check('percentage equals scored/possible',
    withData.every((s) =>
      Math.abs(s.percentage - Math.round((s.marks_scored / s.marks_possible) * 1000) / 10) < 0.05),
    withData.map((s) => `${s.marks_scored}/${s.marks_possible}=${s.percentage}%`).join(' '));

  // Negative marking must be reported honestly, not clamped to 0.
  const negatives = (phys.data.students || []).filter((s) => Number(s.marks_scored) < 0);
  check('a student who lost marks shows a negative, not a zero',
    negatives.length === 0 || negatives.every((s) => Number(s.percentage) < 0),
    `${negatives.length} negative row(s)`);

  // ── 5. GET /users no longer leaks cross-subject averages ──
  const chemUsers = await api('/users', { token: chemToken });
  const physUsers = await api('/users', { token: physToken });
  const principalUsers = await api('/users', { token: principalToken });
  check('faculty can still read the student list', chemUsers.status === 200, `status ${chemUsers.status}`);

  const expectedChem = new Map(
    db.prepare(EXPECTED_AVG_SQL).all('chemistry').map((r) => [r.id, r])
  );
  const mismatch = (chemUsers.data || []).filter((u) => {
    const exp = expectedChem.get(u.id);
    if (!exp) return Number(u.avg_score) > 0; // student has no chemistry work → must be null/0
    if (exp.avg_score === null) return u.avg_score !== null && u.avg_score !== undefined;
    return Math.abs(Number(u.avg_score) - Number(exp.avg_score)) > 0.01;
  });
  check('chemistry faculty averages match a chemistry-only computation',
    mismatch.length === 0,
    mismatch.slice(0, 3).map((u) => `${u.name}: api=${u.avg_score}`).join(' | ') || 'all match');

  const expectedPhys = new Map(
    db.prepare(EXPECTED_AVG_SQL).all('physics').map((r) => [r.id, r])
  );
  const physMismatch = (physUsers.data || []).filter((u) => {
    const exp = expectedPhys.get(u.id);
    if (!exp) return Number(u.avg_score) > 0;
    if (exp.avg_score === null) return u.avg_score !== null && u.avg_score !== undefined;
    return Math.abs(Number(u.avg_score) - Number(exp.avg_score)) > 0.01;
  });
  check('physics faculty averages match a physics-only computation',
    physMismatch.length === 0,
    physMismatch.slice(0, 3).map((u) => `${u.name}: api=${u.avg_score}`).join(' | ') || 'all match');

  // The scoping must actually change the number — otherwise this test proves nothing.
  const unrestricted = new Map((principalUsers.data || []).map((u) => [u.id, u.avg_score]));
  const differs = (chemUsers.data || []).filter((u) => {
    const all = unrestricted.get(u.id);
    if (all === null || all === undefined || u.avg_score === null || u.avg_score === undefined) return false;
    return Math.abs(Number(u.avg_score) - Number(all)) > 0.01;
  });
  check('the faculty figure genuinely differs from the all-subject average (scoping is real)',
    differs.length > 0,
    differs.slice(0, 2).map((u) => `${u.name}: chem=${Number(u.avg_score).toFixed(1)}% vs all=${Number(unrestricted.get(u.id)).toFixed(1)}%`).join(' | ') || 'identical for every student');

  // exams_taken must count only exams where the subject was graded.
  const expectedExams = new Map(
    db.prepare(EXPECTED_AVG_SQL).all('chemistry').map((r) => [r.id, Number(r.exams_taken)])
  );
  const examMismatch = (chemUsers.data || []).filter((u) => {
    const exp = expectedExams.get(u.id) ?? 0;
    return Number(u.exams_taken) !== exp;
  });
  check('exams_taken counts only exams graded in that subject',
    examMismatch.length === 0,
    examMismatch.slice(0, 3).map((u) => `${u.name}: api=${u.exams_taken}`).join(' | ') || 'all match');

  // ── 6. The per-student view stays scoped ──
  const targetStudent = (chem.data.students || [])[0];
  if (targetStudent) {
    const detail = await api(`/analytics/student/${targetStudent.student_id}`, { token: chemToken });
    const subjects = (detail.data.subjects || []).map((s) => s.subject);
    check('the per-student breakdown is single-subject for faculty',
      subjects.length > 0 && subjects.every((s) => s === 'chemistry'),
      subjects.join(', ') || 'no subject rows');
    check('and so are its chapters',
      (detail.data.chapters || []).every((c) => c.subject === 'chemistry'),
      [...new Set((detail.data.chapters || []).map((c) => c.subject))].join(', ') || 'no chapters');
  } else {
    check('the per-student breakdown is single-subject for faculty', false, 'no student to inspect');
  }

  console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => { console.error('crashed:', e); process.exit(1); });
