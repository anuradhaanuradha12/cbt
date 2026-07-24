import { json, json403 } from '../middleware/responses';
import { requireAuth } from '../middleware/auth';
import type { Env } from '../types';

export async function getStudentAnalytics(request: Request, env: Env, studentId: string): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['student', 'admin', 'faculty']);
  if (error) return error;

  // Students can only view their own analytics
  if (ctx.user.role === 'student' && ctx.user.sub !== studentId) {
    return json403('Not authorized to view these analytics');
  }

  // 1. Overall Stats
  const overall = await env.DB.prepare(`
    SELECT 
      COUNT(id) as total_exams,
      AVG(score) as average_score,
      SUM(total_correct) as total_correct,
      SUM(total_wrong) as total_wrong,
      SUM(total_unattempted) as total_unattempted
    FROM submissions 
    WHERE student_id = ?
  `).bind(studentId).first();

  // 2. Subject-wise Performance
  const subjectStats = await env.DB.prepare(`
    SELECT 
      q.subject,
      COUNT(sa.question_id) as total_questions,
      SUM(CASE WHEN sa.is_correct = 1 THEN 1 ELSE 0 END) as total_correct,
      SUM(CASE WHEN sa.is_correct = 0 THEN 1 ELSE 0 END) as total_wrong
    FROM submission_answers sa
    JOIN questions q ON q.id = sa.question_id
    JOIN submissions s ON s.id = sa.submission_id
    WHERE s.student_id = ?
    GROUP BY q.subject
  `).bind(studentId).all();

  // 3. Chapter-wise Weaknesses
  const chapterStats = await env.DB.prepare(`
    SELECT 
      q.chapter,
      q.subject,
      COUNT(sa.question_id) as total_questions,
      SUM(CASE WHEN sa.is_correct = 1 THEN 1 ELSE 0 END) as total_correct,
      SUM(CASE WHEN sa.is_correct = 0 THEN 1 ELSE 0 END) as total_wrong
    FROM submission_answers sa
    JOIN questions q ON q.id = sa.question_id
    JOIN submissions s ON s.id = sa.submission_id
    WHERE s.student_id = ?
    GROUP BY q.chapter, q.subject
    ORDER BY total_wrong DESC, total_correct ASC
    LIMIT 20
  `).bind(studentId).all();

  return json({
    overall,
    subjects: subjectStats.results,
    chapters: chapterStats.results
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

  return null;
}
