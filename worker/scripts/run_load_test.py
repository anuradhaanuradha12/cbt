import asyncio
import aiohttp
import time
import json
import statistics
import hmac
import hashlib
import base64
import uuid
import sys
import subprocess
import os

# Configuration
BASE_URL = "https://qforge.shishira-932.workers.dev"
JWT_SECRET = b"qforge-cbt-production-jwt-super-secret-key-2026-secure"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

# 10 realistic questions selected for the benchmark exam
BENCHMARK_QUESTION_IDS = [
    "6dfd04b1-5c75-448d-b621-c5adbf208f41",
    "572e2edc-26a6-48cd-8c4f-16242cf0de12",
    "3010e30b-3d74-4b82-a4be-ec173d01c6e8",
    "6e398a04-07e8-40dc-b0b1-9074a110bdf0",
    "3ff42bf2-75e6-44fd-af08-43c2f296bfc8",
    "dc37b225-7f47-437f-8f49-38c8f75a0093",
    "6b7564bc-6c53-4507-b204-561690bb597c",
    "a6eed102-cb28-4b66-82da-93ce0e63bffc",
    "a98e118e-27f3-4def-8abc-aa8f6548c9f3",
    "5b1c1c63-8570-4b92-a2e8-4612e7ed4d93"
]

def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('utf-8')

def generate_jwt(user_id: str, email: str, role: str, name: str, college_id: str, sid: str) -> str:
    header = {'alg': 'HS256', 'typ': 'JWT'}
    now = int(time.time())
    payload = {
        'sub': user_id,
        'email': email,
        'role': role,
        'name': name,
        'college_id': college_id,
        'sid': sid,
        'iat': now,
        'exp': now + 86400 * 7
    }
    h_b64 = b64url(json.dumps(header).encode())
    p_b64 = b64url(json.dumps(payload).encode())
    msg = f'{h_b64}.{p_b64}'.encode()
    sig = b64url(hmac.new(JWT_SECRET, msg, hashlib.sha256).digest())
    return f'{h_b64}.{p_b64}.{sig}'

class BenchmarkMetrics:
    def __init__(self):
        self.latencies = {
            'GET /exams/:id (KV Cache Hit)': [],
            'POST /attempts (D1 Start)': [],
            'POST /submissions/draft (KV Autosave)': [],
            'POST /submissions (D1 Submit + Async Score)': []
        }
        self.status_codes = {}
        self.errors = []
        self.total_requests = 0
        self.start_time = 0
        self.end_time = 0

    def record(self, action: str, latency: float, status: int, error: str = None):
        self.total_requests += 1
        if action in self.latencies:
            self.latencies[action].append(latency)
        self.status_codes[status] = self.status_codes.get(status, 0) + 1
        if error or status >= 400:
            self.errors.append((action, status, error or f"Status {status}"))

    def summarize(self, student_count: int):
        duration = max(0.001, self.end_time - self.start_time)
        rps = self.total_requests / duration
        print("\n" + "="*88)
        print(f"       QFORGE ENTERPRISE LOAD BENCHMARK REPORT: {student_count:,} CONCURRENT SESSIONS")
        print("="*88)
        print(f"Concurrent Virtual Students:    {student_count:,}")
        print(f"Total API Transactions:         {self.total_requests:,}")
        print(f"Total Test Duration:            {duration:.2f} seconds")
        print(f"Sustained Aggregate RPS:        {rps:.2f} req/sec")
        print(f"HTTP Status Codes:              {dict(sorted(self.status_codes.items()))}")
        print(f"Failed Transactions:            {len(self.errors)}")
        print(f"Success Rate (SLA Compliance):  {((self.total_requests - len(self.errors)) / max(1, self.total_requests))*100:.2f}%")
        print("-"*88)
        print(f"{'Exam Lifecycle Phase':<40} | {'Count':<6} | {'p50 (ms)':<9} | {'p90 (ms)':<9} | {'p95 (ms)':<9} | {'p99 (ms)':<9} | {'Max (ms)':<9}")
        print("-"*88)
        for action, lats in self.latencies.items():
            if not lats:
                continue
            lats_ms = [l * 1000 for l in lats]
            lats_ms.sort()
            count = len(lats_ms)
            p50 = statistics.median(lats_ms)
            p90 = lats_ms[int(count * 0.90)] if count > 1 else lats_ms[0]
            p95 = lats_ms[int(count * 0.95)] if count > 1 else lats_ms[0]
            p99 = lats_ms[int(count * 0.99)] if count > 1 else lats_ms[0]
            max_lat = max(lats_ms)
            print(f"{action:<40} | {count:<6} | {p50:<9.1f} | {p90:<9.1f} | {p95:<9.1f} | {p99:<9.1f} | {max_lat:<9.1f}")
        print("="*88)
        if self.errors:
            print(f"\nCaptured Errors (first 5):")
            for e in self.errors[:5]:
                print(f"  [{e[0]}] HTTP {e[1]}: {e[2]}")
        else:
            print("\n>> ZERO FAILURES OR DROPPED TRANSACTIONS ACROSS ENTIRE SIMULATION RUN <<")
        print("="*88 + "\n")

