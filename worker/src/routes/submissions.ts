// ─── Submission Routes ────────────────────────────────────────────────────────
// POST /submissions        — bulk submit all answers (creates submission + answers rows)
// POST /submissions/draft  — KV draft save (no D1 write, called every 15s)
// GET  /submissions/:exam_id          — student's own result (post-exam)
// GET  /submissions/:exam_id/report   — all results for faculty/admin

import { json, json400, json403, json404, json409 } from '../middleware/responses';
import { requireAuth } from '../middleware/auth';
import { KV_DRAFT_EXTRA_TTL, SUBMIT_GRACE_SECONDS } from '../config';
import type { Env } from '../types';
import type { SubmitRequest, ExamConfig } from '../../../shared/types';

function generateId(): string {
  return crypto.randomUUID();
}

// ── POST /submissions ─────────────────────────────────────────
// Validates server-side timer, scores answers, writes submission + submission_answers.
// Scoring runs async via ctx.waitUntil so response is instant.

export async function submitExam(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const { ctx: authCtx, error } = await requireAuth(request, env, ['student']);
  if (error) return error;

  let body: Partial<SubmitRequest>;
  try { body = await request.json(); } catch { return json400('Invalid JSON'); }

  const { exam_id, attempt_id, answers = {}, marked_for_review = [], answer_timestamps = {}, time_taken_seconds = 0 } = body;
  if (!exam_id || !attempt_id) return json400('exam_id and attempt_id are required');

  // ── Verify attempt belongs to this student ─────────────────
  const attempt = await env.DB.prepare(
    'SELECT id, student_id, status FROM exam_attempts WHERE id = ? AND exam_id = ?'
  ).bind(attempt_id, exam_id).first<{ id: string; student_id: string; status: string }>();

  if (!attempt) return json404('Attempt not found');
  if (attempt.student_id !== authCtx.user.sub) return json403('Not your attempt');
  if (attempt.status === 'submitted') return json409('Already submitted');

  // ── Server-side timer check ────────────────────────────────
  const exam = await env.DB.prepare(
    'SELECT ends_at, config_snapshot FROM exams WHERE id = ? AND college_id = ?'
  ).bind(exam_id, authCtx.user.college_id).first<{ ends_at: number; config_snapshot: string }>();

  if (!exam) return json404('Exam not found');

  const now = Math.floor(Date.now() / 1000);
  if (exam.ends_at && now > exam.ends_at + SUBMIT_GRACE_SECONDS) {
    // Mark as timed_out and reject
    await env.DB.prepare('UPDATE exam_attempts SET status = ? WHERE id = ?')
      .bind('timed_out', attempt_id).run();
    return json403(`Exam time ended ${now - exam.ends_at}s ago. Submission rejected.`);
  }

  // ── Mark attempt as submitted ──────────────────────────────
  await env.DB.prepare('UPDATE exam_attempts SET status = ?, last_seen_at = ? WHERE id = ?')
    .bind('submitted', now, attempt_id).run();

  // ── Create submission row (score computed async) ───────────
  const submissionId = generateId();
  await env.DB.prepare(`
    INSERT INTO submissions (id, attempt_id, exam_id, student_id, time_taken_seconds, college_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(submissionId, attempt_id, exam_id, authCtx.user.sub, time_taken_seconds, authCtx.user.college_id).run();

  // ── Insert submission_answers rows ─────────────────────────
  // Fetch question list for this exam to ensure we record all questions (even unattempted)
  const examQs = await env.DB.prepare(
    'SELECT question_id FROM exam_questions WHERE exam_id = ?'
  ).bind(exam_id).all<{ question_id: string }>();

  const answerStmt = env.DB.prepare(`
    INSERT INTO submission_answers (submission_id, question_id, selected_answer, marked_for_review, answered_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  await env.DB.batch(
    examQs.results.map(q =>
      answerStmt.bind(
        submissionId,
        q.question_id,
        answers[q.question_id] ?? null,
        marked_for_review.includes(q.question_id) ? 1 : 0,
        answer_timestamps[q.question_id] ?? null
      )
    )
  );

  // ── Clean up KV draft ──────────────────────────────────────
  await env.CBT_KV.delete(`draft:${exam_id}:${authCtx.user.sub}`);

  // ── Score async (non-blocking) ─────────────────────────────
  ctx.waitUntil(scoreSubmission(submissionId, exam.config_snapshot, env));

  return json({ success: true, submission_id: submissionId, message: 'Submitted successfully' });
}

// ── Async scoring ─────────────────────────────────────────────
// Runs in background after submit response is sent.
// Reads correct answers from D1, never from KV (security).

async function scoreSubmission(
  submissionId: string,
  configSnapshot: string,
  env: Env
): Promise<void> {
  const config: ExamConfig = configSnapshot ? JSON.parse(configSnapshot) : { marks_correct: 4, marks_wrong: 1 };

  // Fetch submitted answers with correct answers from questions table
  const rows = await env.DB.prepare(`
    SELECT sa.question_id, sa.selected_answer, q.correct_answer, sa.submission_id
    FROM submission_answers sa
    JOIN questions q ON q.id = sa.question_id
    WHERE sa.submission_id = ?
  `).bind(submissionId).all<{
    question_id: string;
    selected_answer: string | null;
    correct_answer: string;
    submission_id: string;
  }>();

  let score = 0;
  let totalCorrect = 0;
  let totalWrong = 0;
  let totalUnattempted = 0;

  const updates = rows.results.map(row => {
    let isCorrect: number | null = null;
    let marksAwarded = 0;

    if (row.selected_answer === null) {
      totalUnattempted++;
    } else if (row.selected_answer === row.correct_answer) {
      isCorrect = 1;
      marksAwarded = config.marks_correct;
      totalCorrect++;
      score += marksAwarded;
    } else {
      isCorrect = 0;
      marksAwarded = config.negative_marking ? -config.marks_wrong : 0;
      totalWrong++;
      score += marksAwarded;
    }

    return env.DB.prepare(`
      UPDATE submission_answers SET is_correct = ?, marks_awarded = ?
      WHERE submission_id = ? AND question_id = ?
    `).bind(isCorrect, marksAwarded, submissionId, row.question_id);
  });

  // Batch update all answers, then update submission totals
  await env.DB.batch(updates);
  await env.DB.prepare(`
    UPDATE submissions SET score = ?, total_correct = ?, total_wrong = ?, total_unattempted = ?
    WHERE id = ?
  `).bind(score, totalCorrect, totalWrong, totalUnattempted, submissionId).run();
}

// ── POST /submissions/draft ───────────────────────────────────
// KV-only save. No D1 write. Called every 15s from auto-save hook.
// Expires automatically when exam ends + 30min grace period.

export async function saveDraft(request: Request, env: Env): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['student']);
  if (error) return error;

  let body: { exam_id?: string; answers?: Record<string, string | null> };
  try { body = await request.json(); } catch { return json400('Invalid JSON'); }
  if (!body.exam_id) return json400('exam_id is required');

  const { exam_id, answers = {} } = body;

  // Get exam end time for KV TTL calculation
  const exam = await env.DB.prepare('SELECT ends_at FROM exams WHERE id = ? AND college_id = ?')
    .bind(exam_id, ctx.user.college_id).first<{ ends_at: number | null }>();

  const now = Math.floor(Date.now() / 1000);
  const ttl = exam?.ends_at
    ? Math.max(60, (exam.ends_at - now) + KV_DRAFT_EXTRA_TTL)
    : KV_DRAFT_EXTRA_TTL;

  await env.CBT_KV.put(
    `draft:${exam_id}:${ctx.user.sub}`,
    JSON.stringify({ answers, saved_at: now }),
    { expirationTtl: ttl }
  );

  return json({ ok: true, saved_at: now });
}

