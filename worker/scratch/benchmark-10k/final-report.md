# 🏆 QForge CBT Platform — Empirical 10,000-Student Synchronized Workload Validation Report

- **Date**: 2026-09-30 05:40:36 UTC
- **Environment**: Cloudflare Workers Production Edge (`https://qforge.shishira-932.workers.dev`)
- **Exam ID**: `bbf22745-8a8b-4a85-bcfc-a227dd6c3fe4`
- **Batch ID**: `1790746104`
- **Architecture**: Zero-Durable-Objects (`Worker -> Cloudflare Queues -> Controlled Consumer -> D1 SQLite -> Scoring Queue -> D1`)
- **Consumer Configuration**: `max_concurrency = 2`, `max_batch_size = 25`, `max_batch_timeout = 2s`

---

## Executive Summary & Core Headline

> **Headline**:  
> **QForge empirically validated a 10,000-submission synchronized workload using Cloudflare Workers, Queues, D1 and KV. The edge admitted 10,799 submission deliveries, including 800 duplicate deliveries, while the controlled persistence consumer reconciled the workload to exactly 10,000 authoritative submissions, 100,000 answer rows and 10,000 finalized attempts, with zero duplicate submissions, zero DLQ messages and no observed D1 overload or queue-timeout errors.**
>
> **Observed persistence throughput was 16.23 submissions/sec at consumer concurrency 2, with the 10,000-submission persistence drain completing in 616.26 seconds.**

---

## 1. Verification Matrix

| Verification Dimension | Workload / Tested Population | Empirical Result | Status |
| :--- | :---: | :---: | :---: |
| **Initial Staged Students** | 10,000 synthetic examinees | **9,999 / 10,000 staged in automated storm** *(1)* | **NOTE** |
| **Duplicate Delivery Injections** | 8.0% (~800 retries) | **800 duplicate submission requests** | **PASS** |
| **Automated Storm Queue Deliveries** | 9,999 authentic + 800 retries | **10,799 / 10,799 HTTP 202 Accepted (100.0%)** | **PASS** |
| **Total Submission Queue Deliveries** | Initial 10,799 + 1 recovered student | **10,800 / 10,800 HTTP 202 Accepted (100.0%)** | **PASS** |
| **Submission Storm 5xx / Drops** | 10,800 queue deliveries | **0 dropped / 0 rejected (100.0% acceptance)** | **PASS** |
| **Overall HTTP Transactions SLA** | 40,798 automated transactions | **40,797 / 40,798 success (99.9975% SLA)** *(1)* | **PASS** |
| **Staging Duration** | Staged attempts & drafts | **77.14 seconds** | **PASS** |
| **Synchronized Storm Duration** | Concurrent barrier release | **8.45 seconds** | **PASS** |
| **Observed Client-Side Storm Admission Throughput** | 10,799 queue deliveries | **1,278.57 req/sec (10,799 in 8.45s)** | **PASS** |
| **Asynchronous D1 Drain Time** | 10,000 submissions | **616.26 seconds (~10.27 minutes)** | **PASS** |
| **Observed Persistence Pipeline Drain Rate** | Multi-row batch transactions | **16.23 submissions/sec (~162.3 rows/s)** | **PASS** |
| **Authoritative D1 Submissions** | Deduplicated persistence | **10,000 (Expected: 10,000)** | **PASS** |
| **Authoritative Answer Rows** | 10 answers / student | **100,000 (Expected: 100,000)** | **PASS** |
| **Finalized Exam Attempts** | status = 'submitted' | **10,000 (Expected: 10,000)** | **PASS** |
| **Duplicate Submissions in D1** | Idempotent persistence | **0 duplicate rows** | **PASS** |
| **Multi-Submission Students in D1** | One submission per student | **0 multi-sub students** | **PASS** |
| **Incomplete Answer Distributions** | Exactly 10 answers / sub | **0 malformed rows** | **PASS** |
| **Submissions Dead Letter Queue (DLQ)** | Measured via KV DLQ counter | **0 messages** | **PASS** |
| **Scoring Dead Letter Queue (DLQ)** | Measured via KV DLQ counter | **0 messages** | **PASS** |
| **D1 Overload / Queue-Timeout Errors** | Monitored across drain | **0 observed** | **PASS** |
| **Benchmark Settlement** | Two consecutive audits | **PASS on Poll 112 & Poll 113** | **PASS** |

*(1) **Staging Anomaly Traceability**: During pre-storm staging across 150 client workers, exactly 1 out of 10,000 `POST /attempts` requests returned `HTTP 500: D1_ERROR: Network connection lost` due to an ephemeral socket reset. The remaining 9,999 students staged cleanly and entered the synchronized barrier storm. The single unstaged student (`bench_s_1790746104_4641`) was subsequently staged (`attempt: 90d93b41-184b-45a8-84a5-ce87641e29e8`) and queued into the persistence pipeline during the drain, bringing the authoritative population to exactly 10,000. Zero submission requests experienced any failure.*

---

## 2. Admission Layer Latency Distribution

Under the 150-worker client socket pool and synchronized barrier release:

