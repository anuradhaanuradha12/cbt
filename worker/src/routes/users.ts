// ─── Users Routes ─────────────────────────────────────────────────────────────
// POST /users/bulk   — bulk import students from CSV payload (Admin only)

import { json, json400, json409 } from '../middleware/responses';
import { requireAuth } from '../middleware/auth';
import { hashPassword } from '../utils/password';
import type { Env } from '../types';

function generateId(): string {
  return crypto.randomUUID();
}

// ── POST /users/bulk ──────────────────────────────────────────

export async function bulkImportUsers(request: Request, env: Env): Promise<Response> {
  const { error } = await requireAuth(request, env, ['admin']);
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
    INSERT INTO users (id, email, password_hash, role, name, batch_name)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const inserts = await Promise.all(users.map(async (u) => {
    const pHash = await hashPassword(u.password);
    return stmt.bind(
      generateId(),
      u.email.toLowerCase().trim(),
      pHash,
      'student', // Always student via bulk upload
      u.name.trim(),
      u.batch_name ? u.batch_name.trim() : null
    );
  }));

  // Execute batch
  await env.DB.batch(inserts);

  return json({ inserted: users.length, message: 'Students successfully imported' }, 201);
}

// ── Route Dispatcher ─────────────────────────────────────────

export async function usersRouter(
  request: Request,
  env: Env,
  pathname: string
): Promise<Response | null> {
  const method = request.method;

  if (pathname === '/users/bulk' && method === 'POST') {
    return bulkImportUsers(request, env);
  }

  return null;
}
