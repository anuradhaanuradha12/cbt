# QForge — Setup & Run Guide

Everything you need to run **QForge** (a multi-tenant CBT exam platform for JEE/NEET/KCET) on your machine, including all setup work already completed on this computer.

---

## 1. What is this project?

- **Stack:** Cloudflare Workers (TypeScript, zero-framework manual router) + D1 databases ×2 + KV + R2 + static frontend (plain HTML/JS, served by the Worker)
- **Auth:** PBKDF2-SHA256 password hashing + JWT (HS256) + single-session enforcement via KV. Roles: `admin`, `faculty`, `student`, `content-creator`.
- **Multi-tenancy:** every record is scoped by `college_id`
- **Live deployment:** the Worker is deployed on the **Shishira@stepvista.com** Cloudflare account (`9325072bdbc32761b8550ef602ebf81e`)
  - D1 `cbt-platform` (`220c5793-3f10-460a-b5fc-8f3223feee43`) — the scraped question bank (**86,737 questions**)
  - D1 `cbt-qforge` (`bbe7c7a4-acbf-42c3-ba60-17e34e5bf9bb`) — question forge
  - KV `CBT_KV` (`9ceb8c5eef2541fcbc7485301a4b23b0`) — sessions/exam cache
  - R2 `cbt-media` — question images (10,165 questions have diagrams)

---

## 2. What has already been set up on this machine

| Item | Status | Details |
|---|---|---|
| Node.js v24 | ✅ | Required for wrangler & the dev server |
| Chrome | ✅ | Used to drive the UI locally |
| `worker/node_modules` | ✅ | Installed with `npm install --ignore-scripts` (see note below) |
| Local D1 database | ✅ | Schema applied (`npm run db:migrate:local`) |
| Admin account (local) | ✅ | `admin@example.com` / `change_me_in_production` |
| **Question bank (local)** | ✅ | **All 86,737 questions** imported from the remote D1 into the local DB |
| Remote users (local) | ✅ | 9 remote users (4 admin · 3 faculty · 3 students) also imported |
| Local secrets | ✅ | `worker/.dev.vars` (JWT secret + Gemini key) — never commit this file |
| Dev server | 🟢 **Running now** | `http://127.0.0.1:8787` (detached, log at `worker/dev-server.log`) |
| Cloudflare CLI auth | ✅ | `wrangler` authorized for the Shishira account (from your browser click) |

### Files added / changed by setup

| File | Purpose |
|---|---|
| `worker/.dev.vars` | Local-only secrets (`JWT_SECRET`, `GEMINI_API_KEY`). Gitignored. |
| `worker/import-questions.cjs` | Reusable importer — loads `questions-export.sql` straight into the local D1 via `node:sqlite` (bypasses wrangler, which chokes on the 83 MB file) |
| `worker/questions-export.sql` | The 83 MB export of the remote `questions` table — **safe to delete** once you're happy |
| `worker/e2e-demo.mjs` | End-to-end demo: creates a real exam from the bank, publishes it, takes it as a student, verifies scoring. Rerun anytime: `node e2e-demo.mjs` |
| `.launch-dev.cjs` | Detached launcher for `wrangler dev` (survives the terminal closing) |
| `worker/dev-server.log` | Live log of the running dev server |
| `frontend/js/api.js` | **Code fix:** API URL is now environment-aware — `localhost`/`127.0.0.1` → local `:8787`, anything else → the deployed Worker (matches the convention already used in `question-gen.html`) |
| `worker/src/routes/exams.ts` | **Bug fix:** `GET /exams` built SQL with `WHERE college_id = ? WHERE status = ?` (should be `AND`) so the exam list 500'd for everyone — including production. Fixed. |
| `worker/src/db/migrations/005_exam_difficulty.sql` | Adds `exams.difficulty` (`easy`/`medium`/`hard`, default `medium`). The blueprint form has a Difficulty picker; duration must be a positive integer (max 200) and start/end times can't be in the past — enforced in the UI **and** server-side. End Time fills itself as Start + Duration. `auto-select-preview`/`auto-replace` only pull questions matching the blueprint's difficulty. |
| `frontend/js/exam.js` | **5-minute outage policy:** answers snapshot to `localStorage` after every change; a `/health` probe every 5s detects outages and shows a full-screen overlay with a 5:00 countdown. Back online within 5 min → exam resumes where the student left off (answers, position, adjusted clock). Outage exceeds 5 min → auto-submit with retry-until-reconnect; the server's `SUBMIT_GRACE_SECONDS = 300` accepts the late submission. Verified end-to-end in `worker/verify-outage-resilience-browser.mjs`. |

> **Why `--ignore-scripts`?** Plain `npm install` fails on Windows because `better-sqlite3` needs Visual Studio Build Tools + Python to compile. Nothing in the dev run uses it, so skipping its build is safe.

---

## 3. Run it (the short version)

```bash
cd worker
npm run dev
```

Open **http://127.0.0.1:8787** and log in:

