// ─── Users Routes ─────────────────────────────────────────────────────────────
// GET  /users                    — list students (admin/faculty/principal, own college)
//                                  includes exams_taken + avg_score (percentage) per student
// POST /users/bulk               — bulk import students from CSV payload (Admin only)
// PUT  /users/:id/password       — reset a student's password (principal/admin).
//                                  Used when a student forgets their password.
// PUT  /users/:id/section        — move one student to another section (principal/admin)
// POST /users/sections/preview   — preview which students a marks-based section move
//                                  would affect (principal/admin)
// POST /users/sections/apply     — bulk-move matching students into a new section,
//                                  chosen by their test marks (principal/admin)

import { json, json400, json403, json404, json409 } from '../middleware/responses';
import { requireAuth } from '../middleware/auth';
import { subjectScope } from '../utils/subject';
import { hashPassword } from '../utils/password';
import type { Env } from '../types';

function generateId(): string {
  return crypto.randomUUID();
}

// Cell values that mean "no section" — a literal 'null' batch_name in the DB
// once broke the section filter and analytics grouping, so these are rejected
// as section names everywhere: CSV import (with the frontend parser as the
// first line of defense), bulk import, and section moves.
const NO_SECTION_VALUES = new Set(['', 'null', 'none', 'n/a', 'na', '-', '--']);

// ── GET /users ────────────────────────────────────────────────

export async function getUsers(request: Request, env: Env): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['admin', 'faculty', 'principal']);
  if (error) return error;

  // College scoping — principals/faculty manage their own college's students only.
  // avg_score is the mean of per-exam percentages (score/total_marks), so exams
  // with different maximum marks are comparable. NULL when a student has no
  // graded submissions.
  //
  // Faculty are subject-locked, so their view of a student's marks must count
  // ONLY their own subject — otherwise the list leaks how the same student is
  // doing in every other subject.
  let facultySubject: string | null = null;
  if (ctx.user.role === 'faculty') {
    const scope = await subjectScope(ctx, env, '');
    if (scope.error) return scope.error;
    facultySubject = scope.subject;
  }

  const users = facultySubject
    ? await env.DB.prepare(
      `SELECT u.id, u.name, u.email, u.batch_name, u.created_at,
              COUNT(sub.submission_id) AS exams_taken,
              AVG(CASE WHEN sub.possible > 0 THEN sub.scored * 100.0 / sub.possible END) AS avg_score
       FROM users u
       LEFT JOIN (
         SELECT s.id AS submission_id, s.student_id,
                SUM(COALESCE(sa.marks_awarded, 0))       AS scored,
                SUM(COALESCE(eq.marks, 4))               AS possible
         FROM submissions s
         JOIN submission_answers sa ON sa.submission_id = s.id
         JOIN questions q ON q.id = sa.question_id
         LEFT JOIN exam_questions eq
           ON eq.exam_id = s.exam_id AND eq.question_id = sa.question_id
         WHERE q.subject = ?
         GROUP BY s.id
       ) sub ON sub.student_id = u.id
       WHERE u.role = 'student' AND u.college_id = ?
       GROUP BY u.id
       ORDER BY u.created_at DESC`
    ).bind(facultySubject, ctx.user.college_id).all()
    : await env.DB.prepare(
      `SELECT u.id, u.name, u.email, u.batch_name, u.created_at,
              COUNT(s.id) AS exams_taken,
              AVG(CASE WHEN s.score IS NOT NULL THEN s.score * 100.0 / e.total_marks END) AS avg_score
       FROM users u
       LEFT JOIN submissions s ON s.student_id = u.id
       LEFT JOIN exams e ON e.id = s.exam_id
       WHERE u.role = 'student' AND u.college_id = ?
       GROUP BY u.id
       ORDER BY u.created_at DESC`
    ).bind(ctx.user.college_id).all();

  return json(users.results);
}

// ── POST /users/bulk ──────────────────────────────────────────

