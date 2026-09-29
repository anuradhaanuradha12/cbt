-- ============================================================
-- Migration: Add Difficulty Provenance & Empirical Tracking
-- Applies to: questions (cbt-platform) and approved_questions (cbt-qforge)
-- ============================================================

-- 1. Difficulty Provenance Columns on questions
ALTER TABLE questions ADD COLUMN difficulty_confidence REAL;
ALTER TABLE questions ADD COLUMN difficulty_source TEXT DEFAULT 'legacy_import' 
  CHECK(difficulty_source IN ('legacy_import', 'jev_auto', 'faculty_override'));
ALTER TABLE questions ADD COLUMN difficulty_review_status TEXT DEFAULT 'unreviewed' 
  CHECK(difficulty_review_status IN ('unreviewed', 'auto_approved', 'faculty_reviewed', 'flagged_conflict'));
ALTER TABLE questions ADD COLUMN difficulty_validation_status TEXT DEFAULT 'unvalidated' 
  CHECK(difficulty_validation_status IN ('unvalidated', 'benchmark_validated', 'faculty_validated', 'empirically_validated'));
ALTER TABLE questions ADD COLUMN difficulty_model_version TEXT;
ALTER TABLE questions ADD COLUMN difficulty_rubric_version TEXT;
ALTER TABLE questions ADD COLUMN difficulty_signals TEXT;       -- JSON string of deterministic QuestionSignalData
ALTER TABLE questions ADD COLUMN difficulty_question_hash TEXT;  -- SHA-256 hash to detect question edits
ALTER TABLE questions ADD COLUMN difficulty_classified_at INTEGER;
ALTER TABLE questions ADD COLUMN observed_attempt_count INTEGER DEFAULT 0;
ALTER TABLE questions ADD COLUMN observed_accuracy_rate REAL;   -- Correct / Attempts (0.00 to 1.00)
ALTER TABLE questions ADD COLUMN observed_avg_solve_seconds INTEGER;

CREATE INDEX IF NOT EXISTS idx_questions_diff_eval 
  ON questions(difficulty, difficulty_validation_status, difficulty_confidence);
CREATE INDEX IF NOT EXISTS idx_questions_hash 
  ON questions(difficulty_question_hash);
