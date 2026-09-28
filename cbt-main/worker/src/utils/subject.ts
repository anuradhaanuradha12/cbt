// ─── Faculty Subject Scoping ──────────────────────────────────────────────────
// Shared rule: faculty accounts are locked to their assigned subject.
// The subject is resolved from the users table (authoritative), not the JWT,
// so a subject change takes effect immediately without re-login.
//
// - faculty with a subject: forced onto it; any other requested subject → 403
// - faculty without a subject: blocked (fail-closed)
// - admin (and other staff roles): unrestricted

import { json403 } from '../middleware/responses';
import type { AuthContext } from '../middleware/auth';
import type { Env } from '../types';

export async function subjectScope(
  ctx: AuthContext,
  env: Env,
  requestedSubject: string
): Promise<{ subject: string; error: null } | { subject: null; error: Response }> {
  if (ctx.user.role === 'faculty') {
    const row = await env.DB.prepare('SELECT subject FROM users WHERE id = ?')
      .bind(ctx.user.sub).first<{ subject: string | null }>();
    const own = (row?.subject ?? '').toLowerCase().trim();

    if (!own) {
      return { subject: null, error: json403('Your faculty account has no subject assigned. Contact an admin.') };
    }
    const req = (requestedSubject ?? '').toLowerCase().trim();
    if (req && req !== own) {
      return { subject: null, error: json403(`You can only access your own subject (${own}).`) };
    }
    return { subject: own, error: null };
  }
  // admin / other staff — unrestricted
  return { subject: (requestedSubject ?? '').toLowerCase().trim(), error: null };
}
