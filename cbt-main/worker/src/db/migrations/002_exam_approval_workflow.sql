-- ============================================================
-- Migration 002: Exam approval workflow (faculty -> principal)
-- Adds the 'principal' role and the review columns/status values
-- needed for: draft -> pending_faculty_review -> pending_principal_review -> published
--
-- D1 enforces foreign_keys=ON for every statement and does not allow
-- disabling it (PRAGMA foreign_keys=OFF is a no-op inside D1's implicit
-- per-execute transaction). SQLite also auto-rewrites *other* tables'
-- REFERENCES clauses whenever a referenced table is RENAMEd. So a plain
-- "rebuild users, rebuild exams" migration leaves exam_questions /
-- exam_attempts / exam_events / submissions / submission_answers still
-- pointing at the renamed-away old copies — which would then reject any
-- FUTURE insert referencing a row that only exists in the new tables.
--
-- To avoid that, every table that transitively FK-references users/exams
-- (everything except the untouched 86k-row `questions` table) is rebuilt
-- here too, in dependency order (parents before children), so each new
-- table is created fresh with correct REFERENCES text bound to the
-- already-finalized parent. All old copies are dropped at the end, by
-- which point nothing references them anymore.
--
-- Run: wrangler d1 execute cbt-platform --local --file=src/db/migrations/002_exam_approval_workflow.sql
--      wrangler d1 execute cbt-platform --file=src/db/migrations/002_exam_approval_workflow.sql   (remote)
-- ============================================================

-- ─── 1. users: allow role = 'principal' ────────────────────────
ALTER TABLE users RENAME TO users_v1;
DROP INDEX idx_users_college;

CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  email        TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role         TEXT NOT NULL CHECK(role IN ('admin','faculty','student','content-creator','principal')),
  name         TEXT NOT NULL,
  subject      TEXT,
  batch_name   TEXT,
  college_id   TEXT NOT NULL DEFAULT 'global',
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT INTO users (id, email, password_hash, role, name, subject, batch_name, college_id, is_active, created_at)
SELECT id, email, password_hash, role, name, subject, batch_name, college_id, is_active, created_at FROM users_v1;
CREATE INDEX idx_users_college ON users(college_id);

-- ─── 2. questions: no schema change, but created_by REFERENCES users
--        was auto-rewritten to users_v1 by step 1's rename — rebuild so
--        it re-binds to the finalized `users` table (needed for any
--        question inserted/edited by a user created after this migration) ──
ALTER TABLE questions RENAME TO questions_v1;
DROP INDEX idx_questions_filter;

CREATE TABLE questions (
  id             TEXT PRIMARY KEY,
  subject        TEXT NOT NULL,
  chapter        TEXT NOT NULL,
  difficulty     TEXT NOT NULL CHECK(difficulty IN ('easy','medium','hard')),
  type           TEXT NOT NULL CHECK(type IN ('mcq','msq','integer')),
  question_text  TEXT NOT NULL,
  option_a       TEXT,
  option_b       TEXT,
  option_c       TEXT,
  option_d       TEXT,
  correct_answer TEXT NOT NULL,
  explanation    TEXT,
  image_r2_key   TEXT,
  explanation_image_r2_key TEXT,
  created_by     TEXT REFERENCES users(id),
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT INTO questions (
  id, subject, chapter, difficulty, type, question_text,
  option_a, option_b, option_c, option_d, correct_answer, explanation,
  image_r2_key, explanation_image_r2_key, created_by, created_at
)
SELECT
  id, subject, chapter, difficulty, type, question_text,
  option_a, option_b, option_c, option_d, correct_answer, explanation,
  image_r2_key, explanation_image_r2_key, created_by, created_at
FROM questions_v1;
CREATE INDEX idx_questions_filter ON questions(subject, chapter, difficulty);

-- ─── 3. exams: new statuses + review columns ───────────────────
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
                   CHECK(status IN ('draft','pending_faculty_review','pending_principal_review','rejected','published','ongoing','completed','archived')),
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
  rejection_stage        TEXT CHECK(rejection_stage IN ('faculty','principal')),
  rejection_reason       TEXT
);
INSERT INTO exams (
  id, parent_exam_id, version, title, description, target_batch, exam_type,
  duration_minutes, total_marks, status, config_snapshot, subject_quotas,
  starts_at, ends_at, college_id, created_by, created_at
)
SELECT
  id, parent_exam_id, version, title, description, target_batch, exam_type,
  duration_minutes, total_marks, status, config_snapshot, subject_quotas,
  starts_at, ends_at, college_id, created_by, created_at
FROM exams_v1;
CREATE INDEX idx_exams_status ON exams(status);
CREATE INDEX idx_exams_college ON exams(college_id);

-- ─── 3. exam_questions: rebuild so exam_id/question_id re-bind to the finalized tables ──
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

-- ─── 4. exam_attempts: rebuild so exam_id/student_id re-bind ───
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

-- ─── 5. exam_events: rebuild so attempt_id re-binds ─────────────
ALTER TABLE exam_events RENAME TO exam_events_v1;
DROP INDEX idx_events_attempt;

CREATE TABLE exam_events (
  id          TEXT PRIMARY KEY,
  attempt_id  TEXT NOT NULL REFERENCES exam_attempts(id),
  event_type  TEXT NOT NULL
                CHECK(event_type IN ('tab_hidden','window_blur','fullscreen_exit','copy','paste','focus_lost')),
  occurred_at INTEGER NOT NULL DEFAULT (unixepoch()),
  metadata    TEXT
);
INSERT INTO exam_events SELECT * FROM exam_events_v1;
CREATE INDEX idx_events_attempt ON exam_events(attempt_id);

-- ─── 6. submissions: rebuild so attempt_id/exam_id/student_id re-bind ──
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

-- ─── 7. submission_answers: rebuild so submission_id/question_id re-bind ──
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
DROP TABLE questions_v1;
DROP TABLE exams_v1;
DROP TABLE users_v1;
