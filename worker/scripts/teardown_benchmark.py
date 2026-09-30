#!/usr/bin/env python3
"""
Controlled Benchmark Teardown & Maintenance Script
Safely purges synthetic 10K benchmark artifacts from remote Cloudflare D1 while preserving:
- All 86,737 questions in the question bank
- All 10 authentic staff and demo user accounts
- Rubric definitions and model difficulty classifications

Follows strict foreign-key order:
submission_answers -> submissions -> exam_attempts -> exam_questions -> exams -> bench_* users -> question telemetry reset
"""

import sys
import json
import shutil
import subprocess
import argparse

BENCHMARK_EXAM_ID = "bbf22745-8a8b-4a85-bcfc-a227dd6c3fe4"
CWD = "d:/Websites/CBT/worker"
NPX_CMD = shutil.which("npx.cmd") or "npx"

def run_d1(command_sql: str) -> dict:
    flat_sql = " ".join(command_sql.strip().split())
    cmd = [
        NPX_CMD, "wrangler", "d1", "execute", "cbt-platform",
        "--remote",
        f"--command={flat_sql}",
        "--json"
    ]
    res = subprocess.run(
        cmd,
        cwd=CWD,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace"
    )

    if res.returncode != 0:
        raise RuntimeError(f"D1 execute failed (code {res.returncode}):\n{res.stderr}\nCommand: {flat_sql}")
    
    raw = res.stdout
    json_start = raw.find("[")
    json_end = raw.rfind("]")
    if json_start != -1 and json_end != -1:
        parsed = json.loads(raw[json_start:json_end+1])
        return parsed[0] if parsed else {}
    return {"raw": raw}

def get_counts():
    sql = (
        "SELECT 'submission_answers' as tbl, count(*) as cnt FROM submission_answers "
        "UNION ALL SELECT 'submissions', count(*) FROM submissions "
        "UNION ALL SELECT 'exam_attempts', count(*) FROM exam_attempts "
        "UNION ALL SELECT 'exam_questions', count(*) FROM exam_questions "
        "UNION ALL SELECT 'exams', count(*) FROM exams "
        "UNION ALL SELECT 'bench_users', count(*) FROM users WHERE id LIKE 'bench_%' "
        "UNION ALL SELECT 'staff_users', count(*) FROM users WHERE id NOT LIKE 'bench_%' "
        "UNION ALL SELECT 'questions', count(*) FROM questions "
        "UNION ALL SELECT 'questions_with_telemetry', count(*) FROM questions WHERE observed_attempt_count > 0;"
    )
    res = run_d1(sql)
    results = res.get("results", [])
    return {r["tbl"]: r["cnt"] for r in results}

