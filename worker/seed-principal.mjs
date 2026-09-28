import crypto from 'crypto';

// Configuration
const EMAIL = 'principal@example.com';
const PASSWORD = 'change_me_in_production';
const NAME = 'Demo Principal';
const ROLE = 'principal';
const COLLEGE_ID = 'ngi'; // Using NGI as the default demo college_id
const ITERATIONS = 100000;
const KEYLEN = 32; // bytes (worker derives 256 bits via WebCrypto — pbkdf2Sync's keylen is in bytes, not hex chars)
const DIGEST = 'sha256';

function generatePasswordHash(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEYLEN, DIGEST).toString('hex');
  return `${salt.toString('hex')}:${hash}`;
}

const id = crypto.randomUUID();
const password_hash = generatePasswordHash(PASSWORD);

const sql = `
INSERT INTO users (id, email, password_hash, role, name, college_id)
VALUES ('${id}', '${EMAIL}', '${password_hash}', '${ROLE}', '${NAME}', '${COLLEGE_ID}');
`;

console.log('--- Principal Seed Script ---');
console.log('Email:', EMAIL);
console.log('Password:', PASSWORD);
console.log('College ID:', COLLEGE_ID);
console.log('\nRun the following SQL command to insert the user into local D1:');
console.log(`npx wrangler d1 execute cbt-platform --local --command="${sql.trim().replace(/\n/g, ' ')}"`);
