/**
 * smoke-test.mjs — End-to-end smoke test for the CBT/QForge platform.
 *
 * Run while `wrangler dev` is serving on http://127.0.0.1:8787:
 *   node smoke-test.mjs
 *
 * Covers the full user journey:
 *   infra → auth (all roles + negatives) → RBAC → questions → exam lifecycle
 *   → attempt → anti-cheat events → submission → async scoring → reports
 *   → analytics → forge drafts → logout → session invalidation
 */

const BASE = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:8787';
const PASSWORD = 'change_me_in_production';

let passed = 0, failed = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(name + (extra ? ` — ${extra}` : ''));
    console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

async function api(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json, res };
}

async function login(email) {
  const r = await api('POST', '/auth/login', { body: { email, password: PASSWORD } });
  if (r.status !== 200 || !r.json?.token) {
    throw new Error(`Login failed for ${email}: ${r.status} ${JSON.stringify(r.json)}`);
  }
  return r.json.token;
}

// ─── 1. Infrastructure ───────────────────────────────────────
async function testInfra() {
  console.log('\n── 1. Infrastructure ──');
  const health = await api('GET', '/health');
  check('GET /health → 200 ok', health.status === 200 && health.json?.status === 'ok');

  const home = await fetch(BASE + '/');
  const html = await home.text();
  check('GET / serves frontend (index.html)', home.status === 200 && /<html/i.test(html));

  const pre = await fetch(BASE + '/questions', { method: 'OPTIONS' });
  check('CORS preflight OPTIONS → 2xx', pre.status >= 200 && pre.status < 300);

  const missing = await api('GET', '/definitely-not-a-route');
  check('Unknown route → 404', missing.status === 404);
}

// ─── 2. Auth ─────────────────────────────────────────────────
const tokens = {};
async function testAuth() {
  console.log('\n── 2. Auth ──');
  for (const email of ['admin@example.com', 'student@example.com', 'faculty@example.com', 'intern@example.com']) {
    try {
      tokens[email.split('@')[0]] = await login(email);
      check(`POST /auth/login ${email} → token issued`, true);
    } catch (e) {
      check(`POST /auth/login ${email} → token issued`, false, e.message);
    }
  }

  const badPw = await api('POST', '/auth/login', { body: { email: 'admin@example.com', password: 'wrong' } });
  check('Login with wrong password → 401', badPw.status === 401);

  const noUser = await api('POST', '/auth/login', { body: { email: 'ghost@example.com', password: PASSWORD } });
  check('Login with unknown user → 401 (no enumeration)', noUser.status === 401);

  const noBody = await api('POST', '/auth/login', { body: { email: 'admin@example.com' } });
  check('Login missing password → 400', noBody.status === 400);

  const noToken = await api('GET', '/questions');
  check('Protected route without token → 401', noToken.status === 401);

  const badToken = await api('GET', '/questions', { token: 'garbage.token.here' });
  check('Protected route with invalid token → 401', badToken.status === 401);
}

// ─── 3. RBAC ─────────────────────────────────────────────────
async function testRbac() {
  console.log('\n── 3. RBAC ──');
  const studentUsers = await api('GET', '/users', { token: tokens.student });
  check('Student GET /users → 403', studentUsers.status === 403);

  const adminUsers = await api('GET', '/users', { token: tokens.admin });
  check('Admin GET /users → 200 list', adminUsers.status === 200 && Array.isArray(adminUsers.json));

  const studentCreateExam = await api('POST', '/exams', { token: tokens.student, body: { title: 'Hack', duration_minutes: 10, total_marks: 100 } });
  check('Student POST /exams → 403', studentCreateExam.status === 403);

  const studentQuestions = await api('GET', '/questions', { token: tokens.student });
  check('Student GET /questions → 403', studentQuestions.status === 403);
}

// ─── 4. Questions ────────────────────────────────────────────
async function testQuestions() {
  console.log('\n── 4. Questions ──');
  const list = await api('GET', '/questions?limit=5', { token: tokens.admin });
  check('GET /questions → 200 with data + total', list.status === 200 && Array.isArray(list.json?.data) && typeof list.json.total === 'number');

  const filtered = await api('GET', '/questions?subject=physics', { token: tokens.admin });
  check('GET /questions?subject=physics → all physics', filtered.status === 200 && filtered.json.data.every(q => q.subject === 'physics') && filtered.json.data.length > 0);

  const chapters = await api('GET', '/questions/chapters', { token: tokens.admin });
  check('GET /questions/chapters → 200', chapters.status === 200);

  const created = await api('POST', '/questions', {
    token: tokens.admin,
    body: {
      subject: 'physics', chapter: 'Thermodynamics', difficulty: 'medium', type: 'mcq',
      question_text: 'What is 0 degrees Celsius in Kelvin?',
      option_a: '273 K', option_b: '373 K', option_c: '0 K', option_d: '100 K',
      correct_answer: 'A', explanation: '0 C = 273.15 K',
    },
  });
  check('POST /questions → 201 created', created.status === 201 && !!created.json?.id);

  const one = await api('GET', `/questions/${created.json.id}`, { token: tokens.admin });
  check('GET /questions/:id → includes correct_answer', one.status === 200 && one.json?.correct_answer === 'A');

  // Faculty subject scoping: faculty is locked to physics
  const facList = await api('GET', '/questions?subject=chemistry', { token: tokens.faculty });
  check('Faculty GET /questions (subject override) → physics only', facList.status === 200 && facList.json.data.every(q => q.subject === 'physics'));

  return created.json.id;
}

