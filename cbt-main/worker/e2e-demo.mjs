// E2E demo against the LOCAL dev server (http://127.0.0.1:8787).
// Proves the imported question bank flows through exam → attempt → submission → scoring.
const BASE = 'http://127.0.0.1:8787';

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

const out = {};

// Requires seed-faculty.mjs and seed-principal.mjs to have been run once
// against the local DB (faculty@example.com / principal@example.com).

// 1. Logins
const admin = await api('/auth/login', { method: 'POST', body: { email: 'admin@example.com', password: 'change_me_in_production' } });
out.admin = admin.user;
const faculty = await api('/auth/login', { method: 'POST', body: { email: 'faculty@example.com', password: 'change_me_in_production' } });
out.faculty = faculty.user;
const principal = await api('/auth/login', { method: 'POST', body: { email: 'principal@example.com', password: 'change_me_in_production' } });
out.principal = principal.user;

// 2. Pull 10 real questions from the bank
const qs = await api('/questions?limit=10', { token: faculty.token });
const qids = qs.data.map((q) => ({ id: q.id, marks: 4, negative_marks: 1 }));
out.questions_pulled = qs.data.map((q) => `${q.subject}/${q.chapter}/${q.difficulty}`);

// 3. Faculty creates the exam -> status: draft (only faculty can create exams — admin cannot)
const created = await api('/exams', {
  method: 'POST',
  token: faculty.token,
  body: {
    title: 'Local Demo Exam (real questions)',
    exam_type: 'JEE',
    duration_minutes: 30,
    total_marks: 40,
    question_ids: qids,
  },
});
out.exam_id = created.id;

// 4. Approval chain: draft -> pending_principal_review -> pending_final_confirmation -> published
// Faculty submits their own draft directly to the principal (no second faculty account
// needed); principal approves and sends it back; the SAME faculty gives the final go-ahead.
await api(`/exams/${created.id}/submit-for-review`, { method: 'POST', token: faculty.token });
await api(`/exams/${created.id}/principal-review`, { method: 'PUT', token: principal.token, body: { decision: 'approve' } });

const now = Math.floor(Date.now() / 1000);
await api(`/exams/${created.id}/final-review`, {
  method: 'PUT',
  token: faculty.token,
  body: {
    decision: 'submit',
    starts_at: now - 60,
    config: { negative_marking: true, marks_correct: 4, marks_wrong: 1, duration_minutes: 30, subjects: ['physics', 'chemistry', 'maths'] },
  },
});
out.exam_published = true;

// 5. Create a student (unique email)
const studentEmail = `demo.student.${now}@local.test`;
await api('/users/bulk', { method: 'POST', token: admin.token, body: [{ name: 'Demo Student', email: studentEmail, password: 'demo1234' }] });
const student = await api('/auth/login', { method: 'POST', body: { email: studentEmail, password: 'demo1234' } });
out.student = student.user;

// 6. Student sees the exam in their list
const exams = await api('/exams', { token: student.token });
out.student_sees_exam = exams.some((e) => e.id === created.id);

// 7. Start attempt
const attempt = await api('/attempts', { method: 'POST', token: student.token, body: { exam_id: created.id } });
out.attempt_id = attempt.attempt_id;

// 8. Fetch exam payload as student — questions present, answers stripped
const payload = await api(`/exams/${created.id}`, { token: student.token });
out.payload_questions = payload.questions.length;
out.answers_stripped = payload.questions.every((q) => q.correct_answer === undefined && q.explanation === undefined);

// 9. Submit: answer first 3 questions with 'A', leave the rest unattempted
const answers = {};
payload.questions.slice(0, 3).forEach((q) => { answers[q.id] = 'A'; });
const sub = await api('/submissions', {
  method: 'POST',
  token: student.token,
  body: { exam_id: created.id, attempt_id: attempt.attempt_id, answers, marked_for_review: [], answer_timestamps: {}, time_taken_seconds: 90 },
});
out.submission_id = sub.submission_id;

// 10. Wait for async scoring, then check result + admin report
await new Promise((r) => setTimeout(r, 2500));
const result = await api(`/submissions/${created.id}`, { token: student.token });
out.score = result.submission.score;
out.total_correct = result.submission.total_correct;
out.total_wrong = result.submission.total_wrong;
out.total_unattempted = result.submission.total_unattempted;

const report = await api(`/submissions/${created.id}/report`, { token: admin.token });
out.report_stats = report.stats;

console.log(JSON.stringify(out, null, 2));