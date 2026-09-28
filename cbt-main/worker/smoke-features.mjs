// ─── Smoke Test: image-requested features ─────────────────────────────────────
// Run: node smoke-features.mjs   (worker dir, dev server on :8787)
//
// Covers:
//   1. Principal resets a forgotten student password (old session dies, old password fails)
//   2. Question usage enrichment: "already selected / repeated with date" after publish
//   3. Faculty hard-locked to their own subject (questions, chapters, exam creation)
//   4. "Continue with Google" route present (503 until credentials configured)

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://127.0.0.1:8787';
// Staff and student accounts were seeded with different default passwords, so
// each role must sign in with its own — using one for both fails every staff
// login and the run dies on an undefined token before it can report anything.
const STAFF_PASSWORD = 'demo12345';
const PASSWORD = 'change_me_in_production'; // student seed default

let passed = 0, failed = 0;
const results = [];

function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  if (ok) passed++; else failed++;
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  -> ${detail}` : ''}`);
}

async function req(path, method = 'GET', body = null, token = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON (redirects etc.) */ }
  return { status: res.status, data };
}

async function login(email, password = PASSWORD) {
  const r = await req('/auth/login', 'POST', { email, password });
  return r;
}

// ── 0. Log in all roles ───────────────────────────────────────────────────────
const admin = await login('admin@example.com', STAFF_PASSWORD);
const faculty = await login('faculty@example.com', STAFF_PASSWORD);
const student = await login('student@example.com');
const principal = await login('principal@example.com', STAFF_PASSWORD);

check('admin login', admin.status === 200 && admin.data?.token, JSON.stringify(admin.data));
check('faculty login', faculty.status === 200 && faculty.data?.token, JSON.stringify(faculty.data));
check('student login', student.status === 200 && student.data?.token, JSON.stringify(student.data));
check('principal login', principal.status === 200 && principal.data?.token, JSON.stringify(principal.data));

const T = {
  admin: admin.data?.token,
  faculty: faculty.data?.token,
  student: student.data?.token,
  principal: principal.data?.token,
};

// ── 1. Principal resets student password ─────────────────────────────────────
const users = await req('/users', 'GET', null, T.principal);
check('principal can list students (GET /users)', users.status === 200 && Array.isArray(users.data), `status=${users.status} body=${JSON.stringify(users.data).slice(0, 120)}`);

const stu = (users.data || []).find(u => u.email === 'student@example.com');
check('student found in list', Boolean(stu));

if (stu) {
  // student's current session works before reset
  const before = await req('/exams', 'GET', null, T.student);
  check('student session valid before reset', before.status === 200, `status=${before.status}`);

  const reset = await req(`/users/${stu.id}/password`, 'PUT', { new_password: 'SmokeTest#2026' }, T.principal);
  check('principal resets student password', reset.status === 200, JSON.stringify(reset.data));

  const oldLogin = await login('student@example.com');
  check('old password rejected after reset', oldLogin.status === 401, `status=${oldLogin.status}`);

  const oldSession = await req('/exams', 'GET', null, T.student);
  check('old student session invalidated (KV)', oldSession.status === 401, `status=${oldSession.status}`);

  const newLogin = await login('student@example.com', 'SmokeTest#2026');
  check('new password works', newLogin.status === 200 && newLogin.data?.token, `status=${newLogin.status}`);

  // faculty cannot reset passwords
  const facTry = await req(`/users/${stu.id}/password`, 'PUT', { new_password: 'Hax#12345' }, T.faculty);
  check('faculty forbidden from resetting passwords', facTry.status === 403, `status=${facTry.status}`);

  // restore original password for repeatable runs (principal token is still valid)
  const restore = await req(`/users/${stu.id}/password`, 'PUT', { new_password: PASSWORD }, T.principal);
  check('password restored for repeatability', restore.status === 200, JSON.stringify(restore.data));
}

// ── 3. Faculty subject lock (tested before creating exam) ─────────────────────
const facSubject = faculty.data?.user?.subject || 'physics';

const chemQ = await req('/questions?subject=chemistry&limit=5', 'GET', null, T.faculty);
check('faculty blocked from other subject (questions)', chemQ.status === 403, `status=${chemQ.status}`);

const chemCh = await req('/questions/chapters?subject=chemistry', 'GET', null, T.faculty);
check('faculty blocked from other subject (chapters)', chemCh.status === 403, `status=${chemCh.status}`);

const ownQ = await req('/questions?limit=100', 'GET', null, T.faculty);
const allOwn = (ownQ.data?.data || []).every(q => (q.subject || '').toLowerCase() === facSubject);
check(`faculty unfiltered list contains only ${facSubject}`, ownQ.status === 200 && allOwn && (ownQ.data?.data || []).length > 0,
  `status=${ownQ.status} subjects=${[...new Set((ownQ.data?.data || []).map(q => q.subject))].join(',')}`);

const adminChem = await req('/questions?subject=chemistry&limit=1', 'GET', null, T.admin);
check('admin unrestricted across subjects', adminChem.status === 200, `status=${adminChem.status}`);

// ── 2. Repeated-with-date: full flow publish -> question shows usage ─────────
const picked = await req(`/questions?subject=${facSubject}&limit=3`, 'GET', null, T.faculty);
const qids = (picked.data?.data || []).slice(0, 3).map(q => q.id);

