// ─── Exam Routes ──────────────────────────────────────────────────────────────
// GET  /exams                       — list exams
// POST /exams                       — create exam with question IDs (status: draft) — faculty only
// GET  /exams/:id                   — fetch exam payload (KV-cached, answers stripped)
// POST /exams/:id/submit-for-review — draft/rejected -> pending_principal_review (faculty).
//                                      Audits each blueprint subject against its quota and
//                                      notifies the principal about any that are missing /
//                                      short / over, or have no faculty assigned.
// PUT  /exams/:id/principal-review  — pending_principal_review -> published | rejected (principal).
//                                      The principal is the FINAL authority: approving publishes
//                                      the exam so students see it immediately.
// PUT  /exams/:id/final-review      — LEGACY only: publishes rows still sitting at
//                                      pending_final_confirmation from before the principal
//                                      became the final authority.
// POST /exams/:id/version           — create a new version of a published exam (faculty)

import { json, json400, json403, json404 } from '../middleware/responses';
import { requireAuth } from '../middleware/auth';
import { subjectScope } from '../utils/subject';
import { computeExamQuotaStatus, notifyBlueprintAssigned, notifyQuotaGaps, notifyTaskCompleted } from './notifications';
import { KV_EXAM_CACHE_TTL } from '../config';
import type { Env } from '../types';
import type { ExamConfig, ExamPayload, QuestionSafe } from '../../../shared/types';

function generateId(): string {
  return crypto.randomUUID();
}

/** Case/punctuation-insensitive key used to match a chapter name to the bank. */
function chapterKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Canonicalise blueprint chapter names against the real question bank.
 *
 * A quota can only be filled by a chapter that actually has questions, so a name
 * that doesn't match one (e.g. the syllabus-style "Alcohols, Phenols and
 * Ethers" vs the bank's "Alcohols Phenols and Ethers") would sit at 0 forever.
 * Rewrites each name to the matching bank chapter, summing quotas that collapse
 * onto the same chapter. Unmatched names are kept as-is rather than dropped.
 */
async function canonicaliseChapterQuotas(env: Env, quotas: unknown): Promise<unknown> {
  if (!quotas || typeof quotas !== 'object') return quotas;
  const out: Record<string, Record<string, number>> = {};

  for (const [subject, chapters] of Object.entries(quotas as Record<string, unknown>)) {
    if (!chapters || typeof chapters !== 'object') continue;

    const rows = await env.DB.prepare(
      'SELECT DISTINCT chapter FROM questions WHERE LOWER(subject) = ? AND chapter IS NOT NULL'
    ).bind(subject.toLowerCase()).all<{ chapter: string }>();

    const byKey = new Map<string, string>();
    for (const r of rows.results) if (r.chapter) byKey.set(chapterKey(r.chapter), r.chapter);

    const bucket: Record<string, number> = {};
    for (const [chapter, value] of Object.entries(chapters as Record<string, number>)) {
      const canonical = byKey.get(chapterKey(chapter)) ?? chapter;
      bucket[canonical] = (bucket[canonical] ?? 0) + (Number(value) || 0);
    }
    out[subject] = bucket;
  }

  return out;
}

function fixLatex(str: string | null | unknown): string | null {
  if (typeof str !== 'string' || !str) return str as string | null;
  return str
    .replace(/\r(ight|ho|ightarrow|angle|m|ef|eq|rangle)/g, '\\r$1')
    .replace(/\n(eq|u|abla|ewline|rightarrow|ormalsize|otin|i)/g, '\\n$1');
}

/** Strip correct_answer, explanation, and explanation_image_r2_key — NEVER sent to students */
function toSafeQuestion(q: Record<string, unknown>): QuestionSafe {
  const { correct_answer, explanation, explanation_image_r2_key, created_by, ...safe } = q;
  void correct_answer; void explanation; void explanation_image_r2_key; void created_by; // explicitly consumed
  
  if (safe.question_text) safe.question_text = fixLatex(safe.question_text);
  if (safe.option_a) safe.option_a = fixLatex(safe.option_a);
  if (safe.option_b) safe.option_b = fixLatex(safe.option_b);
  if (safe.option_c) safe.option_c = fixLatex(safe.option_c);
  if (safe.option_d) safe.option_d = fixLatex(safe.option_d);

  return safe as QuestionSafe;
}

// ── GET /exams ────────────────────────────────────────────────

export async function listExams(request: Request, env: Env): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env);
  if (error) return error;

  const url = new URL(request.url);
  const status = url.searchParams.get('status') ?? '';

  let query = 'SELECT * FROM exams WHERE college_id = ?';
  const params: any[] = [ctx.user.college_id];
  const filters: string[] = [];

  if (ctx.user.role === 'student') {
    // Students never see an exam that hasn't cleared the full approval chain —
    // draft/pending_*_review/rejected exams are invisible even in the list,
    // regardless of any ?status= the client asks for.
    filters.push("status IN ('published','ongoing','completed')");

    const user = await env.DB.prepare('SELECT batch_name FROM users WHERE id = ?').bind(ctx.user.sub).first<{ batch_name: string | null }>();
    if (user?.batch_name) {
      filters.push('(target_batch IS NULL OR target_batch = ?)');
      params.push(user.batch_name);
    } else {
      filters.push('target_batch IS NULL');
    }
  } else if (status) {
    filters.push('status = ?');
    params.push(status);
  }

  if (filters.length > 0) {
    query += ' AND ' + filters.join(' AND ');
  }
  query += ' ORDER BY created_at DESC';

  const rows = await env.DB.prepare(query).bind(...params).all();

  return json(rows.results);
}

