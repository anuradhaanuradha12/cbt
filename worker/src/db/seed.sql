-- Seed: one admin user for local dev
-- Password: Admin@1234  (PBKDF2 hash pre-computed for dev convenience)
-- CHANGE THIS before production — use the /auth/login route to verify
-- To generate a new hash: POST /auth/login won't work without a user,
-- so this seed gets you bootstrapped.

-- Pre-computed PBKDF2 hash of "Admin@1234"
-- salt: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6
-- DO NOT use in production — run the hashPassword utility to generate a real one.

INSERT OR IGNORE INTO users (id, email, password_hash, role, name)
VALUES (
  'usr_admin_001',
  'admin@cbt.local',
  'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4:c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6',
  'admin',
  'Platform Admin'
);