if (qids.length >= 1) {
  const create = await req('/exams', 'POST', {
    title: 'SMOKE TEST exam (safe to delete)',
    description: 'Created by smoke-features.mjs',
    exam_type: 'custom',
    duration_minutes: 30,
    total_marks: qids.length * 4,
    question_ids: qids.map(id => ({ id, marks: 4, negative_marks: 1 })),
  }, T.principal);
  check('principal creates the blueprint', create.status === 201, JSON.stringify(create.data));
  const examId = create.data?.id;

  // Blueprint creation is principal-only — faculty build the question set, they
  // do not create exams.
  const facCreate = await req('/exams', 'POST', {
    title: 'SMOKE faculty blueprint', duration_minutes: 10, total_marks: 4,
    subject_quotas: { chemistry: 5 },
  }, T.faculty);
  check('faculty cannot create a blueprint (principal-only)', facCreate.status === 403, `status=${facCreate.status}`);

  if (examId) {
    const s1 = await req(`/exams/${examId}/submit-for-review`, 'POST', null, T.faculty);
    check('faculty submits for principal review', s1.status === 200, JSON.stringify(s1.data));

    const s2 = await req(`/exams/${examId}/principal-review`, 'PUT', { decision: 'approve' }, T.principal);
    check('principal approves', s2.status === 200, JSON.stringify(s2.data));

    // The principal's approval is the final gate: no faculty round-trip follows.
    const s2b = await req(`/exams/${examId}`, 'GET', null, T.principal);
    check('approval publishes it outright (no faculty round-trip)',
      (s2b.data?.exam || s2b.data)?.status === 'published', (s2b.data?.exam || s2b.data)?.status);

    // Now the picked question should be flagged as previously used, with date+exam
    const after = await req(`/questions?subject=${facSubject}&limit=50`, 'GET', null, T.faculty);
    const hit = (after.data?.data || []).find(q => q.id === qids[0]);
    check('question carries previously_used metadata', hit && hit.previously_used && typeof hit.previously_used === 'object',
      JSON.stringify(hit?.previously_used));
    check('question flagged as used after publish', hit?.previously_used?.used === true, JSON.stringify(hit?.previously_used));
    check('usage includes last exam title', typeof hit?.previously_used?.last_exam_title === 'string' && hit.previously_used.last_exam_title.includes('SMOKE TEST'),
      String(hit?.previously_used?.last_exam_title));
    check('usage includes last_used_at date', Number(hit?.previously_used?.last_used_at) > 0, String(hit?.previously_used?.last_used_at));

    // auto-select-preview also surfaces usage info and sorts unused-first
    const preview = await req(`/exams/${examId}/auto-select-preview`, 'POST', {
      subject: facSubject, chapters: [], count: 5,
    }, T.faculty);
    // chapters:[] is invalid by design -> expect 400; do a real chapters call:
    const chList = await req(`/questions/chapters?subject=${facSubject}`, 'GET', null, T.faculty);
    const chapters = (chList.data?.chapters || []).slice(0, 2);
    if (chapters.length > 0) {
      const preview2 = await req(`/exams/${examId}/auto-select-preview`, 'POST', {
        subject: facSubject, chapters, count: 5,
      }, T.faculty);
      const rows = Array.isArray(preview2.data) ? preview2.data : [];
      check('auto-select returns previously_used on rows', preview2.status === 200 && rows.every(r => r.previously_used && 'used' in r.previously_used),
        `status=${preview2.status} rows=${rows.length}`);
    } else {
      check('auto-select returns previously_used on rows', false, 'no chapters available for subject');
    }
  }
} else {
  check('have questions to build exam with', false, 'no questions returned for faculty subject');
}

// ── 4. Continue with Google ───────────────────────────────────────────────────
const gStart = await fetch(`${BASE}/auth/google`, { redirect: 'manual' });
check('GET /auth/google route exists', gStart.status === 302 || gStart.status === 503, `status=${gStart.status}`);
if (gStart.status === 503) {
  const body = await gStart.json().catch(() => null);
  check('Google OAuth reports missing config clearly', /GOOGLE_CLIENT/.test(body?.error || ''), JSON.stringify(body));
  console.log('  NOTE: Google OAuth is wired but inactive until GOOGLE_CLIENT_ID/SECRET are set (see auth-google.ts header).');
} else {
  const loc = gStart.headers.get('location') || '';
  check('Google OAuth redirects to accounts.google.com', loc.includes('accounts.google.com'), loc);
}

// ── Clean up the exams this run created ───────────────────────────────────────
// They are titled 'SMOKE …' precisely because they are safe to delete; this one
// gets PUBLISHED by the run, so leaving it behind would show a dead exam to
// students on every rerun. There is no DELETE /exams route, so go direct.
try {
  const d1 = path.join(__dirname, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
  const file = fs.readdirSync(d1).filter(f => f.endsWith('.sqlite'))
    .map(f => ({ f, size: fs.statSync(path.join(d1, f)).size }))
    .sort((a, b) => b.size - a.size)[0].f;
  const db = new DatabaseSync(path.join(d1, file));
  const ids = db.prepare("SELECT id FROM exams WHERE title LIKE 'SMOKE%'").all().map(r => r.id);
  for (const id of ids) {
    db.prepare('DELETE FROM notifications WHERE exam_id = ?').run(id);
    db.prepare('DELETE FROM exam_questions WHERE exam_id = ?').run(id);
    db.prepare('DELETE FROM exam_attempts WHERE exam_id = ?').run(id);
    db.prepare('DELETE FROM exams WHERE id = ?').run(id);
  }
  console.log(`  INFO: cleaned up ${ids.length} SMOKE exam(s)`);
} catch (err) {
  console.log(`  NOTE: exam cleanup skipped — ${err.message}`);
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n════════ SMOKE TEST RESULTS ════════');
for (const r of results) console.log(r);
console.log('════════════════════════════════════');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