def main():
    parser = argparse.ArgumentParser(description="Teardown benchmark data from remote D1")
    parser.add_argument("--confirm", action="store_true", help="Execute the deletion")
    args = parser.parse_args()

    print("=" * 70)
    print("      QFORGE CONTROLLED MAINTENANCE: BENCHMARK TEARDOWN")
    print("=" * 70)
    print(f"Target Exam ID: {BENCHMARK_EXAM_ID}")
    print("\nFetching pre-teardown state from remote D1...")
    
    counts = get_counts()
    print("\nCurrent Database Ledger:")
    for tbl, cnt in counts.items():
        print(f"  • {tbl:<26}: {cnt:,}")

    if not args.confirm:
        print("\n[DRY RUN] Run with --confirm to execute the controlled purge.")
        return

    print("\n" + "-" * 70)
    print("EXECUTING CONTROLLED SEQUENTIAL PURGE")
    print("-" * 70)

    # Stage 1: submission_answers
    print("\n[1/7] Purging submission_answers...")
    run_d1(f"DELETE FROM submission_answers WHERE submission_id IN (SELECT id FROM submissions WHERE exam_id = '{BENCHMARK_EXAM_ID}');")
    c1 = run_d1("SELECT count(*) as cnt FROM submission_answers;").get("results", [{}])[0].get("cnt", -1)
    print(f"      Verification: submission_answers remaining = {c1}")
    if c1 != 0:
        raise ValueError(f"Stage 1 failed: {c1} submission_answers still remain!")

    # Stage 2: submissions
    print("\n[2/7] Purging submissions...")
    run_d1(f"DELETE FROM submissions WHERE exam_id = '{BENCHMARK_EXAM_ID}';")
    c2 = run_d1("SELECT count(*) as cnt FROM submissions;").get("results", [{}])[0].get("cnt", -1)
    print(f"      Verification: submissions remaining = {c2}")
    if c2 != 0:
        raise ValueError(f"Stage 2 failed: {c2} submissions still remain!")

    # Stage 3: exam_attempts
    print("\n[3/7] Purging exam_attempts...")
    run_d1(f"DELETE FROM exam_attempts WHERE exam_id = '{BENCHMARK_EXAM_ID}';")
    c3 = run_d1("SELECT count(*) as cnt FROM exam_attempts;").get("results", [{}])[0].get("cnt", -1)
    print(f"      Verification: exam_attempts remaining = {c3}")
    if c3 != 0:
        raise ValueError(f"Stage 3 failed: {c3} exam_attempts still remain!")

    # Stage 4: exam_questions
    print("\n[4/7] Purging exam_questions...")
    run_d1(f"DELETE FROM exam_questions WHERE exam_id = '{BENCHMARK_EXAM_ID}';")
    c4 = run_d1(f"SELECT count(*) as cnt FROM exam_questions WHERE exam_id = '{BENCHMARK_EXAM_ID}';").get("results", [{}])[0].get("cnt", -1)
    print(f"      Verification: exam_questions remaining for exam = {c4}")
    if c4 != 0:
        raise ValueError(f"Stage 4 failed: {c4} exam_questions still remain!")

    # Stage 5: exams
    print("\n[5/7] Purging exam record...")
    run_d1(f"DELETE FROM exams WHERE id = '{BENCHMARK_EXAM_ID}';")
    c5 = run_d1(f"SELECT count(*) as cnt FROM exams WHERE id = '{BENCHMARK_EXAM_ID}';").get("results", [{}])[0].get("cnt", -1)
    print(f"      Verification: exams remaining for exam = {c5}")
    if c5 != 0:
        raise ValueError(f"Stage 5 failed: {c5} exams still remain!")

    # Stage 6: bench_* users
    print("\n[6/7] Purging synthetic bench users...")
    run_d1("DELETE FROM users WHERE id LIKE 'bench_%';")
    c6_bench = run_d1("SELECT count(*) as cnt FROM users WHERE id LIKE 'bench_%';").get("results", [{}])[0].get("cnt", -1)
    c6_staff = run_d1("SELECT count(*) as cnt FROM users;").get("results", [{}])[0].get("cnt", -1)
    print(f"      Verification: bench users remaining = {c6_bench}, authentic staff users = {c6_staff}")
    if c6_bench != 0 or c6_staff != 10:
        raise ValueError(f"Stage 6 failed: bench={c6_bench}, staff={c6_staff} (expected 10)")

    # Stage 7: reset question telemetry on the 10 questions
    print("\n[7/7] Resetting benchmark telemetry on questions...")
    run_d1("UPDATE questions SET observed_attempt_count = 0, observed_accuracy_rate = NULL, observed_avg_solve_seconds = NULL, difficulty_validation_status = 'unvalidated' WHERE observed_attempt_count > 0;")
    c7_tel = run_d1("SELECT count(*) as cnt FROM questions WHERE observed_attempt_count > 0;").get("results", [{}])[0].get("cnt", -1)
    c7_qtot = run_d1("SELECT count(*) as cnt FROM questions;").get("results", [{}])[0].get("cnt", -1)
    print(f"      Verification: questions with telemetry = {c7_tel}, total questions bank = {c7_qtot}")
    if c7_tel != 0 or c7_qtot != 86737:
        raise ValueError(f"Stage 7 failed: questions_with_telemetry={c7_tel}, total_questions={c7_qtot}")

    print("\n" + "=" * 70)
    print("✅ BENCHMARK TEARDOWN COMPLETE — DATABASE IS IN CLEAN PRODUCTION STATE")
    print("=" * 70)

if __name__ == "__main__":
    main()