// ── POST /exams ───────────────────────────────────────────────

export async function createExam(request: Request, env: Env): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['principal', 'admin']);
  if (error) return error;

  let body: {
    title?: string; description?: string; exam_type?: string;
    duration_minutes?: number; total_marks?: number; target_batch?: string;
    difficulty?: string;
    starts_at?: number; ends_at?: number;
    subject_quotas?: any;
    chapter_quotas?: any;
    question_ids?: Array<{ id: string; difficulty?: string; marks?: number; negative_marks?: number }>;
  };
  try { body = await request.json(); } catch { return json400('Invalid JSON'); }

  const { title, exam_type = 'custom', duration_minutes, total_marks, target_batch, difficulty, starts_at, ends_at, subject_quotas, chapter_quotas, question_ids = [] } = body;
  if (!title || !duration_minutes || !total_marks) {
    return json400('title, duration_minutes, and total_marks are required');
  }

  // ── Server-side guards (mirrors of the UI rules) ────────────
  // Duration must be a positive integer — negative/zero/nan rejected.
  if (!Number.isInteger(duration_minutes) || duration_minutes <= 0) {
    return json400('duration_minutes must be a positive integer');
  }
  // Hard cap — matches the UI's 200-minute maximum (NEET's length).
  if (duration_minutes > 200) {
    return json400('duration_minutes cannot exceed 200 minutes');
  }
  // Times must not be in the past (60s clock-skew grace, matching the UI).
  const nowSec = Math.floor(Date.now() / 1000);
  if (starts_at && starts_at < nowSec - 60) {
    return json400('starts_at cannot be in the past');
  }
  // ── Schedule derivation (auto-calculate) ───────────────────
  // The operator picks WHEN the exam starts and HOW LONG it runs; End Time
  // follows. When the client omits ends_at (auto mode), derive it:
  //   start + duration. With no schedule at all, start/end are set at
  // publish time (start defaults to "now", end = start + duration).
  const derivedEndsAt = ends_at ?? (typeof starts_at === 'number' ? starts_at + duration_minutes * 60 : undefined);
  if (derivedEndsAt && derivedEndsAt < nowSec - 60) {
    return json400('ends_at cannot be in the past');
  }
  if (starts_at && derivedEndsAt && starts_at >= derivedEndsAt) {
    return json400('ends_at must be after starts_at');
  }
  if (starts_at && derivedEndsAt && derivedEndsAt - starts_at < duration_minutes * 60) {
    return json400(`the schedule gives less than the ${duration_minutes}-minute exam window`);
  }
  // Difficulty is optional (defaults to medium) but must be valid when present.
  const allowedDifficulties = ['easy', 'medium', 'hard'];
  const difficultyValue = difficulty ? String(difficulty).toLowerCase() : undefined;
  if (difficultyValue && !allowedDifficulties.includes(difficultyValue)) {
    return json400('difficulty must be one of easy, medium, hard');
  }

  const examId = generateId();

  // Store blueprint chapters under their real bank names so faculty can fill them.
  const storedChapterQuotas = await canonicaliseChapterQuotas(env, chapter_quotas);

  // Insert exam
  await env.DB.prepare(`
    INSERT INTO exams (id, title, description, exam_type, duration_minutes, total_marks, difficulty, target_batch, starts_at, ends_at, subject_quotas, chapter_quotas, college_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(examId, title, body.description ?? null, exam_type, duration_minutes, total_marks, difficultyValue ?? 'medium', target_batch || null, starts_at || null, derivedEndsAt ?? null, subject_quotas ? JSON.stringify(subject_quotas) : null, storedChapterQuotas ? JSON.stringify(storedChapterQuotas) : null, ctx.user.college_id, ctx.user.sub).run();

  // Tell EVERY faculty of each quota'd subject — two faculties share a
  // subject, either of them can pick the task up. Fire-and-forget: a
  // notification hiccup must not fail blueprint creation.
  let facultyNotified = 0;
  try {
    facultyNotified = await notifyBlueprintAssigned(env, { ...body, id: examId, college_id: ctx.user.college_id, difficulty: difficultyValue ?? 'medium' }, ctx.user.sub);
  } catch (e) {
    console.error('blueprint notification failed:', e);
  }

  // Link questions
  if (Array.isArray(question_ids) && question_ids.length > 0) {
    const stmt = env.DB.prepare(
      'INSERT INTO exam_questions (exam_id, question_id, order_index, marks, negative_marks) VALUES (?, ?, ?, ?, ?)'
    );
    await env.DB.batch(
      question_ids.map((q, i) => stmt.bind(examId, q?.id, i + 1, q?.marks ?? 4, q?.negative_marks ?? 1.0))
    );
  }

  return json({ id: examId, message: 'Exam created', faculty_notified: facultyNotified }, 201);
}

// ── GET /exams/:id ────────────────────────────────────────────
// Served from KV cache. First request builds + caches the payload.
// Answers are stripped — students get only safe question data.

export async function getExam(request: Request, env: Env, examId: string): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env);
  if (error) return error;

  const cacheKey = `exam:${examId}`;

  // ── Cache hit ──────────────────────────────────────────────
  let payload: Omit<ExamPayload, 'server_time'>;
  let fromCache = false;
  
  const cached = await env.CBT_KV.get<ExamPayload>(cacheKey, 'json');
  if (cached) {
    payload = cached;
    fromCache = true;
  } else {
    // ── Cache miss — query D1 ──────────────────────────────────
    const exam = await env.DB.prepare('SELECT * FROM exams WHERE id = ?').bind(examId).first<Record<string, unknown>>();
    if (!exam) return json404('Exam not found');

    // Only published/ongoing exams are visible to students
    const isStaff = ctx.user.role === 'admin' || ctx.user.role === 'faculty' || ctx.user.role === 'principal';
    if (!isStaff && exam['status'] !== 'published' && exam['status'] !== 'ongoing') {
      return json403('Exam is not available');
    }

    const qRows = await env.DB.prepare(`
      SELECT q.*, eq.marks, eq.negative_marks, eq.order_index
      FROM exam_questions eq
      JOIN questions q ON q.id = eq.question_id
      WHERE eq.exam_id = ?
      ORDER BY eq.order_index
    `).bind(examId).all<Record<string, unknown>>();

    const config: ExamConfig = exam['config_snapshot']
      ? JSON.parse(exam['config_snapshot'] as string)
      : {
          negative_marking: true,
          marks_correct: 4,
          marks_wrong: 1,
          duration_minutes: exam['duration_minutes'] as number,
          subjects: [],
        };

    const safeQuestions: QuestionSafe[] = qRows.results.map(toSafeQuestion);

    payload = {
      exam: { ...(exam as Record<string, unknown>), config } as ExamPayload['exam'],
      questions: safeQuestions,
    };

    // Cache only for published/ongoing exams (not drafts)
    if (exam['status'] === 'published' || exam['status'] === 'ongoing') {
      await env.CBT_KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: KV_EXAM_CACHE_TTL });
    }
  }

  // 🛡️ Security Override: Strip questions if before start time 🛡️
  const serverTime = Math.floor(Date.now() / 1000);
  let isEarlyAccess = false;
  if (ctx.user.role === 'student' && payload.exam.starts_at && serverTime < payload.exam.starts_at) {
    if (payload.exam.starts_at - serverTime > 600) {
      return json403('Exam instructions will be available 10 minutes before start.');
    }
    payload.questions = [];
    isEarlyAccess = true;
  }

  return json({ ...payload, server_time: serverTime, from_cache: fromCache, is_early_access: isEarlyAccess });
}

// ── POST /exams/:id/submit-for-review ─────────────────────────
// Faculty (or admin) sends a draft (or a previously rejected exam)
// straight to the principal for review.

export async function submitExamForReview(request: Request, env: Env, examId: string): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['admin', 'faculty']);
  if (error) return error;

  const exam = await env.DB.prepare('SELECT * FROM exams WHERE id = ? AND college_id = ?').bind(examId, ctx.user.college_id).first<Record<string, unknown>>();
  if (!exam) return json404('Exam not found');
  if (exam['status'] !== 'draft' && exam['status'] !== 'rejected' && exam['status'] !== 'pending_principal_review') {
    return json400(`Exam cannot be submitted for review from status '${exam['status']}'`);
  }

  // ── Quota completion gate ─────────────────────────────────
  // The blueprint is a contract: faculty submit the exam only when every
  // subject's quota is fully filled. An incomplete submission short-changes
  // the principal review and publishes a thinner exam than approved.
  const quotaGaps = await computeExamQuotaStatus(env, exam);
  const unmet = quotaGaps.filter(g => g.selected < g.required);
  if (unmet.length > 0) {
    return json({
      error: `Task incomplete — every subject's quota must be filled before submitting. ` +
        unmet.map(g => `${g.subject}: ${g.selected}/${g.required}`).join(', '),
      code: 'QUOTA_INCOMPLETE',
      quota_gaps: unmet.map(g => ({ subject: g.subject, required: g.required, selected: g.selected })),
    }, 400);
  }

  await env.DB.prepare(`
    UPDATE exams
    SET status = 'pending_principal_review',
        faculty_reviewed_by = ?, faculty_reviewed_at = unixepoch(),
        rejected_by = NULL, rejected_at = NULL, rejection_stage = NULL, rejection_reason = NULL
    WHERE id = ?
  `).bind(ctx.user.sub, examId).run();

  // ── Quota audit ───────────────────────────────────────────────
  // The principal always hears about the submission. Subjects that are complete
  // get a single 'task_completed' notification; subjects that are missing /
  // short / over — or have no faculty — get the granular gap alerts.
  const quotaStatus = await computeExamQuotaStatus(env, exam);
  const completedNotified = await notifyTaskCompleted(env, exam, ctx.user, quotaStatus);
  const gapNotified = await notifyQuotaGaps(env, exam, ctx.user.sub, quotaStatus);

  return json({
    message: 'Submitted for principal review',
    quota_status: quotaStatus,
    principal_notifications_sent: completedNotified + gapNotified,
  });
}

