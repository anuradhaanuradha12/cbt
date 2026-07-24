// ─── Response Helpers ─────────────────────────────────────────────────────────
// Consistent JSON responses with CORS headers baked in.

import { CORS_ORIGIN } from '../config';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': CORS_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

export function json400(message: string): Response {
  return json({ error: message, code: 'BAD_REQUEST' }, 400);
}

export function json401(message: string): Response {
  return json({ error: message, code: 'UNAUTHORIZED' }, 401);
}

export function json403(message: string): Response {
  return json({ error: message, code: 'FORBIDDEN' }, 403);
}

export function json404(message = 'Not found'): Response {
  return json({ error: message, code: 'NOT_FOUND' }, 404);
}

export function json409(message: string): Response {
  return json({ error: message, code: 'CONFLICT' }, 409);
}

export function json500(message = 'Internal server error'): Response {
  return json({ error: message, code: 'INTERNAL_ERROR' }, 500);
}

export function handleOptions(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
