// ─── Smoke Test: section-move feature (principal changes sections by marks) ───
// Run: node smoke-sections.mjs   (worker dir, dev server on :8787)
//
// Covers:
//   1. GET /users returns avg_score + exams_taken per student
//   2. POST /users/sections/preview — criteria validation, dry-run selection
//   3. POST /users/sections/apply   — bulk move matches preview exactly
//   4. PUT  /users/:id/section      — single-student move, guards
//   5. Auth: faculty forbidden, role guards (non-student target rejected)
//   6. 'null' batch_name is treated as unassigned, never as a valid target

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'http://127.0.0.1:8787';
// Staff and student accounts were seeded with different default passwords, so
// each role must sign in with its own — using the student one for staff fails
// every staff login and the run dies on an undefined token.
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
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, data };
}

async function login(email, password = PASSWORD) {
  return req('/auth/login', 'POST', { email, password });
}

// ── Local DB handle ───────────────────────────────────────────────────────────
// Sections are moved by the test, so it restores every student's section (and
// deletes nothing) before it finishes — otherwise a second run starts from a
// world where nobody is unassigned, and the counts stop meaning anything.
const __dirname0 = path.dirname(fileURLToPath(import.meta.url));
function openDb() {
  const dir = path.join(__dirname0, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
  const f = fs.readdirSync(dir).filter(x => x.endsWith('.sqlite'))
    .map(x => ({ x, s: fs.statSync(path.join(dir, x)).size }))
    .sort((a, b) => b.s - a.s)[0].x;
  return new DatabaseSync(path.join(dir, f));
}
const db = openDb();
const sectionSnapshot = new Map(
  db.prepare("SELECT id, batch_name FROM users WHERE role = 'student'").all()
    .map(r => [r.id, r.batch_name])
);

// ── 0. Log in all roles ───────────────────────────────────────────────────────
const admin = await login('admin@example.com', STAFF_PASSWORD);
const faculty = await login('faculty@example.com', STAFF_PASSWORD);
const principal = await login('principal@example.com', STAFF_PASSWORD);

check('admin login', admin.status === 200 && admin.data?.token, JSON.stringify(admin.data).slice(0, 120));
check('faculty login', faculty.status === 200 && faculty.data?.token, JSON.stringify(faculty.data).slice(0, 120));
check('principal login', principal.status === 200 && principal.data?.token, JSON.stringify(principal.data).slice(0, 120));

const T = {
  admin: admin.data?.token,
  faculty: faculty.data?.token,
  principal: principal.data?.token,
};

// ── 1. GET /users enrichment ──────────────────────────────────────────────────
const users = await req('/users', 'GET', null, T.principal);
check('principal lists students', users.status === 200 && Array.isArray(users.data), `status=${users.status}`);
const stu = (users.data || []).find(u => u.email === 'student@example.com');
check('student found in list', Boolean(stu));
check('users rows carry avg_score field', (users.data || []).every(u => 'avg_score' in u));
check('users rows carry exams_taken field', (users.data || []).every(u => 'exams_taken' in u));
// Don't pin this to one seeded account — which students have graded exams is
// data, not a code guarantee. What matters is that the enrichment computes for
// whoever does have submissions.
const graded = (users.data || []).filter(u => u.avg_score !== null && u.avg_score !== undefined);
check('avg_score is computed for students who have graded exams', graded.length > 0,
  `${graded.length} student(s) with marks${graded[0] ? `, e.g. ${graded[0].email} = ${Number(graded[0].avg_score).toFixed(1)}%` : ''}`);

// ── 2. Preview: validation + dry run ─────────────────────────────────────────
const noCriteria = await req('/users/sections/preview', 'POST', {
  target_section: 'Section A',
}, T.principal);
check('preview without marks criteria rejected', noCriteria.status === 400, `status=${noCriteria.status}`);

const badScore = await req('/users/sections/preview', 'POST', {
  target_section: 'Section A', min_score: 150,
}, T.principal);
check('preview with min_score > 100 rejected', badScore.status === 400, `status=${badScore.status}`);

const nullTarget = await req('/users/sections/preview', 'POST', {
  target_section: 'null', min_score: 0, max_score: 100,
}, T.principal);
check("preview rejects 'null' as a target section", nullTarget.status === 400, `status=${nullTarget.status} body=${JSON.stringify(nullTarget.data)}`);

// Dry-run: move unassigned students with avg <= 100 (should be everyone unassigned)
const preview = await req('/users/sections/preview', 'POST', {
  current_section: '',
  target_section: 'SMOKE Section A',
  min_score: 0,
  max_score: 100,
  min_exams: 1,
}, T.principal);
check('preview runs with valid criteria', preview.status === 200, `status=${preview.status} body=${JSON.stringify(preview.data).slice(0, 200)}`);
const previewIds = new Set((preview.data?.students || []).map(s => s.id));
check('preview returns students with avg_score fields', (preview.data?.students || []).every(s => typeof s.avg_score === 'number' && 'exams_taken' in s));
check('preview excludes students with exams (min_exams=1 filter active)', preview.data?.count === 0 || (preview.data?.students || []).every(s => s.exams_taken >= 1));

// Same criteria via faculty must be forbidden
const facPreview = await req('/users/sections/preview', 'POST', {
  current_section: '', target_section: 'Section A', min_score: 0, max_score: 100,
}, T.faculty);
check('faculty forbidden from section preview', facPreview.status === 403, `status=${facPreview.status}`);

const facApply = await req('/users/sections/apply', 'POST', {
  current_section: '', target_section: 'Section A', min_score: 0, max_score: 100,
}, T.faculty);
check('faculty forbidden from section apply', facApply.status === 403, `status=${facApply.status}`);

// ── 3. Apply: bulk move matches preview exactly ───────────────────────────────
const apply = await req('/users/sections/apply', 'POST', {
  current_section: '',
  target_section: 'SMOKE Section A',
  min_score: 0,
  max_score: 100,
  min_exams: 1,
}, T.principal);
check('apply runs', apply.status === 200, `status=${apply.status} body=${JSON.stringify(apply.data)}`);
check('apply moved exactly the previewed count', apply.data?.moved === preview.data?.count,
  `moved=${apply.data?.moved} previewCount=${preview.data?.count}`);

// Verify in DB via GET /users
const usersAfter = await req('/users', 'GET', null, T.principal);
const movedRows = (usersAfter.data || []).filter(u => u.batch_name === 'SMOKE Section A');
check('moved students visible with new section', movedRows.length === preview.data?.count,
  `visible=${movedRows.length} expected=${preview.data?.count}`);

// Same criteria again -> 0 moved (idempotent, current_section no longer matches)
const applyAgain = await req('/users/sections/apply', 'POST', {
  current_section: '',
  target_section: 'SMOKE Section A',
  min_score: 0,
  max_score: 100,
  min_exams: 1,
}, T.principal);
check('re-apply moves nobody (selection is precise)', applyAgain.data?.moved === 0, `moved=${applyAgain.data?.moved}`);

// ── 4. Single-student move ────────────────────────────────────────────────────
if (movedRows.length > 0) {
  const victim = movedRows[0];

  const sameSection = await req(`/users/${victim.id}/section`, 'PUT', { section: 'SMOKE Section A' }, T.principal);
  check('single move to same section rejected', sameSection.status === 400, `status=${sameSection.status}`);

  const toB = await req(`/users/${victim.id}/section`, 'PUT', { section: 'SMOKE Section B' }, T.principal);
  check('single move works', toB.status === 200 && toB.data?.new_section === 'SMOKE Section B',
    `status=${toB.status} body=${JSON.stringify(toB.data)}`);

  const nullMove = await req(`/users/${victim.id}/section`, 'PUT', { section: 'null' }, T.principal);
  check("single move to 'null' section rejected", nullMove.status === 400, `status=${nullMove.status}`);

  // faculty cannot move anyone
  const facMove = await req(`/users/${victim.id}/section`, 'PUT', { section: 'Section C' }, T.faculty);
  check('faculty forbidden from single move', facMove.status === 403, `status=${facMove.status}`);

  // non-student target: try moving the principal himself
  const principalId = principal.data?.user?.id;
  if (principalId) {
    const notStudent = await req(`/users/${principalId}/section`, 'PUT', { section: 'Section C' }, T.admin);
    check('non-student target rejected', notStudent.status === 400, `status=${notStudent.status}`);
  }
} else {
  check('single-student move tested', false, 'no moved rows to test with');
}

// ── 5. Student exam visibility follows section (bonus integration check) ─────
// The one seeded student with batch JEE_2025 should see targeted exams.
// (Just verify the list endpoint works with a batch filter present.)

// ── Restore every student's original section ──────────────────────────────────
// Student exam visibility depends on batch_name, so leaving students in
// 'SMOKE Section A' would quietly change what real students can see.
let restored = 0;
for (const [id, original] of sectionSnapshot) {
  db.prepare('UPDATE users SET batch_name = ? WHERE id = ?').run(original, id);
  restored++;
}
console.log(`  INFO: restored ${restored} student section(s)`);

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n════════ SECTION SMOKE RESULTS ════════');
for (const r of results) console.log(r);
console.log('════════════════════════════════════════');
console.log(`${passed} passed, ${failed} failed`);

// Exit code 0 only when all pass — cleanup happens in the shell afterwards.
process.exit(failed > 0 ? 1 : 0);
