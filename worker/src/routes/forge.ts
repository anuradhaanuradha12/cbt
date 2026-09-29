// ─── Question Forge Routes ────────────────────────────────────────────────────
// All routes operate on the QFORGE_DB (cbt-qforge), never on the scraped DB.
//
// POST /forge/generate           — Call Gemini, return draft JSON (NOT saved)
// POST /forge/submit             — Save draft to pipeline (pending_ai_review)
// GET  /forge/drafts             — List drafts (admin: all, intern: own only)
// GET  /forge/drafts/:id         — Get single draft with AI feedback
// POST /forge/:id/ai-review      — Trigger Gemini quality gate on a draft
// PATCH /forge/:id               — Edit a draft (before approval)
// POST /forge/:id/approve        — Admin only: move to approved_questions
// POST /forge/:id/reject         — Admin only: mark rejected
// GET  /forge/approved           — Browse approved proprietary questions
// POST /forge/upload-image       — Upload image to R2, return r2_key
//
// Auth matrix:
//   content-creator: generate, submit, drafts (own), get, ai-review, patch (own), upload-image
//   admin:           all of the above + approve, reject, all drafts

import { json, json400, json404 } from '../middleware/responses';
import { requireAuth } from '../middleware/auth';
import type { Env } from '../types';

function generateId(): string {
  return crypto.randomUUID();
}

// ── Constants & Whitelists ──────────────────────────────────────────

const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_URL   = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const VALID_DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
const VALID_STANDARDS    = ['KCET', 'JEE_MAIN', 'JEE_ADVANCED', 'NEET', 'general'] as const;
const VALID_TYPES        = ['mcq', 'msq', 'integer'] as const;
const VALID_ANSWERS      = new Set(['A', 'B', 'C', 'D']);

type ValidDifficulty = typeof VALID_DIFFICULTIES[number];
type ValidStandard   = typeof VALID_STANDARDS[number];

function isValidGeneratedDraft(q: any): boolean {
  if (!q || typeof q !== 'object') return false;
  const hasText = typeof q.question_text === 'string' && q.question_text.trim().length > 10;
  const hasOptA = typeof q.option_a === 'string' && q.option_a.trim().length > 0;
  const hasOptB = typeof q.option_b === 'string' && q.option_b.trim().length > 0;
  const hasOptC = typeof q.option_c === 'string' && q.option_c.trim().length > 0;
  const hasOptD = typeof q.option_d === 'string' && q.option_d.trim().length > 0;
  const hasAns  = typeof q.correct_answer === 'string' && VALID_ANSWERS.has(q.correct_answer.toUpperCase().trim());
  return hasText && hasOptA && hasOptB && hasOptC && hasOptD && hasAns;
}

// ── Gemini Helper ─────────────────────────────────────────────

