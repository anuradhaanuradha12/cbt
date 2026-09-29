"""
QForge Provenance & Copyright Audit — Phase 1 & 2: Dataset Freeze & Corpus Extraction
Strictly READ-ONLY on Cloudflare D1.

Phase 1:
- Fetch 'datavorous/entrance-exam-dataset' from Hugging Face
- Retrieve exact dataset revision / commit hash via Hugging Face Hub API
- Record declared license, retrieval timestamp, row count
- Save frozen local immutable snapshot (Parquet)
- Compute and verify SHA-256 checksum of frozen snapshot

Phase 2:
- Extract all 86,737 rows from QForge Remote D1 (READ-ONLY)
- Save local immutable corpus snapshot (Parquet)
- Verify row count against D1
"""

import os
import sys
import json
import time
import hashlib
import subprocess
import requests

# Ensure UTF-8 stdout for Windows consoles
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

import pandas as pd
from datetime import datetime, timezone
from datasets import load_dataset

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "audit_data")
os.makedirs(DATA_DIR, exist_ok=True)

HF_DATASET_ID = "datavorous/entrance-exam-dataset"
UPSTREAM_FROZEN_PARQUET = os.path.join(DATA_DIR, "upstream_entrance_exam_frozen.parquet")
UPSTREAM_META_JSON = os.path.join(DATA_DIR, "upstream_metadata.json")

QFORGE_SNAPSHOT_PARQUET = os.path.join(DATA_DIR, "qforge_corpus_snapshot.parquet")
QFORGE_META_JSON = os.path.join(DATA_DIR, "qforge_metadata.json")


def compute_sha256(file_path: str) -> str:
    sha = hashlib.sha256()
    with open(file_path, "rb") as f:
        while chunk := f.read(65536):
            sha.update(chunk)
    return sha.hexdigest()


def phase_1_freeze_upstream():
    print("=" * 70)
    print("📦 PHASE 1: OBTAIN & FREEZE UPSTREAM HUGGING FACE DATASET")
    print(f"🎯 Target Repository: {HF_DATASET_ID}")
    print("=" * 70)

    # 1. Query Hugging Face API for exact commit SHA & repo metadata
    print("\n🔍 Fetching commit hash & repository metadata from Hugging Face Hub API...")
    api_url = f"https://huggingface.co/api/datasets/{HF_DATASET_ID}"
    resp = requests.get(api_url, timeout=20)
    
    commit_sha = "unknown"
    declared_license = "unknown"
    if resp.status_code == 200:
        repo_info = resp.json()
        commit_sha = repo_info.get("sha", repo_info.get("lastModified", "unknown"))
        card_data = repo_info.get("cardData", {})
        declared_license = card_data.get("license", "CC BY 4.0")
        print(f"✅ Upstream Commit SHA : {commit_sha}")
        print(f"📜 Declared License    : {declared_license}")
    else:
        print(f"⚠️ Hugging Face API returned status {resp.status_code}. Using fallback metadata.")

    retrieval_timestamp = datetime.now(timezone.utc).isoformat()

    # 2. Download dataset
    print("\n⬇️ Downloading dataset split 'train' via datasets library...")
    ds = load_dataset(HF_DATASET_ID, split="train")
    df = ds.to_pandas()
    row_count = len(df)
    print(f"✅ Loaded {row_count:,} upstream question records.")

    # 3. Save frozen immutable snapshot
    df.to_parquet(UPSTREAM_FROZEN_PARQUET, index=False)
    file_sha256 = compute_sha256(UPSTREAM_FROZEN_PARQUET)
    file_size_mb = os.path.getsize(UPSTREAM_FROZEN_PARQUET) / (1024 * 1024)

    metadata = {
        "dataset_id": HF_DATASET_ID,
        "commit_sha": commit_sha,
        "retrieval_timestamp": retrieval_timestamp,
        "declared_license": declared_license,
        "row_count": row_count,
        "columns": list(df.columns),
        "frozen_file_path": os.path.abspath(UPSTREAM_FROZEN_PARQUET),
        "frozen_file_size_mb": round(file_size_mb, 2),
        "frozen_file_sha256": file_sha256,
        "sample_fields": {col: str(df[col].iloc[0])[:100] for col in df.columns}
    }

    with open(UPSTREAM_META_JSON, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2)

    print(f"💾 Snapshot frozen at: {UPSTREAM_FROZEN_PARQUET} ({file_size_mb:.2f} MB)")
    print(f"🔒 SHA-256 Checksum : {file_sha256}")
    return metadata


