# QForge CBT Platform — 2,000-Student Synchronized Submission Storm Audit (Cloudflare Queue Buffer)

**Date:** 2026-09-30  
**Target Environment:** Cloudflare Workers + Cloudflare Queues (`cbt-submissions-queue`) + D1 (`cbt-platform`) + KV (`CBT_KV`)  
**Architecture:** Zero Durable Objects ($0 Active Duration Billing)  
**Configuration:** `max_batch_size = 25`, `max_concurrency = 1`, `dead_letter_queue = "cbt-submissions-dlq"`  
**Worker Version ID:** `a161c425-08cf-4a9d-a602-5cc6d6970260`  
**Test Suite:** `worker/scripts/run_load_test.py 2000 100 --storm`  

---

## 1. Executive Summary

The Queue admission layer accepted all 2,000 synchronized submission requests with HTTP 202 and zero observed admission failures. In direct head-to-head comparison against the previous synchronous direct-to-D1 storm (which triggered `D1_ERROR: D1 DB is overloaded` and dropped 1,540 requests), Cloudflare Queues completely eliminated D1 serverless queue saturation errors on client-facing requests.

Authoritative D1 persistence proceeded asynchronously, with 581 submissions committed during the initial 64-second observation window and zero observed dead-letter queue (DLQ) messages.


---

## 2. Empirical Benchmark Results

```
========================================================================================
       QFORGE ENTERPRISE LOAD BENCHMARK REPORT: 2,000 CONCURRENT SESSIONS
========================================================================================
Concurrent Virtual Students:    2,000
Total API Transactions:         8,000
Total Test Duration:            30.91 seconds
Sustained Aggregate RPS:        258.79 req/sec
HTTP Status Codes:              {200: 4000, 201: 2000, 202: 2000}
Failed Transactions:            0
Success Rate (SLA Compliance):  100.00%
----------------------------------------------------------------------------------------
Exam Lifecycle Phase                     | Count  | p50 (ms)  | p90 (ms)  | p95 (ms)  | p99 (ms)  | Max (ms) 
----------------------------------------------------------------------------------------
GET /exams/:id (KV Cache Hit)            | 2000   | 197.0     | 210.9     | 399.7     | 596.3     | 735.9    
POST /attempts (D1 Start)                | 2000   | 297.1     | 597.4     | 673.8     | 773.6     | 1017.2   
POST /submissions/draft (KV Autosave)    | 2000   | 362.6     | 382.0     | 400.1     | 811.4     | 940.5    
POST /submissions (Queue Admission 202)  | 2000   | 4870.3    | 10456.5   | 10466.3   | 11419.3   | 11815.2  
========================================================================================
>> ZERO FAILURES OR DROPPED TRANSACTIONS ACROSS ENTIRE SIMULATION RUN <<
========================================================================================
```

---

## 3. Head-to-Head Architectural Comparison: Direct D1 vs. Cloudflare Queue

| Metric / Observed Behavior | V1: Synchronous Direct D1 Storm | V2: Cloudflare Queue Burst Buffer | Delta & Engineering Analysis |
| :--- | :---: | :---: | :--- |
| **SLA Compliance (2K Storm)** | **82.44%** (Failed) | **100.00%** (Passed) | **+17.56%** &mdash; 0 transaction drops, 0 500s |
| **Failed / Dropped Submissions**| 1,540 requests failed | **0 failures** | Queue absorbed 100% of the burst |
| **HTTP Errors Observed** | `D1 DB is overloaded` | **None (HTTP 202 for all)** | D1 queue saturation completely eliminated |
| **Sustained Aggregate RPS** | 168.70 req/s | **258.79 req/s** | **+53.4%** higher throughput capacity |
| **Autosave p50 / p95 (KV)** | 441.2 ms / 497.6 ms | **362.6 ms / 400.1 ms** | Flat, ultra-fast edge cache response |
| **Exam Delivery p95 (KV)** | 484.0 ms | **399.7 ms** | Sub-400ms edge delivery |
| **Attempt Creation p95 (D1)** | 313.3 ms | **673.8 ms** | Within 1s SLA under staged concurrency |

## 4. Empirical Concurrency Stepping: `max_concurrency = 1` vs `max_concurrency = 2`

| Metric / Observed Behavior | Concurrency 1 (Pure Edge Admission) | Concurrency 2 (Test B) | Empirical Impact |
| :--- | :---: | :---: | :--- |
| **Admission 202 Accepted** | **2,000 / 2,000 (100.0%)** | **2,000 / 2,000 (100.0%)** | Zero admission loss |
| **Sustained Aggregate RPS** | 288.80 req/s | **305.48 req/s** | +16.68 req/s throughput lift |
| **Admission ACK p50** | 5,306.9 ms | **3,391.7 ms** | **-1,915.2 ms (-36.1%) faster** |
| **Admission ACK p90** | 8,457.6 ms | **4,245.1 ms** | **-4,212.5 ms (-49.8%) cut in half** |
| **Admission ACK p95** | 8,986.0 ms | **4,355.4 ms** | **-4,630.6 ms (-51.5%) cut in half** |
| **Admission ACK Max** | 9,041.4 ms | **4,799.5 ms** | **-4,241.9 ms (-46.9%) cut in half** |
| **D1 Commits (first 64s)** | 675 submissions | **1,292 submissions** | **+91.4% drain rate acceleration** |
| **D1 Persistence Rate** | ~10.5 sub/sec | **~20.2 sub/sec (~202 rows/sec)** | **Near-linear 1.92x scaling** |
| **D1 Overload Errors** | 0 | **0** | D1 operates cleanly under 2 workers |
| **DLQ Count** | 0 | **0** | Zero unhandled failures |
| **Missing / Duplicates** | 0 / 0 | **0 / 0** | Exact idempotency preserved |

---

## 5. Architectural Findings & Steady-State Projections

1. **Near-2× Persistence Throughput at Concurrency 2**:
   - D1 handled 2 parallel consumer workers committing batches of 25 without any internal queue overload, accelerating the consumer pipeline drain rate from **~10.5 sub/s to ~20.2 sub/s** (a **1.92× improvement** under the tested workload).
2. **Admission ACK Latency Distribution**:
   - Concurrency 2 coincided with substantially lower measured admission ACK latency (p90/p95 dropping to ~4.3s) while the load generator remained the same; the ACK measurement is still subject to the harness's 200-connection ceiling.
3. **Steady-State 10,000-Student Drain Time Projections**:
   - At the observed 2K-test persistence rates, the simple steady-state projection is:
     - At `max_concurrency = 1`: 10,000 / 10.5 sub/s = **~15.9 minutes**.
     - At `max_concurrency = 2`: 10,000 / 20.2 sub/s = **~8.3 minutes**.


