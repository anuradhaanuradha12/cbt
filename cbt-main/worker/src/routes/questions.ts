// ─── Question Routes ──────────────────────────────────────────────────────────
// GET  /questions          — list with filters (faculty/admin)
// POST /questions          — create single question (faculty/admin)
// POST /questions/bulk     — bulk import from JSON array (admin)
// GET  /questions/chapters — distinct chapters for a subject (faculty/admin)
// GET  /questions/:id      — get single question with answer (faculty/admin)
// PUT  /questions/:id      — update question (faculty/admin)
//
// Subject scoping: faculty accounts carry a `subject` (JWT + users table).
// Faculty are HARD-LOCKED to their subject — every list/create/update/chapter
// request is forced onto their subject regardless of what the client asks for,
// and they get 403 on any other subject. Admins are unrestricted.
// Principals have no question-bank access at all.
//
// Usage metadata: every question row includes
//   previously_used { used, times_used, last_used_at, last_exam_title }
//   — "already selected" signal for faculty picking questions for an exam.

import { json, json400, json403, json404 } from '../middleware/responses';
import { requireAuth } from '../middleware/auth';
import { subjectScope } from '../utils/subject';
import type { Env } from '../types';

function generateId(): string {
  return crypto.randomUUID();
}

// ── Usage enrichment ──────────────────────────────────────────
// For the given question ids, find where each was already used in exams
// (published or later — drafts don't count as "repeated with date").
// Returns a Map<question_id, {times_used, last_used_at, last_exam_title}>.

async function usageByQuestionId(
  env: Env,
  questionIds: string[]
): Promise<Map<string, { times_used: number; last_used_at: number | null; last_exam_title: string | null }>> {
  const map = new Map<string, { times_used: number; last_used_at: number | null; last_exam_title: string | null }>();
  if (questionIds.length === 0) return map;

  const placeholders = questionIds.map(() => '?').join(',');
  const rows = await env.DB.prepare(`
    SELECT eq.question_id,
           COUNT(*)                AS times_used,
           MAX(e.starts_at)        AS last_used_at
    FROM exam_questions eq
    JOIN exams e ON e.id = eq.exam_id
    WHERE eq.question_id IN (${placeholders})
      AND e.status IN ('published','ongoing','completed','archived')
    GROUP BY eq.question_id
  `).bind(...questionIds).all<{ question_id: string; times_used: number; last_used_at: number | null }>();

  const idsWithHistory = rows.results.map(r => r.question_id);

  // Latest exam title per question (separate query — SQLite lacks DISTINCT ON)
  const titleMap = new Map<string, string>();
  if (idsWithHistory.length > 0) {
    const plc = idsWithHistory.map(() => '?').join(',');
    const titleRows = await env.DB.prepare(`
      SELECT eq.question_id, e.title, e.starts_at
      FROM exam_questions eq
      JOIN exams e ON e.id = eq.exam_id
      WHERE eq.question_id IN (${plc})
        AND e.status IN ('published','ongoing','completed','archived')
      ORDER BY e.starts_at DESC
    `).bind(...idsWithHistory).all<{ question_id: string; title: string; starts_at: number | null }>();

    for (const r of titleRows.results) {
      if (!titleMap.has(r.question_id)) titleMap.set(r.question_id, r.title);
    }
  }

  for (const r of rows.results) {
    map.set(r.question_id, {
      times_used: r.times_used,
      last_used_at: r.last_used_at,
      last_exam_title: titleMap.get(r.question_id) ?? null,
    });
  }
  return map;
}

function withUsage(q: Record<string, unknown>, usage: Map<string, { times_used: number; last_used_at: number | null; last_exam_title: string | null }>): Record<string, unknown> {
  const u = usage.get(q.id as string);
  q.previously_used = {
    used: (u?.times_used ?? 0) > 0,
    times_used: u?.times_used ?? 0,
    last_used_at: u?.last_used_at ?? null,
    last_exam_title: u?.last_exam_title ?? null,
  };
  return q;
}

