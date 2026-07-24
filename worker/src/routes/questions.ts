// ─── Question Routes ──────────────────────────────────────────────────────────
// GET  /questions          — list with filters (faculty/admin)
// POST /questions          — create single question (faculty/admin)
// POST /questions/bulk     — bulk import from JSON array (admin)
// GET  /questions/:id      — get single question with answer (faculty/admin)
// PUT  /questions/:id      — update question (faculty/admin)

import { json, json400, json404 } from '../middleware/responses';
import { requireAuth } from '../middleware/auth';
import type { Env } from '../types';

function generateId(): string {
  return crypto.randomUUID();
}

// ── GET /questions ────────────────────────────────────────────

export async function listQuestions(request: Request, env: Env): Promise<Response> {
  const { error } = await requireAuth(request, env, ['admin', 'faculty']);
  if (error) return error;

  const url = new URL(request.url);
  const subject    = url.searchParams.get('subject')    ?? '';
  const chapter    = url.searchParams.get('chapter')    ?? '';
  const difficulty = url.searchParams.get('difficulty') ?? '';
  const type       = url.searchParams.get('type')       ?? '';
  const page       = Math.max(1, parseInt(url.searchParams.get('page') ?? '1'));
  const limit      = Math.min(100, parseInt(url.searchParams.get('limit') ?? '50'));
  const offset     = (page - 1) * limit;

  // Build dynamic WHERE clause
  const conditions: string[] = [];
  const bindings: string[] = [];
  if (subject)    { conditions.push('subject = ?');    bindings.push(subject); }
  if (chapter)    { conditions.push('chapter = ?');    bindings.push(chapter); }
  if (difficulty) { conditions.push('difficulty = ?'); bindings.push(difficulty); }
  if (type)       { conditions.push('type = ?');       bindings.push(type); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const [rows, countRow] = await Promise.all([
    env.DB.prepare(`SELECT * FROM questions ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .bind(...bindings, limit, offset).all(),
    env.DB.prepare(`SELECT COUNT(*) as total FROM questions ${where}`)
      .bind(...bindings).first<{ total: number }>(),
  ]);

  return json({
    data: rows.results,
    total: countRow?.total ?? 0,
    page,
    limit,
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

  const id = generateId();
  await env.DB.prepare(`
    INSERT INTO questions
      (id, subject, chapter, difficulty, type, question_text,
       option_a, option_b, option_c, option_d, correct_answer,
       explanation, image_r2_key, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, subject, chapter, difficulty, type, question_text,
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
  const { error } = await requireAuth(request, env, ['admin', 'faculty']);
  if (error) return error;

  const q = await env.DB.prepare('SELECT * FROM questions WHERE id = ?').bind(id).first();
  if (!q) return json404('Question not found');
  return json(q);
}

// ── PUT /questions/:id ────────────────────────────────────────

export async function updateQuestion(request: Request, env: Env, id: string): Promise<Response> {
  const { error } = await requireAuth(request, env, ['admin', 'faculty']);
  if (error) return error;

  const existing = await env.DB.prepare('SELECT id FROM questions WHERE id = ?').bind(id).first();
  if (!existing) return json404('Question not found');

  let body: Record<string, string>;
  try { body = await request.json(); } catch { return json400('Invalid JSON'); }

  const allowed = ['subject','chapter','difficulty','type','question_text',
                   'option_a','option_b','option_c','option_d','correct_answer','explanation'];
  const fields = Object.keys(body).filter(k => allowed.includes(k));
  if (fields.length === 0) return json400('No valid fields to update');

  const setClause = fields.map(f => `${f} = ?`).join(', ');
  const values = fields.map(f => body[f]);

  await env.DB.prepare(`UPDATE questions SET ${setClause} WHERE id = ?`)
    .bind(...values, id).run();

  return json({ message: 'Question updated' });
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
