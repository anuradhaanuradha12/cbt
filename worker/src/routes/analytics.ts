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
        0 as average_score,
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
    overall: overall || { total_exams: 0, average_score: 0, total_correct: 0, total_wrong: 0, total_unattempted: 0 },
    subjects: subjectStats.results || [],
    chapters: chapterStats.results || []
  });
}

export async function getAnalyticsOverview(request: Request, env: Env): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['admin', 'faculty']);
  if (error) return error;

  const collegeId = ctx.user.college_id;
  const isGlobal = collegeId === 'global';

  // 1. Get all students in college
  const studentsQuery = isGlobal
    ? 'SELECT id, name, email, batch_name FROM users WHERE role = "student" AND is_active = 1 ORDER BY name ASC'
    : 'SELECT id, name, email, batch_name FROM users WHERE role = "student" AND is_active = 1 AND college_id = ? ORDER BY name ASC';
  const studentsRes = isGlobal
    ? await env.DB.prepare(studentsQuery).all<{ id: string; name: string; email: string; batch_name: string | null }>()
    : await env.DB.prepare(studentsQuery).bind(collegeId).all<{ id: string; name: string; email: string; batch_name: string | null }>();
  
  const studentList = studentsRes.results || [];

  // 2. Fetch all student scores per subject
  const scoresQuery = `
    SELECT 
      s.student_id,
      q.subject,
      COALESCE(SUM(sa.marks_awarded), 0) as scored,
      COALESCE(SUM(eq.marks), 0) as possible
    FROM submissions s
    JOIN submission_answers sa ON s.id = sa.submission_id
    JOIN questions q ON q.id = sa.question_id
    JOIN exam_questions eq ON eq.exam_id = s.exam_id AND eq.question_id = sa.question_id
    ${isGlobal ? '' : 'WHERE s.college_id = ?'}
    GROUP BY s.student_id, q.subject
  `;
  const scoresRes = isGlobal
    ? await env.DB.prepare(scoresQuery).all<{ student_id: string; subject: string; scored: number; possible: number }>()
    : await env.DB.prepare(scoresQuery).bind(collegeId).all<{ student_id: string; subject: string; scored: number; possible: number }>();

  // Map scores by student_id
  const studentScoresMap = new Map<string, { subjects: Record<string, { scored: number; possible: number }>; totalScored: number; totalPossible: number }>();
  for (const row of scoresRes.results || []) {
    if (!studentScoresMap.has(row.student_id)) {
      studentScoresMap.set(row.student_id, { subjects: {}, totalScored: 0, totalPossible: 0 });
    }
    const rec = studentScoresMap.get(row.student_id)!;
    rec.subjects[row.subject] = { scored: Number(row.scored || 0), possible: Number(row.possible || 0) };
    rec.totalScored += Number(row.scored || 0);
    rec.totalPossible += Number(row.possible || 0);
  }

  const subjects = ['physics', 'chemistry', 'mathematics', 'biology'];
  
  // Format students array
  const formattedStudents = studentList.map(st => {
    const scoreData = studentScoresMap.get(st.id) || { subjects: {}, totalScored: 0, totalPossible: 0 };
    const hasTaken = studentScoresMap.has(st.id) && scoreData.totalPossible > 0;
    const percentage = hasTaken ? Math.round((scoreData.totalScored / scoreData.totalPossible) * 100) : null;
    return {
      student_id: st.id,
      student_name: st.name,
      student_email: st.email,
      batch_name: st.batch_name,
      subjects: scoreData.subjects,
      total_scored: scoreData.totalScored,
      total_possible: scoreData.totalPossible,
      percentage,
      rank: 0
    };
  });

  // Sort graded students by total_scored descending, then calculate ranks
  formattedStudents.sort((a, b) => {
    if (a.percentage === null && b.percentage === null) return a.student_name.localeCompare(b.student_name);
    if (a.percentage === null) return 1;
    if (b.percentage === null) return -1;
    return b.total_scored - a.total_scored;
  });

  let rank = 1;
  let gradedCount = 0;
  for (const st of formattedStudents) {
    if (st.percentage !== null) {
      st.rank = rank++;
      gradedCount++;
    }
  }

  const toppers = formattedStudents.filter(s => s.percentage !== null).slice(0, 5);

  return json({
    count: studentList.length,
    graded_count: gradedCount,
    subjects,
    students: formattedStudents,
    toppers
  });
}

export async function getSubjectAnalytics(request: Request, env: Env): Promise<Response> {
  const { ctx, error } = await requireAuth(request, env, ['admin', 'faculty']);
  if (error) return error;

  const isFaculty = ctx.user.role === 'faculty';
  const targetSubject = isFaculty ? ctx.user.subject : null;
  const collegeId = ctx.user.college_id;
  const isGlobal = collegeId === 'global';

  let query = `
    SELECT 
      u.id as student_id,
      u.name as student_name,
      u.email as student_email,
      q.subject,
      COUNT(DISTINCT s.id) as exams_taken,
      COALESCE(SUM(sa.marks_awarded), 0) as marks_scored,
      COALESCE(SUM(eq.marks), 0) as marks_possible
    FROM users u
    JOIN submissions s ON s.student_id = u.id
    JOIN submission_answers sa ON s.id = sa.submission_id
    JOIN questions q ON q.id = sa.question_id
    JOIN exam_questions eq ON eq.exam_id = s.exam_id AND eq.question_id = sa.question_id
    WHERE u.role = 'student' AND u.is_active = 1
  `;
  const params: any[] = [];

  if (!isGlobal) {
    query += ' AND u.college_id = ?';
    params.push(collegeId);
  }

  if (targetSubject) {
    query += ' AND q.subject = ?';
    params.push(targetSubject);
  }

  query += `
    GROUP BY u.id, q.subject
    ORDER BY marks_scored DESC
  `;

  const results = await env.DB.prepare(query).bind(...params).all<{
    student_id: string;
    student_name: string;
    student_email: string;
    subject: string;
    exams_taken: number;
    marks_scored: number;
    marks_possible: number;
  }>();

  const students = (results.results || []).map(r => {
    const percentage = r.marks_possible > 0 ? Math.round((r.marks_scored / r.marks_possible) * 100) : null;
    return {
      student_id: r.student_id,
      student_name: r.student_name,
      student_email: r.student_email,
      subject: r.subject,
      exams_taken: r.exams_taken,
      marks_scored: r.marks_scored,
      marks_possible: r.marks_possible,
      percentage
    };
  });

  return json({
    subject: targetSubject || null,
    students
  });
}

// ── Route Dispatcher ─────────────────────────────────────────

export async function analyticsRouter(
  request: Request,
  env: Env,
  pathname: string
): Promise<Response | null> {
  const method = request.method;

  if (pathname === '/analytics/overview' && method === 'GET') {
    return getAnalyticsOverview(request, env);
  }

  if (pathname === '/analytics/subject' && method === 'GET') {
    return getSubjectAnalytics(request, env);
  }

  const studentMatch = pathname.match(/^\/analytics\/student\/([^/]+)$/);
  if (studentMatch && method === 'GET') {
    return getStudentAnalytics(request, env, studentMatch[1]);
  }

  return null;
}
