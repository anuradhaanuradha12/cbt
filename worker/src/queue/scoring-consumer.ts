import type { MessageBatch, ExecutionContext } from '@cloudflare/workers-types';
import type { Env, ScoringMessage } from '../types';
import type { ExamConfig } from '../../../shared/types';

/**
 * Scoring Consumer (Domain 2)
 * Consumes batches of ScoringMessage from cbt-scoring-queue.
 * Grades submissions, calculates marks, and updates empirical question calibration.
 *
 * Invariants:
 * 1. Fully decoupled from submission ingestion.
 * 2. Scoring failures do not roll back the student's authoritative submission or answers.
 * 3. Question difficulty calibration updates are executed asynchronously.
 */
export async function handleScoringBatch(
  batch: MessageBatch<ScoringMessage>,
  env: Env,
  _ctx: ExecutionContext
): Promise<void> {
  if (!batch.messages || batch.messages.length === 0) return;

  const validMessages = batch.messages.filter(m => m.body && m.body.submission_id);
  if (validMessages.length === 0) {
    batch.ackAll();
    return;
  }

  // Process scoring for each submission in the batch
  for (const msg of validMessages) {
    const { submission_id, exam_id } = msg.body;
    try {
      // 1. Fetch exam configuration snapshot
      const exam = await env.DB.prepare(
        'SELECT config_snapshot FROM exams WHERE id = ?'
      ).bind(exam_id).first<{ config_snapshot: string | null }>();

      const config: ExamConfig = exam?.config_snapshot
        ? JSON.parse(exam.config_snapshot)
        : { marks_correct: 4, marks_wrong: 1, negative_marking: true };

      // 2. Fetch submitted answers joined with correct answers
      const rows = await env.DB.prepare(`
        SELECT sa.question_id, sa.selected_answer, q.correct_answer, sa.submission_id
        FROM submission_answers sa
        JOIN questions q ON q.id = sa.question_id
        WHERE sa.submission_id = ?
      `).bind(submission_id).all<{
        question_id: string;
        selected_answer: string | null;
        correct_answer: string;
        submission_id: string;
      }>();

      let score = 0;
      let totalCorrect = 0;
      let totalWrong = 0;
      let totalUnattempted = 0;

      const updates = rows.results.map(row => {
        let isCorrect: number | null = null;
        let marksAwarded = 0;

        if (row.selected_answer === null) {
          totalUnattempted++;
        } else if (row.selected_answer === row.correct_answer) {
          isCorrect = 1;
          marksAwarded = config.marks_correct ?? 4;
          totalCorrect++;
          score += marksAwarded;
        } else {
          isCorrect = 0;
          marksAwarded = config.negative_marking ? -(config.marks_wrong ?? 1) : 0;
          totalWrong++;
          score += marksAwarded;
        }

        return env.DB.prepare(`
          UPDATE submission_answers SET is_correct = ?, marks_awarded = ?
          WHERE submission_id = ? AND question_id = ?
        `).bind(isCorrect, marksAwarded, submission_id, row.question_id);
      });

      // Update submission summary totals
      const updateSubmissionStmt = env.DB.prepare(`
        UPDATE submissions SET score = ?, total_correct = ?, total_wrong = ?, total_unattempted = ?
        WHERE id = ?
      `).bind(score, totalCorrect, totalWrong, totalUnattempted, submission_id);

      // Execute scoring update batch for this submission
      await env.DB.batch([...updates, updateSubmissionStmt]);

      // 3. Update Empirical Calibration Metrics
      try {
        const questionUpdates = rows.results
          .filter(r => r.selected_answer !== null)
          .map(r => {
            const isCorr = r.selected_answer === r.correct_answer ? 1 : 0;
            return env.DB.prepare(`
              UPDATE questions
              SET 
                observed_attempt_count = COALESCE(observed_attempt_count, 0) + 1,
                observed_accuracy_rate = (
                  (COALESCE(observed_accuracy_rate, 0.0) * COALESCE(observed_attempt_count, 0) + ?) / 
                  (COALESCE(observed_attempt_count, 0) + 1)
                ),
                difficulty_validation_status = CASE 
                  WHEN (COALESCE(observed_attempt_count, 0) + 1) >= 50 THEN 'empirically_validated'
                  ELSE difficulty_validation_status
                END,
                difficulty_review_status = CASE
                  WHEN (COALESCE(observed_attempt_count, 0) + 1) >= 50 
                       AND difficulty = 'easy' 
                       AND ((COALESCE(observed_accuracy_rate, 0.0) * COALESCE(observed_attempt_count, 0) + ?) / (COALESCE(observed_attempt_count, 0) + 1)) < 0.35
                       AND COALESCE(difficulty_confidence, 0.0) >= 0.80
                  THEN 'flagged_conflict'
                  ELSE difficulty_review_status
                END
              WHERE id = ?
            `).bind(isCorr, isCorr, r.question_id);
          });

        if (questionUpdates.length > 0) {
          await env.DB.batch(questionUpdates);
        }
      } catch (calibErr) {
        console.error(`Calibration update non-critical warning for submission ${submission_id}:`, calibErr);
      }

      msg.ack();
    } catch (err: any) {
      console.error(`Scoring consumer failed for submission ${submission_id}:`, err);
      msg.retry();
    }
  }
}
