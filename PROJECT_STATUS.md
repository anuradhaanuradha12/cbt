# CBT Platform — Project Status & Onboarding Guide

> Last updated: 2026-07-24 | Sprint: Day 1 of 3

---

## ✅ Completed

### Infrastructure (Cloudflare)
| Resource | Name | ID / Location |
|---|---|---|
| D1 Database | `cbt-platform` | `220c5793-3f10-460a-b5fc-8f3223feee43` (APAC) |
| KV Namespace | `CBT_KV` | `9ceb8c5eef2541fcbc7485301a4b23b0` |
| R2 Bucket | `cbt-media` | `cbt-media` (Standard) |
| Worker | `cbt-worker` | Running locally on `http://127.0.0.1:8787` |

### Database Schema (8 tables, all indexed)
| Table | Purpose |
|---|---|
| `users` | Admin, faculty, student accounts |
| `questions` | Question bank (text in D1, images in R2) |
| `exams` | Exam definitions with versioning + immutable config |
| `exam_questions` | Links exams ↔ questions with marks/negative marks |
| `exam_attempts` | Created when student starts exam — enables live dashboard, attendance, resume |
| `exam_events` | Anti-cheat log (tab hidden, blur, copy, paste, fullscreen exit) |
| `submissions` | One row per student per exam, async-scored |
| `submission_answers` | Normalized per-question answers with `is_correct`, `marks_awarded` |

### Backend Worker (TypeScript, zero npm deps)

#### Auth
- [x] `POST /auth/login` — PBKDF2 password verify, 6-hour JWT (WebCrypto HMAC-SHA256), KV session
- [x] `POST /auth/logout` — KV session delete (JWT instantly invalidated)
- [x] Single active session enforcement — second login kills previous session
- [x] Role-based auth middleware — `admin`, `faculty`, `student`

#### Questions
- [x] `GET /questions` — list with filters (subject, chapter, difficulty, type, pagination)
- [x] `POST /questions` — create single question
- [x] `POST /questions/bulk` — import up to 500 questions via JSON array (D1 batch)
- [x] `GET /questions/:id` — fetch full question with answer (staff only)
- [x] `PUT /questions/:id` — update question

#### Exams
- [x] `GET /exams` — list (filter by status)
- [x] `POST /exams` — create with question IDs, marks, negative marks
- [x] `GET /exams/:id` — KV-cached payload, answers **never** in cache
- [x] `PUT /exams/:id/publish` — freezes `config_snapshot` (immutable), sets `starts_at`/`ends_at`
- [x] `POST /exams/:id/version` — creates new draft version (v1 → v2 → v3, audit trail)

#### Attempts & Anti-Cheat
- [x] `POST /attempts` — start attempt (crash resume: if attempt exists, returns existing ID)
- [x] `POST /attempts/:id/heartbeat` — updates `last_seen_at` every 30s (powers live dashboard)
- [x] `POST /events` — logs anti-cheat events per attempt (passive, no auto-penalty)

#### Submissions
- [x] `POST /submissions` — bulk submit, server-side timer validation, async scoring via `ctx.waitUntil`
- [x] `POST /submissions/draft` — KV draft save (15s auto-save, expires with exam + 30min grace)
- [x] `GET /submissions/draft/:exam_id` — restore draft on reload (crash recovery)
- [x] `GET /submissions/:exam_id` — student's own result with answers + explanations
- [x] `GET /submissions/:exam_id/report` — faculty/admin: all results, stats, rank order

#### Utilities
- [x] `GET /health` — `{"status":"ok"}`
- [x] CORS preflight (`OPTIONS`) handled globally

### Security
- [x] PBKDF2-SHA256 passwords (100K iterations, constant-time comparison)
- [x] JWT via native WebCrypto API — zero deps
- [x] JWT_SECRET in `.dev.vars` locally, `wrangler secret put` for production
- [x] Correct answers **never** sent to students, never stored in KV cache
- [x] Exam timer validated server-side (30s grace period for network lag)
- [x] User enumeration prevention (same error for wrong email AND wrong password)

### Smoke Tests Passed ✅
```
GET  /health    → {"status":"ok"}
POST /auth/login → valid JWT + user object
```

---

## 🔲 Pending (Day 2–3)

### Priority 1 — Git Push
- [ ] `git init` in `d:\Websites\CBT`
- [ ] `git remote add origin https://github.com/raoshishira/cbt`
- [ ] First commit + push

### Priority 2 — Frontend (React + Vite)

#### Student Interface
- [ ] Login page
- [ ] Exam list / dashboard
- [ ] **JEE-style CBT interface** — question panel, section tabs, timer, answer palette
- [ ] `useAutoSave` hook — saves to `localStorage` every 15s + KV draft
- [ ] `useExamTimer` hook — derived from server `starts_at` (not client clock)
- [ ] Draft restore on page reload (crash recovery)
- [ ] Submit confirmation + result page

#### Faculty Interface
- [ ] Question bank — list, filter, create, bulk upload (JSON/CSV)
- [ ] Exam builder — select questions + set marks
- [ ] Exam publish flow
- [ ] Live dashboard — who is in-progress, last heartbeat
- [ ] Anti-cheat event log per student

#### Admin Interface
- [ ] User management — create/deactivate faculty and students
- [ ] Exam management — publish, archive, version
- [ ] Report page — rank list, avg score, CSV export

