// ─── Google OAuth ("Continue with Google") ────────────────────────────────────
// GET  /auth/google           → 302 redirect to Google's consent screen
// GET  /auth/google/callback  → code exchange, find-or-create user, issue JWT
//
// Setup (one-time):
//   1. Google Cloud Console → APIs & Services → Credentials → OAuth client ID
//      (type: Web application)
//   2. Authorized redirect URIs:
//        http://127.0.0.1:8787/auth/google/callback   (local dev)
//        https://cbt-worker.shishira-932.workers.dev/auth/google/callback (prod)
//   3. Secrets:
//        wrangler secret put GOOGLE_CLIENT_ID
//        wrangler secret put GOOGLE_CLIENT_SECRET
//      (local dev: add the same keys to worker/.dev.vars)
//
// Flow notes:
// - OAuth state is a one-time random value stored in KV (10-min TTL) — CSRF guard.
// - A Google account maps to an existing user by email (case-insensitive).
//   If no user exists, a student account is auto-created in the default college.
// - Google accounts never have a password: password_hash = 'oauth:google',
//   which the password login path can never match (it's not a PBKDF2 blob).
// - Sign-in issues a normal JWT + KV session, so the rest of the app
//   (single-session enforcement, role guards) works unchanged.

import { signJWT } from '../utils/jwt';
import { json, json400, json503 } from '../middleware/responses';
import { KV_SESSION_TTL } from '../config';
import type { Env } from '../types';

const DEFAULT_COLLEGE_ID = 'client1'; // matches config.COLLEGE_ID for self-serve signups

function generateId(): string {
  return crypto.randomUUID();
}

function googleRedirectUri(request: Request): string {
  const url = new URL(request.url);
  return `${url.origin}/auth/google/callback`;
}

// ── GET /auth/google ──────────────────────────────────────────

export async function handleGoogleStart(request: Request, env: Env): Promise<Response> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return json503('Google sign-in is not configured on this deployment (missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).');
  }

  const state = generateId().replace(/-/g, '') + generateId().replace(/-/g, '');
  await env.CBT_KV.put(`oauth_state:${state}`, '1', { expirationTtl: 600 });

  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  auth.searchParams.set('redirect_uri', googleRedirectUri(request));
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('scope', 'openid email profile');
  auth.searchParams.set('state', state);
  auth.searchParams.set('prompt', 'select_account');

  return Response.redirect(auth.toString(), 302);
}

// ── GET /auth/google/callback ─────────────────────────────────

export async function handleGoogleCallback(request: Request, env: Env): Promise<Response> {
  const frontendHome = `${new URL(request.url).origin}/`;

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return Response.redirect(`${frontendHome}?oauth_error=not_configured`, 302);
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code || !state) {
    return Response.redirect(`${frontendHome}?oauth_error=missing_code`, 302);
  }

  // One-time state validation (CSRF guard)
  const stored = await env.CBT_KV.get(`oauth_state:${state}`);
  if (!stored) {
    return Response.redirect(`${frontendHome}?oauth_error=invalid_state`, 302);
  }
  await env.CBT_KV.delete(`oauth_state:${state}`);

  // Exchange the authorization code for tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: googleRedirectUri(request),
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenRes.ok) {
    return Response.redirect(`${frontendHome}?oauth_error=token_exchange_failed`, 302);
  }

  const tokens = (await tokenRes.json()) as { access_token?: string };
  if (!tokens.access_token) {
    return Response.redirect(`${frontendHome}?oauth_error=no_access_token`, 302);
  }

  // Fetch the Google profile
  const profileRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!profileRes.ok) {
    return Response.redirect(`${frontendHome}?oauth_error=profile_fetch_failed`, 302);
  }

  const profile = (await profileRes.json()) as {
    sub: string; email?: string; email_verified?: boolean; name?: string; picture?: string;
  };

  if (!profile.email || profile.email_verified === false) {
    return Response.redirect(`${frontendHome}?oauth_error=email_not_verified`, 302);
  }

  // Find-or-create the local user (case-insensitive email match)
  const email = profile.email.toLowerCase().trim();
  let user = await env.DB.prepare(
    'SELECT id, email, role, name, college_id, subject, is_active FROM users WHERE LOWER(email) = LOWER(?)'
  ).bind(email).first<{ id: string; email: string; role: string; name: string; college_id: string; subject: string | null; is_active: number }>();

  if (!user) {
    // Self-serve signup: new Google accounts become students in the default college
    const id = generateId();
    await env.DB.prepare(`
      INSERT INTO users (id, email, password_hash, role, name, college_id, is_active)
      VALUES (?, ?, 'oauth:google', 'student', ?, ?, 1)
    `).bind(id, email, profile.name ?? email.split('@')[0], DEFAULT_COLLEGE_ID).run();

    user = {
      id,
      email,
      role: 'student',
      name: profile.name ?? email.split('@')[0],
      college_id: DEFAULT_COLLEGE_ID,
      subject: null,
      is_active: 1,
    };
  }

  if (!user.is_active) {
    return Response.redirect(`${frontendHome}?oauth_error=account_disabled`, 302);
  }

  // Issue a normal session — identical to password login from here on
  const sessionId = generateId();
  const token = await signJWT(
    { sub: user.id, email: user.email, role: user.role as 'admin' | 'faculty' | 'student' | 'content-creator' | 'principal', name: user.name, college_id: user.college_id, subject: user.subject as any, sid: sessionId },
    env.JWT_SECRET
  );
  await env.CBT_KV.put(`session:${user.id}`, sessionId, { expirationTtl: KV_SESSION_TTL });

  // Hand the token to the frontend via a one-time code in KV;
  // oauth-callback.html polls/redeems it and stores it like a normal login.
  const exchangeCode = generateId().replace(/-/g, '');
  await env.CBT_KV.put(
    `oauth_token:${exchangeCode}`,
    JSON.stringify({ token, user: { id: user.id, email: user.email, role: user.role, name: user.name, subject: user.subject } }),
    { expirationTtl: 120 }
  );

  return Response.redirect(`${new URL(request.url).origin}/oauth-callback.html?code=${exchangeCode}`, 302);
}

// ── GET /auth/google/exchange?code=... ────────────────────────
// Frontend redeems the one-time code for the actual JWT. The code is deleted
// on first use — it never sits in browser history as a bearer token.

export async function handleGoogleExchange(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  if (!code) return json400('code is required');

  const raw = await env.CBT_KV.get(`oauth_token:${code}`);
  if (!raw) return json400('Invalid or expired code');

  await env.CBT_KV.delete(`oauth_token:${code}`);
  return json(JSON.parse(raw));
}

// ── Route dispatcher (called from authRouter) ─────────────────

export async function googleAuthRouter(
  request: Request,
  env: Env,
  pathname: string
): Promise<Response | null> {
  if (pathname === '/auth/google' && request.method === 'GET') return handleGoogleStart(request, env);
  if (pathname === '/auth/google/callback' && request.method === 'GET') return handleGoogleCallback(request, env);
  if (pathname === '/auth/google/exchange' && request.method === 'GET') return handleGoogleExchange(request, env);
  return null;
}
