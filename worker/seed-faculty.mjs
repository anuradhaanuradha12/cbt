import crypto from 'crypto';
import fs from 'fs';

// Configuration
const EMAIL = 'faculty@qforge-demo.edu';
const PASSWORD = 'FacultyPassword@123';
const NAME = 'Dr. Demo Faculty';
const ROLE = 'faculty';
const SUBJECT = 'physics';
const COLLEGE_ID = 'ngi'; // Using NGI as the default demo college_id
const ITERATIONS = 100000;
const KEYLEN = 64;
const DIGEST = 'sha256';

function generatePasswordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEYLEN, DIGEST).toString('hex');
  return `${salt}:${hash}`;
}

const id = crypto.randomUUID();
const password_hash = generatePasswordHash(PASSWORD);

const sql = `
INSERT INTO users (id, email, password_hash, role, name, subject, college_id)
VALUES ('${id}', '${EMAIL}', '${password_hash}', '${ROLE}', '${NAME}', '${SUBJECT}', '${COLLEGE_ID}');
`;

console.log('--- Faculty Seed Script ---');
console.log('Email:', EMAIL);
console.log('Password:', PASSWORD);
console.log('College ID:', COLLEGE_ID);
console.log('\nRun the following SQL command to insert the user into local D1:');
console.log(`npx wrangler d1 execute cbt-platform --local --command="${sql.trim().replace(/\n/g, ' ')}"`);
