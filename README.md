# CBT Platform

A multi-tenant, white-labeled **Computer-Based Testing (CBT) platform** for colleges (JEE/NEET/KCET) built entirely on the Cloudflare edge stack.

## Overview

Over the past few months, we've built a multi-tenant Computer-Based Testing platform designed for engineering and medical entrance exams. 
Instead of traditional VMs or containers, the platform runs entirely on Cloudflare's edge using Workers, D1, KV, and R2.

Building everything on an edge-native architecture allows for a lightweight platform with minimal infrastructure overhead, significantly reduced latency for end-users, and scalable multi-tenancy.

## Core Features

- **Progressive Web App (PWA):** Fully responsive on mobile. Can be installed directly to the home screen (Standalone Mode) on iOS and Android.
- **Multi-Tenant Architecture:** Capable of serving multiple colleges from a single deployment with absolute data isolation.
- **Strict Anti-Cheat:** 
  - **PC:** Enforces Fullscreen API, disables copy/paste, right-click, and tracks tab-switching.
  - **Mobile:** Zero-tolerance policy on app switching or minimizing.
- **Real-time Analytics Dashboard:** Real-time dashboards (Average Score, Peak Engagement, Attempt details).
- **Dynamic Exam Generation:** Automated exam generation and quotas based on specific test formats.
- **AI-Assisted Question Workflow:** Proprietary Question Forge workflow for automated, high-quality question generation and review.
- **Exam Scheduling & Waiting Room:** Scheduled exams unlock exactly at start time. Includes a pre-exam instruction screen.

## Stack & Cost Philosophy

QForge is engineered to handle up to **10,000 concurrent students** during high-stakes entrance exams with **zero Durable Objects ($0 active duration charges)**, keeping overall platform infrastructure within a **$5–10/month** envelope:

| Layer | Technology | Primary Role |
| :--- | :--- | :--- |
| **Edge Compute** | Cloudflare Workers | Authentication, routing, server-side timer validation |
| **Read Path / Cache** | Cloudflare KV | Immutable exam JSON payloads + ephemeral 20s autosave drafts |
| **Burst Ingestion Buffer** | Cloudflare Queues (`cbt-submissions-queue`) | Absorbs synchronized finish storms (`max_concurrency = 2`, `batch = 25`) |
| **Decoupled Scoring** | Cloudflare Queues (`cbt-scoring-queue`) | Asynchronous answer scoring and difficulty recalibration |
| **System of Record** | Cloudflare D1 | 86,700+ question bank, authoritative submissions, and analytics |
| **Media / Assets** | Cloudflare R2 | Question and explanation diagrams |
| **Frontend** | Cloudflare Pages / Static Assets | Vanilla PWA (zero build dependencies, instant delivery) |

## Scaling Architecture: Worker → Queue → D1

> **Core Architectural Principle:**
> *KV handles ephemeral student state. Queues absorb the burst. Controlled consumers protect D1. D1 remains the source of truth.*

```text
                    QFORGE PLATFORM
                          │
                   Cloudflare Pages
                          │
                          ▼
                   ┌─────────────┐
                   │   Worker    │
                   │  Auth / API │
                   └──────┬──────┘
                          │
            ┌─────────────┼─────────────┐
            │             │             │
            ▼             ▼             ▼
           KV           Cache           R2
       Exam/Drafts     Static         Diagrams
            │
            ▼
      FINAL SUBMIT (202 Accepted)
            │
            ▼
   ┌───────────────────┐
   │ Cloudflare Queue  │
   │  cbt-submissions  │
   └────────┬──────────┘
            │
      max_concurrency = 2 (Controlled write rate)
            │
            ▼
   ┌───────────────────┐
   │ Persistence Worker│
   │ (Batched D1 Write)│
   └────────┬──────────┘
            │
            ├────────► Cloudflare D1 (Authoritative Submissions & Answers)
            ├────────► Post-Commit KV Draft Cleanup
            │
            ▼
   ┌───────────────────┐
   │ Cloudflare Queue  │
   │    cbt-scoring    │
   └────────┬──────────┘
            │
            ▼
   ┌───────────────────┐
   │  Scoring Consumer │
   │ (Async Evaluation)│
   └────────┬──────────┘
            │
            ▼
   Cloudflare D1 (Scores, Analytics & Calibration)
```