// ── GET /submissions/draft/:exam_id ──────────────────────────
// Restore draft answers on page reload (crash recovery).

export async function getDraft(request: Request, env: Env, examId: string): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['student']);
  if (error) return error;

  const draft = await env.CBT_KV.get<{ answers: Record<string, string | null>; saved_at: number }>(
    `draft:${examId}:${ctx.user.sub}`, 'json'
  );

  return json(draft ?? { answers: {}, saved_at: null });
}

// ── GET /submissions/:exam_id ─────────────────────────────────
// Student's own result after exam. Includes scored answers + questions.

export async function getMyResult(request: Request, env: Env, examId: string): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['student']);
  if (error) return error;

  const submission = await env.DB.prepare(
    'SELECT * FROM submissions WHERE exam_id = ? AND student_id = ? AND college_id = ?'
  ).bind(examId, ctx.user.sub, ctx.user.college_id).first<Record<string, unknown>>();

  if (!submission) return json404('No submission found for this exam');

  const answers = await env.DB.prepare(
    'SELECT sa.*, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_answer, q.explanation, q.image_r2_key, q.explanation_image_r2_key FROM submission_answers sa JOIN questions q ON q.id = sa.question_id WHERE sa.submission_id = ?'
  ).bind(submission['id']).all();

  return json({ submission, answers: answers.results });
}

// ── GET /submissions/:exam_id/report ─────────────────────────
// All results for faculty/admin. Includes rank ordering.

