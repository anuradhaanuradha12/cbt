# CBT Platform — Monorepo

A multi-tenant, white-labeled **Computer-Based Testing (CBT) platform** for colleges (JEE/NEET/KCET) built entirely on the Cloudflare edge stack.

## Stack

| Layer    | Technology                                |
| -------- | ----------------------------------------- |
| Runtime  | Cloudflare Workers (TypeScript)           |
| Database | Cloudflare D1 (SQLite)                    |
| Cache    | Cloudflare KV                             |
| Media    | Cloudflare R2                             |
| Frontend | Vanilla HTML/CSS/JS (Zero build steps)    |
| Auth     | JWT via Web Crypto API (PBKDF2 passwords) |

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
├── frontend/        # Vanilla HTML/CSS/JS frontend
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

| Method | Path                           | Role                |
| ------ | ------------------------------ | ------------------- |
| POST   | `/auth/login`                  | public              |
| POST   | `/auth/logout`                 | authenticated       |
| GET    | `/questions`                   | faculty/admin       |
| POST   | `/questions`                   | faculty/admin       |
| GET    | `/exams`                       | all                 |
| POST   | `/exams`                       | faculty/admin       |
| GET    | `/exams/:id`                   | student (KV-cached) |
| PUT    | `/exams/:id/publish`           | admin               |
| POST   | `/exams/:id/auto-select-preview` | faculty/admin     |
| POST   | `/exams/:id/auto-replace`      | faculty/admin       |
| PUT    | `/exams/:id/questions`         | faculty/admin       |
| POST   | `/attempts`                    | student             |
| POST   | `/attempts/:id/heartbeat`      | student             |
| POST   | `/events`                      | student             |
| POST   | `/submissions`                 | student             |
| GET    | `/submissions/:exam_id`        | student             |
| GET    | `/submissions/:exam_id/report` | faculty/admin (Role-Scoped Analytics) |
| GET    | `/analytics/student/:id`       | admin/faculty/self  |

## Phase Roadmap

- **Student Frontend**: 100% Complete. Highly polished, timed JEE-style interface featuring MathJax, synchronized state, and client-side anti-cheat question/option shuffling.
- **Admin Frontend**: 100% Complete. Search 97,000+ question bank and assemble custom exams with a click. Added automated multi-tenant quotas assignment & auto-select bulk fulfillment.
- **Analytics UI**: 100% Complete. Real-time dashboards (Average Score, Peak Engagement, Attempt details).
- **Anti-Cheat**: 100% Complete. Strict 3-strike policy enforcing fullscreen, no dev tools, and no tab switching.
- **Exam Scheduling & Waiting Room**: 100% Complete. Scheduled exams unlock exactly at start time. Includes a 5-minute pre-exam instruction screen with zero-leak API payload protection.
- **Automated Reports**: 100% Complete. Cloudflare Worker CRON triggers set up for scheduled parent reporting.
- **Phase 3:** Multi-tenant SaaS — subdomain routing, white-labeling, refresh tokens.

## License

Private — All rights reserved.
