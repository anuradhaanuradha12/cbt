# QForge CBT Platform — 500-User Concurrency Benchmark Report

**Date:** 2026-09-29  
**Target Environment:** Cloudflare Workers + D1 (`cbt-platform`) + Cloudflare KV (`CBT_KV`)  
**Worker Version ID:** `d95027da-fee5-4fff-a4c5-3f90bdb08aa4`  
**Test Harness:** `worker/scripts/run_load_test.py`  

---

## 1. Executive Summary

QForge was load-tested with **500 concurrent virtual student sessions** executing full end-to-end examination lifecycles across **2,500 total API transactions**. The test achieved **100.00% SLA compliance (0 failures or dropped requests)** at an aggregate throughput of **96.11 req/sec**.

Following database batching (`env.DB.batch`) and pure KV autosave optimizations, **final submission p95 latency decreased from 1,491.0 ms to 1,010.4 ms (a 32.2% latency reduction)**.

---

## 2. Test Architecture & Workload Profile

The simulation mirrors real-world test-taking behavior for 500 examinees:
- **Exam Delivery (`GET /exams/:id`)**: Edge KV cache hits returning exam payload with answer keys safely stripped.
- **Attempt Initialization (`POST /attempts`)**: Server-side exam validation, timer start, and attempt record creation.
- **In-Exam Autosave (`POST /submissions/draft`)**: Periodic KV state persistence (2 drafts per student = 1,000 autosave transactions) with zero D1 read/write overhead.
- **Final Exam Submission (`POST /submissions`)**: Atomic batched update of attempt status, submission record creation, per-question answer records, and asynchronous score calculation.

---

## 3. Benchmark Results & Latency Distribution

```
========================================================================================
       QFORGE CONCURRENCY BENCHMARK REPORT: 500 CONCURRENT SESSIONS
========================================================================================
Concurrent Virtual Students:    500
Total API Transactions:         2,500
Total Test Duration:            26.01 seconds
Sustained Aggregate RPS:        96.11 req/sec
HTTP Status Codes:              {200: 2000, 201: 500}
Failed Transactions:            0
Success Rate (SLA Compliance):  100.00%
----------------------------------------------------------------------------------------
Exam Lifecycle Phase                     | Count  | p50 (ms)  | p90 (ms)  | p95 (ms)  | p99 (ms)  | Max (ms) 
----------------------------------------------------------------------------------------
GET /exams/:id (KV Cache Hit)            | 500    | 250.5     | 473.4     | 539.0     | 639.1     | 5974.0   
POST /attempts (D1 Start)                | 500    | 204.4     | 415.1     | 503.8     | 622.2     | 835.7    
POST /submissions/draft (KV Autosave)    | 1000   | 443.1     | 485.5     | 566.0     | 776.9     | 1311.9   
POST /submissions (D1 Submit + Async)    | 500    | 639.0     | 933.7     | 1010.4    | 1237.3    | 1770.1   
========================================================================================
```

---

## 4. Before vs. After Optimization Comparison

| Metric / Endpoint | Pre-Optimization Baseline | Post-Optimization (Current) | Delta / Improvement |
| :--- | :---: | :---: | :---: |
| **Total Transactions** | 2,500 | 2,500 | 0 failed requests (100%) |
| **Aggregate RPS** | 88.31 req/s | **96.11 req/s** | **+8.8% throughput** |
| **Submission p50** | 896.3 ms | **639.0 ms** | ⚡ **-28.7%** (-257 ms) |
| **Submission p90** | ~1,250 ms | **933.7 ms** | ⚡ **Sub-second p90** |
| **Submission p95** | 1,491.0 ms | **1,010.4 ms** | ⚡ **-32.2%** (-481 ms) |
| **Submission p99** | 1,723.2 ms | **1,237.3 ms** | ⚡ **-28.2%** (-486 ms) |
| **Autosave p50** | 506.9 ms | **443.1 ms** | ⚡ **-12.6%** (Zero D1 reads) |
| **Autosave p95** | 742.4 ms | **566.0 ms** | ⚡ **-23.8%** (-176 ms) |
| **Attempt Start p50** | 293.8 ms | **204.4 ms** | ⚡ **-30.4%** (-89 ms) |
| **Attempt Start p95** | 688.4 ms | **503.8 ms** | ⚡ **-26.8%** (-185 ms) |

---

## 5. Architectural Verification & Database Integrity

1. **Edge-to-Database Segregation**:
   - Autosaves operate 100% on Cloudflare KV edge cache without querying D1.
   - Core exam payloads are served from KV edge cache, eliminating database contention during exam delivery.
2. **D1 Batching Atomicity**:
   - Attempt validation and start are executed in a single atomic round-trip.
   - Submission state update and per-question record persistence are executed in a single atomic batch transaction.
3. **Pristine State Maintenance**:
   - Automated teardown successfully purged all 500 test student accounts and exam attempts. Production question bank remains at exactly 86,737 verified records.
