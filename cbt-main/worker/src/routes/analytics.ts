import { json, json403 } from '../middleware/responses';
import { requireAuth } from '../middleware/auth';
import { subjectScope } from '../utils/subject';
import type { Env } from '../types';

export async function getStudentAnalytics(request: Request, env: Env, studentId: string): Promise<Response> {
  // Principals use this too: their class-wide table drills into a student, and
  // the per-student breakdown is subject-scoped only for faculty.
  const { ctx, error } = await requireAuth(request, env, ['student', 'admin', 'faculty', 'principal']);
  if (error) return error;

  // Students can only view their own analytics
  if (ctx.user.role === 'student' && ctx.user.sub !== studentId) {
    return json403('Not authorized to view these analytics');
  }

  // Subject scoping — faculty only analyse their own subject
  let subjectFilter: string | null = null;
  if (ctx.user.role === 'faculty') {
    const scope = await subjectScope(ctx, env, '');
    if (scope.error) return scope.error;
    subjectFilter = scope.subject; // null only for unrestricted roles
  }

  // 1. Overall Stats
  // For faculty scoped to a subject, overall aggregates only count that
  // subject's answers so "their subject" numbers are what they see.
  const overallQuery = subjectFilter
    ? `
    SELECT
      COUNT(DISTINCT s.id) as total_exams,
      CASE WHEN COUNT(DISTINCT s.id) = 0 THEN 0
           ELSE SUM(sa.marks_awarded) * 1.0 / (COUNT(sa.question_id) * 4) * 100 END as average_score,
      SUM(CASE WHEN sa.is_correct = 1 THEN 1 ELSE 0 END) as total_correct,
      SUM(CASE WHEN sa.is_correct = 0 THEN 1 ELSE 0 END) as total_wrong,
      SUM(CASE WHEN sa.selected_answer IS NULL THEN 1 ELSE 0 END) as total_unattempted
    FROM submissions s
    LEFT JOIN submission_answers sa ON sa.submission_id = s.id
    LEFT JOIN questions q ON q.id = sa.question_id
    WHERE s.student_id = ? AND q.subject = ?
  `
    : `
    SELECT
      COUNT(id) as total_exams,
      AVG(score) as average_score,
      SUM(total_correct) as total_correct,
      SUM(total_wrong) as total_wrong,
      SUM(total_unattempted) as total_unattempted
    FROM submissions
    WHERE student_id = ?
  `;

  const overall = subjectFilter
    ? await env.DB.prepare(overallQuery).bind(studentId, subjectFilter).first()
    : await env.DB.prepare(overallQuery).bind(studentId).first();

  // 2. Subject-wise Performance
  // Faculty: only their subject row is returned — no visibility into others.
  const subjectQuery = `
    SELECT
      q.subject,
      COUNT(sa.question_id) as total_questions,
      SUM(CASE WHEN sa.is_correct = 1 THEN 1 ELSE 0 END) as total_correct,
      SUM(CASE WHEN sa.is_correct = 0 THEN 1 ELSE 0 END) as total_wrong
    FROM submission_answers sa
    JOIN questions q ON q.id = sa.question_id
    JOIN submissions s ON s.id = sa.submission_id
    WHERE s.student_id = ? ${subjectFilter ? 'AND q.subject = ?' : ''}
    GROUP BY q.subject
  `;
  const subjectStats = subjectFilter
    ? await env.DB.prepare(subjectQuery).bind(studentId, subjectFilter).all()
    : await env.DB.prepare(subjectQuery).bind(studentId).all();

  // 3. Chapter-wise Weaknesses
  const chapterQuery = `
    SELECT
      q.chapter,
      q.subject,
      COUNT(sa.question_id) as total_questions,
      SUM(CASE WHEN sa.is_correct = 1 THEN 1 ELSE 0 END) as total_correct,
      SUM(CASE WHEN sa.is_correct = 0 THEN 1 ELSE 0 END) as total_wrong
    FROM submission_answers sa
    JOIN questions q ON q.id = sa.question_id
    JOIN submissions s ON s.id = sa.submission_id
    WHERE s.student_id = ? ${subjectFilter ? 'AND q.subject = ?' : ''}
    GROUP BY q.chapter, q.subject
    ORDER BY total_wrong DESC, total_correct ASC
    LIMIT 20
  `;

  const chapterStats = subjectFilter
    ? await env.DB.prepare(chapterQuery).bind(studentId, subjectFilter).all()
    : await env.DB.prepare(chapterQuery).bind(studentId).all();

  return json({
    overall,
    subjects: subjectStats.results,
    chapters: chapterStats.results
  });
}

