// ─── Auth Middleware ──────────────────────────────────────────────────────────
// Verifies JWT and enforces role-based access control.
// Also enforces single active session via KV session check.

import type { JWTPayload, Role } from '../../../shared/types';
import type { Env } from '../types';
import { verifyJWT } from '../utils/jwt';
import { json401, json403 } from './responses';

export interface AuthContext {
  user: JWTPayload;
}

/**
 * Extracts and verifies the Bearer token from the Authorization header.
 * Returns null and sends appropriate response if auth fails.
 */
export async function requireAuth(
  request: Request,
  env: Env,
  allowedRoles?: Role[]
): Promise<{ ctx: AuthContext; error: null } | { ctx: null; error: Response }> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { ctx: null, error: json401('Missing or malformed Authorization header') };
  }

  const token = authHeader.slice(7);
  const payload = await verifyJWT(token, env.JWT_SECRET);

  if (!payload) {
    return { ctx: null, error: json401('Invalid or expired token') };
  }

  // Single active session check — if student opens exam on another device,
  // this invalidates the previous session automatically.
  const activeSessionId = await env.CBT_KV.get(`session:${payload.sub}`);
  if (activeSessionId !== payload.sid) {
    return { ctx: null, error: json401('Session invalidated. Please log in again.') };
  }

  // Role guard
  if (allowedRoles && !allowedRoles.includes(payload.role)) {
    return { ctx: null, error: json403('Insufficient permissions') };
  }

  return { ctx: { user: payload }, error: null };
}
