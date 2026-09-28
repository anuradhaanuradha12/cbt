import crypto from 'crypto';
import fs from 'fs';

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
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    KEY_LENGTH
  );
  return `${toHex(salt.buffer)}:${toHex(bits)}`;
}

async function run() {
  const passwords = [
    { email: 'teacher@cbt.local', pass: 'physics1_pass' },
    { email: 'faculty_physics@cbt.local', pass: 'physics2_pass' },
    { email: 'faculty@qforge-demo.edu', pass: 'physics3_pass' },
    { email: 'faculty@example.com', pass: 'physics4_pass' },
    { email: 'faculty2@example.com', pass: 'chem1_pass' },
    { email: 'biology@cbt.local', pass: 'bio_pass' },
    { email: 'maths@cbt.local', pass: 'math_pass' },
    { email: 'physics@cbt.local', pass: 'physics5_pass' },
    { email: 'chemistry@cbt.local', pass: 'chem2_pass' }
  ];

  let sql = '';
  for (let p of passwords) {
    const hash = await hashPassword(p.pass);
    sql += `UPDATE users SET password_hash = '${hash}' WHERE email = '${p.email}';\n`;
  }
  
  fs.writeFileSync('update_passwords_utf8.sql', sql, 'utf8');
}

run();