// ── PUT /exams/:id/principal-review ────────────────────────────
// Principal (or admin) reviews the submitted exam. Approve PUBLISHES it —
// the principal is the final authority, so no faculty round-trip follows.
// Reject sends it back to 'rejected' (faculty can revise and resubmit).

export async function principalReviewExam(request: Request, env: Env, examId: string): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['admin', 'principal']);
  if (error) return error;

  let body: { decision?: 'approve' | 'reject'; reason?: string; starts_at?: number };
  try { body = await request.json(); } catch { return json400('Invalid JSON'); }
  if (body.decision !== 'approve' && body.decision !== 'reject') {
    return json400("decision must be 'approve' or 'reject'");
  }

  const exam = await env.DB.prepare('SELECT * FROM exams WHERE id = ? AND college_id = ?').bind(examId, ctx.user.college_id).first<Record<string, unknown>>();
  if (!exam) return json404('Exam not found');
  if (exam['status'] !== 'pending_principal_review') {
    return json400(`Exam is not awaiting principal review (status: '${exam['status']}')`);
  }

  if (body.decision === 'reject') {
    await env.DB.prepare(`
      UPDATE exams
      SET status = 'rejected', rejected_by = ?, rejected_at = unixepoch(),
          rejection_stage = 'principal', rejection_reason = ?
      WHERE id = ?
    `).bind(ctx.user.sub, body.reason ?? null, examId).run();
    return json({ message: 'Exam rejected at principal review' });
  }

  // ── Approve = publish ────────────────────────────────────────
  // The principal is the final authority. Freezing the config and setting the
  // schedule here is what previously happened at the (now removed) faculty
  // final-confirmation step. Default start: immediately.
  // End always respects the full duration window from the effective start —
  // an override start can never clip the exam shorter than configured.
  const startsAt = body.starts_at ?? (exam['starts_at'] as number | null) ?? Math.floor(Date.now() / 1000);
  const storedEnd = exam['ends_at'] as number | null;
  const minEnd = startsAt + (exam['duration_minutes'] as number) * 60;
  const endsAt = !storedEnd || storedEnd < minEnd ? minEnd : storedEnd;

  const config: ExamConfig = {
    negative_marking: true,
    marks_correct: 4,
    marks_wrong: 1,
    duration_minutes: exam['duration_minutes'] as number,
    subjects: [],
    section_wise: false,
    total_marks: exam['total_marks'] as number | undefined,
  };

  await env.DB.prepare(`
    UPDATE exams
    SET status = 'published', config_snapshot = ?, starts_at = ?, ends_at = ?,
        principal_reviewed_by = ?, principal_reviewed_at = unixepoch()
    WHERE id = ?
  `).bind(JSON.stringify(config), startsAt, endsAt, ctx.user.sub, examId).run();

  // Invalidate any stale cache entry
  await env.CBT_KV.delete(`exam:${examId}`);

  return json({ message: 'Approved and published — students can now see the exam', starts_at: startsAt, ends_at: endsAt });
}

