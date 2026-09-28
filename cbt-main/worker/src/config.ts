// ─── Platform Config ─────────────────────────────────────────────────────────
// Phase 1: Single-college hardcoded constants.
// Phase 2: Replace COLLEGE_ID with Host-header middleware (2-hour task).

export const COLLEGE_ID = 'client1';
export const PLATFORM_NAME = 'CBT Platform';
export const PLATFORM_DOMAIN = 'localhost'; // Replace with cbtplatform.com on deploy

// JWT
export const JWT_EXPIRY_SECONDS = 6 * 60 * 60; // 6 hours (exam duration safe)

// KV TTLs (seconds)
export const KV_EXAM_CACHE_TTL = 60 * 60;       // 1 hour — exam question payload
export const KV_DRAFT_EXTRA_TTL = 30 * 60;       // 30 min grace after exam ends
export const KV_SESSION_TTL = JWT_EXPIRY_SECONDS; // matches JWT lifetime

// Submission
// 5 minutes: matches the client's outage policy — a student whose internet
// drops mid-exam keeps answering locally and the client auto-submits as soon
// as connectivity returns, even if that is after ends_at. The server must
// accept that late submission instead of discarding their work.
export const SUBMIT_GRACE_SECONDS = 300;

// CORS — tighten in production to your actual frontend domain
export const CORS_ORIGIN = '*';