// ── GET /analytics/subject ───────────────────────────────────
// "How much did each student score in MY subject?"
//
// A faculty member's Analytics tab opens on this roster: every student in their
// college with the marks they earned in the faculty's own subject, summed across
// every exam they have submitted. Nothing from another subject is ever included —
// the subject filter is applied in SQL and faculty cannot override it (the
// scope is resolved from the users table, not the request).
//
// Admins are unrestricted, so they see one row per student per subject (the
// response then carries a `subject` column and `subject` comes back null).

export async function getSubjectAnalytics(request: Request, env: Env): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['admin', 'faculty']);
  if (error) return error;

  // Faculty are pinned to their own subject; a conflicting ?subject= is a 403.
  const requested = new URL(request.url).searchParams.get('subject') ?? '';
  const scope = await subjectScope(ctx, env, requested);
  if (scope.error) return scope.error;
  const subject = scope.subject || null;

  // marks_possible comes from the exam's own question list (exam_questions.marks),
  // so a question worth 4 counts as 4 whether the student attempted it or not.
  const query = `
    SELECT
      u.id                                     AS student_id,
      u.name                                   AS student_name,
      u.email                                  AS student_email,
      u.batch_name                             AS batch_name,
      q.subject                                AS subject,
      COUNT(DISTINCT s.id)                     AS exams_taken,
      COALESCE(SUM(sa.marks_awarded), 0)       AS marks_scored,
      COALESCE(SUM(COALESCE(eq.marks, 4)), 0)  AS marks_possible,
      SUM(CASE WHEN sa.is_correct = 1 THEN 1 ELSE 0 END)                        AS total_correct,
      SUM(CASE WHEN sa.is_correct = 0 AND sa.selected_answer IS NOT NULL THEN 1 ELSE 0 END) AS total_wrong,
      SUM(CASE WHEN sa.selected_answer IS NULL THEN 1 ELSE 0 END)               AS total_unattempted
    FROM submission_answers sa
    JOIN submissions s ON s.id = sa.submission_id
    JOIN users u ON u.id = s.student_id
    JOIN questions q ON q.id = sa.question_id
    LEFT JOIN exam_questions eq
      ON eq.exam_id = s.exam_id AND eq.question_id = sa.question_id
    WHERE s.college_id = ?${subject ? ' AND q.subject = ?' : ''}
    GROUP BY u.id, q.subject
    ORDER BY marks_scored DESC, u.name ASC
  `;

  const rows = subject
    ? await env.DB.prepare(query).bind(ctx.user.college_id, subject).all()
    : await env.DB.prepare(query).bind(ctx.user.college_id).all();

  const students = (rows.results as Array<Record<string, unknown>>).map((r): Record<string, unknown> => {
    const scored = Number(r['marks_scored'] ?? 0);
    const possible = Number(r['marks_possible'] ?? 0);
    return {
      ...r,
      // Negative marking can push this below 0 — report it as-is rather than
      // clamping, so a student who lost marks is not shown as scoring zero.
      percentage: possible > 0 ? Math.round((scored / possible) * 1000) / 10 : null,
    };
  });

  return json({
    subject,
    // Faculty care about one subject; tell the UI whose it is.
    subjects: [...new Set(students.map((s) => s['subject']))],
    count: students.length,
    students,
  });
}

// ── GET /analytics/overview ──────────────────────────────────
// The principal's view of the whole college: every student, their marks broken
// down by subject, a grand total, and a rank — plus the topper board.
//
// Unrestricted roles only (principal/admin); faculty have no business seeing how
// students are doing outside their own subject.
//
// Students who have not been graded at all are still listed, at zero — a
// principal ranking the college wants the whole roll, not just the scorers.

