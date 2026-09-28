// ─── Password Utilities ──────────────────────────────────────────────────────
// Uses PBKDF2 via native WebCrypto — no bcrypt, no npm deps.
// Storage format: "salt_hex:hash_hex"
// 100,000 iterations of PBKDF2-SHA256 (OWASP recommended minimum for 2024)

const ITERATIONS = 100_000;
const KEY_LENGTH = 256; // bits

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

export async function hashPassword(password: string): Promise<string> {
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

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;

  const enc = new TextEncoder();
  const salt = fromHex(saltHex);

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

  // Constant-time comparison to prevent timing attacks
  const candidate = new Uint8Array(bits);
  const expected = fromHex(hashHex);
  if (candidate.length !== expected.length) return false;

  let diff = 0;
  for (let i = 0; i < candidate.length; i++) {
    diff |= candidate[i] ^ expected[i];
  }
  return diff === 0;
}
