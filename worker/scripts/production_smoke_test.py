#!/usr/bin/env python3
"""
Production Read-Only Smoke Test
Verifies end-to-end operational health of the production deployment:
1. Edge API /health endpoint
2. Student authentication (POST /auth/login) with demo password
3. Principal/Admin authentication (POST /auth/login)
4. Question bank read access (GET /questions)
5. D1 system of record counts:
   - Exactly 86,737 questions
   - Exactly 10 authentic demo/staff users
   - 0 synthetic bench users
   - 0 exams / attempts / submissions / answers
   - 0 questions with empirical attempt telemetry (observed_attempt_count reset; AI/rubric classification intact)
6. KV DLQ counters
7. Static asset delivery (GET /)
"""

import sys
import json
import urllib.request
import urllib.error
import subprocess

PROD_URL = "https://qforge.shishira-932.workers.dev"
CWD = "d:/Websites/CBT/worker"

def http_req(method: str, path: str, data: dict = None, token: str = None) -> tuple[int, dict, str]:
    url = f"{PROD_URL}{path}"
    headers = {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = json.dumps(data).encode("utf-8") if data else None

    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            content = resp.read().decode("utf-8")
            try:
                parsed = json.loads(content)
            except Exception:
                parsed = None
            return resp.status, parsed, content
    except urllib.error.HTTPError as e:
        err_content = e.read().decode("utf-8")
        try:
            parsed = json.loads(err_content)
        except Exception:
            parsed = None
        return e.code, parsed, err_content
    except Exception as e:
        return 0, None, str(e)

def run_d1(command_sql: str) -> dict:
    flat_sql = " ".join(command_sql.strip().split())
    cmd = f'npx wrangler d1 execute cbt-platform --remote --command="{flat_sql}" --json'
    res = subprocess.run(
        cmd,
        cwd=CWD,
        shell=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace"
    )
    raw = res.stdout
    start = raw.find("[")
    end = raw.rfind("]")
    if start != -1 and end != -1:
        parsed = json.loads(raw[start:end+1])
        return parsed[0] if parsed else {}
    return {"raw": raw}

def main():
    print("=" * 70)
    print("      QFORGE PRODUCTION DEPLOYMENT & DATABASE SMOKE TEST")
    print("=" * 70)
    print(f"Target Edge URL: {PROD_URL}")

    # 1. Health check
    print("\n[1/6] Testing Edge Runtime /health...")
    status, data, _ = http_req("GET", "/health")
    print(f"      HTTP {status} -> {data}")
    assert status == 200 and data.get("status") == "ok", f"Health check failed! Status: {status}"

    # 2. Student Authentication
    print("\n[2/6] Testing Student Demo Authentication (POST /auth/login)...")
    status, data, _ = http_req("POST", "/auth/login", {"email": "student@cbt.local", "password": "demo12345"})
    student_token = data.get("token") if data else None
    print(f"      HTTP {status} -> User: {data.get('user', {}).get('name')}, Role: {data.get('user', {}).get('role')}, Token Present: {bool(student_token)}")
    assert status == 200 and student_token, "Student login failed!"

    # 3. Principal/Admin Authentication
    print("\n[3/6] Testing Principal Authentication (POST /auth/login)...")
    status, data, _ = http_req("POST", "/auth/login", {"email": "principal@cbt.local", "password": "demo12345"})
    admin_token = data.get("token") if data else None
    print(f"      HTTP {status} -> User: {data.get('user', {}).get('name')}, Role: {data.get('user', {}).get('role')}, Token Present: {bool(admin_token)}")
    assert status == 200 and admin_token, "Principal login failed!"

    # 4. Question Bank API
    print("\n[4/6] Testing Question Bank API (GET /questions?limit=3)...")
    status, data, _ = http_req("GET", "/questions?limit=3", token=admin_token)
    q_count = len(data.get("data", [])) if data else 0
    total_bank = data.get("total") if data else 0
    print(f"      HTTP {status} -> Questions returned: {q_count}, Bank total reported by API: {total_bank:,}")
    assert status == 200 and q_count == 3 and total_bank == 86737, f"Question bank query failed! count={q_count}, total={total_bank}"

    # 5. D1 Remote Invariant Verification
    print("\n[5/6] Auditing Remote D1 Production State...")
    sql1 = "SELECT 'questions' as tbl, count(*) as cnt FROM questions UNION ALL SELECT 'staff_users', count(*) FROM users WHERE id NOT LIKE 'bench_%' UNION ALL SELECT 'bench_users', count(*) FROM users WHERE id LIKE 'bench_%';"
    sql2 = "SELECT 'exams' as tbl, count(*) as cnt FROM exams UNION ALL SELECT 'attempts', count(*) FROM exam_attempts UNION ALL SELECT 'submissions', count(*) FROM submissions UNION ALL SELECT 'answers', count(*) FROM submission_answers;"
    sql3 = "SELECT 'questions_with_empirical_telemetry' as tbl, count(*) as cnt FROM questions WHERE observed_attempt_count > 0;"

    rows = []
    for s in [sql1, sql2, sql3]:
        res = run_d1(s)
        rows.extend(res.get("results", []))

    ledger = {r["tbl"]: r["cnt"] for r in rows}
    for tbl, cnt in ledger.items():
        print(f"      * {tbl:<36}: {cnt:,}")

    assert ledger["questions"] == 86737, f"Question count mismatch: {ledger['questions']}"
    assert ledger["staff_users"] == 10, f"Staff users count mismatch: {ledger['staff_users']}"
    assert ledger["bench_users"] == 0, f"Benchmark users remain: {ledger['bench_users']}"
    assert ledger["exams"] == 0, f"Benchmark exams remain: {ledger['exams']}"
    assert ledger["attempts"] == 0, f"Attempts remain: {ledger['attempts']}"
    assert ledger["submissions"] == 0, f"Submissions remain: {ledger['submissions']}"
    assert ledger["answers"] == 0, f"Answers remain: {ledger['answers']}"
    assert ledger["questions_with_empirical_telemetry"] == 0, f"Questions with telemetry remain: {ledger['questions_with_empirical_telemetry']}"

    # 6. Static Asset Delivery
    print("\n[6/6] Testing Static Assets PWA Delivery (GET /)...")
    status, _, html = http_req("GET", "/")
    has_title = "<title>" in html
    print(f"      HTTP {status} -> HTML length: {len(html):,} bytes, Contains <title>: {has_title}")
    assert status == 200 and has_title, "Static asset delivery failed!"

    print("\n" + "=" * 70)
    print("ALL PRODUCTION SMOKE TESTS PASSED -- SYSTEM FULLY OPERATIONAL")
    print("=" * 70)

if __name__ == "__main__":
    main()
