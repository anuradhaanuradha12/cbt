import asyncio
import aiohttp
import time
import json
import statistics
import hmac
import hashlib
import base64
import uuid

# Configuration
BASE_URL = "https://qforge.shishira-932.workers.dev"
JWT_SECRET = b"qforge-cbt-production-jwt-super-secret-key-2026-secure"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

# Sample 10 question IDs for the test exam
TEST_QUESTION_IDS = [
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
            'login': [],
            'get_exam': [],
            'start_attempt': [],
            'save_draft': [],
            'submit_exam': []
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
        if error:
            self.errors.append((action, status, error))

    def summarize(self):
        duration = max(0.001, self.end_time - self.start_time)
        rps = self.total_requests / duration
        print("\n" + "="*70)
        print("          QFORGE CLOUD INFRASTRUCTURE LOAD BENCHMARK")
        print("="*70)
        print(f"Total Requests:      {self.total_requests:,}")
        print(f"Total Duration:      {duration:.2f} seconds")
        print(f"Throughput (RPS):    {rps:.2f} req/sec")
        print(f"Status Code Summary: {dict(sorted(self.status_codes.items()))}")
        print(f"Total Errors:        {len(self.errors)}")
        print("-"*70)
        print(f"{'Endpoint / Action':<20} | {'Count':<6} | {'p50 (ms)':<9} | {'p90 (ms)':<9} | {'p95 (ms)':<9} | {'p99 (ms)':<9} | {'Max (ms)':<9}")
        print("-"*70)
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
            print(f"{action:<20} | {count:<6} | {p50:<9.1f} | {p90:<9.1f} | {p95:<9.1f} | {p99:<9.1f} | {max_lat:<9.1f}")
        print("="*70)
        if self.errors[:5]:
            print("\nSample Errors:")
            for e in self.errors[:5]:
                print(f"  [{e[0]}] Status {e[1]}: {e[2]}")
        print("="*70)

metrics = BenchmarkMetrics()

async def simulate_student(session: aiohttp.ClientSession, student_idx: int, exam_id: str, jwt_token: str, sem: asyncio.Semaphore):
    headers = {
        'Authorization': f'Bearer {jwt_token}',
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        'Accept': 'application/json'
    }

    async with sem:
        # Step 1: GET /exams/:id (Load exam questions & config, test KV cache hit)
        t0 = time.perf_counter()
        try:
            async with session.get(f"{BASE_URL}/exams/{exam_id}", headers=headers) as resp:
                t1 = time.perf_counter()
                body = await resp.json()
                metrics.record('get_exam', t1 - t0, resp.status)
                if resp.status != 200:
                    metrics.record('get_exam', t1 - t0, resp.status, str(body))
                    return
        except Exception as e:
            metrics.record('get_exam', time.perf_counter() - t0, 0, str(e))
            return

        # Step 2: POST /attempts (Start exam attempt)
        t0 = time.perf_counter()
        attempt_id = None
        try:
            async with session.post(f"{BASE_URL}/attempts", headers=headers, json={"exam_id": exam_id}) as resp:
                t1 = time.perf_counter()
                body = await resp.json()
                metrics.record('start_attempt', t1 - t0, resp.status)
                if resp.status in (200, 201):
                    attempt_id = body.get('attempt_id')
                else:
                    metrics.record('start_attempt', t1 - t0, resp.status, str(body))
                    return
        except Exception as e:
            metrics.record('start_attempt', time.perf_counter() - t0, 0, str(e))
            return

        # Step 3: POST /submissions/draft (Simulate intermediate autosaves during test)
        for draft_num in range(2):
            t0 = time.perf_counter()
            answers = {
                TEST_QUESTION_IDS[0]: "A",
                TEST_QUESTION_IDS[1]: "B",
                TEST_QUESTION_IDS[2]: "C",
            }
            try:
                async with session.post(f"{BASE_URL}/submissions/draft", headers=headers, json={"exam_id": exam_id, "answers": answers}) as resp:
                    t1 = time.perf_counter()
                    body = await resp.json()
                    metrics.record('save_draft', t1 - t0, resp.status)
            except Exception as e:
                metrics.record('save_draft', time.perf_counter() - t0, 0, str(e))

        # Step 4: POST /submissions (Final bulk submission & scoring)
        t0 = time.perf_counter()
        final_answers = {
            TEST_QUESTION_IDS[0]: "A",
            TEST_QUESTION_IDS[1]: "B",
            TEST_QUESTION_IDS[2]: "C",
            TEST_QUESTION_IDS[3]: "D",
            TEST_QUESTION_IDS[4]: "A",
        }
        try:
            async with session.post(f"{BASE_URL}/submissions", headers=headers, json={
                "exam_id": exam_id,
                "attempt_id": attempt_id,
                "answers": final_answers,
                "marked_for_review": [TEST_QUESTION_IDS[0]],
                "answer_timestamps": {TEST_QUESTION_IDS[0]: int(time.time())},
                "time_taken_seconds": 120
            }) as resp:
                t1 = time.perf_counter()
                body = await resp.json()
                metrics.record('submit_exam', t1 - t0, resp.status)
                if resp.status != 200:
                    metrics.record('submit_exam', t1 - t0, resp.status, str(body))
        except Exception as e:
            metrics.record('submit_exam', time.perf_counter() - t0, 0, str(e))

async def main(concurrency: int = 500, max_in_flight: int = 100):
    print(f"Initializing high-concurrency load test: {concurrency} virtual students (max {max_in_flight} in-flight)...")

    # Step A: Generate an exam in D1 or retrieve existing
    admin_token = generate_jwt('usr_admin_1', 'principal@cbt.local', 'admin', 'Platform Admin', 'global', 'admin-session')
    
    # We will register a shared session for testing
    student_jwt = generate_jwt('usr_student_1', 'student@cbt.local', 'student', 'Student Demo', 'global', 'load-test-session')
    
    admin_headers = {
        'Authorization': f'Bearer {admin_token}',
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT
    }

    connector = aiohttp.TCPConnector(limit=max_in_flight, ttl_dns_cache=300)
    async with aiohttp.ClientSession(connector=connector) as session:
        # Create an exam
        exam_id = f"load-test-exam-{int(time.time())}"
        print(f"Creating published benchmark exam: {exam_id}...")
        
        exam_payload = {
            "title": f"Institutional Benchmark Mock {int(time.time())}",
            "duration_minutes": 180,
            "total_marks": 40,
            "exam_type": "neet",
            "question_ids": [{"id": qid, "marks": 4, "negative_marks": 1.0} for qid in TEST_QUESTION_IDS]
        }
        
        async with session.post(f"{BASE_URL}/exams", headers=admin_headers, json=exam_payload) as resp:
            exam_data = await resp.json()
            if resp.status not in (200, 201):
                print(f"Failed to create exam: {resp.status} {exam_data}")
                return
            created_exam_id = exam_data['id']
            print(f"Exam created successfully: {created_exam_id}")

        # Publish the exam
        starts_at = int(time.time()) - 60 # started 1 min ago
        publish_payload = {
            "starts_at": starts_at,
            "config": {
                "negative_marking": True,
                "marks_correct": 4,
                "marks_wrong": 1,
                "duration_minutes": 180
            }
        }
        async with session.put(f"{BASE_URL}/exams/{created_exam_id}/publish", headers=admin_headers, json=publish_payload) as resp:
            pub_data = await resp.json()
            print(f"Exam published: {resp.status} {pub_data}")

        # Execute warm-up request to pre-populate KV cache for exam
        async with session.get(f"{BASE_URL}/exams/{created_exam_id}", headers={'Authorization': f'Bearer {student_jwt}', 'User-Agent': USER_AGENT}) as resp:
            res_json = await resp.json()
            print(f"KV Warmup GET /exams/{created_exam_id}: status={resp.status}, cached={res_json.get('from_cache', False)}")

        print(f"\nStarting concurrent simulated student sessions ({concurrency} students)...")
        metrics.start_time = time.perf_counter()
        
        sem = asyncio.Semaphore(max_in_flight)
        tasks = [
            simulate_student(session, i, created_exam_id, student_jwt, sem)
            for i in range(concurrency)
        ]
        
        await asyncio.gather(*tasks)
        metrics.end_time = time.perf_counter()

        metrics.summarize()

if __name__ == '__main__':
    import sys
    concurrency = int(sys.argv[1]) if len(sys.argv) > 1 else 100
    in_flight = int(sys.argv[2]) if len(sys.argv) > 2 else 50
    asyncio.run(main(concurrency, in_flight))