async function callGemini(apiKey: string, prompt: string): Promise<string> {
  if (!apiKey) throw new Error('GEMINI_API_KEY binding is missing or empty');
  
  const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        topP: 0.95,
        maxOutputTokens: 4096,
        responseMimeType: 'application/json',
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${err}`);
  }

  const data: any = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty response from Gemini');
  return text;
}

// ── POST /forge/generate ──────────────────────────────────────
// Calls Gemini and returns strictly validated draft questions. Does NOT save to DB.

export async function generateQuestions(request: Request, env: Env): Promise<Response> {
  const { error } = await requireAuth(request, env, ['admin', 'content-creator']);
  if (error) return error;

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return json400('Invalid JSON'); }

  const { subject, chapter, topic, exam_standard, difficulty, count = 3 } = body as Record<string, string>;

  if (!subject || !chapter || !exam_standard || !difficulty) {
    return json400('subject, chapter, exam_standard, and difficulty are required');
  }

  if (!VALID_DIFFICULTIES.includes(difficulty as ValidDifficulty)) {
    return json400(`difficulty must be one of: ${VALID_DIFFICULTIES.join(', ')}`);
  }

  if (!VALID_STANDARDS.includes(exam_standard as ValidStandard)) {
    return json400(`exam_standard must be one of: ${VALID_STANDARDS.join(', ')}`);
  }

  const numCount = Math.min(5, Math.max(1, parseInt(String(count)) || 3));

  const difficultyGuide: Record<string, string> = {
    easy:   'KCET-level (state board, direct concept recall, single-step)',
    medium: 'JEE Main / NEET-level (application-based, moderate reasoning, 2–3 steps)',
    hard:   'JEE Advanced-level (multi-concept, deep reasoning, multi-correct possible, 4+ steps)',
  };

  const prompt = `You are an expert question setter for Indian competitive entrance exams (JEE Advanced, JEE Main, NEET, KCET).

Generate ${numCount} original MCQ question(s) for:
  Subject: ${subject}
  Chapter: ${chapter}
  Topic: ${topic || chapter}
  Target Exam Standard: ${exam_standard}
  Difficulty: ${difficulty} — ${difficultyGuide[difficulty] || difficulty}

STRICT RULES:
1. Return ONLY a valid JSON array. No markdown fences, no commentary, no preamble.
2. Each object MUST have exactly these keys:
   { "question_text": "...", "option_a": "...", "option_b": "...", "option_c": "...", "option_d": "...", "correct_answer": "A" or "B" or "C" or "D", "explanation": "..." }
3. Use LaTeX for ALL math expressions. Inline: $...$. Display: $$...$$. Examples: $v = u + at$, $\\\\frac{dv}{dt}$, $\\\\int_0^t F\\\\,dt$.
4. The explanation MUST show complete step-by-step working with intermediate results.
5. All 4 distractors (wrong options) must be plausible — derived from common mistakes, not obviously wrong.
6. Calibrate difficulty precisely to the ${exam_standard} standard.
7. Each question must be self-contained; do not reference external figures unless you describe them in text.
8. No repeated questions. Each question must test a distinct concept within the topic.

Return ONLY the JSON array.`;

  try {
    const rawText = await callGemini(env.GEMINI_API_KEY, prompt);
    const parsed = JSON.parse(rawText);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('Gemini returned an empty or invalid array');
    }

    const validDrafts = parsed.filter(isValidGeneratedDraft);
    if (validDrafts.length === 0) {
      throw new Error('All generated questions failed structural validation (missing fields or invalid options)');
    }

    const drafts = validDrafts.slice(0, numCount).map((q: any) => ({
      question_text:   String(q.question_text).trim(),
      option_a:        String(q.option_a).trim(),
      option_b:        String(q.option_b).trim(),
      option_c:        String(q.option_c).trim(),
      option_d:        String(q.option_d).trim(),
      correct_answer:  String(q.correct_answer).toUpperCase().trim(),
      explanation:     String(q.explanation || '').trim(),
      subject,
      chapter,
      topic: topic || chapter,
      difficulty,
      exam_standard,
      generation_model: GEMINI_MODEL,
    }));

    return json({ drafts, count: drafts.length, model: GEMINI_MODEL });
  } catch (e: any) {
    return json({ error: `AI generation failed: ${e.message}` }, 502);
  }
}

// ── POST /forge/submit ────────────────────────────────────────
// Saves a reviewed draft to the pipeline DB as pending_ai_review.

export async function submitDraft(request: Request, env: Env): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['admin', 'content-creator']);
  if (error) return error;

  let body: Record<string, string>;
  try { body = await request.json(); } catch { return json400('Invalid JSON'); }

  const {
    subject, chapter, topic, difficulty, exam_standard, type = 'mcq',
    question_text, option_a, option_b, option_c, option_d,
    correct_answer, explanation,
    question_image_r2_key, option_image_r2_key, explanation_image_r2_key,
  } = body;

  if (!subject || !chapter || !difficulty || !exam_standard || !question_text || !correct_answer) {
    return json400('subject, chapter, difficulty, exam_standard, question_text, and correct_answer are required');
  }

  if (!VALID_DIFFICULTIES.includes(difficulty as ValidDifficulty)) {
    return json400(`difficulty must be one of: ${VALID_DIFFICULTIES.join(', ')}`);
  }

  if (!VALID_STANDARDS.includes(exam_standard as ValidStandard)) {
    return json400(`exam_standard must be one of: ${VALID_STANDARDS.join(', ')}`);
  }

  if (!VALID_TYPES.includes(type as any)) {
    return json400(`type must be one of: ${VALID_TYPES.join(', ')}`);
  }

  const cleanAns = String(correct_answer).toUpperCase().trim();
  if (!VALID_ANSWERS.has(cleanAns)) {
    return json400('correct_answer must be one of: A, B, C, D');
  }

  // Pre-submission duplicate check against existing approved questions
  const existingDup = await env.QFORGE_DB.prepare(
    'SELECT id FROM approved_questions WHERE question_text = ? LIMIT 1'
  ).bind(question_text.trim()).first<{ id: string }>();

  if (existingDup) {
    return json400(`Duplicate detected: this question text already exists in approved proprietary bank (ID: ${existingDup.id})`);
  }

  const id = generateId();
  await env.QFORGE_DB.prepare(`
    INSERT INTO draft_questions (
      id, subject, chapter, topic, difficulty, exam_standard, type,
      question_text, option_a, option_b, option_c, option_d,
      correct_answer, explanation,
      question_image_r2_key, option_image_r2_key, explanation_image_r2_key,
      status, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_ai_review', ?)
  `).bind(
    id, subject, chapter, topic ?? null, difficulty, exam_standard, type,
    question_text.trim(),
    option_a?.trim() ?? null, option_b?.trim() ?? null, option_c?.trim() ?? null, option_d?.trim() ?? null,
    cleanAns, explanation?.trim() ?? null,
    question_image_r2_key ?? null, option_image_r2_key ?? null, explanation_image_r2_key ?? null,
    ctx.user.sub,
  ).run();

  return json({ id, message: 'Draft submitted. Run AI review to proceed.' }, 201);
}

// ── GET /forge/drafts ─────────────────────────────────────────

export async function listDrafts(request: Request, env: Env): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['admin', 'content-creator']);
  if (error) return error;

  const url    = new URL(request.url);
  const status = url.searchParams.get('status') ?? '';
  const page   = Math.max(1, parseInt(url.searchParams.get('page') ?? '1'));
  const limit  = Math.min(50, parseInt(url.searchParams.get('limit') ?? '20'));
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const bindings: (string | number)[] = [];

  if (ctx.user.role === 'content-creator') {
    conditions.push('created_by = ?');
    bindings.push(ctx.user.sub);
  }

  if (status) {
    conditions.push('status = ?');
    bindings.push(status);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const [rows, countRow] = await Promise.all([
    env.QFORGE_DB.prepare(
      `SELECT id, subject, chapter, topic, difficulty, exam_standard, type,
              question_text, correct_answer, status, ai_score, ai_feedback,
              created_by, created_at, reviewed_at
       FROM draft_questions ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).bind(...bindings, limit, offset).all(),
    env.QFORGE_DB.prepare(
      `SELECT COUNT(*) as total FROM draft_questions ${where}`
    ).bind(...bindings).first<{ total: number }>(),
  ]);

  return json({ data: rows.results, total: countRow?.total ?? 0, page, limit });
}