export async function bulkImportUsers(request: Request, env: Env): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['admin']);
  if (error) return error;

  let users: Record<string, string>[];
  try {
    users = await request.json();
  } catch {
    return json400('Invalid JSON');
  }

  if (!Array.isArray(users) || users.length === 0) {
    return json400('Body must be a non-empty array of users');
  }
  if (users.length > 1000) {
    return json400('Maximum 1000 users per bulk import');
  }

  // Verify all required fields
  for (let i = 0; i < users.length; i++) {
    const { name, email, password } = users[i];
    if (!name || !email || !password) {
      return json400(`Row ${i + 1} is missing name, email, or password`);
    }
  }

  // Extract all emails to check for duplicates in one go
  const emails = users.map(u => u.email.toLowerCase().trim());

  // Check for duplicate emails within the payload itself
  const uniqueEmails = new Set(emails);
  if (uniqueEmails.size !== emails.length) {
    return json400('Duplicate emails found within the uploaded file');
  }

  // Check against DB
  const placeholders = emails.map(() => 'LOWER(?)').join(',');
  const existingUsers = await env.DB.prepare(
    `SELECT email FROM users WHERE LOWER(email) IN (${placeholders})`
  ).bind(...emails).all<{ email: string }>();

  if (existingUsers.results.length > 0) {
    // User explicitly requested an error here but to be careful not to leak too much.
    // We will just say that N emails already exist.
    return json409(`Upload failed: ${existingUsers.results.length} email(s) already exist in the system.`);
  }

  // Prepare batch insert
  const stmt = env.DB.prepare(`
    INSERT INTO users (id, email, password_hash, role, name, batch_name, college_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const inserts = await Promise.all(users.map(async (u) => {
    const pHash = await hashPassword(u.password);
    const batch = (u.batch_name ?? '').trim();
    return stmt.bind(
      generateId(),
      u.email.toLowerCase().trim(),
      pHash,
      'student', // Always student via bulk upload
      u.name.trim(),
      NO_SECTION_VALUES.has(batch.toLowerCase()) ? null : batch || null,
      ctx.user.college_id
    );
  }));

  // Execute batch
  await env.DB.batch(inserts);

  return json({ inserted: users.length, message: 'Students successfully imported' }, 201);
}

// ── PUT /users/:id/password ───────────────────────────────────
// Principal (or admin) resets a forgotten student password.
// Sets a new hash AND deletes the student's KV session so any device
// still holding the old JWT is logged out immediately.

export async function resetUserPassword(request: Request, env: Env, userId: string): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['principal', 'admin']);
  if (error) return error;

  let body: { new_password?: string; reason?: string };
  try { body = await request.json(); } catch { return json400('Invalid JSON'); }

  const { new_password, reason } = body;
  if (!new_password || typeof new_password !== 'string') {
    return json400('new_password is required');
  }
  if (new_password.length < 8) {
    return json400('Password must be at least 8 characters');
  }

  const target = await env.DB.prepare(
    'SELECT id, email, role, college_id, is_active FROM users WHERE id = ?'
  ).bind(userId).first<{ id: string; email: string; role: string; college_id: string; is_active: number }>();
  if (!target) return json404('User not found');

  // Multi-tenant isolation: cannot reset across colleges
  if (target.college_id !== ctx.user.college_id) {
    return json403('User belongs to a different college');
  }
  if (!target.is_active) {
    return json400('User account is deactivated');
  }
  // Principal password resets are for students. Admins themselves rotate their
  // own credentials; nobody resets an admin/principal this way.
  if (target.role !== 'student') {
    return json400(`Only student passwords can be reset (target role: '${target.role}')`);
  }

  const password_hash = await hashPassword(new_password);
  await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .bind(password_hash, userId).run();

  // Invalidate any active session — the old token stops working instantly
  await env.CBT_KV.delete(`session:${userId}`);

  return json({
    message: `Password reset successfully for ${target.email}. Their active sessions were logged out.`,
    reason: reason ?? null,
  });
}

// ── POST /users/sections/preview + /users/sections/apply ──────
// Principal (or admin) bulk-moves students into a different section
// (the student's batch_name) based on their test marks.
//
// Flow: preview first (dry run listing exactly who would move), then apply.
// Students are selected by: average score percentage across all their graded
// submissions (min/max bounds), minimum exams taken, and optionally their
// current section. At least one marks/exam criterion is mandatory so nobody
// can accidentally move the entire student body.
//
// Note: batch_name is read fresh from the DB on every exam list request, so
// moved students see their new section's exams immediately — no re-login
// and no session invalidation needed.

const AVG_SCORE_EXPR =
  'AVG(CASE WHEN s.score IS NOT NULL THEN s.score * 100.0 / e.total_marks END)';

interface SectionMoveCriteria {
  target_section: string;
  current_section?: string; // '' = currently unassigned
  min_score?: number;       // percent 0-100, inclusive
  max_score?: number;       // percent 0-100, inclusive
  min_exams?: number;       // inclusive
}

function parseSectionMoveCriteria(body: unknown): { data?: SectionMoveCriteria; error?: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const { target_section, current_section, min_score, max_score, min_exams } = b;

  if (typeof target_section !== 'string' || !target_section.trim()) {
    return { error: 'target_section is required' };
  }
  const target = target_section.trim();
  if (target.length > 60) {
    return { error: 'target_section must be 60 characters or fewer' };
  }

  const criteria: SectionMoveCriteria = { target_section: target };

  if (current_section !== undefined && current_section !== null) {
    if (typeof current_section !== 'string') return { error: 'current_section must be a string' };
    criteria.current_section = current_section.trim();
  }

  for (const [key, val] of [['min_score', min_score], ['max_score', max_score]] as const) {
    if (val === undefined || val === null) continue;
    if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || val > 100) {
      return { error: `${key} must be a number between 0 and 100 (a percentage)` };
    }
    criteria[key] = val;
  }

  if (min_exams !== undefined && min_exams !== null) {
    if (typeof min_exams !== 'number' || !Number.isInteger(min_exams) || min_exams < 0) {
      return { error: 'min_exams must be a non-negative integer' };
    }
    criteria.min_exams = min_exams;
  }

  if (
    criteria.min_score === undefined &&
    criteria.max_score === undefined &&
    criteria.min_exams === undefined
  ) {
    return { error: 'At least one criterion is required (min_score, max_score, or min_exams) — refusing to move every student blindly' };
  }
  if (
    criteria.min_score !== undefined &&
    criteria.max_score !== undefined &&
    criteria.min_score > criteria.max_score
  ) {
    return { error: 'min_score cannot be greater than max_score' };
  }

  return { data: criteria };
}

/** WHERE/HAVING shared by preview and apply so both select the same students. */
function buildSectionSelect(criteria: SectionMoveCriteria, collegeId: string): { sql: string; params: unknown[] } {
  const where: string[] = ["u.role = 'student'", 'u.college_id = ?', 'u.is_active = 1'];
  const params: unknown[] = [collegeId];

  if (criteria.current_section !== undefined) {
    if (criteria.current_section === '') {
      // "Unassigned" — treat NULL, empty string, and the legacy literal
      // 'null' (bad seed/import data) as unassigned so they're catchable
      // and get cleaned up on move.
      where.push("(u.batch_name IS NULL OR u.batch_name = '' OR LOWER(u.batch_name) = 'null')");
    } else {
      where.push('u.batch_name = ?');
      params.push(criteria.current_section);
    }
  }

  const having: string[] = [];
  if (criteria.min_score !== undefined) {
    having.push(`${AVG_SCORE_EXPR} >= ?`);
    params.push(criteria.min_score);
  }
  if (criteria.max_score !== undefined) {
    having.push(`${AVG_SCORE_EXPR} <= ?`);
    params.push(criteria.max_score);
  }
  if (criteria.min_exams !== undefined) {
    having.push('COUNT(s.id) >= ?');
    params.push(criteria.min_exams);
  }

  const sql = `
    SELECT u.id, u.name, u.email, u.batch_name,
           COUNT(s.id) AS exams_taken,
           ${AVG_SCORE_EXPR} AS avg_score
    FROM users u
    LEFT JOIN submissions s ON s.student_id = u.id
    LEFT JOIN exams e ON e.id = s.exam_id
    WHERE ${where.join(' AND ')}
    GROUP BY u.id
    ${having.length > 0 ? `HAVING ${having.join(' AND ')}` : ''}
    ORDER BY avg_score DESC, u.name ASC
  `;
  return { sql, params };
}

export async function previewSectionMove(request: Request, env: Env): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['principal', 'admin']);
  if (error) return error;

  let body: unknown;
  try { body = await request.json(); } catch { return json400('Invalid JSON'); }

  const parsed = parseSectionMoveCriteria(body);
  if (parsed.error || !parsed.data) return json400(parsed.error ?? 'Invalid criteria');
  const criteria = parsed.data;

  if (criteria.current_section !== undefined && criteria.current_section === criteria.target_section) {
    return json400('Target section is the same as the current section — nothing to move');
  }

  // Don't create more fake sections: 'null'/'none'/'' as a target name is
  // exactly the bug this feature is cleaning up after.
  if (NO_SECTION_VALUES.has(criteria.target_section.toLowerCase())) {
    return json400(`'${criteria.target_section}' is not a valid section name — it would be treated as "unassigned"`);
  }

  const { sql, params } = buildSectionSelect(criteria, ctx.user.college_id);
  const rows = await env.DB.prepare(sql).bind(...params).all();

  return json({
    target_section: criteria.target_section,
    criteria: {
      current_section: criteria.current_section ?? null,
      min_score: criteria.min_score ?? null,
      max_score: criteria.max_score ?? null,
      min_exams: criteria.min_exams ?? null,
    },
    count: rows.results.length,
    students: rows.results,
  });
}

export async function applySectionMove(request: Request, env: Env): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['principal', 'admin']);
  if (error) return error;

  let body: unknown;
  try { body = await request.json(); } catch { return json400('Invalid JSON'); }

  const parsed = parseSectionMoveCriteria(body);
  if (parsed.error || !parsed.data) return json400(parsed.error ?? 'Invalid criteria');
  const criteria = parsed.data;

  if (criteria.current_section !== undefined && criteria.current_section === criteria.target_section) {
    return json400('Target section is the same as the current section — nothing to move');
  }

  // Don't create more fake sections: 'null'/'none'/'' as a target name is
  // exactly the bug this feature is cleaning up after.
  if (NO_SECTION_VALUES.has(criteria.target_section.toLowerCase())) {
    return json400(`'${criteria.target_section}' is not a valid section name — it would be treated as "unassigned"`);
  }

  // Reuse the exact same selection as the preview, wrapped in an UPDATE.
  // The selection returns several columns, so it has to be projected down to the
  // single id column — `id IN (<5 columns>)` is a SQLite error, not a no-op.
  const { sql, params } = buildSectionSelect(criteria, ctx.user.college_id);
  const result = await env.DB.prepare(
    `UPDATE users SET batch_name = ? WHERE id IN (SELECT id FROM (${sql}))`
  ).bind(criteria.target_section, ...params).run();

  const moved = result.meta.changes ?? 0;
  return json({
    moved,
    target_section: criteria.target_section,
    message: moved === 0
      ? 'No students matched these criteria — nothing was changed.'
      : `Moved ${moved} student${moved === 1 ? '' : 's'} to '${criteria.target_section}'. They see their new section's exams immediately — no re-login needed.`,
  });
}

