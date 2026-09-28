-- ============================================================
-- 009 — PROD CATCH-UP (additive only)
-- Production D1 was last migrated at 003. Local has 004–008.
-- 002/003 are table-rebuild migrations and must NOT be re-run;
-- everything they produced already exists in prod. This file adds
-- only what's missing, in final form, idempotently.
--
-- Run (remote): wrangler d1 execute cbt-platform --remote --file=src/db/migrations/009_prod_catchup.sql
-- ============================================================

-- ── 004: chapter quotas ──────────────────────────────────────
ALTER TABLE exams ADD COLUMN chapter_quotas TEXT;

-- ── 005: exam-level difficulty ───────────────────────────────
ALTER TABLE exams ADD COLUMN difficulty TEXT NOT NULL DEFAULT 'medium'
  CHECK(difficulty IN ('easy','medium','hard'));

-- ── 005/007/008: notifications (final form from 008) ─────────
CREATE TABLE IF NOT EXISTS notifications (
  id             TEXT PRIMARY KEY,
  recipient_id   TEXT NOT NULL REFERENCES users(id),
  recipient_role TEXT NOT NULL,
  college_id     TEXT NOT NULL DEFAULT 'global',
  type           TEXT NOT NULL
                   CHECK(type IN (
                     'quota_missing',       -- faculty selected nothing for a subject
                     'quota_shortfall',     -- fewer questions than the blueprint requires
                     'quota_excess',        -- more questions than the blueprint requires
                     'faculty_unassigned',  -- no faculty account exists for the subject
                     'principal_message',   -- free-text message from the principal
                     'task_completed',      -- a subject faculty finished their quota
                     'blueprint_assigned'   -- a blueprint needs this subject's questions
                   )),
  title          TEXT NOT NULL,
  message        TEXT NOT NULL,
  exam_id        TEXT REFERENCES exams(id),
  subject        TEXT,
  meta           TEXT,                    -- JSON: { required, selected, status, ... }
  created_by     TEXT REFERENCES users(id),
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  read_at        INTEGER
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient
  ON notifications(recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON notifications(recipient_id, read_at);
CREATE INDEX IF NOT EXISTS idx_notifications_exam
  ON notifications(exam_id);

-- ── college scoping columns/indexes (003-era additions) ──────
ALTER TABLE submissions ADD COLUMN college_id TEXT NOT NULL DEFAULT 'global';

CREATE INDEX IF NOT EXISTS idx_users_college      ON users(college_id);
CREATE INDEX IF NOT EXISTS idx_questions_filter   ON questions(subject, chapter, difficulty);
CREATE INDEX IF NOT EXISTS idx_exams_status       ON exams(status);
CREATE INDEX IF NOT EXISTS idx_exams_college      ON exams(college_id);
CREATE INDEX IF NOT EXISTS idx_eq_exam            ON exam_questions(exam_id);
CREATE INDEX IF NOT EXISTS idx_attempts_exam      ON exam_attempts(exam_id, status);
CREATE INDEX IF NOT EXISTS idx_attempts_student   ON exam_attempts(student_id);
CREATE INDEX IF NOT EXISTS idx_attempts_college   ON exam_attempts(college_id);
CREATE INDEX IF NOT EXISTS idx_events_attempt     ON exam_events(attempt_id);
CREATE INDEX IF NOT EXISTS idx_submissions_exam   ON submissions(exam_id);
CREATE INDEX IF NOT EXISTS idx_submissions_college ON submissions(college_id);
CREATE INDEX IF NOT EXISTS idx_sa_submission      ON submission_answers(submission_id);
CREATE INDEX IF NOT EXISTS idx_sa_question        ON submission_answers(question_id);

-- ── 006: repair the duplicated "hydrogen recoil" question ────
UPDATE questions SET
  question_text = 'When a hydrogen atom emits a photon in going from \( \mathrm{n}=5 \) to \( \mathrm{n}=1 \), its recoil speed is almost',
  option_a = '\( 10^{-4} \mathrm{~m} / \mathrm{s} \)',
  option_b = '\( 2 \times 10^{-2} \mathrm{~m} / \mathrm{s} \)',
  option_c = '\( 4 \mathrm{~m} / \mathrm{s} \)',
  option_d = '\( 8 \times 10^{2} \mathrm{~m} / \mathrm{s} \)',
  correct_answer = 'C',
  explanation = 'Energy of the emitted photon \(=13.6\left(\frac{1}{1}-\frac{1}{25}\right) \mathrm{eV}=13.056 \mathrm{eV}\)
Photon momentum \(p=\frac{E}{c}=\frac{13.056 \times 1.6 \times 10^{-19}}{3 \times 10^{8}} \approx 6.96 \times 10^{-27} \mathrm{~kg} \mathrm{~m} / \mathrm{s}\)
By conservation of momentum the recoiling hydrogen atom carries the same momentum, so \(v=\frac{p}{m}=\frac{6.96 \times 10^{-27}}{1.67 \times 10^{-27}} \approx 4 \mathrm{~m} / \mathrm{s}\)'
WHERE id = '6312307b-31f8-49a4-b09c-fba850fd107d';

UPDATE questions SET
  question_text = 'When a hydrogen atom emits a photon in going from \( \mathrm{n}=5 \) to \( \mathrm{n}=1 \), its recoil speed is almost',
  option_a = '\( 10^{-4} \mathrm{~m} / \mathrm{s} \)',
  option_b = '\( 2 \times 10^{-2} \mathrm{~m} / \mathrm{s} \)',
  option_c = '\( 4 \mathrm{~m} / \mathrm{s} \)',
  option_d = '\( 8 \times 10^{2} \mathrm{~m} / \mathrm{s} \)',
  correct_answer = 'C',
  explanation = 'Energy of the emitted photon \(=13.6\left(\frac{1}{1}-\frac{1}{25}\right) \mathrm{eV}=13.056 \mathrm{eV}\)
Photon momentum \(p=\frac{E}{c}=\frac{13.056 \times 1.6 \times 10^{-19}}{3 \times 10^{8}} \approx 6.96 \times 10^{-27} \mathrm{~kg} \mathrm{~m} / \mathrm{s}\)
By conservation of momentum the recoiling hydrogen atom carries the same momentum, so \(v=\frac{p}{m}=\frac{6.96 \times 10^{-27}}{1.67 \times 10^{-27}} \approx 4 \mathrm{~m} / \mathrm{s}\)'
WHERE id = '7e49698d-c9eb-4d18-9259-73ff1196c938';