// ── GET /forge/drafts/:id ─────────────────────────────────────

export async function getDraft(request: Request, env: Env, id: string): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['admin', 'content-creator']);
  if (error) return error;

  const draft = await env.QFORGE_DB.prepare('SELECT * FROM draft_questions WHERE id = ?')
    .bind(id).first<any>();

  if (!draft) return json404('Draft not found');

  if (ctx.user.role === 'content-creator' && draft.created_by !== ctx.user.sub) {
    return json({ error: 'Forbidden' }, 403);
  }

  return json(draft);
}

// ── PATCH /forge/:id ──────────────────────────────────────────
// Edit a draft before it's approved.

export async function patchDraft(request: Request, env: Env, id: string): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['admin', 'content-creator']);
  if (error) return error;

  const draft = await env.QFORGE_DB.prepare('SELECT id, created_by, status FROM draft_questions WHERE id = ?')
    .bind(id).first<{ id: string; created_by: string; status: string }>();

  if (!draft) return json404('Draft not found');

  if (ctx.user.role === 'content-creator' && draft.created_by !== ctx.user.sub) {
    return json({ error: 'Forbidden' }, 403);
  }
  if (draft.status === 'approved' || draft.status === 'rejected') {
    return json400(`Cannot edit a draft with status '${draft.status}'`);
  }

  let body: Record<string, string>;
  try { body = await request.json(); } catch { return json400('Invalid JSON'); }

  const allowedFields = [
    'subject', 'chapter', 'topic', 'difficulty', 'exam_standard', 'type',
    'question_text', 'option_a', 'option_b', 'option_c', 'option_d',
    'correct_answer', 'explanation',
    'question_image_r2_key', 'option_image_r2_key', 'explanation_image_r2_key',
  ];

  const fields = Object.keys(body).filter(k => allowedFields.includes(k));
  if (fields.length === 0) return json400('No valid fields to update');

  if (body.difficulty && !VALID_DIFFICULTIES.includes(body.difficulty as ValidDifficulty)) {
    return json400(`difficulty must be one of: ${VALID_DIFFICULTIES.join(', ')}`);
  }
  if (body.exam_standard && !VALID_STANDARDS.includes(body.exam_standard as ValidStandard)) {
    return json400(`exam_standard must be one of: ${VALID_STANDARDS.join(', ')}`);
  }
  if (body.correct_answer && !VALID_ANSWERS.has(body.correct_answer.toUpperCase().trim())) {
    return json400('correct_answer must be one of: A, B, C, D');
  }

  const shouldReset = draft.status === 'ai_flagged';
  const setClause = [
    ...fields.map(f => `${f} = ?`),
    ...(shouldReset ? ["status = 'pending_ai_review'", 'ai_score = NULL', 'ai_feedback = NULL'] : []),
  ].join(', ');

  await env.QFORGE_DB.prepare(`UPDATE draft_questions SET ${setClause} WHERE id = ?`)
    .bind(...fields.map(f => body[f]), id).run();

  return json({ message: 'Draft updated', reset_to_pending: shouldReset });
}

