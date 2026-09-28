-- ============================================================
-- Migration 003: Two-stage approval workflow
-- Replaces the old 3-stage chain (faculty creates -> DIFFERENT faculty
-- reviews -> principal reviews -> published) with a simpler back-and-forth
-- that doesn't require a second faculty account:
--   draft -> pending_principal_review (faculty submits)
--         -> pending_final_confirmation (principal approves)
--         -> published (same faculty gives the final go-ahead)
--
-- Same SQLite/D1 constraint as migration 002: foreign_keys is always on
-- and can't be disabled, and renaming a table auto-rewrites every OTHER
-- table's REFERENCES text to the new name. So every table that
-- transitively references `exams` (everything except users/questions,
-- which aren't changing this time) gets rebuilt here too, in dependency
-- order, so each ends up correctly bound to the finalized table names.
--
-- Run: wrangler d1 execute cbt-platform --local --file=src/db/migrations/003_two_stage_workflow.sql
--      wrangler d1 execute cbt-platform --file=src/db/migrations/003_two_stage_workflow.sql   (remote)
-- ============================================================

-- ─── 1. exams: new statuses + rejection_stage values ───────────
ALTER TABLE exams RENAME TO exams_v1;
DROP INDEX idx_exams_status;
DROP INDEX idx_exams_college;

CREATE TABLE exams (
  id             TEXT PRIMARY KEY,
  parent_exam_id TEXT REFERENCES exams(id),
  version        INTEGER NOT NULL DEFAULT 1,
  title          TEXT NOT NULL,
  description    TEXT,
  target_batch   TEXT,
  exam_type      TEXT NOT NULL DEFAULT 'custom',
  duration_minutes INTEGER NOT NULL,
  total_marks    INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'draft'
                   CHECK(status IN ('draft','pending_principal_review','pending_final_confirmation','rejected','published','ongoing','completed','archived')),
  config_snapshot TEXT,
  subject_quotas  TEXT,
  starts_at      INTEGER,
  ends_at        INTEGER,
  college_id     TEXT NOT NULL DEFAULT 'global',
  created_by     TEXT REFERENCES users(id),
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  faculty_reviewed_by    TEXT REFERENCES users(id),
  faculty_reviewed_at    INTEGER,
  principal_reviewed_by  TEXT REFERENCES users(id),
  principal_reviewed_at  INTEGER,
  rejected_by            TEXT REFERENCES users(id),
  rejected_at            INTEGER,
  rejection_stage        TEXT CHECK(rejection_stage IN ('principal','faculty_final')),
  rejection_reason       TEXT
);
INSERT INTO exams (
  id, parent_exam_id, version, title, description, target_batch, exam_type,
  duration_minutes, total_marks, status, config_snapshot, subject_quotas,
  starts_at, ends_at, college_id, created_by, created_at,
  faculty_reviewed_by, faculty_reviewed_at, principal_reviewed_by, principal_reviewed_at,
  rejected_by, rejected_at, rejection_stage, rejection_reason
)
SELECT
  id, parent_exam_id, version, title, description, target_batch, exam_type,
  duration_minutes, total_marks,
  CASE WHEN status = 'pending_faculty_review' THEN 'pending_principal_review' ELSE status END,
  config_snapshot, subject_quotas,
  starts_at, ends_at, college_id, created_by, created_at,
  faculty_reviewed_by, faculty_reviewed_at, principal_reviewed_by, principal_reviewed_at,
  rejected_by, rejected_at,
  CASE WHEN rejection_stage = 'faculty' THEN NULL ELSE rejection_stage END,
  rejection_reason
FROM exams_v1;
CREATE INDEX idx_exams_status ON exams(status);
CREATE INDEX idx_exams_college ON exams(college_id);

-- ─── 2. exam_questions: rebuild so exam_id re-binds ─────────────
ALTER TABLE exam_questions RENAME TO exam_questions_v1;
DROP INDEX idx_eq_exam;

CREATE TABLE exam_questions (
  exam_id        TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  question_id    TEXT NOT NULL REFERENCES questions(id),
  order_index    INTEGER NOT NULL,
  marks          INTEGER NOT NULL DEFAULT 4,
  negative_marks REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (exam_id, question_id)
);
INSERT INTO exam_questions SELECT * FROM exam_questions_v1;
CREATE INDEX idx_eq_exam ON exam_questions(exam_id);

-- ─── 3. exam_attempts: rebuild so exam_id/student_id re-bind ───
ALTER TABLE exam_attempts RENAME TO exam_attempts_v1;
DROP INDEX idx_attempts_exam;
DROP INDEX idx_attempts_student;
DROP INDEX idx_attempts_college;

CREATE TABLE exam_attempts (
  id           TEXT PRIMARY KEY,
  exam_id      TEXT NOT NULL REFERENCES exams(id),
  student_id   TEXT NOT NULL REFERENCES users(id),
  started_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
  ip_address   TEXT,
  user_agent   TEXT,
  college_id   TEXT NOT NULL DEFAULT 'global',
  status       TEXT NOT NULL DEFAULT 'in_progress'
                 CHECK(status IN ('in_progress','submitted','abandoned','timed_out')),
  UNIQUE(exam_id, student_id)
);
INSERT INTO exam_attempts SELECT * FROM exam_attempts_v1;
CREATE INDEX idx_attempts_exam    ON exam_attempts(exam_id, status);
CREATE INDEX idx_attempts_student ON exam_attempts(student_id);
CREATE INDEX idx_attempts_college ON exam_attempts(college_id);

-- ─── 4. exam_events: rebuild so attempt_id re-binds ─────────────
ALTER TABLE exam_events RENAME TO exam_events_v1;
DROP INDEX idx_events_attempt;

CREATE TABLE exam_events (
  id          TEXT PRIMARY KEY,
  attempt_id  TEXT NOT NULL REFERENCES exam_attempts(id),
  event_type  TEXT NOT NULL
                CHECK(event_type IN ('tab_hidden','window_blur','fullscreen_exit','copy','paste','focus_lost','strike_issued')),
  occurred_at INTEGER NOT NULL DEFAULT (unixepoch()),
  metadata    TEXT
);
INSERT INTO exam_events SELECT * FROM exam_events_v1;
CREATE INDEX idx_events_attempt ON exam_events(attempt_id);

-- ─── 5. submissions: rebuild so attempt_id/exam_id/student_id re-bind ──
ALTER TABLE submissions RENAME TO submissions_v1;
DROP INDEX idx_submissions_exam;
DROP INDEX idx_submissions_college;

CREATE TABLE submissions (
  id                  TEXT PRIMARY KEY,
  attempt_id          TEXT NOT NULL UNIQUE REFERENCES exam_attempts(id),
  exam_id             TEXT NOT NULL REFERENCES exams(id),
  student_id          TEXT NOT NULL REFERENCES users(id),
  score               REAL,
  total_correct       INTEGER,
  total_wrong         INTEGER,
  total_unattempted   INTEGER,
  college_id          TEXT NOT NULL DEFAULT 'global',
  submitted_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  time_taken_seconds  INTEGER,
  UNIQUE(exam_id, student_id)
);
INSERT INTO submissions SELECT * FROM submissions_v1;
CREATE INDEX idx_submissions_exam    ON submissions(exam_id);
CREATE INDEX idx_submissions_college ON submissions(college_id);

-- ─── 6. submission_answers: rebuild so submission_id re-binds ──
ALTER TABLE submission_answers RENAME TO submission_answers_v1;
DROP INDEX idx_sa_submission;
DROP INDEX idx_sa_question;

CREATE TABLE submission_answers (
  submission_id    TEXT NOT NULL REFERENCES submissions(id),
  question_id      TEXT NOT NULL REFERENCES questions(id),
  selected_answer  TEXT,
  marked_for_review INTEGER NOT NULL DEFAULT 0,
  answered_at      INTEGER,
  is_correct       INTEGER,
  marks_awarded    REAL,
  PRIMARY KEY (submission_id, question_id)
);
INSERT INTO submission_answers SELECT * FROM submission_answers_v1;
CREATE INDEX idx_sa_submission ON submission_answers(submission_id);
CREATE INDEX idx_sa_question   ON submission_answers(question_id);

-- ─── Cleanup: nothing references the _v1 copies anymore ────────
DROP TABLE submission_answers_v1;
DROP TABLE submissions_v1;
DROP TABLE exam_events_v1;
DROP TABLE exam_attempts_v1;
DROP TABLE exam_questions_v1;
DROP TABLE exams_v1;
