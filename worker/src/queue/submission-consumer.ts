import type { MessageBatch, ExecutionContext } from '@cloudflare/workers-types';
import type { Env, SubmissionMessage, ScoringMessage } from '../types';

/**
 * Persistence Consumer (Domain 1)
 * Consumes batches of SubmissionMessage from cbt-submissions-queue.
 * Controlled with max_concurrency = 1 (or 2) to protect D1 from write storms.
 *
 * Invariants:
 * 1. Multi-entity idempotency:
 *    - submissions: ON CONFLICT(id) DO NOTHING
 *    - submission_answers: ON CONFLICT(submission_id, question_id) DO NOTHING
 *    - exam_attempts: status = 'submitted' WHERE id = ?
 * 2. KV Draft safety net:
 *    - Delete KV draft ONLY after D1 persistence commit succeeds.
 * 3. Two-phase decoupling:
 *    - Enqueue ScoringMessage into cbt-scoring-queue.
 * 4. Explicit message acknowledgment:
 *    - msg.ack() only after D1 transaction commit.
 */
export async function handleSubmissionsBatch(
  batch: MessageBatch<SubmissionMessage>,
  env: Env,
  _ctx: ExecutionContext
): Promise<void> {
  if (!batch.messages || batch.messages.length === 0) return;

  const validMessages = batch.messages.filter(m => m.body && m.body.submission_id && m.body.attempt_id);
  if (validMessages.length === 0) {
    batch.ackAll();
    return;
  }

  // Group exam question lookups so we can populate all questions for each submission
  const examIds = [...new Set(validMessages.map(m => m.body.exam_id))];
  const examQuestionsMap = new Map<string, string[]>();

  // Fetch question IDs for distinct exams in this batch
  await Promise.all(
    examIds.map(async examId => {
      try {
        const rows = await env.DB.prepare(
          'SELECT question_id FROM exam_questions WHERE exam_id = ?'
        ).bind(examId).all<{ question_id: string }>();
        examQuestionsMap.set(examId, rows.results.map(r => r.question_id));
      } catch (err) {
        console.error(`Failed to fetch questions for exam ${examId}:`, err);
        examQuestionsMap.set(examId, []);
      }
    })
  );

  const persistenceStmts: D1PreparedStatement[] = [];
  const successfulMessages: typeof validMessages = [];
  const scoringMessages: ScoringMessage[] = [];

  for (const msg of validMessages) {
    const p = msg.body;
    const now = Math.floor(Date.now() / 1000);

    // 1. Finalize attempt (idempotent, only if not already submitted)
    persistenceStmts.push(
      env.DB.prepare(
        "UPDATE exam_attempts SET status = 'submitted', last_seen_at = ? WHERE id = ? AND status != 'submitted'"
      ).bind(now, p.attempt_id)
    );

    // 2. Insert submission record (idempotent ON CONFLICT DO NOTHING)
    persistenceStmts.push(
      env.DB.prepare(`
        INSERT INTO submissions (id, attempt_id, exam_id, student_id, time_taken_seconds, college_id, submitted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `).bind(
        p.submission_id,
        p.attempt_id,
        p.exam_id,
        p.student_id,
        p.time_taken_seconds,
        p.college_id,
        p.submitted_at || now
      )
    );

    // 3. Insert all submission answers (even unattempted, ON CONFLICT DO NOTHING)
    const qList = examQuestionsMap.get(p.exam_id) || Object.keys(p.answers || {});
    for (const qId of qList) {
      persistenceStmts.push(
        env.DB.prepare(`
          INSERT INTO submission_answers (submission_id, question_id, selected_answer, marked_for_review, answered_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(submission_id, question_id) DO NOTHING
        `).bind(
          p.submission_id,
          qId,
          p.answers[qId] ?? null,
          p.marked_for_review?.includes(qId) ? 1 : 0,
          p.answer_timestamps?.[qId] ?? null
        )
      );
    }

    successfulMessages.push(msg);
    scoringMessages.push({
      submission_id: p.submission_id,
      exam_id: p.exam_id,
      college_id: p.college_id
    });
  }

  try {
    // Execute atomic D1 persistence batch for all messages in this batch
    if (persistenceStmts.length > 0) {
      await env.DB.batch(persistenceStmts);
    }

    // Phase 1 succeeded! Post-commit cleanup:
    // 1. Delete KV draft keys for committed attempts (draft safety net fulfilled)
    await Promise.all(
      successfulMessages.map(m =>
        env.CBT_KV.delete(`draft:${m.body.exam_id}:${m.body.student_id}`).catch(() => {})
      )
    );

    // 2. Enqueue scoring messages into Domain 2 (cbt-scoring-queue)
    if (scoringMessages.length > 0 && env.SCORING_QUEUE) {
      await Promise.all(
        scoringMessages.map(sm =>
          env.SCORING_QUEUE.send(sm).catch(err => {
            console.error(`Failed to enqueue scoring for ${sm.submission_id}:`, err);
          })
        )
      );
    }

    // 3. Acknowledge messages to cbt-submissions-queue
    for (const msg of successfulMessages) {
      msg.ack();
    }
  } catch (err: any) {
    console.error('D1 persistence batch failed in handleSubmissionsBatch:', err);
    // Do NOT ack messages; Cloudflare Queues will retry with exponential backoff up to max_retries
    for (const msg of validMessages) {
      msg.retry();
    }
    throw err;
  }
}