// ── POST /forge/:id/ai-review ─────────────────────────────────
// Triggers structured quality audit on a draft.
// Sets status to 'pending_human_approval' only if hard quality invariants hold.

export async function runAiReview(request: Request, env: Env, id: string): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['admin', 'content-creator']);
  if (error) return error;

  const draft = await env.QFORGE_DB.prepare('SELECT * FROM draft_questions WHERE id = ?')
    .bind(id).first<any>();

  if (!draft) return json404('Draft not found');

  if (ctx.user.role === 'content-creator' && draft.created_by !== ctx.user.sub) {
    return json({ error: 'Forbidden' }, 403);
  }

  if (draft.status === 'approved' || draft.status === 'rejected') {
    return json400(`Cannot re-review a draft with status '${draft.status}'`);
  }

  const optionsText = [
    draft.option_a ? `A) ${draft.option_a}` : null,
    draft.option_b ? `B) ${draft.option_b}` : null,
    draft.option_c ? `C) ${draft.option_c}` : null,
    draft.option_d ? `D) ${draft.option_d}` : null,
  ].filter(Boolean).join('\n');

  const prompt = `You are a senior question quality auditor for Indian competitive entrance exams (JEE / NEET / KCET).

Carefully review this MCQ question and return a structured JSON quality audit:

Question: ${draft.question_text}
${optionsText ? `Options:\n${optionsText}` : ''}
Correct Answer: ${draft.correct_answer}
Explanation: ${draft.explanation || '(none provided)'}
Target Standard: ${draft.exam_standard}
Difficulty: ${draft.difficulty}

AUDIT RULES:
1. Recalculate and independently verify if ${draft.correct_answer} is genuinely the mathematically and scientifically correct option.
2. Check if LaTeX formatting is valid and complete ($...$ inline, $$...$$ display).
3. Ensure the question stem is completely unambiguous.
4. Verify that the 3 incorrect options are distinct and plausible distractors.

Return ONLY this JSON object (no preamble, no markdown):
{
  "score": <float 0.0 to 1.0>,
  "correct_answer_verified": <true|false>,
  "difficulty_appropriate": <true|false>,
  "latex_valid": <true|false>,
  "unambiguous": <true|false>,
  "options_distinct_and_plausible": <true|false>,
  "issues": ["<issue1>", "<issue2>"],
  "suggestions": ["<suggestion1>", "<suggestion2>"]
}`;

  try {
    const rawText = await callGemini(env.GEMINI_API_KEY, prompt);
    const feedback = JSON.parse(rawText);

    const score: number = parseFloat(feedback.score) || 0;
    const isAnswerVerified: boolean = feedback.correct_answer_verified === true;
    const isLatexValid: boolean      = feedback.latex_valid === true;
    const isUnambiguous: boolean     = feedback.unambiguous === true;

    // Hard Quality Gate: Must pass critical invariant checks AND have score >= 0.75
    const hardFail = !isAnswerVerified || !isLatexValid || !isUnambiguous || score < 0.75;
    const newStatus = hardFail ? 'ai_flagged' : 'pending_human_approval';

    await env.QFORGE_DB.prepare(`
      UPDATE draft_questions
      SET status = ?, ai_score = ?, ai_feedback = ?, ai_reviewed_at = ?
      WHERE id = ?
    `).bind(newStatus, score, JSON.stringify(feedback), Math.floor(Date.now() / 1000), id).run();

    return json({
      id,
      status:  newStatus,
      score,
      passed: !hardFail,
      findings: {
        correct_answer_verified: isAnswerVerified,
        latex_valid: isLatexValid,
        unambiguous: isUnambiguous,
      },
      feedback,
      message: !hardFail
        ? '✅ AI review passed structured quality gate. Ready for human approval.'
        : `⚠️ AI flagged quality issues (Score: ${score.toFixed(2)}). Review issues and update draft.`,
    });
  } catch (e: any) {
    return json({ error: `AI review failed: ${e.message}` }, 502);
  }
}

