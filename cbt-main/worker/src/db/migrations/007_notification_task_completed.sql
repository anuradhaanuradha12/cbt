-- ============================================================
-- 007 — allow the 'task_completed' notification type
--
-- 'task_completed' tells the principal that a subject's faculty has finished
-- their assigned quota (the positive counterpart to the existing gap alerts).
-- It is written by notifyTaskCompleted() when an exam is submitted for review.
--
-- SQLite cannot ALTER a CHECK constraint, so the table is rebuilt and its rows
-- copied across. Nothing references notifications, so the swap is safe.
-- ============================================================

CREATE TABLE notifications_new (
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
                     'principal_message',  -- free-text message from the principal
                     'task_completed'      -- a subject faculty finished their quota
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

INSERT INTO notifications_new SELECT * FROM notifications;

DROP TABLE notifications;

ALTER TABLE notifications_new RENAME TO notifications;

CREATE INDEX IF NOT EXISTS idx_notifications_recipient
  ON notifications(recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON notifications(recipient_id, read_at);
CREATE INDEX IF NOT EXISTS idx_notifications_exam
  ON notifications(exam_id);