// ─── 5. Exam lifecycle ───────────────────────────────────────
async function testExamLifecycle(newQuestionId) {
  console.log('\n── 5. Exam lifecycle (create → publish → deliver) ──');
  const qIds = ['q-smoke-1', 'q-smoke-2', 'q-smoke-3', 'q-smoke-4', 'q-smoke-5', newQuestionId];

  const created = await api('POST', '/exams', {
    token: tokens.admin,
    body: {
      title: 'Smoke Test Exam',
      description: 'E2E smoke test exam',
      exam_type: 'custom',
      duration_minutes: 30,
      total_marks: qIds.length * 4,
      question_ids: qIds.map(id => ({ id, marks: 4, negative_marks: 1 })),
    },
  });
  check('POST /exams → 201 exam created', created.status === 201 && !!created.json?.id);
  const examId = created.json.id;

  // Publish starting 60s in the past so the student can access immediately
  const publish = await api('PUT', `/exams/${examId}/publish`, {
    token: tokens.admin,
    body: { starts_at: Math.floor(Date.now() / 1000) - 60 },
  });
  check('PUT /exams/:id/publish → published', publish.status === 200);

  const republish = await api('PUT', `/exams/${examId}/publish`, { token: tokens.admin, body: {} });
  check('Re-publishing published exam → 400', republish.status === 400);

  // Student sees the exam
  const studentExams = await api('GET', '/exams', { token: tokens.student });
  check('Student GET /exams → sees published exam', studentExams.status === 200 && studentExams.json.some(e => e.id === examId));

  // Security: student payload must not contain answers
  const studentView = await api('GET', `/exams/${examId}`, { token: tokens.student });
  const payloadStr = JSON.stringify(studentView.json);
  check('Student GET /exams/:id → 200 with questions', studentView.status === 200 && studentView.json.questions.length === qIds.length);
  check('Student payload leaks no correct_answer', !payloadStr.includes('"correct_answer"'));
  check('Student payload leaks no explanation', !payloadStr.includes('"explanation"'));
  check('Student payload includes server_time', typeof studentView.json.server_time === 'number');

  return examId;
}

// ─── 6. Attempt flow ─────────────────────────────────────────
async function testAttempts(examId) {
  console.log('\n── 6. Attempt flow (start → resume → heartbeat → events) ──');
  const start = await api('POST', '/attempts', { token: tokens.student, body: { exam_id: examId } });
  check('POST /attempts → 201 attempt_id', start.status === 201 && !!start.json?.attempt_id);
  const attemptId = start.json.attempt_id;

  const resume = await api('POST', '/attempts', { token: tokens.student, body: { exam_id: examId } });
  check('POST /attempts again → resumes existing', resume.status === 200 && resume.json?.resumed === true && resume.json.attempt_id === attemptId);

  const hb = await api('POST', `/attempts/${attemptId}/heartbeat`, { token: tokens.student });
  check('POST /attempts/:id/heartbeat → ok', hb.status === 200 && hb.json?.ok === true);

  const ev = await api('POST', '/events', { token: tokens.student, body: { attempt_id: attemptId, event_type: 'tab_hidden' } });
  check('POST /events (tab_hidden) → ok', ev.status === 200 && ev.json?.ok === true);

  const badEv = await api('POST', '/events', { token: tokens.student, body: { attempt_id: attemptId, event_type: 'hacked' } });
  check('POST /events with invalid type → 400', badEv.status === 400);

  // Someone else's attempt must be rejected
  const facStart = await api('POST', '/attempts', { token: tokens.faculty, body: { exam_id: examId } });
  check('Faculty POST /attempts → 403 (role gate)', facStart.status === 403);

  return attemptId;
}