// ── PUT /users/:id/section ────────────────────────────────────
// Principal (or admin) moves a single student to another section.
// Exactly one row changes — no criteria, no bulk side effects.

export async function moveUserSection(request: Request, env: Env, userId: string): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['principal', 'admin']);
  if (error) return error;

  let body: { section?: string };
  try { body = await request.json(); } catch { return json400('Invalid JSON'); }

  const section = typeof body.section === 'string' ? body.section.trim() : '';
  if (!section) return json400('section is required');
  if (section.length > 60) return json400('section must be 60 characters or fewer');
  // Same guard as the bulk preview/apply: a literal 'null'/'none'/'' was written
  // into batch_name by an earlier bug and read back as a real section, so it
  // must never be accepted as one here either.
  if (NO_SECTION_VALUES.has(section.toLowerCase())) {
    return json400(`'${section}' is not a valid section name — it would be treated as "unassigned"`);
  }

  const target = await env.DB.prepare(
    'SELECT id, batch_name, role, college_id, is_active FROM users WHERE id = ?'
  ).bind(userId).first<{ batch_name: string | null; role: string; college_id: string; is_active: number }>();
  if (!target) return json404('User not found');
  if (target.college_id !== ctx.user.college_id) {
    return json403('User belongs to a different college');
  }
  if (target.role !== 'student') {
    return json400('Only students can be moved between sections');
  }
  if (!target.is_active) return json400('User account is deactivated');
  if ((target.batch_name ?? '') === section) {
    return json400(`Student is already in section '${section}'`);
  }

  await env.DB.prepare('UPDATE users SET batch_name = ? WHERE id = ?')
    .bind(section, userId).run();

  return json({
    message: `Student moved to section '${section}'. They see their new section's exams immediately — no re-login needed.`,
    previous_section: target.batch_name,
    new_section: section,
  });
}

// ── Route Dispatcher ─────────────────────────────────────────

export async function usersRouter(
  request: Request,
  env: Env,
  pathname: string
): Promise<Response | null> {
  const method = request.method;

  if (pathname === '/users' && method === 'GET') {
    return getUsers(request, env);
  }

  if (pathname === '/users/bulk' && method === 'POST') {
    return bulkImportUsers(request, env);
  }

  // Section-move routes must match before any future /users/:id patterns
  if (pathname === '/users/sections/preview' && method === 'POST') {
    return previewSectionMove(request, env);
  }
  if (pathname === '/users/sections/apply' && method === 'POST') {
    return applySectionMove(request, env);
  }

  const passwordMatch = pathname.match(/^\/users\/([^/]+)\/password$/);
  if (passwordMatch && method === 'PUT') {
    return resetUserPassword(request, env, passwordMatch[1]);
  }

  const sectionMatch = pathname.match(/^\/users\/([^/]+)\/section$/);
  if (sectionMatch && method === 'PUT') {
    return moveUserSection(request, env, sectionMatch[1]);
  }

  return null;
}