### Priority 3 — Production Deploy
- [ ] `wrangler secret put JWT_SECRET` (strong random 32+ char secret)
- [ ] `wrangler deploy`
- [ ] Seed production admin user (`seed-admin.mjs` → `--remote`)
- [ ] Verify `/health` on production URL

### Priority 4 — Phase 2 (Post Client Sign-off)
- [ ] Multi-tenancy: subdomain routing (`college.cbtplatform.com` → `college_id`)
- [ ] White-label: per-college logo and colors
- [ ] Refresh tokens
- [ ] Parent portal
- [ ] AI proctoring
- [ ] SaaS onboarding flow

---

## 📋 How to Onboard a New College (Phase 1 — Single College MVP)

Since Phase 1 is single-college, onboarding is manual via API. Here are the exact steps:

### Step 1 — Create Users in D1

Generate a real PBKDF2 password hash:

```bash
# From d:\Websites\CBT\worker
node seed-admin.mjs
# Copy the INSERT statement from console output
```

Insert into production D1:
```bash
npx wrangler d1 execute cbt-platform --remote --command "INSERT INTO users ..."
```

Or into local D1 for testing:
```bash
npx wrangler d1 execute cbt-platform --local --command "INSERT INTO users ..."
```

### Step 2 — Import Question Bank

```bash
# 1. Login to get token
POST /auth/login
{ "email": "admin@cbt.local", "password": "Admin@1234" }

# 2. Bulk import questions (max 500 per request)
POST /questions/bulk
Authorization: Bearer <token>
Content-Type: application/json
[
  {
    "subject": "physics",
    "chapter": "Mechanics",
    "difficulty": "medium",
    "type": "mcq",
    "question_text": "A ball is dropped from rest...",
    "option_a": "10 m/s",
    "option_b": "20 m/s",
    "option_c": "5 m/s",
    "option_d": "15 m/s",
    "correct_answer": "A",
    "explanation": "Using s = ut + ½at²..."
  }
]
```

### Step 3 — Create and Publish an Exam

```bash
# 1. Create exam
POST /exams
Authorization: Bearer <admin-token>
{
  "title": "JEE Mock Test 1",
  "exam_type": "JEE",
  "duration_minutes": 180,
  "total_marks": 300,
  "question_ids": [
    { "id": "uuid-1", "marks": 4, "negative_marks": 1 },
    { "id": "uuid-2", "marks": 4, "negative_marks": 1 }
  ]
}

# 2. Publish (freezes config, sets start time)
PUT /exams/:id/publish
Authorization: Bearer <admin-token>
{
  "starts_at": 1784910000,
  "config": {
    "negative_marking": true,
    "marks_correct": 4,
    "marks_wrong": 1
  }
}
```

### Step 4 — Students Take the Exam

1. Login → get JWT
2. `GET /exams/:id` → receive question payload (KV-cached for all 2000+ students)
3. `POST /attempts` → register attempt (captures IP, user agent)
4. Answer questions (auto-saved to localStorage + KV every 15s via frontend)
5. `POST /submissions` → bulk submit all answers
6. `GET /submissions/:exam_id` → view result + rank

### Step 5 — Faculty Reviews Results

```bash
GET /submissions/:exam_id/report
Authorization: Bearer <faculty-token>
# Returns: rank list, avg score, highest/lowest, attempt breakdown
```

---

## 🔑 Dev Credentials

| Role | Email | Password |
|---|---|---|
| Admin | `admin@cbt.local` | `Admin@1234` |

> **⚠️ Change before production.** Run `seed-admin.mjs` with your real password, insert via `--remote`, delete the old row.

---

## 📁 File Map

```
d:\Websites\CBT\
├── worker/
│   ├── src/
│   │   ├── index.ts              ← Router entry point
│   │   ├── config.ts             ← COLLEGE_ID, TTLs, constants
│   │   ├── types.ts              ← Env bindings (D1, KV, R2, JWT_SECRET)
│   │   ├── middleware/
│   │   │   ├── auth.ts           ← JWT verify + KV session + role guard
│   │   │   └── responses.ts      ← JSON helpers with CORS
│   │   ├── routes/
│   │   │   ├── auth.ts           ← Login, logout
│   │   │   ├── questions.ts      ← CRUD + bulk import
│   │   │   ├── exams.ts          ← Create, publish, KV cache, versioning
│   │   │   ├── attempts.ts       ← Start, heartbeat, anti-cheat events
│   │   │   └── submissions.ts    ← Submit, draft, result, report
│   │   ├── db/
│   │   │   ├── schema.sql        ← 8 tables + indexes ✅ applied
│   │   │   └── seed.sql          ← Placeholder (use seed-admin.mjs instead)
│   │   └── utils/
│   │       ├── jwt.ts            ← WebCrypto HMAC-SHA256
│   │       └── password.ts       ← PBKDF2-SHA256
│   ├── seed-admin.mjs            ← One-time script: generates admin INSERT SQL
│   ├── .dev.vars                 ← Local secrets — NOT in git ✅
│   ├── wrangler.toml             ← Real resource IDs wired in ✅
│   ├── tsconfig.json
│   └── package.json
├── frontend/                     ← ❌ NOT BUILT YET (Day 2)
├── shared/
│   └── types.ts                  ← All shared TypeScript types
├── PROJECT_STATUS.md             ← This file
├── .gitignore                    ✅
└── README.md                     ✅
```