// ─── 7. Draft + Submission + Scoring ────────────────────────
async function testSubmission(examId, attemptId, newQuestionId) {
  console.log('\n── 7. Draft save → Submission → Async scoring ──');
  const draft = await api('POST', '/submissions/draft', {
    token: tokens.student,
    body: { exam_id: examId, answers: { 'q-smoke-1': 'B' } },
  });
  check('POST /submissions/draft → ok', draft.status === 200 && draft.json?.ok === true);

  const restored = await api('GET', `/submissions/draft/${examId}`, { token: tokens.student });
  check('GET /submissions/draft/:exam_id → draft restored', restored.status === 200 && restored.json?.answers?.['q-smoke-1'] === 'B');

  // Submit: 5 correct, 1 wrong (q-smoke-5 correct is A, we answer D) → 5*4 - 1 = 19
  const answers = {
    'q-smoke-1': 'B', // correct
    'q-smoke-2': 'A', // correct
    'q-smoke-3': 'C', // correct
    'q-smoke-4': 'B', // correct
    'q-smoke-5': 'D', // WRONG (correct is A)
    [newQuestionId]: 'A', // correct
  };
  const submit = await api('POST', '/submissions', {
    token: tokens.student,
    body: { exam_id: examId, attempt_id: attemptId, answers, marked_for_review: ['q-smoke-3'], time_taken_seconds: 600 },
  });
  check('POST /submissions → accepted', submit.status === 200 && !!submit.json?.submission_id);

  const dup = await api('POST', '/submissions', {
    token: tokens.student,
    body: { exam_id: examId, attempt_id: attemptId, answers },
  });
  check('Duplicate submission → 409', dup.status === 409);

  // Scoring is async (ctx.waitUntil) — poll until score lands
  let result = null;
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 500));
    result = await api('GET', `/submissions/${examId}`, { token: tokens.student });
    if (result.json?.submission?.score !== null && result.json?.submission?.score !== undefined) break;
  }
  check('GET /submissions/:exam_id → result found', result.status === 200 && !!result.json?.submission);
  const s = result.json?.submission ?? {};
  check(`Score correct (expected 19, got ${s.score})`, s.score === 19);
  check('total_correct = 5', s.total_correct === 5);
  check('total_wrong = 1', s.total_wrong === 1);
  check('total_unattempted = 0', s.total_unattempted === 0);

  const wrongAnswer = (result.json?.answers ?? []).find(a => a.question_id === 'q-smoke-5');
  check('Wrong answer flagged is_correct=0, marks=-1', wrongAnswer?.is_correct === 0 && wrongAnswer?.marks_awarded === -1);
  check('Result includes correct_answer + explanation', !!wrongAnswer?.correct_answer && !!wrongAnswer?.explanation);
}

// ─── 8. Reports + Analytics ─────────────────────────────────
async function testReports(examId) {
  console.log('\n── 8. Faculty report + Analytics ──');
  const report = await api('GET', `/submissions/${examId}/report`, { token: tokens.faculty });
  check('GET /submissions/:exam_id/report (faculty) → 200', report.status === 200);
  check('Report includes the student submission', JSON.stringify(report.json).includes('Demo Student'));

  const adminReport = await api('GET', `/submissions/${examId}/report`, { token: tokens.admin });
  check('GET /submissions/:exam_id/report (admin) → 200', adminReport.status === 200);

  // student id from report or login: fetch via /users
  const users = await api('GET', '/users', { token: tokens.admin });
  const student = users.json.find(u => u.email === 'student@example.com');

  const myStats = await api('GET', `/analytics/student/${student.id}`, { token: tokens.student });
  check('GET /analytics/student/:id (own) → 200 with stats', myStats.status === 200 && 'overall' in (myStats.json ?? {}));

  const otherStats = await api('GET', `/analytics/student/${student.id}`, { token: tokens.faculty });
  check('GET /analytics/student/:id (faculty) → 200', otherStats.status === 200);
}

// ─── 9. Forge (QForge AI pipeline) ──────────────────────────
async function testForge() {
  console.log('\n── 9. Question Forge ──');
  const internDrafts = await api('GET', '/forge/drafts', { token: tokens.intern });
  check('GET /forge/drafts (intern) → 200', internDrafts.status === 200);

  const studentDrafts = await api('GET', '/forge/drafts', { token: tokens.student });
  check('GET /forge/drafts (student) → 403', studentDrafts.status === 403);

  const approved = await api('GET', '/forge/approved', { token: tokens.intern });
  check('GET /forge/approved (intern) → 200', approved.status === 200);
}

// ─── 10. Logout & session invalidation ──────────────────────
async function testLogout() {
  console.log('\n── 10. Logout & session invalidation ──');
  const logout = await api('POST', '/auth/logout', { token: tokens.intern });
  check('POST /auth/logout → 200', logout.status === 200);

  const afterLogout = await api('GET', '/forge/drafts', { token: tokens.intern });
  check('Token revoked after logout → 401', afterLogout.status === 401);
}

// ─── Run ─────────────────────────────────────────────────────
(async () => {
  console.log(`Smoke testing ${BASE}\n`);
  try {
    await testInfra();
    await testAuth();
    await testRbac();
    const newQuestionId = await testQuestions();
    const examId = await testExamLifecycle(newQuestionId);
    const attemptId = await testAttempts(examId);
    await testSubmission(examId, attemptId, newQuestionId);
    await testReports(examId);
    await testForge();
    await testLogout();
  } catch (e) {
    failed++;
    failures.push(`Fatal: ${e.message}`);
    console.error('\nFATAL:', e);
  }

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(`  • ${f}`));
    process.exit(1);
  }
  console.log('ALL GREEN ✔');
})();
