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

---

## 🏗️ 7. Technical Infrastructure Specifications

| Component | Cloudflare Service | Technology / Specs | Role |
| :--- | :--- | :--- | :--- |
| **API Runtime** | Cloudflare Workers | TypeScript / WebCrypto API | High-throughput edge routing, sub-10ms response times |
| **Primary DB** | Cloudflare D1 | Distributed SQLite (`cbt-platform`) | 86,730+ questions, users, exam schedules, attempts, scoring |
| **AI Question DB** | Cloudflare D1 | Distributed SQLite (`cbt-qforge`) | Draft questions, approved proprietary questions |
| **Fast Cache** | Cloudflare KV | Distributed Key-Value (`CBT_KV`) | Session management, sanitized exam payload caching |
| **Media Storage** | Cloudflare R2 | S3-Compatible Object Store (`cbt-media`) | High-resolution question diagrams, circuit schematics, figures |
| **Frontend** | Cloudflare Static Assets | Vanilla HTML5 / CSS3 / JavaScript | Zero-build overhead, instant PWA loading, MathJax equations |
| **Auth Security** | Native Web Crypto | PBKDF2-SHA256 (100,000 iterations) | OWASP-compliant password hashing and signed JWT tokens |

---

## 📋 8. Quick Start Guide

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
