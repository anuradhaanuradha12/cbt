# Controlled Benchmark Teardown & Maintenance Script (PowerShell)
param(
    [switch]$Confirm
)

$ErrorActionPreference = "Stop"
$BenchmarkExamId = "bbf22745-8a8b-4a85-bcfc-a227dd6c3fe4"
$WorkerDir = "d:\Websites\CBT\worker"
Set-Location $WorkerDir

function Invoke-D1([string]$sql) {
    $flatSql = ($sql -replace '\s+', ' ').Trim()
    $raw = (cmd /c "npx wrangler d1 execute cbt-platform --remote --command=""$flatSql"" --json 2>nul") | Out-String
    $start = $raw.IndexOf("[")
    $end = $raw.LastIndexOf("]")
    if ($start -ge 0 -and $end -ge 0) {
        $cleanJson = $raw.Substring($start, $end - $start + 1)
        $parsed = ($cleanJson | ConvertFrom-Json)
        if ($parsed -is [System.Array]) {
            return $parsed[0]
        }
        return $parsed
    }
    Write-Host "RAW: $raw"
    throw "Failed to parse D1 output"
}

Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "      QFORGE CONTROLLED MAINTENANCE: BENCHMARK TEARDOWN" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan
$countsSql1 = "SELECT 'submission_answers' as tbl, count(*) as cnt FROM submission_answers UNION ALL SELECT 'submissions', count(*) FROM submissions UNION ALL SELECT 'exam_attempts', count(*) FROM exam_attempts UNION ALL SELECT 'exam_questions', count(*) FROM exam_questions;"
$countsSql2 = "SELECT 'exams' as tbl, count(*) as cnt FROM exams UNION ALL SELECT 'bench_users', count(*) FROM users WHERE id LIKE 'bench_%' UNION ALL SELECT 'staff_users', count(*) FROM users WHERE id NOT LIKE 'bench_%' UNION ALL SELECT 'questions', count(*) FROM questions;"
$countsSql3 = "SELECT 'questions_with_telemetry' as tbl, count(*) as cnt FROM questions WHERE observed_attempt_count > 0;"

$res1 = Invoke-D1 $countsSql1
$res2 = Invoke-D1 $countsSql2
$res3 = Invoke-D1 $countsSql3

$allRows = @($res1.results) + @($res2.results) + @($res3.results)

Write-Host "`nCurrent Database Ledger:" -ForegroundColor Yellow
foreach ($row in $allRows) {
    Write-Host ("  • {0,-26}: {1,8:N0}" -f $row.tbl, $row.cnt)
}

if (-not $Confirm) {
    Write-Host "`n[DRY RUN] Run with -Confirm to execute the controlled purge." -ForegroundColor Cyan
    exit 0
}

Write-Host "`n----------------------------------------------------------------------" -ForegroundColor Red
Write-Host "EXECUTING CONTROLLED SEQUENTIAL PURGE" -ForegroundColor Red
Write-Host "----------------------------------------------------------------------" -ForegroundColor Red

# Stage 1: submission_answers
Write-Host "`n[1/7] Purging submission_answers in chunks..." -ForegroundColor Yellow
while ($true) {
    Invoke-D1 "DELETE FROM submission_answers WHERE rowid IN (SELECT rowid FROM submission_answers WHERE submission_id IN (SELECT id FROM submissions WHERE exam_id = '$BenchmarkExamId') LIMIT 25000);" | Out-Null
    $c1 = (Invoke-D1 "SELECT count(*) as cnt FROM submission_answers;").results[0].cnt
    Write-Host "      Progress: submission_answers remaining = $c1"
    if ($c1 -eq 0) { break }
}

# Stage 2: submissions
Write-Host "`n[2/7] Purging submissions..." -ForegroundColor Yellow
Invoke-D1 "DELETE FROM submissions WHERE exam_id = '$BenchmarkExamId';" | Out-Null
$c2 = (Invoke-D1 "SELECT count(*) as cnt FROM submissions;").results[0].cnt
Write-Host "      Verification: submissions remaining = $c2"
if ($c2 -ne 0) { throw "Stage 2 failed: $c2 submissions remain!" }

