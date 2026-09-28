// Direct SQLite import of questions-export.sql into the local D1 database.
// Bypasses wrangler (which chokes on the large file); uses node:sqlite.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.argv[2];
const SQL_PATH = process.argv[3];

if (!DB_PATH || !SQL_PATH) {
  console.error('usage: node import-questions.cjs <sqlite-path> <sql-file>');
  process.exit(1);
}

const sql = fs.readFileSync(SQL_PATH, 'utf8');

// Quote-aware statement splitter: splits on ';' outside of '...' and "..." strings.
function splitStatements(src) {
  const statements = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inSingle) {
      cur += ch;
      if (ch === "'") {
        if (src[i + 1] === "'") { cur += "'"; i++; } // escaped ''
        else inSingle = false;
      }
    } else if (inDouble) {
      cur += ch;
      if (ch === '"') {
        if (src[i + 1] === '"') { cur += '"'; i++; }
        else inDouble = false;
      }
    } else {
      if (ch === "'") { inSingle = true; cur += ch; }
      else if (ch === '"') { inDouble = true; cur += ch; }
      else if (ch === ';') {
        const stmt = cur.trim();
        if (stmt) statements.push(stmt);
        cur = '';
      } else cur += ch;
    }
  }
  if (cur.trim()) statements.push(cur.trim());
  return statements;
}

const db = new DatabaseSync(DB_PATH, { readOnly: false });

// The export references remote user IDs in created_by that don't exist locally.
db.exec('PRAGMA foreign_keys=OFF;');

db.exec('DROP TABLE IF EXISTS questions;');
db.exec('BEGIN;');
const statements = splitStatements(sql);
let n = 0;
for (const stmt of statements) {
  db.exec(stmt);
  n++;
  if (n % 10000 === 0) console.log(`executed ${n} statements...`);
}
db.exec('COMMIT;');
db.exec('CREATE INDEX IF NOT EXISTS idx_questions_filter ON questions(subject, chapter, difficulty);');

const row = db.prepare('SELECT COUNT(*) AS c FROM questions').get();
console.log(`done: ${n} statements executed; questions in table: ${row.c}`);
db.close();