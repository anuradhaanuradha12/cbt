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

  let query = 'SELECT * FROM exams';
  const params: any[] = [];
  const filters: string[] = [];

  if (status) {
    filters.push('status = ?');
    params.push(status);
  }

  // If student, filter by their batch or global exams
  if (ctx.user.role === 'student') {
    const user = await env.DB.prepare('SELECT batch_name FROM users WHERE id = ?').bind(ctx.user.sub).first<{ batch_name: string | null }>();
    if (user?.batch_name) {
      filters.push('(target_batch IS NULL OR target_batch = ?)');
      params.push(user.batch_name);
    } else {
      filters.push('target_batch IS NULL');
    }
  }

  if (filters.length > 0) {
    query += ' WHERE ' + filters.join(' AND ');
  }
  query += ' ORDER BY created_at DESC';

  const rows = await env.DB.prepare(query).bind(...params).all();

  return json(rows.results);
}

// ── POST /exams ───────────────────────────────────────────────

export async function createExam(request: Request, env: Env): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['admin', 'faculty']);
  if (error) return error;

  let body: {
    title?: string; description?: string; exam_type?: string;
    duration_minutes?: number; total_marks?: number; target_batch?: string;
    subject_quotas?: any;
    question_ids?: Array<{ id: string; marks?: number; negative_marks?: number }>;
  };
  try { body = await request.json(); } catch { return json400('Invalid JSON'); }

  const { title, exam_type = 'custom', duration_minutes, total_marks, target_batch, subject_quotas, question_ids = [] } = body;
  if (!title || !duration_minutes || !total_marks) {
    return json400('title, duration_minutes, and total_marks are required');
  }

  const examId = generateId();

  // Insert exam
  await env.DB.prepare(`
    INSERT INTO exams (id, title, description, exam_type, duration_minutes, total_marks, target_batch, subject_quotas, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(examId, title, body.description ?? null, exam_type, duration_minutes, total_marks, target_batch || null, subject_quotas ? JSON.stringify(subject_quotas) : null, ctx.user.sub).run();

  // Link questions
  if (Array.isArray(question_ids) && question_ids.length > 0) {
    const stmt = env.DB.prepare(
      'INSERT INTO exam_questions (exam_id, question_id, order_index, marks, negative_marks) VALUES (?, ?, ?, ?, ?)'
    );
    await env.DB.batch(
      question_ids.map((q, i) => stmt.bind(examId, q?.id, i + 1, q?.marks ?? 4, q?.negative_marks ?? 1.0))
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

    payload = {
      exam: { ...(exam as Record<string, unknown>), config } as ExamPayload['exam'],
      questions: safeQuestions,
    };

    // Cache only for published/ongoing exams (not drafts)
    if (exam['status'] === 'published' || exam['status'] === 'ongoing') {
      await env.CBT_KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: KV_EXAM_CACHE_TTL });
    }
  }

  // ── Security Override: Strip questions if before start time ──
  const serverTime = Math.floor(Date.now() / 1000);
  let isEarlyAccess = false;
  if (ctx.user.role === 'student' && payload.exam.starts_at && serverTime < payload.exam.starts_at) {
    payload.questions = [];
    isEarlyAccess = true;
  }

  return json({ ...payload, server_time: serverTime, from_cache: fromCache, is_early_access: isEarlyAccess });
}

// Code replaced above

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

// ── POST /exams/:id/auto-select-preview ──────────────────────
export async function autoSelectPreview(request: Request, env: Env, _examId: string): Promise<Response> {
  const { error } = await requireAuth(request, env, ['admin', 'faculty']);
  if (error) return error;

  let body: { subject: string; chapters: string[]; count: number };
  try { body = await request.json(); } catch { return json400('Invalid JSON'); }
  const { subject, chapters, count } = body;
  if (!subject || !Array.isArray(chapters) || chapters.length === 0 || !count) return json400('Missing required fields');

  const placeholders = chapters.map(() => '?').join(',');
  const query = `
    SELECT q.*, 
           CASE WHEN eq.exam_id IS NOT NULL THEN 1 ELSE 0 END as previously_used
    FROM questions q
    LEFT JOIN exam_questions eq ON q.id = eq.question_id
    WHERE q.subject = ? AND q.chapter IN (${placeholders})
    GROUP BY q.id
    ORDER BY previously_used ASC, RANDOM()
    LIMIT ?
  `;
  const params = [subject, ...chapters, count];
  const rows = await env.DB.prepare(query).bind(...params).all();

  return json(rows.results);
}

// ── POST /exams/:id/auto-replace ──────────────────────────────
export async function autoReplace(request: Request, env: Env, _examId: string): Promise<Response> {
  const { error } = await requireAuth(request, env, ['admin', 'faculty']);
  if (error) return error;

  let body: { subject: string; chapters: string[]; exclude_ids: string[] };
  try { body = await request.json(); } catch { return json400('Invalid JSON'); }
  const { subject, chapters, exclude_ids } = body;
  if (!subject || !Array.isArray(chapters) || chapters.length === 0 || !Array.isArray(exclude_ids)) return json400('Missing required fields');

  const chaptersPlc = chapters.map(() => '?').join(',');
  let query = `
    SELECT q.*, 
           CASE WHEN eq.exam_id IS NOT NULL THEN 1 ELSE 0 END as previously_used
    FROM questions q
    LEFT JOIN exam_questions eq ON q.id = eq.question_id
    WHERE q.subject = ? AND q.chapter IN (${chaptersPlc})
  `;
  const params = [subject, ...chapters];

  if (exclude_ids.length > 0) {
    const excludePlc = exclude_ids.map(() => '?').join(',');
    query += ` AND q.id NOT IN (${excludePlc})`;
    params.push(...exclude_ids);
  }

  query += `
    GROUP BY q.id
    ORDER BY previously_used ASC, RANDOM()
    LIMIT 1
  `;

  const rows = await env.DB.prepare(query).bind(...params).all();
  if (rows.results.length === 0) return json404('No replacements found');
  return json(rows.results[0]);
}

// ── PUT /exams/:id/questions ──────────────────────────────────
export async function addQuestionsToExam(request: Request, env: Env, examId: string): Promise<Response> {
  const { error } = await requireAuth(request, env, ['admin', 'faculty']);
  if (error) return error;

  let body: { question_ids: Array<{ id: string; marks?: number; negative_marks?: number }> };
  try { body = await request.json(); } catch { return json400('Invalid JSON'); }
  
  const { question_ids } = body;
  if (!Array.isArray(question_ids) || question_ids.length === 0) return json400('No questions provided');

  const maxOrderRes = await env.DB.prepare('SELECT MAX(order_index) as max_idx FROM exam_questions WHERE exam_id = ?').bind(examId).first<{ max_idx: number }>();
  let currentOrder = maxOrderRes?.max_idx ?? 0;

  const stmt = env.DB.prepare(
    'INSERT INTO exam_questions (exam_id, question_id, order_index, marks, negative_marks) VALUES (?, ?, ?, ?, ?)'
  );
  await env.DB.batch(
    question_ids.map(q => {
      currentOrder++;
      return stmt.bind(examId, q?.id, currentOrder, q?.marks ?? 4, q?.negative_marks ?? 1.0);
    })
  );

  return json({ message: 'Questions added successfully' });
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

  const autoSelectMatch = pathname.match(/^\/exams\/([^/]+)\/auto-select-preview$/);
  if (autoSelectMatch && method === 'POST') return autoSelectPreview(request, env, autoSelectMatch[1]);

  const autoReplaceMatch = pathname.match(/^\/exams\/([^/]+)\/auto-replace$/);
  if (autoReplaceMatch && method === 'POST') return autoReplace(request, env, autoReplaceMatch[1]);

  const addQuestionsMatch = pathname.match(/^\/exams\/([^/]+)\/questions$/);
  if (addQuestionsMatch && method === 'PUT') return addQuestionsToExam(request, env, addQuestionsMatch[1]);

  const idMatch = pathname.match(/^\/exams\/([^/]+)$/);
  if (idMatch && method === 'GET') return getExam(request, env, idMatch[1]);

  return null;
}