# Stage 3: exam_attempts
Write-Host "`n[3/7] Purging exam_attempts..." -ForegroundColor Yellow
Invoke-D1 "DELETE FROM exam_attempts WHERE exam_id = '$BenchmarkExamId';" | Out-Null
$c3 = (Invoke-D1 "SELECT count(*) as cnt FROM exam_attempts;").results[0].cnt
Write-Host "      Verification: exam_attempts remaining = $c3"
if ($c3 -ne 0) { throw "Stage 3 failed: $c3 exam_attempts remain!" }

# Stage 4: exam_questions
Write-Host "`n[4/7] Purging exam_questions..." -ForegroundColor Yellow
Invoke-D1 "DELETE FROM exam_questions WHERE exam_id = '$BenchmarkExamId';" | Out-Null
$c4 = (Invoke-D1 "SELECT count(*) as cnt FROM exam_questions WHERE exam_id = '$BenchmarkExamId';").results[0].cnt
Write-Host "      Verification: exam_questions remaining for exam = $c4"
if ($c4 -ne 0) { throw "Stage 4 failed: $c4 exam_questions remain!" }

# Stage 5: exams
Write-Host "`n[5/7] Purging exam record..." -ForegroundColor Yellow
Invoke-D1 "DELETE FROM exams WHERE id = '$BenchmarkExamId';" | Out-Null
$c5 = (Invoke-D1 "SELECT count(*) as cnt FROM exams WHERE id = '$BenchmarkExamId';").results[0].cnt
Write-Host "      Verification: exams remaining for exam = $c5"
if ($c5 -ne 0) { throw "Stage 5 failed: $c5 exams remain!" }

# Stage 6: bench_* users
Write-Host "`n[6/7] Purging synthetic bench users in chunks..." -ForegroundColor Yellow
while ($true) {
    Invoke-D1 "DELETE FROM users WHERE rowid IN (SELECT rowid FROM users WHERE id LIKE 'bench_%' LIMIT 5000);" | Out-Null
    $c6_bench = (Invoke-D1 "SELECT count(*) as cnt FROM users WHERE id LIKE 'bench_%';").results[0].cnt
    Write-Host "      Progress: bench users remaining = $c6_bench"
    if ($c6_bench -eq 0) { break }
}
$c6_staff = (Invoke-D1 "SELECT count(*) as cnt FROM users;").results[0].cnt
Write-Host "      Verification: authentic staff users = $c6_staff"
if ($c6_staff -ne 10) { throw "Stage 6 failed: staff=$c6_staff (expected 10)" }

# Stage 7: reset question telemetry on the 10 questions
Write-Host "`n[7/7] Resetting benchmark telemetry on questions..." -ForegroundColor Yellow
Invoke-D1 "UPDATE questions SET observed_attempt_count = 0, observed_accuracy_rate = NULL, observed_avg_solve_seconds = NULL, difficulty_validation_status = 'unvalidated' WHERE observed_attempt_count > 0;" | Out-Null
$c7_tel = (Invoke-D1 "SELECT count(*) as cnt FROM questions WHERE observed_attempt_count > 0;").results[0].cnt
$c7_qtot = (Invoke-D1 "SELECT count(*) as cnt FROM questions;").results[0].cnt
Write-Host "      Verification: questions with telemetry = $c7_tel, total questions bank = $c7_qtot"
if ($c7_tel -ne 0 -or $c7_qtot -ne 86737) { throw "Stage 7 failed: questions_with_telemetry=$c7_tel, total_questions=$c7_qtot" }

Write-Host "`n======================================================================" -ForegroundColor Green
Write-Host "✅ BENCHMARK TEARDOWN COMPLETE — DATABASE IS IN CLEAN PRODUCTION STATE" -ForegroundColor Green
Write-Host "======================================================================" -ForegroundColor Green

$post1 = Invoke-D1 $countsSql1
$post2 = Invoke-D1 $countsSql2
$post3 = Invoke-D1 $countsSql3
$postRows = @($post1.results) + @($post2.results) + @($post3.results)

Write-Host "`nFinal Database Ledger:" -ForegroundColor Green
foreach ($row in $postRows) {
    Write-Host ("  • {0,-26}: {1,8:N0}" -f $row.tbl, $row.cnt)
}
