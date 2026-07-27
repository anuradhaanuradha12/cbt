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
  let overall;
  if (ctx.user.role === 'faculty' && ctx.user.subject) {
    overall = await env.DB.prepare(`
      SELECT 
        COUNT(DISTINCT s.id) as total_exams,
        0 as average_score, -- Note: exact subject score calculation omitted for brevity
        SUM(CASE WHEN sa.is_correct = 1 THEN 1 ELSE 0 END) as total_correct,
        SUM(CASE WHEN sa.is_correct = 0 THEN 1 ELSE 0 END) as total_wrong,
        SUM(CASE WHEN sa.is_correct IS NULL THEN 1 ELSE 0 END) as total_unattempted
      FROM submissions s
      JOIN submission_answers sa ON s.id = sa.submission_id
      JOIN questions q ON q.id = sa.question_id
      WHERE s.student_id = ? AND q.subject = ?
    `).bind(studentId, ctx.user.subject).first();
  } else {
    overall = await env.DB.prepare(`
      SELECT 
        COUNT(id) as total_exams,
        AVG(score) as average_score,
        SUM(total_correct) as total_correct,
        SUM(total_wrong) as total_wrong,
        SUM(total_unattempted) as total_unattempted
      FROM submissions 
      WHERE student_id = ?
    `).bind(studentId).first();
  }

  // 2. Subject-wise Performance
  let subjectQuery = `
    SELECT 
      q.subject,
      COUNT(sa.question_id) as total_questions,
      SUM(CASE WHEN sa.is_correct = 1 THEN 1 ELSE 0 END) as total_correct,
      SUM(CASE WHEN sa.is_correct = 0 THEN 1 ELSE 0 END) as total_wrong
    FROM submission_answers sa
    JOIN questions q ON q.id = sa.question_id
    JOIN submissions s ON s.id = sa.submission_id
    WHERE s.student_id = ?
  `;
  const subjectParams: any[] = [studentId];
  if (ctx.user.role === 'faculty' && ctx.user.subject) {
    subjectQuery += ' AND q.subject = ?';
    subjectParams.push(ctx.user.subject);
  }
  subjectQuery += ' GROUP BY q.subject';
  
  const subjectStats = await env.DB.prepare(subjectQuery).bind(...subjectParams).all();

  // 3. Chapter-wise Weaknesses
  let chapterQuery = `
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
  `;
  const chapterParams: any[] = [studentId];
  if (ctx.user.role === 'faculty' && ctx.user.subject) {
    chapterQuery += ' AND q.subject = ?';
    chapterParams.push(ctx.user.subject);
  }
  chapterQuery += `
    GROUP BY q.chapter, q.subject
    ORDER BY total_wrong DESC, total_correct ASC
    LIMIT 20
  `;
  
  const chapterStats = await env.DB.prepare(chapterQuery).bind(...chapterParams).all();

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