// ── PUT /exams/:id/final-review ────────────────────────────────
// Faculty (or admin) gives the final go-ahead after principal approval.
// This is the ONLY place an exam can become 'published': freezes
// config_snapshot, sets starts_at/ends_at. After this point, scoring
// always reads from config_snapshot — immutable. Reject sends it back
// to 'rejected' (must go through principal review again after revision).

export async function finalConfirmExam(request: Request, env: Env, examId: string): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['admin', 'faculty']);
  if (error) return error;

  let body: { decision?: 'submit' | 'reject'; reason?: string; starts_at?: number; config?: Partial<ExamConfig> };
  try { body = await request.json(); } catch { return json400('Invalid JSON'); }
  if (body.decision !== 'submit' && body.decision !== 'reject') {
    return json400("decision must be 'submit' or 'reject'");
  }

  const exam = await env.DB.prepare('SELECT * FROM exams WHERE id = ? AND college_id = ?').bind(examId, ctx.user.college_id).first<Record<string, unknown>>();
  if (!exam) return json404('Exam not found');
  if (exam['status'] !== 'pending_final_confirmation') {
    return json400(`Exam is not awaiting final confirmation (status: '${exam['status']}')`);
  }

  // The final publish gate belongs to the faculty who SUBMITTED the exam —
  // the principal has already approved the content, and a different subject's
  // faculty must not be able to publish someone else's exam. Legacy rows
  // submitted before submitter tracking existed fall back to created_by.
  // Admins keep full authority over any exam in their college.
  if (ctx.user.role === 'faculty') {
    const submitter = (exam['faculty_reviewed_by'] ?? exam['created_by']) as string | null;
    if (submitter !== ctx.user.sub) {
      return json403('Only the faculty who submitted this exam can give the final publish confirmation.');
    }
  }

  if (body.decision === 'reject') {
    await env.DB.prepare(`
      UPDATE exams
      SET status = 'rejected', rejected_by = ?, rejected_at = unixepoch(),
          rejection_stage = 'faculty_final', rejection_reason = ?
      WHERE id = ?
    `).bind(ctx.user.sub, body.reason ?? null, examId).run();
    return json({ message: 'Exam rejected at final confirmation' });
  }

  const startsAt = body.starts_at ?? (exam['starts_at'] as number | null) ?? Math.floor(Date.now() / 1000) + 300; // default: 5 min from now
  // Same rule as principal-approve: end respects the full duration window
  // from the effective start (an override start can't clip the exam).
  const storedEnd = exam['ends_at'] as number | null;
  const minEnd = startsAt + (exam['duration_minutes'] as number) * 60;
  const endsAt = !storedEnd || storedEnd < minEnd ? minEnd : storedEnd;

  const config: ExamConfig = {
    negative_marking: body.config?.negative_marking ?? true,
    marks_correct: body.config?.marks_correct ?? 4,
    marks_wrong: body.config?.marks_wrong ?? 1,
    duration_minutes: exam['duration_minutes'] as number,
    subjects: body.config?.subjects ?? [],
    section_wise: body.config?.section_wise ?? false,
    total_marks: exam['total_marks'] as number | undefined,
  };

  await env.DB.prepare(`
    UPDATE exams
    SET status = 'published', config_snapshot = ?, starts_at = ?, ends_at = ?,
        faculty_reviewed_by = ?, faculty_reviewed_at = unixepoch()
    WHERE id = ?
  `).bind(JSON.stringify(config), startsAt, endsAt, ctx.user.sub, examId).run();

  // Invalidate any stale cache entry
  await env.CBT_KV.delete(`exam:${examId}`);

  return json({ message: 'Exam published', starts_at: startsAt, ends_at: endsAt });
}

