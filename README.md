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
# D1 database (Scraped Questions)
wrangler d1 create cbt-platform

# D1 database (Proprietary AI Questions)
wrangler d1 create cbt-qforge

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
| POST   | `/forge/generate`              | admin/content-creator |
| POST   | `/forge/submit`                | admin/content-creator |
| GET    | `/forge/drafts`                | admin/content-creator |
| PATCH  | `/forge/drafts/:id`            | admin/content-creator |
| POST   | `/forge/:id/ai-review`         | admin/content-creator |
| POST   | `/forge/:id/approve`           | admin                 |
| POST   | `/forge/:id/reject`            | admin                 |
| GET    | `/forge/approved`              | admin/faculty/content-creator |

## Phase Roadmap

- **Student Frontend**: 100% Complete. Highly polished, timed JEE-style interface featuring MathJax, synchronized state, and client-side anti-cheat question/option shuffling.
- **Admin Frontend**: 100% Complete. Search 97,000+ question bank and assemble custom exams with a click. Added automated multi-tenant quotas assignment & auto-select bulk fulfillment.
- **Analytics UI**: 100% Complete. Real-time dashboards (Average Score, Peak Engagement, Attempt details).
- **Anti-Cheat**: 100% Complete. Strict 3-strike policy enforcing fullscreen, no dev tools, and no tab switching.
- **Exam Scheduling & Waiting Room**: 100% Complete. Scheduled exams unlock exactly at start time. Includes a 5-minute pre-exam instruction screen with zero-leak API payload protection.
- **Automated Reports**: 100% Complete. Cloudflare Worker CRON triggers set up for scheduled parent reporting.
- **Phase 3: Question Forge**: 100% Complete. Isolated AI database (`cbt-qforge`), Gemini 2.0 pipeline, 2-tier approval workflow, and `question-gen.html` portal for content-creator interns.
- **Phase 4: QForge Multi-Tenant SaaS**: 100% Complete. `college_id` isolation for exams and student attempts, StepVista rebranding (Zinc/Emerald dark mode), and faculty-scoped access.

## QForge Integration
The application uses the secondary `QFORGE_DB` database for fetching proprietary AI-generated questions generated by Content Creators. Content Creators draft the questions on a standalone QForge app, and the CBT Platform's Admin imports them here.

---

## Live Demo Credentials

Use these credentials to access the deployed **QForge CBT Platform** (`https://qforge.shishira-932.workers.dev`):

### 1. Platform Admin
- **Email:** `admin@cbt.local`
- **Password:** `AdminSecret@2026`
- **Role:** Can create exams, manage all users, and assign subjects/batches.
- **College ID:** `global`

### 2. Faculty
- **Email:** `faculty@qforge-demo.edu`
- **Password:** `FacultyPassword@123`
- **Role:** Subject Matter Expert. Reviews AI questions and monitors students.
- **College ID:** `ngi`

### 3. Student
- **Email:** `student@qforge-demo.edu`
- **Password:** `StudentPassword@123`
- **Role:** Exam taker. Can only view published exams assigned to their college (`ngi`).
- **College ID:** `ngi`

### 4. Content Creator
- **Email:** `intern1@ngi.edu`
- **Password:** `Intern1@2026`
- **Role:** Drafts questions using the QForge AI generator.
- **College ID:** `ngi`

---

## Multi-Tenant Onboarding (Adding New Colleges)

The platform is designed to handle multiple colleges seamlessly using the `college_id` column for absolute data isolation. To onboard a new college (e.g., "StepVista Academy" with ID `stepvista`):

1. **Create Faculty for the New College:**
   The admin creates new faculty accounts and sets their `college_id` to `stepvista`.
   ```sql
   INSERT INTO users (id, email, password_hash, role, name, college_id) 
   VALUES ('uuid-here', 'teacher@stepvista.edu', 'hash-here', 'faculty', 'Mr. Teacher', 'stepvista');
   ```

2. **Create Students for the New College:**
   Students are enrolled similarly with `college_id` set to `stepvista`.
   ```sql
   INSERT INTO users (id, email, password_hash, role, name, college_id) 
   VALUES ('uuid2-here', 'student@stepvista.edu', 'hash-here', 'student', 'John Doe', 'stepvista');
   ```

3. **Data Isolation (How it works under the hood):**
   - When the Admin creates an exam for `stepvista`, the `college_id` is automatically attached to the `exams` row.
   - When a student from `stepvista` logs in, they can **only** query `exams` where `college_id = 'stepvista'`.
   - When a faculty member from `stepvista` logs in, they can **only** query `exam_attempts` and `submissions` for exams that belong to `stepvista`.
   - This ensures **zero cross-talk** between different client colleges on the same database instance!

## License

Private — All rights reserved.
