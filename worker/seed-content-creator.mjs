/**
 * seed-content-creator.mjs
 * Creates a content-creator (intern) account in the CBT platform.
 *
 * Usage:
 *   node seed-content-creator.mjs
 *
 * Then copy the printed SQL and run:
 *   npx wrangler d1 execute cbt-platform --remote --command "<paste INSERT here>"
 *
 * Or for local dev:
 *   npx wrangler d1 execute cbt-platform --local --command "<paste INSERT here>"
 *
 * To create multiple interns, run this script multiple times with different configs below.
 */

// ── Configure intern details here ────────────────────────────────────────────
const INTERN_NAME     = 'Intern One';         // ← Change for each intern
const INTERN_EMAIL    = 'intern1@ngi.edu';    // ← Change for each intern
const INTERN_PASSWORD = 'Intern@1234';        // ← Change (or use a random generator)
const INTERN_SUBJECT  = 'physics';            // ← Lock to a subject, or leave '' for all subjects
// ─────────────────────────────────────────────────────────────────────────────

const ITERATIONS = 100_000;
const KEY_LENGTH  = 256;

function toHex(buf) {
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hashPassword(password) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    keyMaterial, KEY_LENGTH
  );
  return `${toHex(salt.buffer)}:${toHex(bits)}`;
}

const hash    = await hashPassword(INTERN_PASSWORD);
const id      = crypto.randomUUID();
const subject = INTERN_SUBJECT ? `'${INTERN_SUBJECT}'` : 'NULL';

const sql = `INSERT OR IGNORE INTO users (id, email, password_hash, role, name, subject)
VALUES ('${id}', '${INTERN_EMAIL}', '${hash}', 'content-creator', '${INTERN_NAME}', ${subject});`;

console.log('\n── Generated SQL ────────────────────────────────────────────');
console.log(sql);
console.log('\n── Run with ─────────────────────────────────────────────────');
console.log(`npx wrangler d1 execute cbt-platform --remote --command "${sql.replace(/\n/g,' ')}"`);
console.log('\n── Credentials ──────────────────────────────────────────────');
console.log(`  Email:    ${INTERN_EMAIL}`);
console.log(`  Password: ${INTERN_PASSWORD}`);
console.log(`  Role:     content-creator`);
console.log(`  Subject:  ${INTERN_SUBJECT || '(all)'}`);
console.log('─────────────────────────────────────────────────────────────\n');
