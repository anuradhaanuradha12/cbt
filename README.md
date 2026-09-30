# CBT Platform

A multi-tenant, white-labeled **Computer-Based Testing (CBT) platform** for colleges (JEE/NEET/KCET) built entirely on the Cloudflare edge stack.

## Overview

Over the past few months, we've built a multi-tenant Computer-Based Testing platform designed for engineering and medical entrance exams. 
Instead of traditional VMs or containers, the platform runs entirely on Cloudflare's edge using Workers, D1, KV, and R2.

Building everything on an edge-native architecture allows for a lightweight platform with minimal infrastructure overhead, significantly reduced latency for end-users, and scalable multi-tenancy.

## Core Features

- **Progressive Web App (PWA):** Fully responsive on mobile. Can be installed directly to the home screen (Standalone Mode) on iOS and Android.
- **Multi-Tenant Architecture:** Capable of serving multiple colleges from a single deployment with absolute data isolation.
- **Exam Integrity Controls:** 
  - **PC:** Fullscreen mode, clipboard restrictions, context-menu restrictions and visibility/tab-switch event monitoring.
  - **Mobile:** Visibility-change, page-lifecycle and focus-loss monitoring, with configurable exam-integrity responses.
  - **Server-side validation:** Exam timing and submission state are independently validated by the backend rather than trusted solely to the client.
- **Live Exam Analytics Dashboard:** Score, participation and attempt metrics with continuously refreshed exam-state data.
- **Dynamic Exam Generation:** Automated exam generation and quotas based on specific test formats.
- **AI-Assisted Question Workflow:** Proprietary Question Forge workflow for automated, high-quality question generation and review.
- **Exam Scheduling & Waiting Room:** Scheduled exams unlock exactly at start time. Includes a pre-exam instruction screen.

## Stack & Architecture Philosophy

QForge is **validated against a synchronized 10,000-submission workload** and designed for an operational footprint of approximately **1,000 simultaneous examinees**. The system is designed to minimize infrastructure overhead, with **no Durable Objects** in the production architecture ($0 active duration charges):

| Layer | Technology | Primary Role |
| :--- | :--- | :--- |
| **Edge Compute** | Cloudflare Workers | Authentication, routing, server-side timer validation |
| **Read Path / Cache** | Cloudflare KV | Immutable exam JSON payloads + ephemeral 20s autosave drafts |
| **Burst Ingestion Buffer** | Cloudflare Queues (`cbt-submissions-queue`) | Absorbs synchronized finish storms (`max_concurrency = 2`, `batch = 25`) |
| **Decoupled Scoring** | Cloudflare Queues (`cbt-scoring-queue`) | Asynchronous answer scoring and difficulty recalibration |
| **System of Record** | Cloudflare D1 | Managed serverless SQL (86,700+ questions, authoritative submissions, analytics) |
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
            ┌─────────────┴─────────────┐
            │                           │
            ▼                           ▼
           KV                          R2
   ├── Exam payloads            Media / Diagrams
   └── Autosave drafts
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

### Engineering Boundaries & Design Non-Goals
- **No Durable Objects in the production architecture**: Relies on edge Queues and controlled consumer concurrency to avoid active instance duration charges.
- **No synchronous D1 writes on student final-submission path**: Submissions are queued and acknowledged with HTTP 202; persistence drains asynchronously.
- **No client-side trust for authoritative state**: Exam scheduling, timers, question counts, and submission validity are verified server-side.
- **No answer-key delivery in candidate payloads**: Live test bundles delivered to examinees strictly exclude correct options and solution rationales.
- **No automatic promotion of raw AI generation**: Every AI-generated question requires human faculty review and sign-off before entering the production question bank.
- **No 10,000-student 3-hour endurance claim**: The 10K benchmark specifically validates the synchronized submission storm and persistence pipeline; continuous multi-hour autosave traffic represents a distinct workload profile.
- **No statistical claim of infallible AI classification**: The TypeSafe Jev difficulty engine provides rubric-grounded classifications and probability distributions; empirical attempt tracking ($\ge 50$ attempts) and faculty overrides form an essential calibration feedback loop.

---

## 🏆 Empirical 10,000-Submission Synchronized Workload Validation

> **Defensible Engineering Headline**:  
> **QForge has empirically validated a synchronized 10,000-submission workload on Cloudflare Workers, Queues, D1 and KV. A total of 10,800 total submission deliveries (10,000 authentic + 800 duplicate retries), including one authentic submission delivered after the initial automated staging anomaly, reconciled to exactly 10,000 authoritative submissions, 100,000 answer rows and 10,000 finalized attempts. The controlled persistence pipeline sustained an observed 16.23 submissions/sec at consumer concurrency 2, with zero observed D1 overload/queue-timeout errors and zero DLQ messages.**  
>  
> **The intended production footprint is approximately 1,000 simultaneous examinees, with the 10,000-submission benchmark providing a substantially larger tested submission workload.**

### Validation Ledger & Reconciliation Truth

| Metric / Dimension | Validated State | Notes / Traceability |
| :--- | :---: | :--- |
| **Edge Storm Acceptance** | **10,799 / 10,799 (100.0%)** | Initial synchronized barrier release in 8.45s (1,278.57 req/s) |
| **Total Queue Deliveries** | **10,800** | 10,799 automated deliveries + 1 recovered staging delivery |
| **Injected Duplicate Retries** | **800 (8.0%)** | Full duplicate retry payloads simulated |
| **Authoritative Submissions** | **10,000 / 10,000** | Exact D1 persistence match at settlement (`bbf22745-8a8b-4a85-bcfc-a227dd6c3fe4`) |
| **Authoritative Answer Rows** | **100,000 / 100,000** | Strictly 10 answers/student (zero orphaned or missing rows) |
| **Finalized Attempts (`submitted`)** | **10,000 / 10,000** | Atomic attempt status finalization verified |
| **Duplicate Authoritative Rows** | **0** | Attempt-level duplicate protection verified |
| **Dead Letter Queue (DLQ)** | **0 messages** | Both submissions DLQ and scoring DLQ remained empty |
| **D1 Overload / Contention Errors** | **0 observed** | Zero observed D1 overload or queue-timeout errors during the measured persistence drain |
| **Observed Persistence Throughput** | **16.23 sub/sec** | ~162.3 rows/sec sustained across 616.26s (~10.27 min) drain |
| **Active Durable Objects** | **0** | $0 DO active duration fees |

### Target Deployment Projection
- **Operational Footprint**: 10 colleges $\times$ 100 workstations = **1,000 simultaneous examinees**.
- **Persistence Drain Projection**: A synchronized submission storm from 1,000 examinees would project to approximately **61.6 seconds** at the validated 16.23 sub/s rate (a throughput projection, not a separate capacity test).
- **Workload Boundary**: Validates the synchronized submission and persistence storm path; a separate 3-hour endurance test characterizes continuous autosave traffic.
- **Data Settlement & Teardown**: The benchmark was reconciled against the remote D1 database at settlement; synthetic benchmark records were subsequently removed from the production database. The complete benchmark ledger and reconciliation report are retained in the repository.
- **Full Report**: See [`worker/scripts/audit_data/benchmark-10000-queue-storm.md`](worker/scripts/audit_data/benchmark-10000-queue-storm.md) for complete latency distributions and SQL reconciliation logs.

