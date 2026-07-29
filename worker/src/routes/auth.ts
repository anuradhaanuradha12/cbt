// ─── Auth Routes ─────────────────────────────────────────────────────────────
// POST /auth/login   — verify credentials, issue JWT, register KV session
// POST /auth/logout  — delete KV session (invalidates JWT instantly)

import { verifyPassword } from '../utils/password';
import { signJWT } from '../utils/jwt';
import { json, json400, json401 } from '../middleware/responses';
import { requireAuth } from '../middleware/auth';
import { KV_SESSION_TTL } from '../config';
import type { Env } from '../types';
import type { LoginResponse } from '../../../shared/types';

// ── Helpers ──────────────────────────────────────────────────

function generateId(): string {
  return crypto.randomUUID();
}

// ── Handlers ─────────────────────────────────────────────────

export async function handleLogin(request: Request, env: Env): Promise<Response> {
  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return json400('Request body must be valid JSON');
  }

  const { email, password } = body;
  if (!email || !password) {
    return json400('email and password are required');
  }

  // Fetch user — case-insensitive email lookup
  const user = await env.DB.prepare(
    'SELECT id, email, role, name, college_id, subject, password_hash, is_active FROM users WHERE LOWER(email) = LOWER(?)'
  ).bind(email.trim()).first<{
    id: string; email: string; role: string; name: string; college_id: string; subject: string | null;
    password_hash: string; is_active: number;
  }>();

  if (!user || !user.is_active) {
    // Return same error for missing user OR wrong password — prevents user enumeration
    return json401('Invalid email or password');
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return json401('Invalid email or password');
  }

  // Generate a new session ID — any previous session in KV is automatically invalidated
  const sessionId = generateId();

  const token = await signJWT(
    { sub: user.id, email: user.email, role: user.role as 'admin' | 'faculty' | 'student' | 'content-creator', name: user.name, college_id: user.college_id, subject: user.subject as any, sid: sessionId },
    env.JWT_SECRET
  );

  // Store session in KV — single active session enforcement
  await env.CBT_KV.put(`session:${user.id}`, sessionId, { expirationTtl: KV_SESSION_TTL });

  const response: LoginResponse = {
    token,
    user: { id: user.id, email: user.email, role: user.role as 'admin' | 'faculty' | 'student', name: user.name, subject: user.subject as any },
  };

  return json(response);
}

export async function handleLogout(request: Request, env: Env): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env);
  if (error) return error;

  // Delete KV session — JWT is now worthless even if not expired
  await env.CBT_KV.delete(`session:${ctx.user.sub}`);

  return json({ message: 'Logged out successfully' });
}

// ── Route dispatcher ─────────────────────────────────────────

export async function authRouter(
  request: Request,
  env: Env,
  pathname: string
): Promise<Response | null> {
  if (pathname === '/auth/login' && request.method === 'POST')  return handleLogin(request, env);
  if (pathname === '/auth/logout' && request.method === 'POST') return handleLogout(request, env);
  return null;
}