// ── POST /exams/:id/version ───────────────────────────────────
// Creates a new draft version of an existing exam (copy questions, bump version).

export async function versionExam(request: Request, env: Env, examId: string): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['faculty']);
  if (error) return error;

  const exam = await env.DB.prepare('SELECT * FROM exams WHERE id = ? AND college_id = ?').bind(examId, ctx.user.college_id).first<Record<string, unknown>>();
  if (!exam) return json404('Exam not found');

  // Find the root exam id (parent or self)
  const parentId = (exam['parent_exam_id'] as string | null) ?? examId;

  // Get the latest version number for this exam family
  const latest = await env.DB.prepare(
    'SELECT MAX(version) as max_v FROM exams WHERE parent_exam_id = ? OR id = ?'
  ).bind(parentId, parentId).first<{ max_v: number }>();

  const newVersion = (latest?.max_v ?? 1) + 1;
  const newId = generateId();

  await env.DB.prepare(`
    INSERT INTO exams (id, parent_exam_id, version, title, description, exam_type,
                       duration_minutes, total_marks, difficulty, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    newId, parentId, newVersion,
    `${exam['title']} v${newVersion}`,
    exam['description'] ?? null,
    exam['exam_type'], exam['duration_minutes'], exam['total_marks'],
    exam['difficulty'] ?? 'medium',
    ctx.user.sub
  ).run();

  // Copy all questions from the source exam
  const srcQuestions = await env.DB.prepare(
    'SELECT * FROM exam_questions WHERE exam_id = ?'
  ).bind(examId).all<{ question_id: string; order_index: number; marks: number; negative_marks: number }>();

  if (srcQuestions.results.length > 0) {
    const stmt = env.DB.prepare(
      'INSERT INTO exam_questions (exam_id, question_id, order_index, marks, negative_marks) VALUES (?, ?, ?, ?, ?)'
    );
    await env.DB.batch(
      srcQuestions.results.map(q => stmt.bind(newId, q.question_id, q.order_index, q.marks, q.negative_marks))
    );
  }

  return json({ id: newId, version: newVersion, message: `Version ${newVersion} created as draft` }, 201);
}

// ── POST /exams/:id/auto-select-preview ──────────────────────
// Returns candidate questions for a quota. Every row carries `previously_used`
// { used, times_used, last_used_at, last_exam_title } — the UI shows an
// "Already selected" badge, and "Repeated" with the exam/date when the
// question appeared in a published exam before.
export async function autoSelectPreview(request: Request, env: Env, _examId: string): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['admin', 'faculty']);
  if (error) return error;

  let body: { subject: string; chapters: string[]; count: number; difficulty?: string };
  try { body = await request.json(); } catch { return json400('Invalid JSON'); }
  const { chapters, count, difficulty } = body;
  if (!body.subject || !Array.isArray(chapters) || chapters.length === 0 || !count) return json400('Missing required fields');

  // Faculty can only auto-select within their own subject
  const scope = await subjectScope(ctx, env, body.subject);
  if (scope.error) return scope.error;
  const subject = scope.subject;

  // Blueprint difficulty filter — 'medium' is the default for older blueprints
  // and matches where nearly all the bank's questions live.
  const blueprintDifficulty = difficulty && ['easy', 'medium', 'hard'].includes(difficulty) ? difficulty : 'medium';

  const placeholders = chapters.map(() => '?').join(',');
  const query = `
    SELECT q.*,
           (SELECT COUNT(*) FROM exam_questions eq2
             JOIN exams e2 ON e2.id = eq2.exam_id
            WHERE eq2.question_id = q.id
              AND e2.status IN ('published','ongoing','completed','archived')) AS times_used,
           (SELECT MAX(e3.starts_at) FROM exam_questions eq3
             JOIN exams e3 ON e3.id = eq3.exam_id
            WHERE eq3.question_id = q.id
              AND e3.status IN ('published','ongoing','completed','archived')) AS last_used_at,
           (SELECT e4.title FROM exam_questions eq4
             JOIN exams e4 ON e4.id = eq4.exam_id
            WHERE eq4.question_id = q.id
              AND e4.status IN ('published','ongoing','completed','archived')
            ORDER BY e4.starts_at DESC LIMIT 1) AS last_exam_title
    FROM questions q
    WHERE q.subject = ? AND q.chapter IN (${placeholders}) AND q.difficulty = ?
    ORDER BY times_used ASC, RANDOM()
    LIMIT ?
  `;
  const params = [subject, ...chapters, blueprintDifficulty, count];
  const rows = await env.DB.prepare(query).bind(...params).all<Record<string, any>>();

  return json(rows.results.map(r => ({
    ...r,
    previously_used: {
      used: (r.times_used ?? 0) > 0,
      times_used: r.times_used ?? 0,
      last_used_at: r.last_used_at ?? null,
      last_exam_title: r.last_exam_title ?? null,
    },
  })));
}

// ── POST /exams/:id/auto-replace ──────────────────────────────
export async function autoReplace(request: Request, env: Env, _examId: string): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['admin', 'faculty']);
  if (error) return error;

  let body: { subject: string; chapters: string[]; exclude_ids: string[]; difficulty?: string };
  try { body = await request.json(); } catch { return json400('Invalid JSON'); }
  const { chapters, exclude_ids, difficulty } = body;
  if (!body.subject || !Array.isArray(chapters) || chapters.length === 0 || !Array.isArray(exclude_ids)) return json400('Missing required fields');

  // Faculty can only auto-replace within their own subject
  const scope = await subjectScope(ctx, env, body.subject);
  if (scope.error) return scope.error;
  const subject = scope.subject;

  // Mirror the auto-select difficulty filter so replacements match the blueprint.
  const replaceDifficulty = difficulty && ['easy', 'medium', 'hard'].includes(difficulty) ? difficulty : 'medium';

  const chaptersPlc = chapters.map(() => '?').join(',');
  let query = `
    SELECT q.*,
           (SELECT COUNT(*) FROM exam_questions eq2
             JOIN exams e2 ON e2.id = eq2.exam_id
            WHERE eq2.question_id = q.id
              AND e2.status IN ('published','ongoing','completed','archived')) AS times_used,
           (SELECT MAX(e3.starts_at) FROM exam_questions eq3
             JOIN exams e3 ON e3.id = eq3.exam_id
            WHERE eq3.question_id = q.id
              AND e3.status IN ('published','ongoing','completed','archived')) AS last_used_at,
           (SELECT e4.title FROM exam_questions eq4
             JOIN exams e4 ON e4.id = eq4.exam_id
            WHERE eq4.question_id = q.id
              AND e4.status IN ('published','ongoing','completed','archived')
            ORDER BY e4.starts_at DESC LIMIT 1) AS last_exam_title
    FROM questions q
    WHERE q.subject = ? AND q.chapter IN (${chaptersPlc}) AND q.difficulty = ?
  `;
  const params = [subject, ...chapters, replaceDifficulty];

  if (exclude_ids.length > 0) {
    const excludePlc = exclude_ids.map(() => '?').join(',');
    query += ` AND q.id NOT IN (${excludePlc})`;
    params.push(...exclude_ids);
  }

  query += `
    ORDER BY times_used ASC, RANDOM()
    LIMIT 1
  `;

  const rows = await env.DB.prepare(query).bind(...params).all<Record<string, any>>();
  if (rows.results.length === 0) return json404('No replacements found');
  const r = rows.results[0];
  return json({
    ...r,
    previously_used: {
      used: (r.times_used ?? 0) > 0,
      times_used: r.times_used ?? 0,
      last_used_at: r.last_used_at ?? null,
      last_exam_title: r.last_exam_title ?? null,
    },
  });
}

// ── PUT /exams/:id/questions ──────────────────────────────────
export async function addQuestionsToExam(request: Request, env: Env, examId: string): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['admin', 'faculty']);
  if (error) return error;

  let body: { question_ids: Array<{ id: string; marks?: number; negative_marks?: number }> };
  try { body = await request.json(); } catch { return json400('Invalid JSON'); }
  
  const { question_ids } = body;
  if (!Array.isArray(question_ids) || question_ids.length === 0) return json400('No questions provided');

  const exam = await env.DB.prepare('SELECT chapter_quotas FROM exams WHERE id = ?').bind(examId).first<{ chapter_quotas: string | null }>();
  if (!exam) return json404('Exam not found');
  
  const chapterQuotas = exam.chapter_quotas ? JSON.parse(exam.chapter_quotas) : null;

  // Idempotent save. The faculty panel preloads the questions this exam already
  // has, so those come back in the payload; counting them again would look like
  // the quota was exceeded ("Circle: Allowed 5, Attempted total 10").
  const linked = await env.DB.prepare('SELECT question_id FROM exam_questions WHERE exam_id = ?')
    .bind(examId).all<{ question_id: string }>();
  const linkedIds = new Set(linked.results.map(r => r.question_id));

  const seenIds = new Set<string>();
  const newQuestions = question_ids.filter(q => {
    const id = q?.id;
    if (!id || linkedIds.has(id) || seenIds.has(id)) return false;
    seenIds.add(id);
    return true;
  });

  if (newQuestions.length === 0) {
    return json({
      message: 'Nothing to add — those questions are already in this exam',
      added: 0,
      skipped: question_ids.length,
    });
  }

  // Faculty can only add questions from their own subject, and must respect quotas
  if (ctx.user.role === 'faculty') {
    const scope = await subjectScope(ctx, env, '');
    if (scope.error) return scope.error;
    const own = scope.subject;

    const ids = newQuestions.map(q => q?.id).filter(Boolean);
    if (ids.length > 0) {
      const plc = ids.map(() => '?').join(',');
      const rows = await env.DB.prepare(
        `SELECT DISTINCT subject, chapter FROM questions WHERE id IN (${plc})`
      ).bind(...ids).all<{ subject: string, chapter: string }>();
      
      const foreign = rows.results.map(r => r.subject).filter(s => s.toLowerCase() !== own);
      if (foreign.length > 0) {
        return json403(`You can only add questions from your own subject (${own}).`);
      }
      
      if (chapterQuotas && chapterQuotas[own]) {
        const allowedChapters = chapterQuotas[own];
        
        // Count existing questions in the exam for this subject's chapters
        const existingRows = await env.DB.prepare(`
          SELECT q.chapter, COUNT(*) as cnt
          FROM exam_questions eq
          JOIN questions q ON q.id = eq.question_id
          WHERE eq.exam_id = ? AND q.subject = ?
          GROUP BY q.chapter
        `).bind(examId, own).all<{ chapter: string, cnt: number }>();
        
        const currentCounts: Record<string, number> = {};
        for (const r of existingRows.results) {
          currentCounts[r.chapter] = r.cnt;
        }
        
        // Count new questions being added
        const fullNewQuestions = await env.DB.prepare(
          `SELECT chapter FROM questions WHERE id IN (${plc})`
        ).bind(...ids).all<{ chapter: string }>();
        
        for (const r of fullNewQuestions.results) {
          currentCounts[r.chapter] = (currentCounts[r.chapter] || 0) + 1;
        }
        
        // Verify against quotas
        for (const [chapter, total] of Object.entries(currentCounts)) {
          if (!allowedChapters[chapter]) {
            return json403(`Chapter '${chapter}' is not assigned to this exam blueprint.`);
          }
          if (total > allowedChapters[chapter]) {
            return json403(`Exceeded quota for '${chapter}'. Allowed: ${allowedChapters[chapter]}, Attempted total: ${total}`);
          }
        }
      }
    }
  }

  const maxOrderRes = await env.DB.prepare('SELECT MAX(order_index) as max_idx FROM exam_questions WHERE exam_id = ?').bind(examId).first<{ max_idx: number }>();
  let currentOrder = maxOrderRes?.max_idx ?? 0;

  const stmt = env.DB.prepare(
    'INSERT INTO exam_questions (exam_id, question_id, order_index, marks, negative_marks) VALUES (?, ?, ?, ?, ?)'
  );
  await env.DB.batch(
    newQuestions.map(q => {
      currentOrder++;
      return stmt.bind(examId, q?.id, currentOrder, q?.marks ?? 4, q?.negative_marks ?? 1.0);
    })
  );

  return json({
    message: 'Questions added successfully',
    added: newQuestions.length,
    skipped: question_ids.length - newQuestions.length,
  });
}

// ── Route Dispatcher ─────────────────────────────────────────

export async function reportQuestionFeedback(request: Request, env: Env, examId: string, questionId: string): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env);
  if (error) return error;

  let body: { feedback?: string };
  try { body = await request.json(); } catch { return json400('Invalid JSON'); }
  
  if (!body.feedback || !body.feedback.trim()) return json400('Feedback is required');

  const exam = await env.DB.prepare('SELECT title, college_id FROM exams WHERE id = ?').bind(examId).first<{ title: string, college_id: string }>();
  if (!exam) return json404('Exam not found');

  const question = await env.DB.prepare('SELECT subject FROM questions WHERE id = ?').bind(questionId).first<{ subject: string }>();
  if (!question) return json404('Question not found');

  const principals = await env.DB.prepare(`
    SELECT id, role FROM users 
    WHERE role IN ('principal', 'admin') AND is_active = 1 
      AND (college_id = ? OR college_id = 'global')
  `).bind(exam.college_id).all<{ id: string, role: string }>();

  const faculties = await env.DB.prepare(`
    SELECT id, role FROM users 
    WHERE role = 'faculty' AND is_active = 1 
      AND LOWER(subject) = ? 
      AND (college_id = ? OR college_id = 'global')
  `).bind((question.subject || '').toLowerCase(), exam.college_id).all<{ id: string, role: string }>();

  const allRecipients = [...principals.results, ...faculties.results];
  if (allRecipients.length > 0) {
    const uniqueRecipients = Array.from(new Map(allRecipients.map(r => [r.id, r])).values());
    const stmt = env.DB.prepare(`
      INSERT INTO notifications 
      (id, recipient_id, recipient_role, college_id, type, title, message, exam_id, subject, meta, created_by)
      VALUES (?, ?, ?, ?, 'principal_message', ?, ?, ?, ?, ?, ?)
    `);

    const title = `Question Feedback on ${exam.title}`;
    const message = `Student reported an issue:\n\n${body.feedback}`;
    const metaStr = JSON.stringify({ question_id: questionId });

    await env.DB.batch(uniqueRecipients.map(r => 
      stmt.bind(
        crypto.randomUUID(), r.id, r.role, exam.college_id, title, message, examId, question.subject || null, metaStr, ctx.user.sub
      )
    ));
  }

  return json({ message: 'Feedback sent successfully' });
}

export async function examsRouter(
  request: Request,
  env: Env,
  pathname: string
): Promise<Response | null> {
  const method = request.method;

  if (pathname === '/exams') {
    if (method === 'GET')  return listExams(request, env);
    if (method === 'POST') return createExam(request, env);
  }

  const feedbackMatch = pathname.match(/^\/exams\/([^/]+)\/questions\/([^/]+)\/feedback$/);
  if (feedbackMatch && method === 'POST') return reportQuestionFeedback(request, env, feedbackMatch[1], feedbackMatch[2]);

  const submitForReviewMatch = pathname.match(/^\/exams\/([^/]+)\/submit-for-review$/);
  if (submitForReviewMatch && method === 'POST') return submitExamForReview(request, env, submitForReviewMatch[1]);

  const principalReviewMatch = pathname.match(/^\/exams\/([^/]+)\/principal-review$/);
  if (principalReviewMatch && method === 'PUT') return principalReviewExam(request, env, principalReviewMatch[1]);

  const finalReviewMatch = pathname.match(/^\/exams\/([^/]+)\/final-review$/);
  if (finalReviewMatch && method === 'PUT') return finalConfirmExam(request, env, finalReviewMatch[1]);

  const versionMatch = pathname.match(/^\/exams\/([^/]+)\/version$/);
  if (versionMatch && method === 'POST') return versionExam(request, env, versionMatch[1]);

  const autoSelectMatch = pathname.match(/^\/exams\/([^/]+)\/auto-select-preview$/);
  if (autoSelectMatch && method === 'POST') return autoSelectPreview(request, env, autoSelectMatch[1]);

  const autoReplaceMatch = pathname.match(/^\/exams\/([^/]+)\/auto-replace$/);
  if (autoReplaceMatch && method === 'POST') return autoReplace(request, env, autoReplaceMatch[1]);

  const quotaStatusMatch = pathname.match(/^\/exams\/([^/]+)\/quota-status$/);
  if (quotaStatusMatch && method === 'GET') return examQuotaStatus(request, env, quotaStatusMatch[1]);

  const addQuestionsMatch = pathname.match(/^\/exams\/([^/]+)\/questions$/);
  if (addQuestionsMatch && method === 'PUT') return addQuestionsToExam(request, env, addQuestionsMatch[1]);

  const idMatch = pathname.match(/^\/exams\/([^/]+)$/);
  if (idMatch && method === 'GET') return getExam(request, env, idMatch[1]);

  return null;
}

// ── GET /exams/:id/quota-status ──────────────────────────────
// Per-subject completion state for the blueprint, for ALL subjects (not just
// the caller's). Powers the sweet completion/incomplete messages — every
// faculty sees the whole board, matching what the principal will review.
export async function examQuotaStatus(request: Request, env: Env, examId: string): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env);
  if (error) return error;

  const exam = await env.DB.prepare('SELECT * FROM exams WHERE id = ? AND college_id = ?')
    .bind(examId, ctx.user.college_id).first<Record<string, unknown>>();
  if (!exam) return json404('Exam not found');

  const gaps = await computeExamQuotaStatus(env, exam);
  const subjects = gaps.map(g => ({
    subject: g.subject,
    required: g.required,
    selected: g.selected,
    complete: g.selected >= g.required,
  }));
  const complete = subjects.length > 0 && subjects.every(s => s.complete);

  return json({ exam_id: examId, complete, subjects });
}