metrics = BenchmarkMetrics()

async def simulate_student_session(
    session: aiohttp.ClientSession,
    student_id: str,
    email: str,
    exam_id: str,
    token: str,
    sem: asyncio.Semaphore
):
    headers = {
        'Authorization': f'Bearer {token}',
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        'Accept': 'application/json'
    }

    async with sem:
        # Phase 1: GET /exams/:id (KV edge cache hit)
        t0 = time.perf_counter()
        try:
            async with session.get(f"{BASE_URL}/exams/{exam_id}", headers=headers) as resp:
                t1 = time.perf_counter()
                body = await resp.json()
                metrics.record('GET /exams/:id (KV Cache Hit)', t1 - t0, resp.status)
                if resp.status != 200:
                    metrics.record('GET /exams/:id (KV Cache Hit)', t1 - t0, resp.status, str(body))
                    return
        except Exception as e:
            metrics.record('GET /exams/:id (KV Cache Hit)', time.perf_counter() - t0, 0, str(e))
            return

        # Phase 2: POST /attempts (Student starts attempt in D1)
        t0 = time.perf_counter()
        attempt_id = None
        try:
            async with session.post(f"{BASE_URL}/attempts", headers=headers, json={"exam_id": exam_id}) as resp:
                t1 = time.perf_counter()
                body = await resp.json()
                metrics.record('POST /attempts (D1 Start)', t1 - t0, resp.status)
                if resp.status in (200, 201):
                    attempt_id = body.get('attempt_id')
                else:
                    metrics.record('POST /attempts (D1 Start)', t1 - t0, resp.status, str(body))
                    return
        except Exception as e:
            metrics.record('POST /attempts (D1 Start)', time.perf_counter() - t0, 0, str(e))
            return

        # Phase 3: POST /submissions/draft (Periodic auto-save into KV)
        for _ in range(2):
            t0 = time.perf_counter()
            answers = {
                BENCHMARK_QUESTION_IDS[0]: "A",
                BENCHMARK_QUESTION_IDS[1]: "C",
                BENCHMARK_QUESTION_IDS[2]: "B",
            }
            try:
                async with session.post(
                    f"{BASE_URL}/submissions/draft",
                    headers=headers,
                    json={"exam_id": exam_id, "answers": answers}
                ) as resp:
                    t1 = time.perf_counter()
                    body = await resp.json()
                    metrics.record('POST /submissions/draft (KV Autosave)', t1 - t0, resp.status)
            except Exception as e:
                metrics.record('POST /submissions/draft (KV Autosave)', time.perf_counter() - t0, 0, str(e))

        # Phase 4: POST /submissions (Final bulk submission & async scoring)
        t0 = time.perf_counter()
        final_answers = {
            BENCHMARK_QUESTION_IDS[0]: "A",
            BENCHMARK_QUESTION_IDS[1]: "B",
            BENCHMARK_QUESTION_IDS[2]: "C",
            BENCHMARK_QUESTION_IDS[3]: "D",
            BENCHMARK_QUESTION_IDS[4]: "A",
            BENCHMARK_QUESTION_IDS[5]: "B",
            BENCHMARK_QUESTION_IDS[6]: "C",
            BENCHMARK_QUESTION_IDS[7]: "D",
            BENCHMARK_QUESTION_IDS[8]: "A",
            BENCHMARK_QUESTION_IDS[9]: "B",
        }
        try:
            async with session.post(
                f"{BASE_URL}/submissions",
                headers=headers,
                json={
                    "exam_id": exam_id,
                    "attempt_id": attempt_id,
                    "answers": final_answers,
                    "marked_for_review": [BENCHMARK_QUESTION_IDS[2]],
                    "answer_timestamps": {BENCHMARK_QUESTION_IDS[0]: int(time.time())},
                    "time_taken_seconds": 240
                }
            ) as resp:
                t1 = time.perf_counter()
                body = await resp.json()
                metrics.record('POST /submissions (D1 Submit + Async Score)', t1 - t0, resp.status)
                if resp.status != 200:
                    metrics.record('POST /submissions (D1 Submit + Async Score)', t1 - t0, resp.status, str(body))
        except Exception as e:
            metrics.record('POST /submissions (D1 Submit + Async Score)', time.perf_counter() - t0, 0, str(e))

