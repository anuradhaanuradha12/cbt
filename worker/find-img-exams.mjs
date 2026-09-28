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

const rows = db
  .prepare(
    `SELECT eq.exam_id, e.title, e.status, COUNT(*) AS img_q
     FROM exam_questions eq
     JOIN questions q ON q.id = eq.question_id
     JOIN exams e ON e.id = eq.exam_id
     WHERE COALESCE(q.option_a,'')||COALESCE(q.option_b,'')||COALESCE(q.option_c,'')||COALESCE(q.option_d,'')||COALESCE(q.question_text,'') LIKE '%[IMG:/images/external/%'
     GROUP BY eq.exam_id ORDER BY img_q DESC LIMIT 8`
  )
  .all();
console.log('exams containing [IMG:] questions:');
for (const r of rows) console.log(' ', r.exam_id, '|', String(r.title).slice(0, 30), '|', r.status, '| img questions:', r.img_q);
