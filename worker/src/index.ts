// ─── Worker Entry Point ───────────────────────────────────────────────────────
// Lightweight manual router — no frameworks, no Node.js modules.
// Pattern: URL pathname matched against route handlers in priority order.

import { authRouter } from './routes/auth';
import { questionsRouter } from './routes/questions';
import { examsRouter } from './routes/exams';
import { attemptsRouter } from './routes/attempts';
import { submissionsRouter } from './routes/submissions';
import { usersRouter } from './routes/users';
import { analyticsRouter } from './routes/analytics';
import { imagesRouter } from './routes/images';
import { forgeRouter } from './routes/forge';
import { handleSubmissionsBatch } from './queue/submission-consumer';
import { handleScoringBatch } from './queue/scoring-consumer';
import { json, json404, handleOptions } from './middleware/responses';
import type { Env } from './types';

// ── CORS Helper ──────────────────────────────────────────────────────────────

function handleCors(request: Request): Response | null {
  if (request.method === 'OPTIONS') {
    return handleOptions();
  }
  return null;
}

// ── Main Entry ───────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // 1. Handle CORS Preflight
    const corsResponse = handleCors(request);
    if (corsResponse) return corsResponse;

    try {
      // 2. Health check
      if (pathname === '/health' && request.method === 'GET') {
        return json({ status: 'ok', timestamp: Math.floor(Date.now() / 1000) });
      }

      // 3. Route Dispatch
      let response: Response | null = null;
      
      response ??= await authRouter(request, env, pathname);
      response ??= await usersRouter(request, env, pathname);
      response ??= await questionsRouter(request, env, pathname);
      response ??= await examsRouter(request, env, pathname);
      response ??= await attemptsRouter(request, env, pathname);
      response ??= await submissionsRouter(request, env, ctx, pathname);
      response ??= await analyticsRouter(request, env, pathname);
      response ??= await imagesRouter(request, env, pathname);
      response ??= await forgeRouter(request, env, pathname);

      if (pathname === '/admin/reconciliation/reset-dlq' && request.method === 'POST') {
        await env.CBT_KV.put('dlq_counter:cbt-submissions-dlq', '0');
        await env.CBT_KV.put('dlq_counter:cbt-scoring-dlq', '0');
        return json({ reset: true, timestamp: new Date().toISOString() });
      }

      if (pathname === '/admin/reconciliation' && request.method === 'GET') {
        const urlParams = new URL(request.url).searchParams;
        const examId = urlParams.get('exam_id');
        const format = urlParams.get('format');
        const expectedStudents = urlParams.get('expected_students');

        if (format === 'audit' && examId) {
          const [
            subRes,
            uniqStudentRes,
            uniqAttemptRes,
            uniqSubIdRes,
            ansRes,
            finAttemptsRes,
            scoredRes,
            dupSubIdRes,
            multiStudentRes,
            multiAttemptRes,
            wrongAnsCountRes,
            notFinRes
          ] = await env.DB.batch<{ count: number }>([
            env.DB.prepare('SELECT COUNT(*) as count FROM submissions WHERE exam_id = ?').bind(examId),
            env.DB.prepare('SELECT COUNT(DISTINCT student_id) as count FROM submissions WHERE exam_id = ?').bind(examId),
            env.DB.prepare('SELECT COUNT(DISTINCT attempt_id) as count FROM submissions WHERE exam_id = ?').bind(examId),
            env.DB.prepare('SELECT COUNT(DISTINCT id) as count FROM submissions WHERE exam_id = ?').bind(examId),
            env.DB.prepare('SELECT COUNT(*) as count FROM submission_answers WHERE submission_id IN (SELECT id FROM submissions WHERE exam_id = ?)').bind(examId),
            env.DB.prepare("SELECT COUNT(*) as count FROM exam_attempts WHERE exam_id = ? AND status = 'submitted'").bind(examId),
            env.DB.prepare('SELECT COUNT(*) as count FROM submissions WHERE exam_id = ? AND score IS NOT NULL').bind(examId),
            env.DB.prepare('SELECT COUNT(*) as count FROM (SELECT id FROM submissions WHERE exam_id = ? GROUP BY id HAVING COUNT(*) > 1)').bind(examId),
            env.DB.prepare('SELECT COUNT(*) as count FROM (SELECT student_id FROM submissions WHERE exam_id = ? GROUP BY student_id HAVING COUNT(*) > 1)').bind(examId),
            env.DB.prepare('SELECT COUNT(*) as count FROM (SELECT attempt_id FROM submissions WHERE exam_id = ? GROUP BY attempt_id HAVING COUNT(*) > 1)').bind(examId),
            env.DB.prepare('SELECT COUNT(*) as count FROM (SELECT s.id FROM submissions s LEFT JOIN submission_answers sa ON sa.submission_id = s.id WHERE s.exam_id = ? GROUP BY s.id HAVING COUNT(sa.question_id) != 10)').bind(examId),
            env.DB.prepare("SELECT COUNT(*) as count FROM submissions s JOIN exam_attempts a ON a.id = s.attempt_id WHERE s.exam_id = ? AND a.status != 'submitted'").bind(examId)
          ]);

          const submissions = Number(subRes.results?.[0]?.count ?? 0);
          const uniqueStudents = Number(uniqStudentRes.results?.[0]?.count ?? 0);
          const uniqueAttempts = Number(uniqAttemptRes.results?.[0]?.count ?? 0);
          const uniqueSubIds = Number(uniqSubIdRes.results?.[0]?.count ?? 0);
          const answers = Number(ansRes.results?.[0]?.count ?? 0);
          const finalizedAttempts = Number(finAttemptsRes.results?.[0]?.count ?? 0);
          const scoredSubmissions = Number(scoredRes.results?.[0]?.count ?? 0);
          const duplicateSubIds = Number(dupSubIdRes.results?.[0]?.count ?? 0);
          const multiStudentSubs = Number(multiStudentRes.results?.[0]?.count ?? 0);
          const multiAttemptSubs = Number(multiAttemptRes.results?.[0]?.count ?? 0);
          const wrongAnsCounts = Number(wrongAnsCountRes.results?.[0]?.count ?? 0);
          const unfinalizedAttempts = Number(notFinRes.results?.[0]?.count ?? 0);

          const expectedCount = expectedStudents ? Number(expectedStudents) : submissions;
          const expectedAnswers = expectedCount * 10;

          const subDlqCount = Number(await env.CBT_KV.get('dlq_counter:cbt-submissions-dlq') || '0');
          const scoreDlqCount = Number(await env.CBT_KV.get('dlq_counter:cbt-scoring-dlq') || '0');

          const invariantsPass = 
            submissions === expectedCount &&
            uniqueStudents === expectedCount &&
            uniqueAttempts === expectedCount &&
            uniqueSubIds === expectedCount &&
            answers === expectedAnswers &&
            finalizedAttempts === expectedCount &&
            duplicateSubIds === 0 &&
            multiStudentSubs === 0 &&
            multiAttemptSubs === 0 &&
            wrongAnsCounts === 0 &&
            unfinalizedAttempts === 0 &&
            subDlqCount === 0;

          return json({
            exam_id: examId,
            expected: {
              students: expectedCount,
              submissions: expectedCount,
              answers: expectedAnswers,
              finalized_attempts: expectedCount
            },
            actual: {
              submissions,
              unique_students: uniqueStudents,
              unique_attempts: uniqueAttempts,
              unique_submission_ids: uniqueSubIds,
              answers,
              finalized_attempts: finalizedAttempts,
              scored_submissions: scoredSubmissions
            },
            invariants: {
              submission_count_exact: submissions === expectedCount,
              unique_student_count_exact: uniqueStudents === expectedCount,
              unique_attempt_count_exact: uniqueAttempts === expectedCount,
              unique_submission_id_exact: uniqueSubIds === expectedCount,
              answer_count_exact: answers === expectedAnswers,
              finalized_attempt_count_exact: finalizedAttempts === expectedCount,
              duplicate_submission_ids: duplicateSubIds,
              students_with_multiple_submissions: multiStudentSubs,
              attempts_with_multiple_submissions: multiAttemptSubs,
              submissions_with_wrong_answer_count: wrongAnsCounts,
              attempts_not_finalized_for_submissions: unfinalizedAttempts
            },
            queue_observation: {
              submission_dlq_messages: subDlqCount,
              scoring_dlq_messages: scoreDlqCount,
              measurement_source: "dlq_consumer_kv_counter",
              observed_at: new Date().toISOString()
            },
            status: invariantsPass ? "PASS" : "DRAINING_OR_FAIL"
          });
        }

        const countQuery = examId 
          ? `SELECT 
               (SELECT COUNT(*) FROM exam_attempts WHERE exam_id = ?) as attempts,
               (SELECT COUNT(*) FROM submissions WHERE exam_id = ?) as submissions,
               (SELECT COUNT(*) FROM submissions WHERE exam_id = ? AND score IS NOT NULL) as scored_submissions,
               (SELECT COUNT(*) FROM submission_answers WHERE submission_id IN (SELECT id FROM submissions WHERE exam_id = ?)) as answers`
          : `SELECT 
               (SELECT COUNT(*) FROM exam_attempts) as attempts,
               (SELECT COUNT(*) FROM submissions) as submissions,
               (SELECT COUNT(*) FROM submissions WHERE score IS NOT NULL) as scored_submissions,
               (SELECT COUNT(*) FROM submission_answers) as answers`;
        
        const params = examId ? [examId, examId, examId, examId] : [];
        const counts = await env.DB.prepare(countQuery).bind(...params).first<Record<string, number>>();
        return json(counts || {});
      }

      if (pathname === '/admin/maintenance/purge-bench' && request.method === 'POST') {
        let totalPurged = 0;
        for (let iter = 0; iter < 100; iter++) {
          const { results } = await env.DB.prepare("SELECT id FROM users WHERE id >= 'bench_s_' AND id < 'bench_t' LIMIT 100").all<{ id: string }>();
          if (!results || results.length === 0) break;
          const stmts = results.map(r => env.DB.prepare("DELETE FROM users WHERE id = ?").bind(r.id));
          await env.DB.batch(stmts);
          totalPurged += results.length;
          if (results.length < 100) break;
        }
        return json({ purged: totalPurged });
      }

      if (response) return response;

      if (env.ASSETS && request.method === 'GET') {
        try {
          return await env.ASSETS.fetch(request);
        } catch (e) {
          // Fall through on error
        }
      }

      return json404(`No route for ${request.method} ${pathname}`);
    } catch (e: any) {
      return json({ error: e.message }, 500);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env) {
    // Cron triggered every week (e.g. Sunday midnight)
    console.log(`Cron triggered at ${event.cron}`);
    try {
      const result = await env.DB.prepare(`
        SELECT COUNT(*) as recent_submissions 
        FROM submissions 
        WHERE submitted_at > ?
      `).bind(Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60).first();
      console.log(`Found ${result?.recent_submissions || 0} recent submissions.`);
    } catch (e: any) {
      console.error('Failed to generate parent reports', e.message);
    }
  },

  async queue(batch: MessageBatch<any>, env: Env, ctx: ExecutionContext): Promise<void> {
    if (batch.queue === 'cbt-submissions-queue') {
      return handleSubmissionsBatch(batch, env, ctx);
    }
    if (batch.queue === 'cbt-scoring-queue') {
      return handleScoringBatch(batch, env, ctx);
    }
    if (batch.queue === 'cbt-submissions-dlq' || batch.queue === 'cbt-scoring-dlq') {
      const key = `dlq_counter:${batch.queue}`;
      const current = Number(await env.CBT_KV.get(key) || '0');
      await env.CBT_KV.put(key, String(current + batch.messages.length));
      batch.ackAll();
      return;
    }
  }
};
