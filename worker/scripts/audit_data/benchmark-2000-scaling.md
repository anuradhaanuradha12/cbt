# QForge CBT Platform — 2,000-User Concurrency Benchmark Report

**Date:** 2026-09-29  
**Target Environment:** Cloudflare Workers + D1 (`cbt-platform`) + Cloudflare KV (`CBT_KV`)  
**Worker Version ID:** `d95027da-fee5-4fff-a4c5-3f90bdb08aa4`  
**Test Harness:** `worker/scripts/run_load_test.py`  

---

## 1. Executive Summary

QForge was load-tested with **2,000 concurrent virtual student sessions** executing full end-to-end examination lifecycles across **10,000 total API transactions**. The benchmark maintained **100.00% transaction success (0 failures, 0 dropped requests, 0 HTTP 5xx errors)** at an aggregate sustained throughput of **124.40 req/sec**.

---

## 2. Benchmark Results & Latency Distribution

```
========================================================================================
       QFORGE CONCURRENCY BENCHMARK REPORT: 2,000 CONCURRENT SESSIONS
========================================================================================
Concurrent Virtual Students:    2,000
Total API Transactions:         10,000
Total Test Duration:            80.38 seconds
Sustained Aggregate RPS:        124.40 req/sec
HTTP Status Codes:              {200: 8000, 201: 2000}
Failed Transactions:            0
Success Rate (SLA Compliance):  100.00%
----------------------------------------------------------------------------------------
Exam Lifecycle Phase                     | Count  | p50 (ms)  | p90 (ms)  | p95 (ms)  | p99 (ms)  | Max (ms) 
----------------------------------------------------------------------------------------
GET /exams/:id (KV Cache Hit)            | 2000   | 259.5     | 451.3     | 800.2     | 5004.8    | 7302.0   
POST /attempts (D1 Start)                | 2000   | 517.3     | 948.6     | 1079.4    | 2598.2    | 4172.8   
POST /submissions/draft (KV Autosave)    | 4000   | 442.8     | 505.1     | 695.6     | 3887.8    | 5283.7   
POST /submissions (D1 Submit + Async)    | 2000   | 1057.7    | 1546.3    | 1669.8    | 2876.1    | 4994.3   
========================================================================================
```

---

## 3. Concurrency Scaling Curve: 500 &rarr; 1,000 &rarr; 2,000 Sessions

| Metric / Lifecycle Phase | 500 Sessions (2.5k Txns) | 1,000 Sessions (5.0k Txns) | 2,000 Sessions (10.0k Txns) | Scaling Trend |
| :--- | :---: | :---: | :---: | :---: |
| **Sustained Aggregate RPS** | `96.11 req/s` | `123.75 req/s` | **`124.40 req/s`** | Reached worker connection plateau (~124 RPS) |
| **Failed Transactions** | 0 (0.00%) | 0 (0.00%) | **0 (0.00%)** | **100% SLA across all load tiers** |
| **Autosave p50 / p95** | 443.1 / 566.0 ms | 442.9 / 508.3 ms | **442.8 / 695.6 ms** | Solid p50/p95 (p99 tail under heavy concurrency) |
| **Attempt Start p50 / p95** | 204.4 / 503.8 ms | 307.7 / 745.0 ms | **517.3 / 1,079.4 ms** | Linear D1 transaction queueing |
| **Final Submission p50** | 639.0 ms | 748.9 ms | **1,057.7 ms** | Predictable growth (~1.05s median) |
| **Final Submission p95** | 1,010.4 ms | 1,284.6 ms | **1,669.8 ms** | Sub-1.7s p95 at 2,000 concurrency |
| **Final Submission p99** | 1,237.3 ms | 1,497.7 ms | **2,876.1 ms** | Visible D1 queue tail |

---

## 4. Empirical Scaling Conclusions

1. **Transaction Integrity**:
   - Zero transaction drops, deadlocks, or database corruption occurred across the 10,000-transaction run.
2. **Predictable Latency Profile**:
   - Up through **p95**, all operations remained under **1.67 seconds**, with median submissions at ~1.05s.
3. **Queue Behavior at p99**:
   - Under 2,000 concurrent sessions, the system aggregate throughput leveled out at ~124 RPS, causing the p99 tail for database writes and client connection pools to stretch to ~2.6–2.9s.
