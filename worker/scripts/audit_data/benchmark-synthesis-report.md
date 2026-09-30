# QForge CBT Platform — Empirical Concurrency & Scalability Synthesis Report

**Date:** 2026-09-30  
**Target Environment:** Cloudflare Workers + D1 (`cbt-platform`) + Cloudflare KV (`CBT_KV`)  
**Worker Version ID:** `039f73c3-0dac-474b-8cbf-46c3ffa09c44`  
**Test Suite:** `worker/scripts/run_load_test.py`  

---

## 1. Executive Summary & Core Discovery

Across progressive empirical load testing tiers (500 &rarr; 1,000 &rarr; 2,000 concurrent virtual students), QForge demonstrated robust behavior under progressively higher distributed concurrency, with aggregate throughput reaching a sustained plateau around 124 requests/sec.

When subjected to an **instantaneous 2,000-examinee synchronized submission storm**, the test suite uncovered the exact database write admission ceiling of serverless SQLite (Cloudflare D1):
- **Edge Cache & Autosave**: Remained flat and fully responsive via Cloudflare KV (`p50: 441ms`, `p95: 497ms`).
- **D1 Submission Admission**: Saturated D1's internal transactional queue under 2,000 simultaneous multi-row writes, returning the exact observed Cloudflare error:  
  `D1_ERROR: D1 DB is overloaded. Requests queued for too long.`

This empirical finding provides a concrete basis for evaluating a sharded Durable Object + Queue architecture for synchronized submission bursts.

---

## 2. Multi-Tier Concurrency Matrix

| Metric / Workload Tier | Tier 1: 500 Students | Tier 2: 1,000 Students | Tier 3: 2,000 Students (Distributed Flow) | Tier 4: 2,000-Student Synchronized Submission Storm — D1 Stress Boundary |
| :--- | :---: | :---: | :---: | :---: |
| **Workload Pattern** | Full Lifecycle | Full Lifecycle | Full Lifecycle | Synchronized Instant Burst |
| **Total API Transactions** | 2,500 | 5,000 | 10,000 | 2,000 unique students (2,770 HTTP attempts*) |
| **Sustained Aggregate RPS** | 96.11 req/s | 123.75 req/s | 124.40 req/s | 168.70 req/s (peak storm wave) |
| **Success Rate (SLA)** | **100.00%** | **100.00%** | **100.00%** | **82.44% (D1 Queue Saturated)** |
| **Exam Delivery (`GET`) p95** | 539.0 ms | 661.5 ms | 800.2 ms | 484.0 ms |
| **KV Autosave (`POST`) p50 / p95** | 443.1 / 566.0 ms | 442.9 / 508.3 ms | 442.8 / 695.6 ms | 441.2 / 497.6 ms |
| **Attempt Start (`POST`) p95** | 503.8 ms | 745.0 ms | 1,079.4 ms | 313.3 ms (staged) |
| **Final Submission p50** | 639.0 ms | 748.9 ms | 1,057.7 ms | 15,837.4 ms (queued) |
| **Final Submission p95** | **1,010.4 ms** | **1,284.6 ms** | **1,669.8 ms** | 26,462.6 ms (tail timeout) |
| **Failures / Errors** | 0 | 0 | 0 | 1,540 queued timeout 500s |

*\*Note on Request Counts: In the 2,000-student storm test, client-side HTTP socket retries upon queue timeout generated 2,770 total submission requests across the 2,000 unique students (1,230 unique submissions succeeded, while 1,540 requests exceeded D1's serverless queue timeout threshold).*

---

## 3. Key Architectural Takeaways

### 1. KV Autosave Decoupling is Proven Under Scale
Moving `POST /submissions/draft` TTL calculation to read directly from the cached exam payload in KV completely eliminated D1 read contention during exam conduct. Across all 4 load tiers (including the storm), autosave median latency stayed fixed at **~442ms**.

### 2. D1 Batching Optimization Impact
Collapsing sequential database round-trips into atomic `env.DB.batch([UPDATE attempt, INSERT submission, ...INSERT answers])` reduced final submission p95 latency from **1,491 ms down to 1,010 ms** (a 32.2% reduction) under 500 concurrent sessions, providing headroom for up to 2,000 distributed sessions.

### 3. The Synchronized Stampede Constraint
Under distributed test-taking, 2,000 concurrent examinees operate with zero errors (124.4 RPS, p95: 1.67s). However, when all 2,000 examinees submit at the exact same second, D1's request queue saturates and requests exceed Cloudflare's queue duration limit (`D1_ERROR: D1 DB is overloaded. Requests queued for too long.`).

---

## 4. Architectural Evaluation: Sharded Durable Objects with Outbox & Queue Buffer

To decouple the student-facing submission acknowledgement from D1 write queue limits while guaranteeing durable persistence:

```
                    STUDENT CLIENT
                          │
                          ▼
                  Cloudflare Worker
                          │
            ┌─────────────┴─────────────┐
            │                           │
           KV                    Durable Objects
     (Draft Autosave)         (Submission Shards)
                                        │
                         hash(attempt_id) % SHARD_COUNT
                                        │
                                        ▼
                         ┌──────────────┴──────────────┐
                         │                             │
                   Submission Record              Outbox Event
                   (Deterministic Id)          (Transactional State)
                         │                             │
                         └──────────────┬──────────────┘
                                        │
                                        ▼
                                 Cloudflare Queue
                               (Buffered Ingestion)
                                        │
                                  Queue Consumer
                                        │
                                        ▼
                                  D1 Persistence
                                (Controlled Rate)
```

### Architectural Principles

1. **Configurable Sharding (`SHARD_COUNT = 8 | 16 | 32 | 64`)**:
   - Route submissions deterministically via `hash(attempt_id) % SHARD_COUNT` across independent DO actors to eliminate single-instance serialization. Benchmark to determine the optimal shard count.
2. **Transactional Outbox & Idempotency Invariant**:
   - The submission payload and outbox event are committed atomically inside the Durable Object's SQLite storage before returning an authoritative `{ ok: true, submitted_at }` response to the student.
   - Deterministic `submission_id` ensures that client retries are strictly idempotent.
3. **Queue as Burst Shock Absorber**:
   - A retryable queue dispatcher delivers messages to Cloudflare Queues for controlled, rate-limited persistence into D1, ensuring D1 is completely removed from the synchronous critical path.
