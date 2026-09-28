import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const dir = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject';
const dbFile = fs
  .readdirSync(dir)
  .map((f) => dir + '/' + f)
  .filter((f) => f.endsWith('.sqlite'))
  .map((f) => ({ f, s: fs.statSync(f).size }))
  .sort((a, b) => b.s - a.s)[0].f;
const db = new DatabaseSync(dbFile);

const examId = 'd5565f01-943a-49d7-954a-2be12336d699';
const qid = '4adc294d-48a1-410a-9c8f-46493280e530';
const now = Math.floor(Date.now() / 1000);

// 1. refresh the exam window: opened 1h ago, closes in 24h
db.prepare(`UPDATE exams SET starts_at = ?, ends_at = ?, duration_minutes = 30 WHERE id = ?`).run(
  now - 3600,
  now + 86400,
  examId
);

// 2. add the image question as the last question (order_index = max+1)
const max = db.prepare(`SELECT MAX(order_index) m FROM exam_questions WHERE exam_id = ?`).get(examId).m || 0;
db.prepare(
  `INSERT INTO exam_questions (exam_id, question_id, order_index, marks, negative_marks)
   VALUES (?, ?, ?, 4, 1.0)
   ON CONFLICT (exam_id, question_id) DO NOTHING`
).run(examId, qid, max + 1);

// verify
const exam = db.prepare(`SELECT starts_at, ends_at, status FROM exams WHERE id = ?`).get(examId);
const q = db
  .prepare(
    `SELECT q.id, q.subject, eq.order_index FROM exam_questions eq
     JOIN questions q ON q.id = eq.question_id
     WHERE eq.exam_id = ? AND q.id = ?`
  )
  .get(examId, qid);
console.log('exam window now:', JSON.stringify(exam), '| live:', now >= exam.starts_at && now < exam.ends_at);
console.log('image question in exam:', JSON.stringify(q));