// Latex sanity fixer for scraped data
function fixLatex(str: string | null): string | null {
  if (!str) return str;
  return str
    .replace(/\r(ight|ho|ightarrow|angle|m|ef|eq|rangle)/g, '\\r$1')
    .replace(/\n(eq|u|abla|ewline|rightarrow|ormalsize|otin|i)/g, '\\n$1');
}

function sanitizeQuestion(q: any) {
  if (q.question_text) q.question_text = fixLatex(q.question_text);
  if (q.explanation) q.explanation = fixLatex(q.explanation);
  if (q.option_a) q.option_a = fixLatex(q.option_a);
  if (q.option_b) q.option_b = fixLatex(q.option_b);
  if (q.option_c) q.option_c = fixLatex(q.option_c);
  if (q.option_d) q.option_d = fixLatex(q.option_d);
  return q;
}

// ── GET /questions ────────────────────────────────────────────

export async function listQuestions(request: Request, env: Env): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['admin', 'faculty']);
  if (error) return error;

  const url = new URL(request.url);
  const requestedSubject = url.searchParams.get('subject') ?? '';
  const chapter    = url.searchParams.get('chapter')    ?? '';
  const difficulty = url.searchParams.get('difficulty') ?? '';
  const type       = url.searchParams.get('type')       ?? '';
  const page       = Math.max(1, parseInt(url.searchParams.get('page') ?? '1'));
  const limit      = Math.min(100, parseInt(url.searchParams.get('limit') ?? '50'));
  const offset     = (page - 1) * limit;

  // Faculty are hard-locked to their subject; admins can filter freely
  const scope = await subjectScope(ctx, env, requestedSubject);
  if (scope.error) return scope.error;

  // Build dynamic WHERE clause
  const conditions: string[] = [];
  const bindings: string[] = [];
  if (scope.subject) { conditions.push('subject = ?'); bindings.push(scope.subject); }
  if (chapter) {
    // A chapter name can legitimately contain a comma (e.g. a legacy blueprint
    // entry "Alcohols, Phenols and Ethers"). Splitting that unconditionally
    // turns it into two chapters that don't exist and silently returns nothing,
    // so prefer a whole-string match before treating the value as a list.
    let chapters = [chapter];
    if (chapter.includes(',')) {
      const exact = await env.DB.prepare('SELECT 1 AS hit FROM questions WHERE chapter = ? LIMIT 1')
        .bind(chapter).first<{ hit: number }>();
      if (!exact) {
        chapters = chapter.split(',').map(c => c.trim()).filter(c => c);
      }
    }
    if (chapters.length === 1) {
      conditions.push('chapter = ?');
      bindings.push(chapters[0]);
    } else if (chapters.length > 1) {
      const placeholders = chapters.map(() => '?').join(',');
      conditions.push(`chapter IN (${placeholders})`);
      bindings.push(...chapters);
    }
  }
  if (difficulty) { conditions.push('difficulty = ?'); bindings.push(difficulty); }
  if (type)       { conditions.push('type = ?');       bindings.push(type); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const [rows, countRow] = await Promise.all([
    // created_at is only second-resolution, so thousands of rows share a value.
    // Ordering by it alone made pagination non-deterministic (rows could repeat
    // or be skipped between pages), and made a question's page uncomputable.
    // id DESC is the stable tiebreak — /questions/locate relies on it.
    env.DB.prepare(`SELECT * FROM questions ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .bind(...bindings, limit, offset).all<Record<string, unknown>>(),
    env.DB.prepare(`SELECT COUNT(*) as total FROM questions ${where}`)
      .bind(...bindings).first<{ total: number }>(),
  ]);

  const usage = await usageByQuestionId(env, rows.results.map(r => r.id as string));

  return json({
    data: rows.results.map(r => sanitizeQuestion(withUsage(r, usage))),
    total: countRow?.total ?? 0,
    page,
    limit,
  });
}

// ── GET /questions/chapters ───────────────────────────────────

export async function listChapters(request: Request, env: Env): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['admin', 'faculty', 'principal']);
  if (error) return error;

  const url = new URL(request.url);
  const requestedSubject = url.searchParams.get('subject') ?? '';

  const scope = await subjectScope(ctx, env, requestedSubject);
  if (scope.error) return scope.error;

  if (!scope.subject) {
    return json({ chapters: [] });
  }

  const res = await env.DB.prepare('SELECT DISTINCT chapter FROM questions WHERE subject = ? ORDER BY chapter ASC')
    .bind(scope.subject).all<{ chapter: string }>();

  return json({
    chapters: res.results.map(r => r.chapter)
  });
}

// ── POST /questions ───────────────────────────────────────────

export async function createQuestion(request: Request, env: Env): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['admin', 'faculty']);
  if (error) return error;

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return json400('Invalid JSON'); }

  const { subject, chapter, difficulty, type, question_text, correct_answer,
          option_a, option_b, option_c, option_d, explanation, image_r2_key } = body as Record<string, string>;

  if (!subject || !chapter || !difficulty || !type || !question_text || !correct_answer) {
    return json400('subject, chapter, difficulty, type, question_text, and correct_answer are required');
  }

  // Faculty can only author questions in their own subject
  const scope = await subjectScope(ctx, env, subject as string);
  if (scope.error) return scope.error;

  const id = generateId();
  await env.DB.prepare(`
    INSERT INTO questions
      (id, subject, chapter, difficulty, type, question_text,
       option_a, option_b, option_c, option_d, correct_answer,
       explanation, image_r2_key, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, scope.subject || subject, chapter, difficulty, type, question_text,
    option_a ?? null, option_b ?? null, option_c ?? null, option_d ?? null,
    correct_answer, explanation ?? null, image_r2_key ?? null, ctx.user.sub
  ).run();

  return json({ id, message: 'Question created' }, 201);
}

// ── POST /questions/bulk ──────────────────────────────────────

export async function bulkImportQuestions(request: Request, env: Env): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['admin']);
  if (error) return error;

  let questions: Record<string, string>[];
  try { questions = await request.json(); } catch { return json400('Invalid JSON'); }

  if (!Array.isArray(questions) || questions.length === 0) {
    return json400('Body must be a non-empty array of questions');
  }
  if (questions.length > 500) {
    return json400('Maximum 500 questions per bulk import');
  }

  const stmt = env.DB.prepare(`
    INSERT INTO questions
      (id, subject, chapter, difficulty, type, question_text,
       option_a, option_b, option_c, option_d, correct_answer,
       explanation, image_r2_key, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const inserts = questions.map(q =>
    stmt.bind(
      generateId(), q.subject, q.chapter, q.difficulty, q.type, q.question_text,
      q.option_a ?? null, q.option_b ?? null, q.option_c ?? null, q.option_d ?? null,
      q.correct_answer, q.explanation ?? null, q.image_r2_key ?? null, ctx.user.sub
    )
  );

  await env.DB.batch(inserts);

  return json({ inserted: questions.length, message: 'Bulk import complete' }, 201);
}

// ── GET /questions/:id ────────────────────────────────────────

export async function getQuestion(request: Request, env: Env, id: string): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['admin', 'faculty']);
  if (error) return error;

  const q = await env.DB.prepare('SELECT * FROM questions WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!q) return json404('Question not found');

  // Faculty can only open questions in their own subject
  const scope = await subjectScope(ctx, env, (q.subject as string) ?? '');
  if (scope.error) return scope.error;

  const usage = await usageByQuestionId(env, [id]);
  return json(sanitizeQuestion(withUsage(q, usage)));
}

// ── PUT /questions/:id ────────────────────────────────────────

export async function updateQuestion(request: Request, env: Env, id: string): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['admin', 'faculty']);
  if (error) return error;

  const existing = await env.DB.prepare('SELECT id, subject FROM questions WHERE id = ?')
    .bind(id).first<{ id: string; subject: string }>();
  if (!existing) return json404('Question not found');

  // Faculty can only edit questions in their own subject, and cannot move
  // a question into another subject.
  const scope = await subjectScope(ctx, env, existing.subject);
  if (scope.error) return scope.error;

  let body: Record<string, string>;
  try { body = await request.json(); } catch { return json400('Invalid JSON'); }

  const allowed = ['subject','chapter','difficulty','type','question_text',
                   'option_a','option_b','option_c','option_d','correct_answer','explanation'];

  const fields = Object.keys(body).filter(k => allowed.includes(k));
  if (fields.length === 0) return json400('No valid fields to update');

  if (ctx.user.role === 'faculty' && fields.includes('subject')) {
    const newSubject = (body.subject ?? '').toLowerCase().trim();
    if (newSubject && newSubject !== scope.subject) {
      return json403(`You can only work within your own subject (${scope.subject}).`);
    }
  }

  const setClause = fields.map(f => `${f} = ?`).join(', ');
  const values = fields.map(f => body[f]);

  await env.DB.prepare(`UPDATE questions SET ${setClause} WHERE id = ?`)
    .bind(...values, id).run();

  return json({ message: 'Question updated' });
}

// ── GET /questions/locate ─────────────────────────────────────
// Returns which page of the chapter-filtered list holds a given question, so
// the UI can jump straight to it. Uses the exact same ORDER BY as
// listQuestions (created_at DESC, id DESC) — keep the two in sync.
export async function locateQuestion(request: Request, env: Env): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['admin', 'faculty', 'principal']);
  if (error) return error;

  const url = new URL(request.url);
  const id = url.searchParams.get('id') ?? '';
  const perPage = Math.max(1, Math.min(100, parseInt(url.searchParams.get('per_page') ?? '20')));
  if (!id) return json400('id is required');

  const row = await env.DB.prepare(
    'SELECT subject, chapter, created_at FROM questions WHERE id = ?'
  ).bind(id).first<{ subject: string; chapter: string; created_at: number }>();
  if (!row) return json404('Question not found');

  // Faculty may only be pointed at their own subject.
  const scope = await subjectScope(ctx, env, row.subject);
  if (scope.error) return scope.error;

  // How many rows sort before this one under (created_at DESC, id DESC).
  const before = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM questions
      WHERE subject = ? AND chapter = ?
        AND (created_at > ? OR (created_at = ? AND id > ?))`
  ).bind(row.subject, row.chapter, row.created_at, row.created_at, id)
    .first<{ n: number }>();

  const index = before?.n ?? 0;
  return json({
    id,
    subject: row.subject,
    chapter: row.chapter,
    index,
    page: Math.floor(index / perPage) + 1,
  });
}

// ── Route Dispatcher ─────────────────────────────────────────

export async function questionsRouter(
  request: Request,
  env: Env,
  pathname: string
): Promise<Response | null> {
  const method = request.method;

  if (pathname === '/questions') {
    if (method === 'GET')  return listQuestions(request, env);
    if (method === 'POST') return createQuestion(request, env);
  }
  if (pathname === '/questions/chapters' && method === 'GET') {
    return listChapters(request, env);
  }
  if (pathname === '/questions/locate' && method === 'GET') {
    return locateQuestion(request, env);
  }
  if (pathname === '/questions/bulk' && method === 'POST') {
    return bulkImportQuestions(request, env);
  }

  // /questions/:id
  const match = pathname.match(/^\/questions\/([^/]+)$/);
  if (match) {
    const id = match[1];
    if (method === 'GET') return getQuestion(request, env, id);
    if (method === 'PUT') return updateQuestion(request, env, id);
  }

  return null;
}
