// Cloudflare Worker environment bindings
// Matches the [[bindings]] declared in wrangler.toml

export interface Env {
  // D1 databases
  DB: D1Database;         // Scraped questions bank (cbt-platform)
  QFORGE_DB: D1Database;  // Proprietary question forge (cbt-qforge)

  // KV namespace — exam cache, sessions, draft saves
  CBT_KV: KVNamespace;

  // R2 bucket — question images/diagrams (shared between both DBs)
  CBT_R2: R2Bucket;

  // Secrets (set via `wrangler secret put`)
  JWT_SECRET: string;
  GEMINI_API_KEY: string;

  // Google OAuth ("Continue with Google") — optional; if unset, the
  // /auth/google routes return a clear setup error.
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;

  // Dev-only guard for the local image ingest route (PUT /images/ingest/:key).
  // Set in .dev.vars for local development; never set in production, where the
  // ingest route therefore always 403s.
  INGEST_SECRET?: string;

  // Static Assets fetcher
  ASSETS?: Fetcher;
}