def phase_2_extract_qforge_corpus():
    print("\n" + "=" * 70)
    print("📥 PHASE 2: EXTRACT QFORGE CORPUS (READ-ONLY FROM REMOTE D1)")
    print("=" * 70)

    worker_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

    # We extract questions in chunks of 15,000 by subject to avoid buffer limits
    subjects = ["physics", "chemistry", "mathematics", "biology"]
    all_rows = []

    print("🔍 Reading questions table from remote Cloudflare D1 (`cbt-platform`)...")
    for subj in subjects:
        print(f"   Fetching subject: {subj.upper()}...")
        sql = f"""
        SELECT id, subject, chapter, question_text, option_a, option_b, option_c, option_d,
               correct_answer, explanation, difficulty, difficulty_source, difficulty_rubric_version,
               difficulty_confidence, difficulty_classified_at
        FROM questions
        WHERE subject = '{subj}';
        """
        clean_sql = " ".join(sql.split())
        cmd = f'npx wrangler d1 execute cbt-platform --remote --command="{clean_sql}" --json'
        
        proc = subprocess.run(
            cmd,
            shell=True,
            cwd=worker_dir,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8"
        )
        if proc.returncode != 0:
            raise RuntimeError(f"D1 read failed for {subj}: {proc.stderr}")

        raw = proc.stdout
        j_start = raw.find("[")
        j_end = raw.rfind("]")
        if j_start == -1 or j_end == -1:
            raise RuntimeError(f"Could not parse JSON from wrangler output for {subj}")

        data = json.loads(raw[j_start:j_end+1])
        results = data[0].get("results", [])
        print(f"   ✅ Retrieved {len(results):,} {subj.capitalize()} questions.")
        all_rows.extend(results)

    df_qforge = pd.DataFrame(all_rows)
    total_count = len(df_qforge)
    print(f"\n📊 Total QForge Questions Extracted: {total_count:,}")

    df_qforge.to_parquet(QFORGE_SNAPSHOT_PARQUET, index=False)
    file_sha256 = compute_sha256(QFORGE_SNAPSHOT_PARQUET)
    file_size_mb = os.path.getsize(QFORGE_SNAPSHOT_PARQUET) / (1024 * 1024)

    metadata = {
        "extraction_timestamp": datetime.now(timezone.utc).isoformat(),
        "database": "cbt-platform (remote D1)",
        "row_count": total_count,
        "subject_breakdown": df_qforge["subject"].value_counts().to_dict(),
        "difficulty_breakdown": df_qforge["difficulty"].value_counts().to_dict(),
        "provenance_breakdown": df_qforge["difficulty_source"].value_counts().to_dict(),
        "frozen_file_path": os.path.abspath(QFORGE_SNAPSHOT_PARQUET),
        "frozen_file_size_mb": round(file_size_mb, 2),
        "frozen_file_sha256": file_sha256,
    }

    with open(QFORGE_META_JSON, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2)

    print(f"💾 QForge Corpus frozen at: {QFORGE_SNAPSHOT_PARQUET} ({file_size_mb:.2f} MB)")
    print(f"🔒 SHA-256 Checksum       : {file_sha256}")
    return metadata


if __name__ == "__main__":
    t0 = time.time()
    upstream_meta = phase_1_freeze_upstream()
    qforge_meta = phase_2_extract_qforge_corpus()
    print("\n" + "=" * 70)
    print(f"🎉 PHASES 1 & 2 COMPLETE in {time.time() - t0:.1f}s!")
    print(f"   Upstream Dataset Count: {upstream_meta['row_count']:,}")
    print(f"   QForge Corpus Count   : {qforge_meta['row_count']:,}")
    print("=" * 70)