### Reliability & Idempotency Guarantees
1. **Server-Owned Submission Identity**: `submission_id` is assigned and authenticated at the edge, bound to the student's `attempt_id`.
2. **Post-Queue-Send 202 Guarantee**: The edge API returns `202 Accepted` strictly after `Queue.send()` succeeds; if queue dispatch fails, a retryable `503 Service Unavailable` is returned while the student's draft remains safely in KV.
3. **KV Draft Retention Safety Net**: Student answer drafts in KV are **not** dropped on submit. They remain alive until D1 commits the authoritative submission.
4. **Multi-Entity Database Idempotency**: `ON CONFLICT` constraints across `submissions`, `submission_answers`, and `exam_attempts` guarantee that duplicate client retries or redeliveries result in exactly one finalized submission without orphaned answers.
5. **Decoupled Scoring Domain**: Grading and question accuracy recalibration execute in an independent queue consumer, preventing scoring calculation errors from rolling back valid student submissions.

---

## 🏆 Empirical 10,000-Student Synchronized Workload Validation

> **Defensible Engineering Headline**:  
> **QForge has empirically validated a 10,000-submission synchronized workload on Cloudflare Workers + Queues + D1 + KV. A total of 10,800 submission deliveries, including 800 duplicate deliveries, reconciled to exactly 10,000 authoritative submissions, 100,000 answer rows and 10,000 finalized attempts. The controlled persistence pipeline sustained an observed 16.23 submissions/sec at consumer concurrency 2, with zero observed D1 overload/queue-timeout errors and zero DLQ messages.**

### Validation Ledger & Reconciliation Truth

| Metric / Dimension | Validated State | Notes / Traceability |
| :--- | :---: | :--- |
| **Edge Storm Acceptance** | **10,799 / 10,799 (100.0%)** | Initial synchronized barrier release in 8.45s (1,278.57 req/s) |
| **Total Queue Deliveries** | **10,800** | 10,799 automated deliveries + 1 recovered staging delivery |
| **Injected Duplicate Retries** | **800 (8.0%)** | Full duplicate retry payloads simulated |
| **Authoritative Submissions** | **10,000 / 10,000** | Exact D1 persistence match (`bbf22745-8a8b-4a85-bcfc-a227dd6c3fe4`) |
| **Authoritative Answer Rows** | **100,000 / 100,000** | Strictly 10 answers/student (zero orphaned or missing rows) |
| **Finalized Attempts (`submitted`)** | **10,000 / 10,000** | Atomic attempt status finalization verified |
| **Duplicate Authoritative Rows** | **0** | Attempt-level duplicate protection verified |
| **Dead Letter Queue (DLQ)** | **0 messages** | Both submissions DLQ and scoring DLQ remained empty |
| **D1 Overload / Contention Errors** | **0 observed** | Zero timeout or lock failures during entire persistence drain |
| **Observed Persistence Throughput** | **16.23 sub/sec** | ~162.3 rows/sec sustained across 616.26s (~10.27 min) drain |
| **Active Durable Objects** | **0** | $0 DO active duration fees |

### Target Deployment Projection
- **Operational Footprint**: 10 colleges $\times$ 100 workstations = **1,000 simultaneous examinees**.
- **Persistence Drain Projection**: A synchronized submission storm from 1,000 examinees would project to approximately **61.6 seconds** at the validated 16.23 sub/s rate (a throughput projection, not a separate capacity test).
- **Workload Boundary**: Validates the synchronized submission and persistence storm path; a separate 3-hour endurance test characterizes continuous autosave traffic.
- **Full Report**: See [`worker/scripts/audit_data/benchmark-10000-queue-storm.md`](worker/scripts/audit_data/benchmark-10000-queue-storm.md) for complete latency distributions and SQL reconciliation logs.

