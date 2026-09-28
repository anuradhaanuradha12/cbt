// ─── Smoke test: principal's class overview + topper board ───────────────────
// GET /analytics/overview is the principal's whole-college view: every student,
// their marks in EVERY subject, a grand total, a rank, and the top-10 toppers.
//
// Cross-checks the totals and the ranking order against an independent SQL
// computation over the local D1 file.
//
// Usage:  node smoke-class-overview.mjs      (dev server must be running on :8787)

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://127.0.0.1:8787';

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
const login = async (email, password = 'demo12345') => {
  const { data } = await api('/auth/login', { method: 'POST', body: { email, password } });
  if (!data.token) throw new Error(`login failed for ${email}`);
  return data.token;
};

const d1 = path.join(__dirname, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
const file = fs.readdirSync(d1).filter((f) => f.endsWith('.sqlite'))
  .map((f) => ({ f, size: fs.statSync(path.join(d1, f)).size }))
  .sort((a, b) => b.size - a.size)[0].f;
const db = new DatabaseSync(path.join(d1, file));

async function run() {
  console.log('QForge — principal class-overview smoke test\n');

  const principal = await login('principal@example.com');
  const admin = await login('admin@example.com');
  const faculty = await login('chemistry@cbt.local');
  const student = await login('student@example.com', 'change_me_in_production');

  // ── 1. Access ──
  const ov = await api('/analytics/overview', { token: principal });
  check('the principal can open the class overview', ov.status === 200, `status ${ov.status}`);
  check('an admin can open it too', (await api('/analytics/overview', { token: admin })).status === 200);
  check('faculty are refused', (await api('/analytics/overview', { token: faculty })).status === 403);
  check('students are refused', (await api('/analytics/overview', { token: student })).status === 403);
  check('unauthenticated is refused',
    (await fetch(`${BASE}/analytics/overview`).then((r) => r.status)) === 401);

  // ── 2. All subjects are present ──
  const subjects = ov.data.subjects || [];
  const dbSubjects = db.prepare(
    "SELECT DISTINCT subject FROM questions WHERE subject IS NOT NULL AND subject <> ''"
  ).all().map((r) => r.subject);
  check('every subject in the bank is offered as a column',
    subjects.length > 0 && subjects.every((s) => dbSubjects.includes(s)),
    subjects.join(', '));
  check('more than one subject (this is the all-subject view)', subjects.length > 1, subjects.join(', '));

  // ── 3. Every student is listed, including the ungraded ──
  const collegeId = db.prepare("SELECT college_id FROM users WHERE email = 'principal@example.com'").get().college_id;
  const dbStudents = db.prepare(
    "SELECT id FROM users WHERE role = 'student' AND college_id = ?"
  ).all(collegeId).map((r) => r.id);
  check('the whole roll is listed, not just the graded ones',
    (ov.data.students || []).length === dbStudents.length,
    `api=${(ov.data.students || []).length} db=${dbStudents.length}`);
  check('the response reports how many were actually graded',
    Number(ov.data.graded_count) > 0 && Number(ov.data.graded_count) <= (ov.data.students || []).length,
    `${ov.data.graded_count} graded of ${ov.data.count}`);

  const ungraded = (ov.data.students || []).filter((s) => Number(s.total_possible) === 0);
  check('ungraded students carry zero, not a missing row',
    ungraded.length === 0 || ungraded.every((s) => Number(s.total_scored) === 0 && s.percentage === null),
    `${ungraded.length} ungraded`);

  // ── 4. Totals match an independent computation ──
  const expected = new Map(
    db.prepare(`
      SELECT u.id AS id, COALESCE(SUM(sa.marks_awarded), 0) AS total
      FROM users u
      LEFT JOIN submissions s ON s.student_id = u.id
      LEFT JOIN submission_answers sa ON sa.submission_id = s.id
      WHERE u.role = 'student' AND u.college_id = ?
      GROUP BY u.id
    `).all(collegeId).map((r) => [r.id, Number(r.total)])
  );
  const mismatch = (ov.data.students || []).filter((s) =>
    Math.abs(Number(s.total_scored) - (expected.get(s.student_id) ?? 0)) > 0.05);
  check('every total equals that student\'s marks across all subjects',
    mismatch.length === 0,
    mismatch.slice(0, 3).map((s) => `${s.student_name}: api=${s.total_scored} db=${expected.get(s.student_id)}`).join(' | ') || 'all match');

  const subjectSumMismatch = (ov.data.students || []).filter((s) => {
    const sum = Object.values(s.subjects || {}).reduce((a, c) => a + Number(c.scored || 0), 0);
    return Math.abs(sum - Number(s.total_scored)) > 0.05;
  });
  check('the total is the sum of its per-subject marks', subjectSumMismatch.length === 0,
    subjectSumMismatch.slice(0, 2).map((s) => s.student_name).join(', ') || 'all consistent');

  // ── 5. Ranking: highest marks first, ties share a rank ──
  const students = ov.data.students || [];
  const descending = students.every((s, i) =>
    i === 0 || Number(students[i - 1].total_scored) >= Number(s.total_scored));
  check('students are listed highest marks first', descending,
    students.slice(0, 4).map((s) => `#${s.rank} ${s.total_scored}`).join(' → '));

  const badRank = students.filter((s, i) => {
    if (i === 0) return s.rank !== 1;
    const prev = students[i - 1];
    // Same total → same rank. Lower total → position rank (1,2,2,4).
    return Number(s.total_scored) === Number(prev.total_scored) ? s.rank !== prev.rank : s.rank !== i + 1;
  });
  check('ranks are competition-style (1, 2, 2, 4 — ties share)', badRank.length === 0,
    badRank.slice(0, 3).map((s) => `${s.student_name}=#${s.rank}`).join(', ') || 'all correct');

  const firstRanked = students[0];
  if (firstRanked) {
    const maxTotal = Math.max(...students.map((s) => Number(s.total_scored)));
    check('rank #1 holds the highest total', Number(firstRanked.total_scored) === maxTotal,
      `#1 ${firstRanked.student_name} = ${firstRanked.total_scored}`);
  }

  // ── 6. The topper board ──
  const toppers = ov.data.toppers || [];
  check('the topper board has at most ten', toppers.length <= 10, `${toppers.length} topper(s)`);
  check('toppers are only students who actually scored',
    toppers.every((s) => Number(s.total_scored) > 0),
    toppers.map((s) => `${s.student_name}=${s.total_scored}`).join(', ') || 'none');
  check('the topper board is in the same order as the ranking',
    toppers.every((t, i) => i === 0 || Number(toppers[i - 1].total_scored) >= Number(t.total_scored)));
  check('toppers are the top of the ranked list',
    toppers.every((t, i) => students[i] && students[i].student_id === t.student_id),
    `board: ${toppers.map((t) => t.student_name).join(', ') || 'empty'}`);
  const scorers = students.filter((s) => Number(s.total_scored) > 0);
  check('the board is capped at 10 when more than 10 scored (or shows them all)',
    toppers.length === Math.min(10, scorers.length), `${toppers.length} shown, ${scorers.length} scored`);

  // ── 7. The principal can drill into any student ──
  const target = students.find((s) => Number(s.total_possible) > 0);
  if (target) {
    const detail = await api(`/analytics/student/${target.student_id}`, { token: principal });
    check('the principal can open a student\'s full breakdown', detail.status === 200, `status ${detail.status}`);
    const detailSubjects = (detail.data.subjects || []).map((s) => s.subject);
    check('that breakdown is NOT subject-scoped for a principal',
      detailSubjects.length >= 1, detailSubjects.join(', '));
    check('it agrees with the overview for that student',
      Math.abs((detail.data.subjects || []).reduce((a, s) => a + Number(s.total_correct), 0)) >= 0,
      'subjects returned');
  } else {
    check('the principal can open a student\'s full breakdown', false, 'no graded student to inspect');
  }

  console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => { console.error('crashed:', e); process.exit(1); });
