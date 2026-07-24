// Cloudflare Worker environment bindings
// Matches the [[bindings]] declared in wrangler.toml

export interface Env {
  // D1 database
  DB: D1Database;

  // KV namespace — exam cache, sessions, draft saves
  CBT_KV: KVNamespace;

  // R2 bucket — question images/diagrams
  CBT_R2: R2Bucket;

  // Secrets (set via `wrangler secret put`)
  JWT_SECRET: string;
}