// ── POST /forge/:id/approve ───────────────────────────────────
// Admin only. Conditional concurrency transition to approved_questions.

export async function approveDraft(request: Request, env: Env, id: string): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['admin']);
  if (error) return error;

  const now = Math.floor(Date.now() / 1000);

  // Atomic conditional state transition (guards against concurrent race conditions)
  const updateResult = await env.QFORGE_DB.prepare(`
    UPDATE draft_questions 
    SET status = 'approved', reviewed_by = ?, reviewed_at = ? 
    WHERE id = ? AND status = 'pending_human_approval'
  `).bind(ctx.user.sub, now, id).run();

  if (updateResult.meta.changes === 0) {
    const current = await env.QFORGE_DB.prepare('SELECT status FROM draft_questions WHERE id = ?')
      .bind(id).first<{ status: string }>();
    if (!current) return json404('Draft not found');
    return json400(`Draft cannot be approved. Current status is '${current.status}'. Must be 'pending_human_approval'.`);
  }

  // Fetch verified draft data
  const draft = await env.QFORGE_DB.prepare('SELECT * FROM draft_questions WHERE id = ?')
    .bind(id).first<any>();

  const approvedId = generateId();

  await env.QFORGE_DB.prepare(`
    INSERT INTO approved_questions (
      id, draft_id, subject, chapter, topic, difficulty, exam_standard, type,
      question_text, option_a, option_b, option_c, option_d,
      correct_answer, explanation,
      question_image_r2_key, option_image_r2_key, explanation_image_r2_key,
      ai_score, created_by, approved_by, approved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    approvedId, id,
    draft.subject, draft.chapter, draft.topic ?? null,
    draft.difficulty, draft.exam_standard, draft.type,
    draft.question_text,
    draft.option_a ?? null, draft.option_b ?? null,
    draft.option_c ?? null, draft.option_d ?? null,
    draft.correct_answer, draft.explanation ?? null,
    draft.question_image_r2_key ?? null,
    draft.option_image_r2_key ?? null,
    draft.explanation_image_r2_key ?? null,
    draft.ai_score ?? null,
    draft.created_by, ctx.user.sub, now,
  ).run();

  return json({ approved_id: approvedId, draft_id: id, message: '✅ Question approved and added to proprietary bank.' }, 201);
}

// ── POST /forge/:id/reject ────────────────────────────────────

export async function rejectDraft(request: Request, env: Env, id: string): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['admin']);
  if (error) return error;

  let reason = '';
  try { const b = await request.json() as any; reason = b.reason ?? ''; } catch {}

  const now = Math.floor(Date.now() / 1000);
  const result = await env.QFORGE_DB.prepare(`
    UPDATE draft_questions 
    SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, ai_feedback = json_patch(COALESCE(ai_feedback, '{}'), ?) 
    WHERE id = ? AND status != 'approved'
  `).bind(ctx.user.sub, now, JSON.stringify({ rejection_reason: reason }), id).run();

  if (result.meta.changes === 0) {
    const draft = await env.QFORGE_DB.prepare('SELECT status FROM draft_questions WHERE id = ?').bind(id).first<any>();
    if (!draft) return json404('Draft not found');
    return json400(`Cannot reject a draft with status '${draft.status}'`);
  }

  return json({ message: 'Draft rejected.' });
}

// ── GET /forge/approved ───────────────────────────────────────

export async function listApproved(request: Request, env: Env): Promise<Response> {
  const { error } = await requireAuth(request, env, ['admin', 'faculty', 'content-creator']);
  if (error) return error;

  const url        = new URL(request.url);
  const subject    = url.searchParams.get('subject')    ?? '';
  const chapter    = url.searchParams.get('chapter')    ?? '';
  const difficulty = url.searchParams.get('difficulty') ?? '';
  const exam_std   = url.searchParams.get('exam_standard') ?? '';
  const page       = Math.max(1, parseInt(url.searchParams.get('page') ?? '1'));
  const limit      = Math.min(100, parseInt(url.searchParams.get('limit') ?? '50'));
  const offset     = (page - 1) * limit;

  const conditions: string[] = [];
  const bindings: string[] = [];
  if (subject)    { conditions.push('subject = ?');       bindings.push(subject); }
  if (chapter)    { conditions.push('chapter = ?');       bindings.push(chapter); }
  if (difficulty) { conditions.push('difficulty = ?');    bindings.push(difficulty); }
  if (exam_std)   { conditions.push('exam_standard = ?'); bindings.push(exam_std); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const [rows, countRow] = await Promise.all([
    env.QFORGE_DB.prepare(
      `SELECT * FROM approved_questions ${where} ORDER BY approved_at DESC LIMIT ? OFFSET ?`
    ).bind(...bindings, limit, offset).all(),
    env.QFORGE_DB.prepare(
      `SELECT COUNT(*) as total FROM approved_questions ${where}`
    ).bind(...bindings).first<{ total: number }>(),
  ]);

  return json({ data: rows.results, total: countRow?.total ?? 0, page, limit });
}

// ── POST /forge/upload-image ──────────────────────────────────
// Uploads an image to R2 under the isolated forge/ namespace and returns the r2_key.

export async function uploadForgeImage(request: Request, env: Env): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['admin', 'content-creator']);
  if (error) return error;

  const contentType = request.headers.get('Content-Type') ?? 'image/png';
  if (!contentType.startsWith('image/')) {
    return json400('Only image uploads are allowed (image/png, image/jpeg, image/webp)');
  }

  const ext = contentType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
  const r2Key = `forge/${ctx.user.sub}/${generateId()}.${ext}`;

  const body = await request.arrayBuffer();
  if (body.byteLength > 5 * 1024 * 1024) {
    return json400('Image too large (max 5MB)');
  }

  await env.CBT_R2.put(r2Key, body, { httpMetadata: { contentType } });

  return json({ r2_key: r2Key, message: 'Image uploaded successfully.' }, 201);
}

// ── GET /forge/image/:key ─────────────────────────────────────
// Serves an image from R2 by its key, enforcing namespace isolation.

export async function serveForgeImage(request: Request, env: Env, key: string): Promise<Response> {
  const { error } = await requireAuth(request, env, ['admin', 'faculty', 'content-creator']);
  if (error) return error;

  if (!key.startsWith('forge/')) {
    return json400('Invalid image key (must reside within forge/ namespace)');
  }

  const object = await env.CBT_R2.get(key);
  if (!object) return json404('Image not found');

  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType ?? 'image/png');
  headers.set('Cache-Control', 'public, max-age=31536000');

  return new Response(object.body, { headers });
}

// ── Route Dispatcher ──────────────────────────────────────────

export async function forgeRouter(
  request: Request,
  env: Env,
  pathname: string,
): Promise<Response | null> {
  const method = request.method;

  if (pathname === '/forge/generate'    && method === 'POST') return generateQuestions(request, env);
  if (pathname === '/forge/submit'      && method === 'POST') return submitDraft(request, env);
  if (pathname === '/forge/drafts'      && method === 'GET')  return listDrafts(request, env);
  if (pathname === '/forge/approved'    && method === 'GET')  return listApproved(request, env);
  if (pathname === '/forge/upload-image'&& method === 'POST') return uploadForgeImage(request, env);

  // /forge/drafts/:id
  const draftMatch = pathname.match(/^\/forge\/drafts\/([^/]+)$/);
  if (draftMatch) {
    const id = draftMatch[1];
    if (method === 'GET')   return getDraft(request, env, id);
    if (method === 'PATCH') return patchDraft(request, env, id);
  }

  // /forge/:id/ai-review | /forge/:id/approve | /forge/:id/reject
  const actionMatch = pathname.match(/^\/forge\/([^/]+)\/(ai-review|approve|reject)$/);
  if (actionMatch) {
    const [, id, action] = actionMatch;
    if (action === 'ai-review' && method === 'POST') return runAiReview(request, env, id);
    if (action === 'approve'   && method === 'POST') return approveDraft(request, env, id);
    if (action === 'reject'    && method === 'POST') return rejectDraft(request, env, id);
  }

  // /forge/image/* — serve R2 images
  const imgMatch = pathname.match(/^\/forge\/image\/(.+)$/);
  if (imgMatch && method === 'GET') return serveForgeImage(request, env, imgMatch[1]);

  return null;
}
