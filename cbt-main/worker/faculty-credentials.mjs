// ─── Faculty credential audit ────────────────────────────────────────────────
// Lists every faculty account, checks it can actually authenticate against the
// running dev server, and resets any that can't to the demo password.
//
// Usage:  node faculty-credentials.mjs          (verify only)
//         node faculty-credentials.mjs --reset  (reset failures to demo12345)
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const D1 = path.join(__dirname, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
const BASE = 'http://127.0.0.1:8787';
const PASSWORD = 'demo12345';
const RESET = process.argv.includes('--reset');

const file = fs.readdirSync(D1).filter(f => f.endsWith('.sqlite'))
  .map(f => ({ f, size: fs.statSync(path.join(D1, f)).size }))
  .sort((a, b) => b.size - a.size)[0].f;
const db = new DatabaseSync(path.join(D1, file));

// Same scheme as src/utils/password.ts
async function hashPassword(password) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' }, keyMaterial, 256
  );
  const hex = (buf) => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex(salt.buffer)}:${hex(bits)}`;
}

async function tryLogin(email) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return res.status;
}

const rows = db.prepare(
  `SELECT id, email, name, subject, college_id, password_hash FROM users
    WHERE role = 'faculty' ORDER BY college_id, subject, email`
).all();

console.log(`Faculty accounts: ${rows.length}\n`);

const results = [];
for (const u of rows) {
  let status = await tryLogin(u.email);
  let reset = false;
  if (status !== 200 && RESET) {
    const hash = await hashPassword(PASSWORD);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, u.id);
    status = await tryLogin(u.email);
    reset = true;
  }
  results.push({ ...u, status, reset });
}

const pad = (s, n) => String(s ?? '').padEnd(n);
console.log(pad('EMAIL', 32), pad('NAME', 22), pad('SUBJECT', 11), pad('COLLEGE', 10), 'LOGIN');
console.log('-'.repeat(90));
for (const r of results) {
  console.log(
    pad(r.email, 32), pad(r.name, 22), pad(r.subject, 11), pad(r.college_id, 10),
    r.status === 200 ? `200 OK${r.reset ? ' (reset)' : ''}` : `FAILED ${r.status}`
  );
}

const bad = results.filter(r => r.status !== 200);
console.log(`\n${bad.length === 0 ? 'All faculty accounts can log in.' : `${bad.length} account(s) still failing.`}`);

console.log('\nCopy-paste (all share the password ' + PASSWORD + '):');
for (const r of results) console.log(`  ${r.email}`);
