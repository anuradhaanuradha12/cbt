# CBT Platform — Comprehensive Feature & System Documentation

A secure, multi-tenant, edge-native **Computer-Based Testing (CBT)** and **Question Intelligence Platform** engineered for high-stakes entrance examinations (JEE Main/Advanced, NEET-UG, KCET, and custom institutional formats).

---

## 🔑 1. Live Demo Access & Credentials

The platform is accessible locally and deployed on Cloudflare's global edge network. All demo accounts use the unified demo password for frictionless evaluation.

- **Production URL:** [https://qforge.shishira-932.workers.dev](https://qforge.shishira-932.workers.dev)
- **Local Dev URL:** [http://127.0.0.1:8787](http://127.0.0.1:8787)
- **Unified Demo Password:** **`demo12345`**

| Role | Name | Login Email (User ID) | Assigned Scope / Subject | Password | Key Permissions |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Principal / Admin** | Demo Principal | `principal@cbt.local` | `global` (All Batches) | `demo12345` | Exam review, final approval & publishing |
| **Platform Admin** | Platform Admin | `admin@cbt.local` | `global` (Institution-wide) | `demo12345` | User management, quotas, system analytics |
| **Faculty (Physics)** | Dr. Demo Faculty | `faculty@qforge-demo.edu` | `physics` (`ngi`) | `demo12345` | Exam assembly, question bank drafting, cohort monitoring |
| **Faculty (Physics)** | Physics Teacher | `teacher@cbt.local` | `physics` (`global`) | `demo12345` | Exam assembly, question drafting |
| **Student** | Demo Student | `student@qforge-demo.edu` | `ngi` College | `demo12345` | Taking scheduled tests, viewing scorecards & solutions |
| **Student** | Test Student | `student@cbt.local` | `global` | `demo12345` | Standard student access |

---

## 🚀 2. Platform Overview

The CBT platform delivers high-concurrency, zero-latency digital testing without traditional virtual machine or container bottlenecks. Built entirely on Cloudflare's serverless edge infrastructure (Workers, D1, KV, and R2), the system handles massive student cohorts with instant sub-10ms response times, zero exam paper leaks, and multi-tenant institutional isolation.

---

## 🎓 3. Features for Students

### • Modern, Distraction-Free Exam Interface
- Clean, eye-friendly layout optimized to eliminate glare and eye fatigue during 3-hour competitive examinations.
- Fully responsive Progressive Web App (PWA) installable on iPads, Android tablets, Chromebooks, and desktop browsers.

### • Live Synchronized Server Timer
- Precision countdown clock tightly synchronized with Cloudflare Edge timestamps.
- Network latency or page refreshes do not penalize candidate time.

### • Pre-Exam Waiting Room & Instructions
- Students enter a secure waiting room 5 minutes prior to scheduled exam launch.
- Live instructions and marking schemes are displayed; test payload unlocks precisely at the designated start second.

### • Instant Scorecards & Step-by-Step Solutions
- Upon submission, results are computed immediately with section-wise breakdowns.
- Step-by-step explanations with complete mathematical equations and LaTeX formulas assist student remediation.

### • Interactive Color-Coded Question Palette
- Intuitive navigation grid tracking question status:
  - 🟢 **Answered**
  - 🟣 **Marked for Review**
  - 🟡 **Answered & Marked for Review**
  - ⚪ **Unattempted / Skipped**

---

## 🛡️ 4. Advanced Anti-Cheating & Proctoring (Fair Play)

To maintain absolute academic integrity, the platform integrates background proctoring safeguards:

### • The 3-Strike Proctoring Policy
- Any unauthorized action triggers a real-time on-screen warning banner.
- Accumulating **3 strikes** instantly force-submits the exam attempt and permanently locks the candidate session.

### • Tab & Application Focus Monitoring
- Detects window minimization, split-screen activation, or switching to external search tabs/calculators.
- Immediately logs an infraction event and issues a strike.

### • Copy, Paste & Right-Click Interception
- Disables clipboard manipulation, context menus, and text highlighting to prevent unauthorized extraction or sharing of questions.

### • Zero-Leak Security Architecture
- Questions, answer keys, and solution payloads are stripped server-side.
- Candidates cannot inspect network traffic or browser memory to preview questions or answers prior to official evaluation.

---

## 👨‍🏫 5. Capabilities for Teachers & Administrators

### • Massive Curated Question Bank
- Instant access to **86,730+ verified questions** spanning complete senior secondary curricula:
  - **Biology**: 21,693 Questions
  - **Chemistry**: 28,294 Questions
  - **Mathematics**: 15,018 Questions
  - **Physics**: 21,732 Questions
- Filterable by subject, chapter, difficulty level (Easy, Medium, Hard), and exam pattern (JEE Main/Adv, NEET, KCET).

### • One-Click Automated Blueprint Assembly
- Define exam parameters (e.g. 25 Physics, 25 Chemistry, 25 Math) with custom difficulty weightages.
- The engine automatically balances questions, computes marking formulas, and populates the test draft.

### • Two-Stage Approval Workflow
1. **Faculty Draft**: Subject teachers assemble questions and submit for institutional review.
2. **Principal / HOD Review**: Administrators verify quality, approve the blueprint, and schedule the release window.

### • Real-Time Visual Analytics Dashboard
- Live monitoring of active candidates, average cohort scores, topic-level strengths/weaknesses, and percentile rankings.

### • Multi-College (Multi-Tenant) Isolation
- Strict data separation using institutional `college_id` partitioning.
- Exams, student rosters, and question drafts belonging to College A remain completely inaccessible to College B.

### • Automated Reporting
- Scheduled Worker CRON triggers generate cohort performance summaries and parent updates automatically.

---

## 🤖 6. AI Question Forge (Proprietary Question Generation)

Integrated with Google Gemini generative models on Cloudflare Workers to assist educators in generating novel, un-searchable entrance exam questions:

### • Automated AI Question Generation
- Faculty can prompt AI for specific topics (e.g., *"Rotational Mechanics: Non-uniform rolling on an inclined plane"* with specified difficulty).
- The model outputs formatted question stems, 4 distractor options, verified correct keys, and rigorous LaTeX step-by-step solutions.

### • Human-in-the-Loop Quality Assurance
- No AI-generated question enters the live question bank directly.
- **2-Tier Review Chain**:
  1. Content Creator / Intern reviews and formats draft in Question Forge (`question-gen.html`).
  2. Subject Faculty / Principal inspects and signs off before moving questions into the approved repository (`cbt-qforge`).

## ⚡ 7. TypeSafe Jev Question Difficulty Intelligence & Calibration Engine

Integrated with TypeSafe AI's **Jev System One Model (`choice` decision layer)** to provide auditable, rubric-grounded difficulty classification, empirical calibration, and provenance tracking.

### • 100% Production Bank Classification Status
The entire **86,737-question bank** on remote Cloudflare D1 is 100% classified with auditable provenance and zero unclassified questions:

| Subject | Total Questions | Easy (Count / %) | Medium (Count / %) | Hard (Count / %) | Rubric Version | Status |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| ⚛️ **Physics** | 21,732 | 6,813 (31.3%) | 13,572 (62.5%) | 1,347 (6.2%) | `physics-kcet-v1.0` | ✅ **100.0%** |
| 📐 **Mathematics** | 15,018 | 3,192 (21.3%) | 10,102 (67.3%) | 1,724 (11.5%) | `mathematics-kcet-v1.0` | ✅ **100.0%** |
| 🧪 **Chemistry** | 28,294 | 17,996 (63.6%) | 9,702 (34.3%) | 596 (2.1%) | `chemistry-kcet-v1.0` | ✅ **100.0%** |
| 🧬 **Biology** | 21,693 | 19,497 (89.9%) | 2,099 (9.7%) | 97 (0.4%) | `biology-kcet-v1.0` | ✅ **100.0%** |
| **TOTAL** | **86,737** | **47,498 (54.76%)** | **35,475 (40.90%)** | **3,764 (4.34%)** | — | 🎯 **100.0%** |

### • 4-Layer Decision Architecture
1. **Deterministic Question Signals Layer**: Deterministically extracts observable syntactic features (`char_count`, `latex_formula_count`, `equation_count`, `has_diagram`, `concept_count_estimate`, `step_count_estimate`, `has_case_analysis`) and computes a canonical SHA-256 `difficulty_question_hash`.
2. **Versioned Subject-Specific Rubric Layer**: Binds structured, immutable criteria (`physics-kcet-v1.0`, `chemistry-kcet-v1.0`, `mathematics-kcet-v1.0`, `biology-kcet-v1.0`).
3. **TypeSafe Jev `choice` Decision Adapter**: Evaluates question state against target rubrics, returning calibrated confidence scores and complete probability distributions (`easy | medium | hard`).
4. **Faculty Override & Provenance Storage**: Stored directly in D1 with full provenance (`difficulty_confidence`, `difficulty_source`, `difficulty_review_status`, `difficulty_validation_status`, `difficulty_model_version`, `difficulty_rubric_version`).

### • Closed-Loop Empirical Calibration
- Background exam submission scoring tracks real-world student attempts (`observed_attempt_count`, `observed_accuracy_rate`).
- Questions with $\ge 50$ attempts are promoted to `empirically_validated`.
- Automatically flags discrepancies (`flagged_conflict`) for faculty review if student accuracy significantly diverges from model predictions (e.g. predicted `Easy` but student accuracy $< 35\%$).

---

## 🏗️ 8. Technical Infrastructure Specifications

| Component | Cloudflare Service | Technology / Specs | Role |
| :--- | :--- | :--- | :--- |
| **API Runtime** | Cloudflare Workers | TypeScript / WebCrypto API | High-throughput edge routing, sub-10ms response times |
| **Ingestion Buffer**| Cloudflare Queues | `cbt-submissions-queue` (`max_concurrency = 2`, `batch = 25`) | Synchronized storm absorption, decoupled D1 persistence |
| **Decoupled Scoring**| Cloudflare Queues | `cbt-scoring-queue` (`max_concurrency = 2`, `batch = 25`) | Asynchronous scoring evaluation and student analytics |
| **Dead Letter Queues**| Cloudflare Queues | `cbt-submissions-dlq` & `cbt-scoring-dlq` | Poison-pill isolation, real-time KV counter monitoring |
| **Primary DB** | Cloudflare D1 | Distributed SQLite (`cbt-platform`) | 86,737 questions, users, exam schedules, attempts, scoring |
| **AI Question DB** | Cloudflare D1 | Distributed SQLite (`cbt-qforge`) | Draft questions, approved proprietary questions |
| **Decision Model**| TypeSafe AI (Jev) | System One `choice` API | Auditable question difficulty classification and calibration |
| **Fast Cache** | Cloudflare KV | Distributed Key-Value (`CBT_KV`) | Session tokens, 20s autosave drafts, sanitized exam payloads |
| **Media Storage** | Cloudflare R2 | S3-Compatible Object Store (`cbt-media`) | High-resolution question diagrams, circuit schematics, figures |
| **Frontend** | Cloudflare Static Assets | Vanilla HTML5 / CSS3 / JavaScript | Zero-build overhead, instant PWA loading, MathJax equations |
| **Auth Security** | Native Web Crypto | PBKDF2-SHA256 (100,000 iterations) | OWASP-compliant password hashing and signed JWT tokens |

---

## ⚡ 9. High-Concurrency Scaling & Empirical 10,000-Student Validation

> **Defensible Architectural Conclusion**:  
> **QForge has empirically validated a 10,000-submission synchronized workload on Cloudflare Workers + Queues + D1 + KV. A total of 10,800 submission deliveries, including 800 duplicate deliveries, reconciled to exactly 10,000 authoritative submissions, 100,000 answer rows and 10,000 finalized attempts. The controlled persistence pipeline sustained an observed 16.23 submissions/sec at consumer concurrency 2, with zero observed D1 overload/queue-timeout errors and zero DLQ messages.**

### • Key Invariant Verification Ledger
- **Synchronized Storm Burst**: 10,799 requests admitted in 8.45s (**1,278.57 req/sec observed client-side admission rate**) with 100% HTTP 202 acceptance.
- **Persistence Drain**: 10,000 examinees completely persisted in **616.26 seconds (~10.27 minutes)** at **16.23 submissions/sec** (~162.3 answer rows/sec).
- **Authoritative Ledger Truth**:
  - Submissions in D1: **10,000**
  - Submission Answers in D1: **100,000** (strict 10:1 ratio, 0 orphaned or malformed distributions)
  - Finalized Attempts: **10,000** (`status = 'submitted'`)
  - Duplicate Authoritative Rows: **0**
  - Dead Letter Queue Messages: **0**
  - Observed D1 Overload / Contention Errors: **0**
- **Durable Objects Removed**: Zero Durable Objects active duration fees ($0 cost overhead; pure edge Queue decoupling).

### • Target Multi-College Deployment Context
- **Target Footprint**: 10 partner colleges $\times$ 100 workstations = **1,000 concurrent examinees**.
- **Persistence Projection**: At 16.23 submissions/sec, a 1,000-student synchronized submission wave projects to approximately **~61.6 seconds** of persistence drain time (throughput projection under smaller workload).
- **Workload Distinction**: The 10K benchmark validates the synchronized submission and persistence storm path. A separate 3-hour endurance test characterizes continuous autosave traffic over full examination duration.

---

## 📋 10. Quick Start Guide

### Running Locally
```bash
# Navigate to the worker directory
cd worker

# Start the edge development server (serves frontend + API on port 8787)
npm run dev
```

### Deploying to Production
```bash
# Deploy latest worker and frontend assets to Cloudflare Edge
npx wrangler deploy
```