| Exam Lifecycle Phase | Count | p50 (ms) | p90 (ms) | p95 (ms) | p99 (ms) | Max (ms) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| `GET /exams/:id (KV Cache Hit)` | 10,000 | 205.7 | 223.5 | 232.1 | 657.6 | 831.7 |
| `POST /attempts (D1 Start)` | 10,000 | 546.9 | 906.7 | 1028.1 | 1288.5 | 1478.9 |
| `POST /submissions/draft (KV Autosave)` | 9,999 | 364.1 | 382.8 | 393.5 | 680.5 | 1040.7 |
| `POST /submissions (Queue Admission 202 Ack)` | 9,999 | 5674.0 | 6864.3 | 7009.2 | 7096.6 | 7382.6 |
| `POST /submissions (Duplicate Retry 202 Ack)` | 800 | 334.8 | 2926.0 | 3611.9 | 3767.0 | 3856.1 |

*Note on Admission Latency*: The ~5.6s p50 on initial submission admission is governed by client-side socket queuing under the 150-worker harness ceiling. Once connections opened, the edge accepted the payload directly into Workers Queues with zero backend D1 reads.

---

## 3. Remote Invariant Audit Truth

From native edge audit endpoint `GET /admin/reconciliation?exam_id=bbf22745-8a8b-4a85-bcfc-a227dd6c3fe4&format=audit`:

```json
{
  "exam_id": "bbf22745-8a8b-4a85-bcfc-a227dd6c3fe4",
  "expected": {
    "students": 10000,
    "submissions": 10000,
    "answers": 100000,
    "finalized_attempts": 10000
  },
  "actual": {
    "submissions": 10000,
    "unique_students": 10000,
    "unique_attempts": 10000,
    "unique_submission_ids": 10000,
    "answers": 100000,
    "finalized_attempts": 10000,
    "scored_submissions": 681
  },
  "invariants": {
    "submission_count_exact": true,
    "unique_student_count_exact": true,
    "unique_attempt_count_exact": true,
    "unique_submission_id_exact": true,
    "answer_count_exact": true,
    "finalized_attempt_count_exact": true,
    "duplicate_submission_ids": 0,
    "students_with_multiple_submissions": 0,
    "attempts_with_multiple_submissions": 0,
    "submissions_with_wrong_answer_count": 0,
    "attempts_not_finalized_for_submissions": 0
  },
  "queue_observation": {
    "submission_dlq_messages": 0,
    "scoring_dlq_messages": 0,
    "measurement_source": "dlq_consumer_kv_counter",
    "observed_at": "2026-09-30T05:40:37.159Z"
  },
  "status": "PASS"
}
```

> **Asynchronous Scoring Status**:  
> The QForge architecture intentionally decouples submission persistence from scoring via a secondary queue (`Worker -> Queues -> Persistence Consumer (D1) -> Scoring Queue -> Scoring Consumer (D1)`). Scoring completion was asynchronous and was not used as a prerequisite for submission-persistence settlement. At reconciliation time, 681 submissions had completed scoring, with zero scoring DLQ failures.

---

## 4. Key Architectural Takeaways & Engineering Conclusions

> **Final Architectural Conclusion**:  
> **QForge has empirically validated a 10,000-submission synchronized workload on Cloudflare Workers + Queues + D1 + KV. A total of 10,800 submission deliveries, including 800 duplicate deliveries, reconciled to exactly 10,000 authoritative submissions, 100,000 answer rows and 10,000 finalized attempts. The controlled persistence pipeline sustained an observed 16.23 submissions/sec at consumer concurrency 2, with zero observed D1 overload/queue-timeout errors and zero DLQ messages.**
>
> **For the intended deployment footprint of approximately 1,000 simultaneous examinees, this provides a substantial empirical margin on the synchronized submission workload. A separate 3-hour endurance test would be required to characterize sustained autosave traffic over the full examination duration.**

1. **Edge Admission Decoupled from D1 Persistence**:
   - Storing incoming exam submissions directly to Cloudflare Queues allowed the platform to absorb an observed client-side storm admission rate of **1,278.57 requests/sec** (10,799 deliveries in 8.45 seconds) without a single submission drop or timeout.
2. **Observed Persistence Pipeline Drain Rate**:
   - At `max_concurrency = 2` and `max_batch_size = 25`, the consumer pipeline sustained **16.23 submissions/sec** (~162.3 answer rows/sec), draining all 10,000 examinees into SQLite D1 in **616.26 seconds (~10.27 minutes)**.
   - Throughout the entire drain, **zero D1 overload or queue-timeout errors** occurred.
3. **Attempt-Level Duplicate Protection Verified**:
   - 10,800 total submission deliveries (10,000 authentic + 800 duplicate retries), including one authentic submission delivered after the initial automated staging anomaly, resulted in exactly **10,000 authoritative submission rows**, **100,000 answer rows**, and **10,000 finalized attempts**.
   - Zero duplicate rows, zero multi-submission students, and zero Dead Letter Queue messages were produced.
4. **Real-World Deployment Projection (1,000 Simultaneous Examinees)**:
   - For an operational footprint of **10 colleges × 100 workstations = 1,000 simultaneous examinees**, a synchronized final-submit wave would project to approximately **61.6 seconds** if the observed 16.23 submissions/sec drain rate were maintained under the smaller workload; this is a throughput projection, not a separate 1,000-student capacity test.
   - The platform demonstrated stability under a synchronized submission workload **10× larger** than this operational footprint without observing D1 overload or queue-timeout errors during the measured persistence drain.
   - **Workload Distinction**: The 10,000-student benchmark validates the synchronized submission/persistence path. It does not by itself constitute a 3-hour endurance test of continuous autosave traffic.
5. **Data Settlement & Teardown**:
   - The benchmark was reconciled against the remote D1 database at settlement; synthetic benchmark records were subsequently removed from the production database. The complete benchmark ledger and reconciliation report are retained in the repository.
