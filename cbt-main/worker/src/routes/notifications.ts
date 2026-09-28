// ─── Notifications ───────────────────────────────────────────────────────────
// In-app notification centre for the exam-blueprint quota workflow.
//
// GET  /notifications            — current user's notifications + unread count
// PUT  /notifications/:id/read   — mark one notification read (own only)
// POST /notifications/read-all   — mark all of the caller's notifications read
// POST /notifications            — principal/admin messages faculty directly
//
// Quota auditing runs when faculty submits an exam for principal review
// (see submitExamForReview in routes/exams.ts): every subject in the exam
// blueprint is compared against its required question count, and any subject
// that is missing / short / over — or has no faculty account at all — raises a
// notification for the principal so they can chase the responsible faculty.

import { json, json400, json403, json404 } from '../middleware/responses';
import { requireAuth } from '../middleware/auth';
import type { Env } from '../types';
import type { NotificationType, SubjectQuotaGap } from '../../../shared/types';

function generateId(): string {
  return crypto.randomUUID();
}

/** Notification types that require the principal's attention. */
type GapType = Extract<NotificationType, 'quota_missing' | 'quota_shortfall' | 'quota_excess' | 'faculty_unassigned'>;

function parseJsonColumn<T>(value: unknown, fallback: T): T {
  // Accept an already-parsed object (request bodies) as-is; only strings
  // (DB columns) go through JSON.parse.
  if (value && typeof value === 'object') return value as T;
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

// ── Quota audit ───────────────────────────────────────────────
// Compares each subject in the blueprint against how many questions are
// actually attached to the exam. Returns one entry per subject in the
// blueprint, including whether the subject has an assigned faculty member.

export async function computeExamQuotaStatus(
  env: Env,
  exam: Record<string, unknown>
): Promise<SubjectQuotaGap[]> {
  const examId = exam['id'] as string;
  const collegeId = (exam['college_id'] as string) ?? 'global';

  const subjectQuotas = parseJsonColumn<Record<string, number>>(exam['subject_quotas'], {});
  const chapterQuotas = parseJsonColumn<Record<string, Record<string, number>>>(exam['chapter_quotas'], {});

  // Blueprint subjects = everything mentioned in either quota column.
  const subjects = new Set<string>([...Object.keys(subjectQuotas), ...Object.keys(chapterQuotas)]);
  if (subjects.size === 0) return [];

  const gaps: SubjectQuotaGap[] = [];

  for (const rawSubject of subjects) {
    const subject = rawSubject.toLowerCase().trim();

    // Required count: explicit subject quota wins, else sum the chapter quotas.
    const explicit = subjectQuotas[rawSubject] ?? subjectQuotas[subject];
    const chapters = chapterQuotas[rawSubject] ?? chapterQuotas[subject];
    const required = explicit ?? (chapters ? Object.values(chapters).reduce((a, b) => a + b, 0) : 0);

    const counted = await env.DB.prepare(`
      SELECT COUNT(*) AS c
      FROM exam_questions eq
      JOIN questions q ON q.id = eq.question_id
      WHERE eq.exam_id = ? AND LOWER(q.subject) = ?
    `).bind(examId, subject).first<{ c: number }>();
    const selected = counted?.c ?? 0;

    // Faculty who could fill this subject. Their own college plus the shared
    // 'global' pool, matching how exams are scoped elsewhere.
    const faculty = await env.DB.prepare(`
      SELECT id, email, name
      FROM users
      WHERE role = 'faculty' AND is_active = 1
        AND LOWER(subject) = ?
        AND (college_id = ? OR college_id = 'global')
      ORDER BY email
    `).bind(subject, collegeId).all<{ id: string; email: string; name: string }>();

    let status: SubjectQuotaGap['status'] = 'ok';
    if (required > 0) {
      if (selected === 0) status = 'missing';
      else if (selected < required) status = 'under';
      else if (selected > required) status = 'over';
    }

    gaps.push({ subject: rawSubject, required, selected, status, faculty: faculty.results });
  }

  return gaps;
}

function describeGap(gap: SubjectQuotaGap): { type: GapType; title: string; message: string } {
  const subjectLabel = gap.subject.charAt(0).toUpperCase() + gap.subject.slice(1);

  if (gap.faculty.length === 0) {
    return {
      type: 'faculty_unassigned',
      title: `No faculty assigned for ${subjectLabel}`,
      message: `No faculty account is assigned to ${subjectLabel}, so its quota of ${gap.required} question(s) cannot be filled. Assign a faculty member or adjust the blueprint.`,
    };
  }

  if (gap.status === 'missing') {
    return {
      type: 'quota_missing',
      title: `${subjectLabel} faculty has selected no questions`,
      message: `${subjectLabel} faculty has not selected any questions yet — 0 of ${gap.required} required questions are in this exam.`,
    };
  }

  if (gap.status === 'under') {
    return {
      type: 'quota_shortfall',
      title: `${subjectLabel} quota not met`,
      message: `${subjectLabel} is short of its quota: ${gap.selected} of ${gap.required} required questions have been selected. Ask the faculty to complete the remaining ${gap.required - gap.selected}.`,
    };
  }

  return {
    type: 'quota_excess',
    title: `${subjectLabel} quota exceeded`,
    message: `${subjectLabel} exceeds its quota: ${gap.selected} questions selected against a blueprint of ${gap.required}. Remove ${gap.selected - gap.required} question(s).`,
  };
}

/**
 * Notifies EVERY active faculty of each blueprint subject that a new blueprint
 * needs questions. Two faculties share a subject, so both get their own card —
 * either of them can fulfill the quota. Quota counting is done on SAVED rows,
 * so if both work on it their progress merges and the first to complete a
 * chapter claims it. De-duplicated per recipient+subject so a resubmit after
 * rejection (or a second save) never stacks duplicate cards.
 * Returns the number of notifications created.
 */
export async function notifyBlueprintAssigned(
  env: Env,
  exam: Record<string, unknown>,
  actorId: string
): Promise<number> {
  const examId = exam['id'] as string;
  const collegeId = (exam['college_id'] as string) ?? 'global';
  const examTitle = (exam['title'] as string) ?? 'Exam';
  const difficulty = ((exam['difficulty'] as string) ?? 'medium').toLowerCase();

  const subjectQuotas = parseJsonColumn<Record<string, number>>(exam['subject_quotas'], {});
  const chapterQuotas = parseJsonColumn<Record<string, Record<string, number>>>(exam['chapter_quotas'], {});

  const subjects = new Set<string>([
    ...Object.keys(subjectQuotas),
    ...Object.keys(chapterQuotas),
  ]);
  if (subjects.size === 0) return 0;

  const faculty = await env.DB.prepare(`
    SELECT id, role, subject FROM users
     WHERE role = 'faculty' AND is_active = 1
       AND (college_id = ? OR college_id = 'global')
  `).bind(collegeId).all<{ id: string; role: string; subject: string | null }>();
  if (faculty.results.length === 0) return 0;

  // Don't stack the same card twice per recipient+subject+exam.
  const existing = await env.DB.prepare(`
    SELECT recipient_id, subject FROM notifications
     WHERE exam_id = ? AND type = 'blueprint_assigned'
  `).bind(examId).all<{ recipient_id: string; subject: string | null }>();
  const seen = new Set(
    existing.results.map((r) => `${r.recipient_id}|${(r.subject ?? '').toLowerCase()}`)
  );

  const stmt = env.DB.prepare(`
    INSERT INTO notifications
      (id, recipient_id, recipient_role, college_id, type, title, message, exam_id, subject, meta, created_by)
    VALUES (?, ?, ?, ?, 'blueprint_assigned', ?, ?, ?, ?, ?, ?)
  `);

  const rows: D1PreparedStatement[] = [];
  for (const rawSubject of subjects) {
    const subject = rawSubject.toLowerCase().trim();
    const chapters = chapterQuotas[rawSubject] ?? chapterQuotas[subject];
    const explicit = subjectQuotas[rawSubject] ?? subjectQuotas[subject];
    const required = explicit ?? (chapters ? Object.values(chapters).reduce((a, b) => a + b, 0) : 0);
    if (required <= 0) continue;

    const chapterList = chapters ? Object.keys(chapters).join(', ') : 'all assigned chapters';

    for (const f of faculty.results) {
      if ((f.subject ?? '').toLowerCase() !== subject) continue;
      const key = `${f.id}|${subject}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const title = `[${examTitle}] New ${subject} task`;
      const message =
        `A new blueprint (${difficulty}) needs ${required} ${subject} question${required === 1 ? '' : 's'} ` +
        `from: ${chapterList}. Any faculty of this subject can fill the quota — open Pending Tasks to start.`;
      const meta = JSON.stringify({
        required,
        chapters: chapters ? Object.keys(chapters) : [],
        difficulty,
        exam_title: examTitle,
        shared: true,
      });

      rows.push(stmt.bind(generateId(), f.id, f.role, collegeId, title, message, examId, subject, meta, actorId));
    }
  }

  if (rows.length > 0) await env.DB.batch(rows);
  return rows.length;
}

/**
 * Notifies every principal (and admin) in the exam's college about subjects
 * that are missing / short / over their quota, or have no faculty at all.
 * Returns the number of notifications created.
 */
export async function notifyQuotaGaps(
  env: Env,
  exam: Record<string, unknown>,
  actorId: string,
  gaps: SubjectQuotaGap[]
): Promise<number> {
  const flagged = gaps.filter((g) => g.status !== 'ok' || g.faculty.length === 0);
  if (flagged.length === 0) return 0;

  const examId = exam['id'] as string;
  const collegeId = (exam['college_id'] as string) ?? 'global';
  const examTitle = (exam['title'] as string) ?? 'Exam';

  const staff = await env.DB.prepare(`
    SELECT id, role
    FROM users
    WHERE role IN ('principal','admin') AND is_active = 1
      AND (college_id = ? OR college_id = 'global')
  `).bind(collegeId).all<{ id: string; role: string }>();

  if (staff.results.length === 0) return 0;

  const stmt = env.DB.prepare(`
    INSERT INTO notifications
      (id, recipient_id, recipient_role, college_id, type, title, message, exam_id, subject, meta, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // De-duplicate against unread alerts already sitting in the inbox: an exam
  // submitted twice (or re-audited after a rejection) must not stack identical
  // cards for the same recipient. Mirrors notifyTaskCompleted's behaviour.
  const open = await env.DB.prepare(`
    SELECT recipient_id, subject, type FROM notifications
     WHERE exam_id = ? AND read_at IS NULL
  `).bind(examId).all<{ recipient_id: string; subject: string | null; type: string }>();
  const seen = new Set(
    open.results.map((r) => `${r.recipient_id}|${(r.subject ?? '').toLowerCase()}|${r.type}`)
  );

  const rows: D1PreparedStatement[] = [];
  for (const gap of flagged) {
    const { type, title, message } = describeGap(gap);
    const meta = JSON.stringify({
      required: gap.required,
      selected: gap.selected,
      status: gap.status,
      faculty_count: gap.faculty.length,
      faculty: gap.faculty.map((f) => f.email),
      exam_title: examTitle,
    });

    for (const person of staff.results) {
      const key = `${person.id}|${(gap.subject ?? '').toLowerCase()}|${type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(
        stmt.bind(
          generateId(), person.id, person.role, collegeId,
          type, `[${examTitle}] ${title}`, message,
          examId, gap.subject, meta, actorId
        )
      );
    }
  }

  if (rows.length > 0) await env.DB.batch(rows);
  return rows.length;
}

// ── Task completed notification ───────────────────────────────
// One 'task_completed' note per exam+subject, telling the principal the faculty
// finished their quota. De-duplicated so repeated saves never spam the inbox.
export async function notifyTaskCompleted(
  env: Env,
  exam: Record<string, unknown>,
  actor: { sub: string; name?: string | null; subject?: string | null },
  gaps: SubjectQuotaGap[]
): Promise<number> {
  const subject = (actor.subject ?? '').toLowerCase();
  if (!subject) return 0;

  const mine = gaps.find((g) => g.subject.toLowerCase() === subject);
  if (!mine || mine.required <= 0 || mine.selected !== mine.required) return 0;

  const examId = exam['id'] as string;
  const collegeId = (exam['college_id'] as string) ?? 'global';
  const examTitle = (exam['title'] as string) ?? 'Exam';

  // Already told? Then this is just another save — stay quiet.
  const dup = await env.DB.prepare(
    `SELECT id FROM notifications
      WHERE exam_id = ? AND type = 'task_completed' AND LOWER(subject) = ? LIMIT 1`
  ).bind(examId, subject).first<{ id: string }>();
  if (dup) return 0;

  const staff = await env.DB.prepare(`
    SELECT id, role FROM users
     WHERE role IN ('principal','admin') AND is_active = 1
       AND (college_id = ? OR college_id = 'global')
  `).bind(collegeId).all<{ id: string; role: string }>();
  if (staff.results.length === 0) return 0;

  const who = actor.name?.trim() || 'The faculty';
  const title = `[${examTitle}] ${subject.charAt(0).toUpperCase() + subject.slice(1)} task completed`;
  const message = `${who} has completed the ${subject} quota — ${mine.selected} of ${mine.required} required questions are in this exam. It is ready for your review.`;
  const meta = JSON.stringify({
    subject, required: mine.required, selected: mine.selected,
    completed_by: actor.sub, exam_title: examTitle,
  });

  const stmt = env.DB.prepare(`
    INSERT INTO notifications
      (id, recipient_id, recipient_role, college_id, type, title, message, exam_id, subject, meta, created_by)
    VALUES (?, ?, ?, ?, 'task_completed', ?, ?, ?, ?, ?, ?)
  `);

  await env.DB.batch(staff.results.map((person) =>
    stmt.bind(generateId(), person.id, person.role, collegeId, title, message, examId, subject, meta, actor.sub)
  ));
  return staff.results.length;
}

// ── GET /notifications ────────────────────────────────────────

export async function listNotifications(request: Request, env: Env): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env);
  if (error) return error;

  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200);
  const unreadOnly = url.searchParams.get('unread') === '1';

  const rows = await env.DB.prepare(`
    SELECT * FROM notifications
    WHERE recipient_id = ?
      ${unreadOnly ? 'AND read_at IS NULL' : ''}
    ORDER BY created_at DESC
    LIMIT ?
  `).bind(ctx.user.sub, limit).all();

  const unread = await env.DB.prepare(
    'SELECT COUNT(*) AS c FROM notifications WHERE recipient_id = ? AND read_at IS NULL'
  ).bind(ctx.user.sub).first<{ c: number }>();

  return json({
    notifications: rows.results,
    unread_count: unread?.c ?? 0,
  });
}

// ── PUT /notifications/:id/read ───────────────────────────────

export async function markNotificationRead(request: Request, env: Env, notificationId: string): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env);
  if (error) return error;

  const row = await env.DB.prepare('SELECT id, recipient_id FROM notifications WHERE id = ?')
    .bind(notificationId).first<{ id: string; recipient_id: string }>();
  if (!row) return json404('Notification not found');
  if (row.recipient_id !== ctx.user.sub) return json403('Not your notification');

  await env.DB.prepare('UPDATE notifications SET read_at = unixepoch() WHERE id = ? AND read_at IS NULL')
    .bind(notificationId).run();

  return json({ message: 'Marked as read' });
}

// ── POST /notifications/read-all ──────────────────────────────

export async function markAllNotificationsRead(request: Request, env: Env): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env);
  if (error) return error;

  await env.DB.prepare('UPDATE notifications SET read_at = unixepoch() WHERE recipient_id = ? AND read_at IS NULL')
    .bind(ctx.user.sub).run();

  return json({ message: 'All notifications marked as read' });
}

// ── POST /notifications ───────────────────────────────────────
// The principal (or an admin) sends a message asking faculty to complete
// their task. Targets either an explicit list of user ids, or every faculty
// account responsible for `subject` in the exam's college.

export async function sendNotification(request: Request, env: Env): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['principal', 'admin']);
  if (error) return error;

  let body: {
    message?: string;
    title?: string;
    exam_id?: string;
    subject?: string;
    recipient_ids?: string[];
  };
  try {
    body = await request.json();
  } catch {
    return json400('Invalid JSON');
  }

  const message = (body.message ?? '').trim();
  if (!message) return json400('message is required');

  let exam: Record<string, unknown> | null = null;
  if (body.exam_id) {
    exam = await env.DB.prepare('SELECT id, title, college_id, subject_quotas FROM exams WHERE id = ?')
      .bind(body.exam_id).first<Record<string, unknown>>();
    if (!exam) return json404('Exam not found');
  }

  const collegeId = (exam?.['college_id'] as string) ?? ctx.user.college_id;
  const examTitle = exam ? (exam['title'] as string) : null;

  // ── Resolve recipients ──────────────────────────────────────
  let recipients: Array<{ id: string; role: string; email: string; name: string }> = [];

  if (Array.isArray(body.recipient_ids) && body.recipient_ids.length > 0) {
    const plc = body.recipient_ids.map(() => '?').join(',');
    const rows = await env.DB.prepare(
      `SELECT id, role, email, name FROM users WHERE id IN (${plc}) AND is_active = 1`
    ).bind(...body.recipient_ids).all<{ id: string; role: string; email: string; name: string }>();
    recipients = rows.results;
    if (recipients.length === 0) return json400('None of the given recipient_ids exist');
  } else if (body.subject) {
    const subject = body.subject.toLowerCase().trim();
    const rows = await env.DB.prepare(`
      SELECT id, role, email, name
      FROM users
      WHERE role = 'faculty' AND is_active = 1
        AND LOWER(subject) = ?
        AND (college_id = ? OR college_id = 'global')
      ORDER BY email
    `).bind(subject, collegeId).all<{ id: string; role: string; email: string; name: string }>();
    recipients = rows.results;
    if (recipients.length === 0) {
      return json404(`No active faculty account is assigned to '${subject}' — assign one before sending a reminder.`);
    }
  } else {
    return json400('Provide either recipient_ids or subject');
  }

  const title = (body.title ?? '').trim()
    || (body.subject ? `Action required: complete the ${body.subject} quota` : 'Message from the principal');

  const stmt = env.DB.prepare(`
    INSERT INTO notifications
      (id, recipient_id, recipient_role, college_id, type, title, message, exam_id, subject, meta, created_by)
    VALUES (?, ?, ?, ?, 'principal_message', ?, ?, ?, ?, ?, ?)
  `);

  await env.DB.batch(
    recipients.map((r) => stmt.bind(
      generateId(), r.id, r.role, collegeId,
      examTitle ? `[${examTitle}] ${title}` : title,
      message,
      body.exam_id ?? null,
      body.subject ?? null,
      JSON.stringify({ sent_by: ctx.user.name, exam_title: examTitle }),
      ctx.user.sub
    ))
  );

  return json({
    sent: recipients.length,
    recipients: recipients.map((r) => ({ id: r.id, email: r.email, name: r.name })),
  }, 201);
}

// ── GET /notifications/quota-status ───────────────────────────
// Deliberately coarse per-subject completion view: for each exam with a blueprint
// in the caller's college, which subject faculties have finished and which have
// not. One line per subject — no missing/short/over breakdown.
// "Completed" means the selected count exactly equals the required count.
export async function listQuotaStatus(request: Request, env: Env): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['admin', 'faculty', 'principal']);
  if (error) return error;

  const exams = await env.DB.prepare(`
    SELECT * FROM exams
     WHERE college_id = ?
       AND chapter_quotas IS NOT NULL
       AND status IN ('draft', 'rejected', 'pending_principal_review', 'pending_final_confirmation')
     ORDER BY created_at DESC
     LIMIT 25
  `).bind(ctx.user.college_id).all<Record<string, unknown>>();

  const own = ctx.user.subject ? ctx.user.subject.toLowerCase() : null;
  const isFaculty = ctx.user.role === 'faculty';

  const out = [];
  for (const exam of exams.results) {
    const gaps = await computeExamQuotaStatus(env, exam);
    const subjects = gaps
      .filter(g => !isFaculty || !own || g.subject.toLowerCase() === own)
      .map(g => ({
        subject: g.subject,
        required: g.required,
        selected: g.selected,
        completed: g.selected === g.required,
        faculty: g.faculty.length,
      }));

    if (subjects.length === 0) continue;
    out.push({
      exam_id: exam['id'],
      title: exam['title'],
      status: exam['status'],
      all_completed: subjects.every(s => s.completed),
      subjects,
    });
  }

  return json({ exams: out });
}

// ── Route dispatcher ─────────────────────────────────────────

export async function notificationsRouter(
  request: Request,
  env: Env,
  pathname: string
): Promise<Response | null> {
  const method = request.method;

  if (pathname === '/notifications') {
    if (method === 'GET')  return listNotifications(request, env);
    if (method === 'POST') return sendNotification(request, env);
  }

  if (pathname === '/notifications/read-all' && method === 'POST') {
    return markAllNotificationsRead(request, env);
  }

  if (pathname === '/notifications/quota-status' && method === 'GET') {
    return listQuotaStatus(request, env);
  }

  const readMatch = pathname.match(/^\/notifications\/([^/]+)\/read$/);
  if (readMatch && method === 'PUT') return markNotificationRead(request, env, readMatch[1]);

  return null;
}