export async function getClassOverview(request: Request, env: Env): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['principal', 'admin']);
  if (error) return error;

  const rows = await env.DB.prepare(`
    SELECT
      u.id                                                          AS student_id,
      u.name                                                        AS student_name,
      u.email                                                       AS student_email,
      u.batch_name                                                  AS batch_name,
      q.subject                                                     AS subject,
      COALESCE(SUM(sa.marks_awarded), 0)                            AS scored,
      COALESCE(SUM(COALESCE(eq.marks, 4)), 0)                       AS possible
    FROM users u
    LEFT JOIN submissions s ON s.student_id = u.id
    LEFT JOIN submission_answers sa ON sa.submission_id = s.id
    LEFT JOIN questions q ON q.id = sa.question_id
    LEFT JOIN exam_questions eq ON eq.exam_id = s.exam_id AND eq.question_id = sa.question_id
    WHERE u.role = 'student' AND u.college_id = ?
    GROUP BY u.id, q.subject
  `).bind(ctx.user.college_id).all<Record<string, unknown>>();

  // ── Pivot the flat rows into one record per student ──
  const byStudent = new Map<string, {
    student_id: string; student_name: string; student_email: string;
    batch_name: string | null; subjects: Record<string, { scored: number; possible: number; percentage: number | null }>;
    total_scored: number; total_possible: number;
  }>();
  const subjectSet = new Set<string>();

  for (const r of rows.results) {
    const id = r['student_id'] as string;
    let row = byStudent.get(id);
    if (!row) {
      row = {
        student_id: id,
        student_name: (r['student_name'] as string) ?? '',
        student_email: (r['student_email'] as string) ?? '',
        batch_name: (r['batch_name'] as string | null) ?? null,
        subjects: {},
        total_scored: 0,
        total_possible: 0,
      };
      byStudent.set(id, row);
    }

    // A student with no graded work still yields one row with a NULL subject.
    const subject = r['subject'] as string | null;
    if (!subject) continue;

    const scored = Number(r['scored'] ?? 0);
    const possible = Number(r['possible'] ?? 0);
    subjectSet.add(subject);
    row.subjects[subject] = {
      scored,
      possible,
      percentage: possible > 0 ? Math.round((scored / possible) * 1000) / 10 : null,
    };
    row.total_scored += scored;
    row.total_possible += possible;
  }

  const students = [...byStudent.values()]
    .map((s) => ({
      ...s,
      total_scored: Math.round(s.total_scored * 10) / 10,
      percentage: s.total_possible > 0
        ? Math.round((s.total_scored / s.total_possible) * 1000) / 10
        : null,
    }))
    // Highest total first. Ties fall back to name so the order is stable between
    // requests — a topper board that reshuffles on refresh looks broken.
    .sort((a, b) => b.total_scored - a.total_scored || a.student_name.localeCompare(b.student_name));

  // Competition ranking: equal totals share a rank, and the next student skips
  // the places they occupy (1, 2, 2, 4).
  let rank = 0;
  let prev: number | null = null;
  const ranked = students.map((s, i) => {
    if (prev === null || s.total_scored !== prev) rank = i + 1;
    prev = s.total_scored;
    return { ...s, rank };
  });

  const toppers = ranked.filter((s) => s.total_scored > 0).slice(0, 10);

  return json({
    subjects: [...subjectSet].sort(),
    count: ranked.length,
    graded_count: ranked.filter((s) => s.total_possible > 0).length,
    students: ranked,
    toppers,
  });
}

// ── Route Dispatcher ─────────────────────────────────────────

export async function analyticsRouter(
  request: Request,
  env: Env,
  pathname: string
): Promise<Response | null> {
  const method = request.method;

  const studentMatch = pathname.match(/^\/analytics\/student\/([^/]+)$/);
  if (studentMatch && method === 'GET') return getStudentAnalytics(request, env, studentMatch[1]);

  if (pathname === '/analytics/subject' && method === 'GET') return getSubjectAnalytics(request, env);
  if (pathname === '/analytics/overview' && method === 'GET') return getClassOverview(request, env);

  return null;
}
