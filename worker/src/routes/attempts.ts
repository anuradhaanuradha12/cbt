// ─── Exam Attempt Routes ──────────────────────────────────────────────────────
// POST /attempts              — start an attempt (student enters exam)
// POST /attempts/:id/heartbeat — update last_seen_at (live dashboard)
// POST /events                — log anti-cheat events (tab hidden, blur, etc.)

import { json, json400, json403, json404, json409 } from '../middleware/responses';
import { requireAuth } from '../middleware/auth';
import type { Env } from '../types';

function generateId(): string {
  return crypto.randomUUID();
}

// ── POST /attempts ────────────────────────────────────────────
// Creates an exam_attempts row when student clicks "Start Exam".
// If attempt already exists and is in_progress → resume (return existing id).

export async function startAttempt(request: Request, env: Env): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['student']);
  if (error) return error;

  let body: { exam_id?: string };
  try { body = await request.json(); } catch { return json400('Invalid JSON'); }
  if (!body.exam_id) return json400('exam_id is required');

  const { exam_id } = body;

  // Verify exam exists and is published/ongoing
  const exam = await env.DB.prepare(
    'SELECT id, status, starts_at, ends_at FROM exams WHERE id = ?'
  ).bind(exam_id).first<{ id: string; status: string; starts_at: number; ends_at: number }>();

  if (!exam) return json404('Exam not found');
  if (exam.status !== 'published' && exam.status !== 'ongoing') {
    return json403('Exam is not currently available');
  }

  const now = Math.floor(Date.now() / 1000);
  if (exam.starts_at && now < exam.starts_at) {
    return json403('Exam has not started yet');
  }
  if (exam.ends_at && now > exam.ends_at) {
    return json403('Exam has ended');
  }

  // Check if attempt already exists
  const existing = await env.DB.prepare(
    'SELECT id, status FROM exam_attempts WHERE exam_id = ? AND student_id = ?'
  ).bind(exam_id, ctx.user.sub).first<{ id: string; status: string }>();

  if (existing) {
    if (existing.status === 'submitted') {
      return json409('You have already submitted this exam');
    }
    // Resume existing attempt (crash recovery)
    await env.DB.prepare('UPDATE exam_attempts SET last_seen_at = ? WHERE id = ?')
      .bind(now, existing.id).run();
    return json({ attempt_id: existing.id, resumed: true });
  }

  // Create new attempt
  const ip = request.headers.get('CF-Connecting-IP') ?? null;
  const ua = request.headers.get('User-Agent')?.slice(0, 255) ?? null;
  const attemptId = generateId();

  await env.DB.prepare(`
    INSERT INTO exam_attempts (id, exam_id, student_id, ip_address, user_agent)
    VALUES (?, ?, ?, ?, ?)
  `).bind(attemptId, exam_id, ctx.user.sub, ip, ua).run();

  return json({ attempt_id: attemptId, resumed: false }, 201);
}

// ── POST /attempts/:id/heartbeat ──────────────────────────────
// Called every ~30s from the client to update last_seen_at.
// Powers the live dashboard (who is still active vs abandoned).

export async function heartbeat(request: Request, env: Env, attemptId: string): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['student']);
  if (error) return error;

  const attempt = await env.DB.prepare(
    'SELECT id, student_id, status FROM exam_attempts WHERE id = ?'
  ).bind(attemptId).first<{ id: string; student_id: string; status: string }>();

  if (!attempt) return json404('Attempt not found');
  if (attempt.student_id !== ctx.user.sub) return json403('Not your attempt');
  if (attempt.status === 'submitted') return json400('Attempt already submitted');

  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare('UPDATE exam_attempts SET last_seen_at = ? WHERE id = ?')
    .bind(now, attemptId).run();

  return json({ ok: true, server_time: now });
}

// ── POST /events ──────────────────────────────────────────────
// Passive anti-cheat logging. No automatic penalty.
// Faculty reviews the event log per student.

export async function logEvent(request: Request, env: Env): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['student']);
  if (error) return error;

  let body: { attempt_id?: string; event_type?: string; occurred_at?: number; metadata?: unknown };
  try { body = await request.json(); } catch { return json400('Invalid JSON'); }

  const { attempt_id, event_type, occurred_at, metadata } = body;
  if (!attempt_id || !event_type) return json400('attempt_id and event_type are required');

  const validEvents = ['tab_hidden','window_blur','fullscreen_exit','copy','paste','focus_lost','strike_issued'];
  if (!validEvents.includes(event_type)) return json400(`Invalid event_type. Must be one of: ${validEvents.join(', ')}`);

  // Verify the attempt belongs to this student
  const attempt = await env.DB.prepare(
    'SELECT student_id FROM exam_attempts WHERE id = ?'
  ).bind(attempt_id).first<{ student_id: string }>();

  if (!attempt || attempt.student_id !== ctx.user.sub) return json404('Attempt not found');

  await env.DB.prepare(`
    INSERT INTO exam_events (id, attempt_id, event_type, occurred_at, metadata)
    VALUES (?, ?, ?, ?, ?)
  `).bind(
    generateId(), attempt_id, event_type,
    occurred_at ?? Math.floor(Date.now() / 1000),
    metadata ? JSON.stringify(metadata) : null
  ).run();

  return json({ ok: true });
}

// ── Route Dispatcher ─────────────────────────────────────────

export async function attemptsRouter(
  request: Request,
  env: Env,
  pathname: string
): Promise<Response | null> {
  const method = request.method;

  if (pathname === '/attempts' && method === 'POST') return startAttempt(request, env);
  if (pathname === '/events'   && method === 'POST') return logEvent(request, env);

  const hbMatch = pathname.match(/^\/attempts\/([^/]+)\/heartbeat$/);
  if (hbMatch && method === 'POST') return heartbeat(request, env, hbMatch[1]);

  return null;
}
