-- exams.difficulty: blueprint-level difficulty the exam's questions should match.
-- Backfilled to 'medium' — the question bank is overwhelmingly medium, so every
-- exam created before this column existed behaves as before.
ALTER TABLE exams ADD COLUMN difficulty TEXT NOT NULL DEFAULT 'medium'
  CHECK(difficulty IN ('easy','medium','hard'));
