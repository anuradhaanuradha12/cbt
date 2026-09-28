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

// full demo exam row
const exam = db
  .prepare(
    `SELECT id, title, status, college_id, starts_at, ends_at, duration_minutes
     FROM exams WHERE id LIKE 'd5565f01%'`
  )
  .get();
console.log('demo exam:', JSON.stringify(exam, null, 1));

// its current questions (subject mix)
const qs = db
  .prepare(
    `SELECT q.id, q.subject, eq.order_index
     FROM exam_questions eq JOIN questions q ON q.id = eq.question_id
     WHERE eq.exam_id = ? ORDER BY eq.order_index`
  )
  .all(exam.id);
console.log('current questions:', qs.map((q) => q.order_index + ':' + q.subject).join(', '));

// pick an image question (physics preferred to match demo mix, else any)
const imgq = db
  .prepare(
    `SELECT id, subject FROM questions
     WHERE COALESCE(option_a,'') LIKE '%[IMG:/images/external/%'
       AND id NOT IN (SELECT question_id FROM exam_questions WHERE exam_id = ?)
     ORDER BY (subject='physics') DESC LIMIT 1`
  )
  .get(exam.id);
console.log('candidate image question:', JSON.stringify(imgq));
