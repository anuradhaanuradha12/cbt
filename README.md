# CBT Platform — Monorepo

A multi-tenant, white-labeled **Computer-Based Testing (CBT) platform** for colleges (JEE/NEET/KCET) built entirely on the Cloudflare edge stack.

## Stack

| Layer | Technology |
|---|---|
| Runtime | Cloudflare Workers (TypeScript) |
| Database | Cloudflare D1 (SQLite) |
| Cache | Cloudflare KV |
| Media | Cloudflare R2 |
| Frontend | React + Vite |
| Auth | JWT via Web Crypto API (PBKDF2 passwords) |

## Monorepo Structure

```
cbt/
├── worker/          # Cloudflare Worker — API backend
│   ├── src/
│   │   ├── index.ts          # Router entry point
│   │   ├── config.ts         # Platform constants
│   │   ├── types.ts          # Worker Env bindings
│   │   ├── middleware/       # Auth, role guard
│   │   ├── routes/           # auth, exams, questions, submissions
│   │   ├── db/               # schema.sql + query helpers
│   │   └── utils/            # jwt.ts, password.ts
│   └── wrangler.toml
├── frontend/        # React + Vite SPA
└── shared/          # Shared TypeScript types
```

## Quick Start

### Prerequisites
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) `>=3.78`
- Node.js `>=18`

### 1. Install dependencies
```bash
cd worker && npm install
```

### 2. Create Cloudflare resources
```bash
# D1 database
wrangler d1 create cbt-platform

# KV namespace
wrangler kv namespace create CBT_KV

# R2 bucket
wrangler r2 bucket create cbt-media
```

Copy the output IDs into `worker/wrangler.toml`.

### 3. Set secrets
```bash
wrangler secret put JWT_SECRET
# Enter a long random string (32+ chars)
```

### 4. Apply schema
```bash
cd worker
npm run db:migrate:local   # local dev
npm run db:migrate         # production
```

### 5. Seed initial admin user
```bash
npm run db:seed
```

### 6. Run locally
```bash
npm run dev
```

## API Routes

| Method | Path | Role |
|---|---|---|
| POST | `/auth/login` | public |
| POST | `/auth/logout` | authenticated |
| GET | `/questions` | faculty/admin |
| POST | `/questions` | faculty/admin |
| GET | `/exams` | all |
| POST | `/exams` | faculty/admin |
| GET | `/exams/:id` | student (KV-cached) |
| PUT | `/exams/:id/publish` | admin |
| POST | `/attempts` | student |
| POST | `/attempts/:id/heartbeat` | student |
| POST | `/events` | student |
| POST | `/submissions` | student |
| POST | `/submissions/draft` | student |
| GET | `/submissions/:exam_id` | student |
| GET | `/submissions/:exam_id/report` | faculty/admin |

## Phase Roadmap

- **Phase 1 (Days 1–3):** Single-college MVP — auth, question bank, exam create/publish, student CBT interface, timer, auto-save, submit, results, CSV export
- **Phase 2:** Multi-tenant SaaS — subdomain routing, white-labeling, refresh tokens, analytics, parent portal

## License

Private — All rights reserved.
