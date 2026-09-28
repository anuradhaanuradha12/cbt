/**
 * seed-admin.mjs
 * Run once to create the bootstrap admin user in the local D1 database.
 *
 * Usage:
 *   node seed-admin.mjs
 *   (then paste the INSERT statement into wrangler d1 execute)
 *
 * Or pipe directly:
 *   node seed-admin.mjs | npx wrangler d1 execute cbt-platform --local --command
 */

const ITERATIONS = 100_000;
const KEY_LENGTH = 256;

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

const password = 'change_me_in_production'; // Change before use
const hash = await hashPassword(password);
const id = crypto.randomUUID();

const sql = `
-- Run this in: npx wrangler d1 execute cbt-platform --local --command "<paste here>"
INSERT OR IGNORE INTO users (id, email, password_hash, role, name)
VALUES ('${id}', 'admin@example.com', '${hash}', 'admin', 'Platform Admin');
`.trim();

console.log(sql);
console.log(`\n-- Password: ${password}`);
console.log(`-- Hash:     ${hash}`);
