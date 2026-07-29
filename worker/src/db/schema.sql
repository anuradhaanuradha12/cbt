-- ============================================================
-- CBT Platform — D1 Schema
-- Single-college MVP (college_id added in Phase 2)
-- Run: wrangler d1 execute cbt-platform --file=src/db/schema.sql
-- ============================================================

-- ─── Users ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  email        TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,          -- format: "salt_hex:pbkdf2_hash_hex"
  role         TEXT NOT NULL CHECK(role IN ('admin','faculty','student','content-creator')),
  name         TEXT NOT NULL,
  subject      TEXT,                    -- For Faculty SMEs (e.g., physics, chemistry)
  batch_name   TEXT,                    -- For students to filter exams
  college_id   TEXT NOT NULL DEFAULT 'global',
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_users_college ON users(college_id);

-- ─── Questions ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS questions (
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
CREATE INDEX IF NOT EXISTS idx_questions_filter
  ON questions(subject, chapter, difficulty);

-- ─── Exams ──────────────────────────────────────────────────
-- parent_exam_id + version support versioned papers (v1, v2…)
-- config_snapshot is frozen JSON at publish time — scoring never
-- reads from mutable columns after this is set.
CREATE TABLE IF NOT EXISTS exams (
  id             TEXT PRIMARY KEY,
  parent_exam_id TEXT REFERENCES exams(id),
  version        INTEGER NOT NULL DEFAULT 1,
  title          TEXT NOT NULL,
  description    TEXT,
  target_batch   TEXT,                -- Null means global
  exam_type      TEXT NOT NULL DEFAULT 'custom',
  duration_minutes INTEGER NOT NULL,
  total_marks    INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'draft'
                   CHECK(status IN ('draft','published','ongoing','completed','archived')),
  config_snapshot TEXT,               -- immutable JSON, set on publish
  subject_quotas  TEXT,               -- JSON specifying quotas e.g. {"physics":30}
  starts_at      INTEGER,             -- unix timestamp
  ends_at        INTEGER,             -- starts_at + duration_minutes * 60
  college_id     TEXT NOT NULL DEFAULT 'global',
  created_by     TEXT REFERENCES users(id),
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_exams_status ON exams(status);
CREATE INDEX IF NOT EXISTS idx_exams_college ON exams(college_id);

-- ─── Exam Questions ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS exam_questions (
  exam_id        TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  question_id    TEXT NOT NULL REFERENCES questions(id),
  order_index    INTEGER NOT NULL,
  marks          INTEGER NOT NULL DEFAULT 4,
  negative_marks REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (exam_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_eq_exam ON exam_questions(exam_id);

-- ─── Exam Attempts ───────────────────────────────────────────
-- One row per student per exam. Created when student clicks "Start Exam".
-- Enables: live dashboard, attendance, resume after crash, audit trail.
CREATE TABLE IF NOT EXISTS exam_attempts (
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
CREATE INDEX IF NOT EXISTS idx_attempts_exam   ON exam_attempts(exam_id, status);
CREATE INDEX IF NOT EXISTS idx_attempts_student ON exam_attempts(student_id);
CREATE INDEX IF NOT EXISTS idx_attempts_college ON exam_attempts(college_id);

-- ─── Exam Events (Anti-Cheat Log) ────────────────────────────
-- Passive logging only. No automatic penalty. Faculty reviews.
CREATE TABLE IF NOT EXISTS exam_events (
  id          TEXT PRIMARY KEY,
  attempt_id  TEXT NOT NULL REFERENCES exam_attempts(id),
  event_type  TEXT NOT NULL
                CHECK(event_type IN ('tab_hidden','window_blur','fullscreen_exit','copy','paste','focus_lost')),
  occurred_at INTEGER NOT NULL DEFAULT (unixepoch()),
  metadata    TEXT                               -- JSON (e.g. { "count": 3 })
);
CREATE INDEX IF NOT EXISTS idx_events_attempt ON exam_events(attempt_id);

-- ─── Submissions ─────────────────────────────────────────────
-- One row per student per exam (attempt → submission on submit).
-- score/correct/wrong are computed async via waitUntil().
CREATE TABLE IF NOT EXISTS submissions (
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
CREATE INDEX IF NOT EXISTS idx_submissions_exam ON submissions(exam_id);
CREATE INDEX IF NOT EXISTS idx_submissions_college ON submissions(college_id);

-- ─── Submission Answers (normalized) ─────────────────────────
-- Primary source of truth for answers. One row per question per submission.
-- Enables: per-question analytics, heatmaps, student review mode, reports.
CREATE TABLE IF NOT EXISTS submission_answers (
  submission_id    TEXT NOT NULL REFERENCES submissions(id),
  question_id      TEXT NOT NULL REFERENCES questions(id),
  selected_answer  TEXT,            -- null = not attempted
  marked_for_review INTEGER NOT NULL DEFAULT 0,
  answered_at      INTEGER,         -- client-side timestamp for timing analytics
  is_correct       INTEGER,         -- 1 / 0 / null (null = not attempted)
  marks_awarded    REAL,            -- positive, negative, or 0
  PRIMARY KEY (submission_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_sa_submission ON submission_answers(submission_id);
CREATE INDEX IF NOT EXISTS idx_sa_question   ON submission_answers(question_id);
