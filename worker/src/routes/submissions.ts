// ─── Submission Routes ────────────────────────────────────────────────────────
// POST /submissions        — bulk submit all answers (creates submission + answers rows)
// POST /submissions/draft  — KV draft save (no D1 write, called every 15s)
// GET  /submissions/:exam_id          — student's own result (post-exam)
// GET  /submissions/:exam_id/report   — all results for faculty/admin

import { json, json400, json403, json404 } from '../middleware/responses';
import { requireAuth } from '../middleware/auth';
import { KV_DRAFT_EXTRA_TTL, SUBMIT_GRACE_SECONDS } from '../config';
import type { Env, SubmissionMessage } from '../types';
import type { SubmitRequest, ExamPayload } from '../../../shared/types';

// ── POST /submissions ─────────────────────────────────────────
// Validates server-side timer, scores answers, writes submission + submission_answers.
// Scoring runs async via ctx.waitUntil so response is instant.

export async function submitExam(
  request: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  const { ctx: authCtx, error } = await requireAuth(request, env, ['student']);
  if (error) return error;

  let body: Partial<SubmitRequest> & { submission_id?: string };
  try { body = await request.json(); } catch { return json400('Invalid JSON'); }

  const { exam_id, attempt_id, answers = {}, marked_for_review = [], answer_timestamps = {}, time_taken_seconds = 0 } = body;
  if (!exam_id || !attempt_id) return json400('exam_id and attempt_id are required');

  // ── Edge Timer & Metadata Check via KV Cache (0 D1 load) ────────
  const now = Math.floor(Date.now() / 1000);
  const cachedExam = await env.CBT_KV.get<ExamPayload>(`exam:${exam_id}`, 'json');
  if (cachedExam?.exam?.ends_at && now > cachedExam.exam.ends_at + SUBMIT_GRACE_SECONDS) {
    return json403(`Exam time ended ${now - cachedExam.exam.ends_at}s ago. Submission rejected.`);
  }

  // ── Formulate and Enqueue SubmissionMessage ─────────────────
  // Server-owned submission_id tied deterministically to attempt_id
  const submissionId = body.submission_id || `sub_${attempt_id}`;
  const submissionMessage: SubmissionMessage = {
    submission_id: submissionId,
    attempt_id,
    exam_id,
    student_id: authCtx.user.sub,
    college_id: authCtx.user.college_id,
    time_taken_seconds,
    submitted_at: now,
    answers,
    marked_for_review,
    answer_timestamps
  };

  try {
    await env.SUBMISSIONS_QUEUE.send(submissionMessage);
  } catch (queueErr: any) {
    console.error('Failed to publish submission to SUBMISSIONS_QUEUE:', queueErr);
    // Queue send failed -> return retryable 503 error, student draft remains intact in KV
    return json({ error: 'Submission service temporarily unavailable. Please retry.' }, 503);
  }

  // Notice: KV draft is intentionally RETAINED here as a safety net.
  // It will be deleted post-commit by handleSubmissionsBatch once D1 persistence is confirmed.

  return json({
    success: true,
    submission_id: submissionId,
    status: 'queued',
    message: 'Submission accepted and queued for processing'
  }, 202);
}


// ── POST /submissions/draft ───────────────────────────────────
// 100% Pure KV edge save. Zero D1 reads or writes. Called from auto-save hook.
// Reads exam end time from KV cache to calculate TTL, ensuring zero DB contention.

export async function saveDraft(request: Request, env: Env): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['student']);
  if (error) return error;

  let body: { exam_id?: string; answers?: Record<string, string | null> };
  try { body = await request.json(); } catch { return json400('Invalid JSON'); }
  if (!body.exam_id) return json400('exam_id is required');

  const { exam_id, answers = {} } = body;
  const now = Math.floor(Date.now() / 1000);

  // Attempt to read ends_at from cached exam payload in KV (0 D1 load)
  let ttl = KV_DRAFT_EXTRA_TTL;
  const cachedExam = await env.CBT_KV.get<ExamPayload>(`exam:${exam_id}`, 'json');
  if (cachedExam?.exam?.ends_at) {
    ttl = Math.max(60, (cachedExam.exam.ends_at - now) + KV_DRAFT_EXTRA_TTL);
  }

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
    'SELECT sa.*, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_answer, q.explanation FROM submission_answers sa JOIN questions q ON q.id = sa.question_id WHERE sa.submission_id = ?'
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