```
Email:    physics@cbt.local / physics2@cbt.local
          chemistry@cbt.local / chemistry2@cbt.local
          maths@cbt.local / maths2@cbt.local
          biology@cbt.local / biology2@cbt.local
Password: demo12345  (all faculties)

Principal: principal@example.com / demo12345

Two faculties share each subject. When the principal creates a blueprint,
EVERY faculty of that subject gets a `blueprint_assigned` notification and
the task appears on both Pending Tasks boards. Either of them (or both,
working together — progress merges because quotas count SAVED questions)
can fill the quota and submit.
Password: change_me_in_production
```

→ You land on the **QForge Admin Panel** with the full 86,737-question bank.

---

## 4. Full setup from scratch (if you ever need to redo it)

```bash
# 1. Install dependencies (skip native builds that fail on Windows)
cd worker
npm install --ignore-scripts

# 2. Apply the schema to the LOCAL D1
npm run db:migrate:local

# 3. (Optional) Seed the bootstrap admin + sample data
npm run db:seed

# 4. Create local secrets (JWT_SECRET at minimum)
#    Copy or create worker/.dev.vars with:
#      JWT_SECRET=<any long random string>
#      GEMINI_API_KEY=<your key, optional>

# 5. Start the dev server
npm run dev
```

If the server needs to survive the terminal closing (recommended on Windows):

```bash
node ../.launch-dev.cjs     # run from worker/ — detaches the server
```

---

## 5. Re-importing the question bank (only if the local DB is wiped)

```bash
cd worker

# 1. Re-export from the REMOTE database (needs wrangler logged into Shishira's account):
export CLOUDFLARE_ACCOUNT_ID=9325072bdbc32761b8550ef602ebf81e
node_modules/.bin/wrangler d1 export cbt-platform --table questions --output questions-export.sql

# 2. Find the local D1 sqlite file (hash name may differ):
DB=$(ls .wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite)

# 3. Import directly into the local DB (fast, bypasses wrangler):
node import-questions.cjs "$DB" questions-export.sql
```

> The importer drops + recreates the `questions` table and disables FK checks (the export references remote user IDs that don't exist locally). 86,737 rows import in well under a minute.

---

## 6. Daily commands

| Action | Command (run from `worker/`) |
|---|---|
| Start server (foreground) | `npm run dev` |
| Start server (detached, survives terminal) | `node ../.launch-dev.cjs` |
| Check it's up | `curl http://127.0.0.1:8787/health` → `{"status":"ok",...}` |
| Watch server logs | `tail -f dev-server.log` |
| Stop the detached server | `powershell -NoProfile -Command "Get-CimInstance Win32_Process \| Where-Object { \$_.CommandLine -match 'wrangler.js dev' } \| Stop-Process -Force"` |
| Run the E2E demo (exam → attempt → scoring) | `node e2e-demo.mjs` |
| Reapply schema to local DB | `npm run db:migrate:local` |
| Typecheck | `npx tsc --noEmit` |
| Deploy to production | `npm run deploy` (asks wrangler login if not authed) |

---

## 7. Remote (Cloudflare) access

- **Account:** Shishira@stepvista.com — `9325072bdbc32761b8550ef602ebf81e`
- `wrangler` is already authorized on this machine for that account (you clicked **Allow** in the browser).
- Remote ops always need the account ID set explicitly (the default OAuth account can differ):

```bash
export CLOUDFLARE_ACCOUNT_ID=9325072bdbc32761b8550ef602ebf81e
cd worker
node_modules/.bin/wrangler d1 list
node_modules/.bin/wrangler r2 bucket list
node_modules/.bin/wrangler whoami
```

- To re-authorize anytime: `npx wrangler login` (a Cloudflare tab opens → click **Allow**).

---

## 8. Notes & known limitations

- **Question images:** 10,145 questions reference diagrams in R2 (`cbt-media/questions/...`), 14,394 keys in total including explanation figures. The **local** R2 binding starts empty, so those images 404 in local dev until they are copied down. No Cloudflare auth is needed for this — the deployed Worker serves them publicly, and the dev-only ingest route stores them locally:

  ```bash
  cd worker
  node sync-figure-images.mjs --probe   # 20 images, then verifies one back
  node sync-figure-images.mjs           # full run (~121 MB, ~9 min, resumable)
  node audit-figure-images.mjs          # 0 missing? every key serves a real image?
  node audit-figure-images.mjs --all    # HTTP-probe all 14,394 keys
  ```

  (`npm run sync:figures` / `npm run audit:figures`.) The script reads the keys from local D1, skips what is already stored, and writes `figure-images-map.json`. If you ever prefer a true bucket sync, `wrangler r2 object get` per key or `rclone` works once you are authenticated.
- **Admin password:** the local bootstrap admin is `admin@example.com` / `change_me_in_production`. The *deployed* site's admin password was changed after bootstrap, so that combo only works locally.
- **`worker/questions-export.sql`** is 83 MB — delete it when you no longer need it.
- **`worker/.dev.vars`** contains real secrets — it's gitignored; never commit or share it.
- **Wrangler config drift:** `frontend/js/api.js` and the deployed Worker use `cbt-worker.shishira-932.workers.dev`, while `wrangler.toml` names the Worker `qforge`. The local dev flow doesn't care (it targets `127.0.0.1:8787`), but keep it in mind for deploys.
- **Exams:** remote D1 had 0 exams (the `GET /exams` bug meant the list always 500'd). The bug is fixed in `worker/src/routes/exams.ts` — deploy it to make exam listing work in production.