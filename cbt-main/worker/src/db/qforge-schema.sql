-- ============================================================
-- CBT Platform — Proprietary Question Forge Schema (cbt-qforge)
-- This DB is SEPARATE from cbt-platform. It holds ONLY
-- human-curated, AI-assisted questions — never scraped data.
--
-- Run: wrangler d1 execute cbt-qforge --file=src/db/qforge-schema.sql
-- ============================================================

-- ─── Draft Questions (Pipeline) ──────────────────────────────
-- Every AI-generated question starts here.
-- Status flow:
--   pending_ai_review → pending_human_approval (AI score ≥ 0.75)
--                     → ai_flagged            (AI score < 0.75)
--   pending_human_approval → approved | rejected
CREATE TABLE IF NOT EXISTS draft_questions (
  id                       TEXT PRIMARY KEY,
  subject                  TEXT NOT NULL,
  chapter                  TEXT NOT NULL,
  topic                    TEXT,
  difficulty               TEXT NOT NULL CHECK(difficulty IN ('easy','medium','hard')),
  exam_standard            TEXT NOT NULL CHECK(exam_standard IN ('KCET','JEE_MAIN','JEE_ADVANCED','NEET','general')),
  type                     TEXT NOT NULL DEFAULT 'mcq' CHECK(type IN ('mcq','msq','integer')),
  question_text            TEXT NOT NULL,
  option_a                 TEXT,
  option_b                 TEXT,
  option_c                 TEXT,
  option_d                 TEXT,
  correct_answer           TEXT NOT NULL,
  explanation              TEXT,
  -- R2 image keys (nullable — set via image upload endpoint)
  question_image_r2_key    TEXT,           -- image embedded in question body
  option_image_r2_key      TEXT,           -- image shown alongside options (rare)
  explanation_image_r2_key TEXT,           -- step-by-step diagram in explanation
  -- Pipeline tracking
  status                   TEXT NOT NULL DEFAULT 'pending_ai_review'
                             CHECK(status IN (
                               'pending_ai_review',
                               'ai_flagged',
                               'pending_human_approval',
                               'approved',
                               'rejected'
                             )),
  ai_score                 REAL,           -- 0.0–1.0 quality score from Gemini
  ai_feedback              TEXT,           -- JSON: { issues: [], suggestions: [], correct_answer_verified: bool }
  ai_reviewed_at           INTEGER,
  -- Provenance
  created_by               TEXT NOT NULL,  -- user ID of the content-creator intern
  reviewed_by              TEXT,           -- user ID of the approving admin
  created_at               INTEGER NOT NULL DEFAULT (unixepoch()),
  reviewed_at              INTEGER
);
CREATE INDEX IF NOT EXISTS idx_dq_status   ON draft_questions(status);
CREATE INDEX IF NOT EXISTS idx_dq_creator  ON draft_questions(created_by);
CREATE INDEX IF NOT EXISTS idx_dq_filter   ON draft_questions(subject, chapter, difficulty);

-- ─── Approved Questions (Permanent Proprietary Bank) ─────────
-- Questions ONLY land here after passing both AI gate + human approval.
-- This is the final, clean proprietary question bank.
CREATE TABLE IF NOT EXISTS approved_questions (
  id                       TEXT PRIMARY KEY,
  draft_id                 TEXT NOT NULL REFERENCES draft_questions(id),
  subject                  TEXT NOT NULL,
  chapter                  TEXT NOT NULL,
  topic                    TEXT,
  difficulty               TEXT NOT NULL CHECK(difficulty IN ('easy','medium','hard')),
  exam_standard            TEXT NOT NULL CHECK(exam_standard IN ('KCET','JEE_MAIN','JEE_ADVANCED','NEET','general')),
  type                     TEXT NOT NULL DEFAULT 'mcq',
  question_text            TEXT NOT NULL,
  option_a                 TEXT,
  option_b                 TEXT,
  option_c                 TEXT,
  option_d                 TEXT,
  correct_answer           TEXT NOT NULL,
  explanation              TEXT,
  -- R2 image keys (copied from draft on approval)
  question_image_r2_key    TEXT,
  option_image_r2_key      TEXT,
  explanation_image_r2_key TEXT,
  -- Provenance
  ai_score                 REAL,           -- Score at time of approval (audit trail)
  created_by               TEXT NOT NULL,  -- original intern
  approved_by              TEXT NOT NULL,  -- approving admin
  approved_at              INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_aq_filter ON approved_questions(subject, chapter, difficulty, exam_standard);
CREATE INDEX IF NOT EXISTS idx_aq_std    ON approved_questions(exam_standard);
