-- ============================================================
-- Migration 005: In-app notifications
--
-- Backs the exam-blueprint quota workflow:
--   * when faculty submits an exam for principal review, every subject in
--     the blueprint is compared against its required question count; any
--     subject that is missing / short / over raises a notification for the
--     principal (types: quota_missing, quota_shortfall, quota_excess,
--     faculty_unassigned)
--   * the principal can then message the responsible subject faculty, which
--     lands as a principal_message notification for each of them
--
-- Run (local):  wrangler d1 execute cbt-platform --local --file=src/db/migrations/005_notifications.sql
-- Run (remote): wrangler d1 execute cbt-platform --file=src/db/migrations/005_notifications.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS notifications (
  id             TEXT PRIMARY KEY,
  recipient_id   TEXT NOT NULL REFERENCES users(id),
  recipient_role TEXT NOT NULL,
  college_id     TEXT NOT NULL DEFAULT 'global',
  type           TEXT NOT NULL
                   CHECK(type IN (
                     'quota_missing',      -- faculty selected nothing for a subject
                     'quota_shortfall',    -- fewer questions than the blueprint requires
                     'quota_excess',       -- more questions than the blueprint requires
                     'faculty_unassigned', -- no faculty account exists for the subject
                     'principal_message'   -- free-text message from the principal
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
