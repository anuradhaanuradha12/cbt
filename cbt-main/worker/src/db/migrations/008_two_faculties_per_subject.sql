-- ============================================================
-- 008 — two faculties per subject + blueprint task notifications
--
-- 1. Allow the 'blueprint_assigned' notification type: when the principal
--    creates a blueprint, EVERY active faculty of each quota'd subject gets
--    a task notification. Any of them can fulfill the quota; the quota board
--    counts what is SAVED, so both faculties' work merges — first to fill
--    the chapter wins, and the other sees it in their progress.
--
-- 2. Seed a second faculty account per subject (physics, chemistry, maths,
--    biology) so the two-faculty workflow is demo-ready. Password for the
--    new accounts: demo12345 (PBKDF2-SHA256, 100k iterations, random salt
--    pre-computed here for dev convenience).
-- ============================================================

CREATE TABLE notifications_new (
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
                     'blueprint_assigned'   -- NEW: a blueprint needs this subject's questions
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

-- ── Second faculty per subject ───────────────────────────────
-- PBKDF2-SHA256 (100k iters) of "demo12345", salt 8f3e1c9a7b5d2f4e6a8c0b2d4e6f8a1c
-- (hash matches the worker's hashPassword format "salt_hex:hash_hex").
INSERT OR IGNORE INTO users (id, email, password_hash, role, name, subject, college_id, is_active)
VALUES
  ('usr_fac_physics2',  'physics2@cbt.local',  'ed52be3380cc61a43588f243a4973513:a95d114d367d8bee20cedbd8df43473c1359e025dcabeeae0c2aca3a5f6842e3', 'faculty', 'Physics Faculty II',  'physics',  'global', 1),
  ('usr_fac_chem2',     'chemistry2@cbt.local','ed52be3380cc61a43588f243a4973513:a95d114d367d8bee20cedbd8df43473c1359e025dcabeeae0c2aca3a5f6842e3', 'faculty', 'Chemistry Faculty II','chemistry','global', 1),
  ('usr_fac_maths2',    'maths2@cbt.local',    'ed52be3380cc61a43588f243a4973513:a95d114d367d8bee20cedbd8df43473c1359e025dcabeeae0c2aca3a5f6842e3', 'faculty', 'Maths Faculty II',    'maths',    'global', 1),
  ('usr_fac_bio2',      'biology2@cbt.local',  'ed52be3380cc61a43588f243a4973513:a95d114d367d8bee20cedbd8df43473c1359e025dcabeeae0c2aca3a5f6842e3', 'faculty', 'Biology Faculty II',  'biology',  'global', 1);