export async function getReport(request: Request, env: Env, examId: string): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['admin', 'faculty']);
  if (error) return error;

  const exam = await env.DB.prepare('SELECT id, title, total_marks FROM exams WHERE id = ? AND college_id = ?').bind(examId, ctx.user.college_id).first();
  if (!exam) return json404('Exam not found');

  const attempts = await env.DB.prepare(
    'SELECT status, COUNT(*) as count FROM exam_attempts WHERE exam_id = ? AND college_id = ? GROUP BY status'
  ).bind(examId, ctx.user.college_id).all<{ status: string; count: number }>();

  let submissionsQuery = '';
  let submissionsParams: any[] = [];
  
  let chaptersQuery = '';
  let chaptersParams: any[] = [];

  if (ctx.user.role === 'faculty' && ctx.user.subject) {
    submissionsQuery = `
      SELECT 
        s.id as submission_id,
        s.student_id,
        u.name,
        u.email,
        SUM(sa.marks_awarded) as score,
        SUM(CASE WHEN sa.is_correct = 1 THEN 1 ELSE 0 END) as total_correct,
        SUM(CASE WHEN sa.is_correct = 0 THEN 1 ELSE 0 END) as total_wrong,
        SUM(CASE WHEN sa.is_correct IS NULL THEN 1 ELSE 0 END) as total_unattempted
      FROM submissions s
      JOIN users u ON u.id = s.student_id
      JOIN submission_answers sa ON s.id = sa.submission_id
      JOIN questions q ON q.id = sa.question_id
      WHERE s.exam_id = ? AND q.subject = ?
      GROUP BY s.id, s.student_id, u.name, u.email
      ORDER BY score DESC
    `;
    submissionsParams = [examId, ctx.user.subject];

    chaptersQuery = `
      SELECT 
        q.chapter,
        q.subject,
        COUNT(sa.question_id) as total_attempts,
        SUM(CASE WHEN sa.is_correct = 1 THEN 1 ELSE 0 END) as total_correct,
        CAST(SUM(CASE WHEN sa.is_correct = 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(sa.question_id) * 100 as accuracy_percentage
      FROM submission_answers sa
      JOIN questions q ON q.id = sa.question_id
      JOIN submissions s ON s.id = sa.submission_id
      WHERE s.exam_id = ? AND q.subject = ?
      GROUP BY q.chapter, q.subject
      ORDER BY accuracy_percentage ASC
    `;
    chaptersParams = [examId, ctx.user.subject];
  } else {
    submissionsQuery = `
      SELECT s.*, u.name, u.email 
      FROM submissions s 
      JOIN users u ON u.id = s.student_id 
      WHERE s.exam_id = ? 
      ORDER BY s.score DESC
    `;
    submissionsParams = [examId];

    chaptersQuery = `
      SELECT 
        q.chapter,
        q.subject,
        COUNT(sa.question_id) as total_attempts,
        SUM(CASE WHEN sa.is_correct = 1 THEN 1 ELSE 0 END) as total_correct,
        CAST(SUM(CASE WHEN sa.is_correct = 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(sa.question_id) * 100 as accuracy_percentage
      FROM submission_answers sa
      JOIN questions q ON q.id = sa.question_id
      JOIN submissions s ON s.id = sa.submission_id
      WHERE s.exam_id = ?
      GROUP BY q.chapter, q.subject
      ORDER BY accuracy_percentage ASC
    `;
    chaptersParams = [examId];
  }

  const [submissions, chapterPerformance] = await Promise.all([
    env.DB.prepare(submissionsQuery).bind(...submissionsParams).all(),
    env.DB.prepare(chaptersQuery).bind(...chaptersParams).all(),
  ]);

  const scores = (submissions.results as Array<{ score: number }>).map(s => s.score).filter(s => s != null);
  const stats = {
    total_submissions: submissions.results.length,
    average_score: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0,
    highest_score: scores.length ? Math.max(...scores) : 0,
    lowest_score: scores.length ? Math.min(...scores) : 0,
    attempt_breakdown: attempts.results,
  };

  return json({ exam, stats, chapter_performance: chapterPerformance.results, results: submissions.results });
}

// ── Route Dispatcher ─────────────────────────────────────────

export async function submissionsRouter(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  pathname: string
): Promise<Response | null> {
  const method = request.method;

  if (pathname === '/submissions' && method === 'POST')       return submitExam(request, env, ctx);
  if (pathname === '/submissions/draft' && method === 'POST') return saveDraft(request, env);

  const draftMatch = pathname.match(/^\/submissions\/draft\/([^/]+)$/);
  if (draftMatch && method === 'GET') return getDraft(request, env, draftMatch[1]);

  const reportMatch = pathname.match(/^\/submissions\/([^/]+)\/report$/);
  if (reportMatch && method === 'GET') return getReport(request, env, reportMatch[1]);

  const idMatch = pathname.match(/^\/submissions\/([^/]+)$/);
  if (idMatch && method === 'GET') return getMyResult(request, env, idMatch[1]);

  return null;
}
