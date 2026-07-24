// ─── Exam Routes ──────────────────────────────────────────────────────────────
// GET  /exams              — list exams
// POST /exams              — create exam with question IDs
// GET  /exams/:id          — fetch exam payload (KV-cached, answers stripped)
// PUT  /exams/:id/publish  — freeze config + set starts_at/ends_at (admin only)
// POST /exams/:id/version  — create a new version of a published exam (faculty/admin)

import { json, json400, json403, json404 } from '../middleware/responses';
import { requireAuth } from '../middleware/auth';
import { KV_EXAM_CACHE_TTL } from '../config';
import type { Env } from '../types';
import type { ExamConfig, ExamPayload, QuestionSafe } from '../../../shared/types';

function generateId(): string {
  return crypto.randomUUID();
}

/** Strip correct_answer and explanation — NEVER sent to students */
function toSafeQuestion(q: Record<string, unknown>): QuestionSafe {
  const { correct_answer, explanation, ...safe } = q;
  void correct_answer; void explanation; // explicitly consumed
  return safe as QuestionSafe;
}

// ── GET /exams ────────────────────────────────────────────────

export async function listExams(request: Request, env: Env): Promise<Response> {
  const { error } = await requireAuth(request, env);
  if (error) return error;

  const url = new URL(request.url);
  const status = url.searchParams.get('status') ?? '';

  const rows = status
    ? await env.DB.prepare('SELECT * FROM exams WHERE status = ? ORDER BY created_at DESC').bind(status).all()
    : await env.DB.prepare('SELECT * FROM exams ORDER BY created_at DESC').all();

  return json(rows.results);
}

// ── POST /exams ───────────────────────────────────────────────

export async function createExam(request: Request, env: Env): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['admin', 'faculty']);
  if (error) return error;

  let body: {
    title?: string; description?: string; exam_type?: string;
    duration_minutes?: number; total_marks?: number;
    question_ids?: Array<{ id: string; marks?: number; negative_marks?: number }>;
  };
  try { body = await request.json(); } catch { return json400('Invalid JSON'); }

  const { title, exam_type = 'custom', duration_minutes, total_marks, question_ids = [] } = body;
  if (!title || !duration_minutes || !total_marks) {
    return json400('title, duration_minutes, and total_marks are required');
  }

  const examId = generateId();

  // Insert exam
  await env.DB.prepare(`
    INSERT INTO exams (id, title, description, exam_type, duration_minutes, total_marks, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(examId, title, body.description ?? null, exam_type, duration_minutes, total_marks, ctx.user.sub).run();

  // Link questions
  if (question_ids.length > 0) {
    const stmt = env.DB.prepare(
      'INSERT INTO exam_questions (exam_id, question_id, order_index, marks, negative_marks) VALUES (?, ?, ?, ?, ?)'
    );
    await env.DB.batch(
      question_ids.map((q, i) => stmt.bind(examId, q.id, i + 1, q.marks ?? 4, q.negative_marks ?? 1.0))
    );
  }

  return json({ id: examId, message: 'Exam created' }, 201);
}

// ── GET /exams/:id ────────────────────────────────────────────
// Served from KV cache. First request builds + caches the payload.
// Answers are stripped — students get only safe question data.

export async function getExam(request: Request, env: Env, examId: string): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env);
  if (error) return error;

  const cacheKey = `exam:${examId}`;

  // ── Cache hit ──────────────────────────────────────────────
  const cached = await env.CBT_KV.get<ExamPayload>(cacheKey, 'json');
  if (cached) {
    return json({ ...cached, server_time: Math.floor(Date.now() / 1000), from_cache: true });
  }

  // ── Cache miss — query D1 ──────────────────────────────────
  const exam = await env.DB.prepare('SELECT * FROM exams WHERE id = ?').bind(examId).first<Record<string, unknown>>();
  if (!exam) return json404('Exam not found');

  // Only published/ongoing exams are visible to students
  const isStaff = ctx.user.role === 'admin' || ctx.user.role === 'faculty';
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

  const payload: Omit<ExamPayload, 'server_time'> = {
    exam: { ...(exam as Record<string, unknown>), config } as ExamPayload['exam'],
    questions: safeQuestions,
  };

  // Cache only for published/ongoing exams (not drafts)
  if (exam['status'] === 'published' || exam['status'] === 'ongoing') {
    await env.CBT_KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: KV_EXAM_CACHE_TTL });
  }

  return json({ ...payload, server_time: Math.floor(Date.now() / 1000), from_cache: false });
}

// ── PUT /exams/:id/publish ────────────────────────────────────
// Freezes config_snapshot, sets starts_at/ends_at, sets status = 'published'.
// After this point, scoring always reads from config_snapshot — immutable.

export async function publishExam(request: Request, env: Env, examId: string): Promise<Response> {
  const { error } = await requireAuth(request, env, ['admin']);
  if (error) return error;

  const exam = await env.DB.prepare('SELECT * FROM exams WHERE id = ?').bind(examId).first<Record<string, unknown>>();
  if (!exam) return json404('Exam not found');
  if (exam['status'] !== 'draft') return json400(`Exam is already ${exam['status']}`);

  let body: { starts_at?: number; config?: Partial<ExamConfig> };
  try { body = await request.json(); } catch { return json400('Invalid JSON'); }

  const startsAt = body.starts_at ?? Math.floor(Date.now() / 1000) + 300; // default: 5 min from now
  const endsAt = startsAt + (exam['duration_minutes'] as number) * 60;

  const config: ExamConfig = {
    negative_marking: body.config?.negative_marking ?? true,
    marks_correct: body.config?.marks_correct ?? 4,
    marks_wrong: body.config?.marks_wrong ?? 1,
    duration_minutes: exam['duration_minutes'] as number,
    subjects: body.config?.subjects ?? [],
    section_wise: body.config?.section_wise ?? false,
  };

  await env.DB.prepare(`
    UPDATE exams
    SET status = 'published', config_snapshot = ?, starts_at = ?, ends_at = ?
    WHERE id = ?
  `).bind(JSON.stringify(config), startsAt, endsAt, examId).run();

  // Invalidate any stale cache entry
  await env.CBT_KV.delete(`exam:${examId}`);

  return json({ message: 'Exam published', starts_at: startsAt, ends_at: endsAt });
}

// ── POST /exams/:id/version ───────────────────────────────────
// Creates a new draft version of an existing exam (copy questions, bump version).

export async function versionExam(request: Request, env: Env, examId: string): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['admin', 'faculty']);
  if (error) return error;

  const exam = await env.DB.prepare('SELECT * FROM exams WHERE id = ?').bind(examId).first<Record<string, unknown>>();
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
                       duration_minutes, total_marks, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    newId, parentId, newVersion,
    `${exam['title']} v${newVersion}`,
    exam['description'] ?? null,
    exam['exam_type'], exam['duration_minutes'], exam['total_marks'],
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

// ── Route Dispatcher ─────────────────────────────────────────

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

  const publishMatch = pathname.match(/^\/exams\/([^/]+)\/publish$/);
  if (publishMatch && method === 'PUT') return publishExam(request, env, publishMatch[1]);

  const versionMatch = pathname.match(/^\/exams\/([^/]+)\/version$/);
  if (versionMatch && method === 'POST') return versionExam(request, env, versionMatch[1]);

  const idMatch = pathname.match(/^\/exams\/([^/]+)$/);
  if (idMatch && method === 'GET') return getExam(request, env, idMatch[1]);

  return null;
}