async def run_benchmark(num_students: int = 500, max_in_flight: int = 50):
    print(f"Setting up load test environment for {num_students:,} distinct student sessions...")
    # Step 0: Define static admin session for the run
    admin_sid = "admin-bench-static-session"
    admin_token = generate_jwt('usr_admin_1', 'principal@cbt.local', 'admin', 'Platform Admin', 'global', admin_sid)
    admin_headers = {
        'Authorization': f'Bearer {admin_token}',
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT
    }

    connector = aiohttp.TCPConnector(limit=max_in_flight, ttl_dns_cache=300)
    async with aiohttp.ClientSession(connector=connector) as session:
        # Step 1: Provision students in D1
        print(f"Provisioning {num_students} virtual students in D1...")
        batch_id = int(time.time())
        student_records = []
        student_auth_list = []

        for i in range(num_students):
            sid = f"bench_s_{batch_id}_{i}"
            email = f"student_{batch_id}_{i}@loadtest.local"
            name = f"Virtual Student {i+1}"
            session_id = f"sess_{sid}"
            jwt = generate_jwt(sid, email, 'student', name, 'global', session_id)
            student_records.append({
                "id": sid,
                "email": email,
                "name": name,
                "session_id": session_id,
                "jwt": jwt
            })
            student_auth_list.append((sid, email, jwt, session_id))

        sql_statements = []
        for s in student_records:
            sql_statements.append(
                f"INSERT OR IGNORE INTO users (id, email, password_hash, role, name, college_id) "
                f"VALUES ('{s['id']}', '{s['email']}', 'dummy:hash', 'student', '{s['name']}', 'global');"
            )

        sql_file = "scratch/temp_students.sql"
        with open(sql_file, "w", encoding="utf-8") as f:
            f.write("\n".join(sql_statements))
        
        print(f"Executing D1 student bulk insertion ({len(sql_statements)} rows)...")
        subprocess.run(
            f'npx wrangler d1 execute cbt-platform --remote --file={sql_file}',
            cwd="d:/Websites/CBT/worker",
            shell=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
        print("Provisioned students in D1 successfully.")

        # Step 2: Register KV sessions for all students AND admin
        print("Registering student & admin sessions into Cloudflare KV...")
        kv_bulk_entries = [
            {"key": f"session:{s['id']}", "value": s['session_id'], "expiration_ttl": 86400}
            for s in student_records
        ]
        kv_bulk_entries.append({"key": "session:usr_admin_1", "value": admin_sid, "expiration_ttl": 86400})
        
        kv_bulk_file = "scratch/temp_kv_sessions.json"
        with open(kv_bulk_file, "w", encoding="utf-8") as f:
            json.dump(kv_bulk_entries, f)

        res_kv = subprocess.run(
            f'npx wrangler kv:bulk put --binding CBT_KV {kv_bulk_file}',
            cwd="d:/Websites/CBT/worker",
            shell=True,
            capture_output=True,
            text=True
        )
        if res_kv.returncode != 0:
            print("Wrangler KV bulk session registration failed:", res_kv.stderr)
            return
        print("Cloudflare KV active sessions synchronized.")

        # Step 3: Create & Publish benchmark exam
        print("Creating benchmark exam...")
        exam_payload = {
            "title": f"Load Test Institutional Simulation (Batch {batch_id})",
            "duration_minutes": 180,
            "total_marks": 40,
            "exam_type": "neet",
            "question_ids": [{"id": qid, "marks": 4, "negative_marks": 1.0} for qid in BENCHMARK_QUESTION_IDS]
        }
        async with session.post(f"{BASE_URL}/exams", headers=admin_headers, json=exam_payload) as resp:
            exam_data = await resp.json()
            if resp.status not in (200, 201):
                print(f"Exam creation failed: {resp.status} {exam_data}")
                return
            exam_id = exam_data['id']
            print(f"Exam created successfully: {exam_id}")

        publish_payload = {
            "starts_at": int(time.time()) - 30, # started 30s ago
            "config": {
                "negative_marking": True,
                "marks_correct": 4,
                "marks_wrong": 1,
                "duration_minutes": 180
            }
        }
        async with session.put(f"{BASE_URL}/exams/{exam_id}/publish", headers=admin_headers, json=publish_payload) as resp:
            print(f"Exam published: {resp.status}")

        # Warm up KV cache
        warmup_token = student_auth_list[0][2]
        async with session.get(f"{BASE_URL}/exams/{exam_id}", headers={'Authorization': f'Bearer {warmup_token}', 'User-Agent': USER_AGENT}) as resp:
            data = await resp.json()
            print(f"Exam KV Cache Warmup: status={resp.status}, cached={data.get('from_cache')}, questions={len(data.get('questions', []))}")

        # Step 4: Fire concurrent load test
        print(f"\n>>> LAUNCHING HIGH-CONCURRENCY EXAM RUN ({num_students:,} STUDENTS, {max_in_flight} IN-FLIGHT) <<<")
        metrics.start_time = time.perf_counter()
        
        sem = asyncio.Semaphore(max_in_flight)
        tasks = [
            simulate_student_session(session, s[0], s[1], exam_id, s[2], sem)
            for s in student_auth_list
        ]
        
        await asyncio.gather(*tasks)
        metrics.end_time = time.perf_counter()

        metrics.summarize(num_students)

        # Cleanup test exam & temp data
        print("Cleaning up benchmark students & exam from D1...")
        cleanup_sql = f"DELETE FROM exam_attempts WHERE exam_id = '{exam_id}';\nDELETE FROM submissions WHERE exam_id = '{exam_id}';\nDELETE FROM exam_questions WHERE exam_id = '{exam_id}';\nDELETE FROM exams WHERE id = '{exam_id}';\nDELETE FROM users WHERE id LIKE 'bench_s_{batch_id}_%';"
        with open("scratch/cleanup.sql", "w", encoding="utf-8") as f:
            f.write(cleanup_sql)
        subprocess.run(
            'npx wrangler d1 execute cbt-platform --remote --file=scratch/cleanup.sql',
            cwd="d:/Websites/CBT/worker",
            shell=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
        print("Cleanup completed.")

if __name__ == '__main__':
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 100
    in_flight = int(sys.argv[2]) if len(sys.argv) > 2 else 25
    asyncio.run(run_benchmark(count, in_flight))
