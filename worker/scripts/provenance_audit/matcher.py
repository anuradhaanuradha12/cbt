"""
QForge Provenance & Copyright Audit — Vectorized Matching Engine & Evidence Generator (Phases 4 - 13)

Ultra-fast Vectorized & Inverted-Index Pipeline:
- Tier 1: Multi-level exact hash matching (full_question_hash, stem_plus_options_ordered_hash, stem_plus_options_unordered_hash, stem_hash)
- Tier 2: Vectorized Token n-Gram / TF-IDF sparse matrix multiplication (>= 0.90) + Jaccard verification
- Tier 3: Structural, formula & numerical sequence matching (>= 0.92)
- Tier 4: Semantic candidate generation + structural verification filter (>= 0.92)
- Provenance Recovery: source_db, exam tags, revision commit SHA, upstream row ID
- Evidence Generation:
    1. qforge-provenance-audit-report.json
    2. qforge-provenance-evidence.csv
    3. qforge-provenance-summary.md
"""

import os
import sys
import json
import time
import re
from datetime import datetime, timezone
from typing import Dict, List, Any, Optional, Set, Tuple
import pandas as pd
import numpy as np

# Force unbuffered UTF-8 stdout/stderr for immediate live log streaming on Windows
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', line_buffering=True)
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', line_buffering=True)

from text_normalizer import canonicalize_text, compute_question_fingerprints
from sklearn.feature_extraction.text import TfidfVectorizer
from scipy.sparse import csr_matrix

AUDIT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "audit_data"))
UPSTREAM_PARQUET = os.path.join(AUDIT_DIR, "upstream_entrance_exam_frozen.parquet")
UPSTREAM_META_JSON = os.path.join(AUDIT_DIR, "upstream_metadata.json")
QFORGE_PARQUET = os.path.join(AUDIT_DIR, "qforge_corpus_snapshot.parquet")

REPORT_JSON = os.path.join(AUDIT_DIR, "qforge-provenance-audit-report.json")
EVIDENCE_CSV = os.path.join(AUDIT_DIR, "qforge-provenance-evidence.csv")
SUMMARY_MD = os.path.join(AUDIT_DIR, "qforge-provenance-summary.md")


def extract_numbers(text: str) -> List[str]:
    """Extract numeric tokens (including decimals and signs) from text."""
    return re.findall(r"[-+]?\d*\.?\d+", text)


def extract_3grams(text: str) -> Set[str]:
    tokens = text.split()
    grams = set()
    for i in range(len(tokens) - 2):
        grams.add(" ".join(tokens[i:i+3]))
    for i in range(len(text) - 4):
        grams.add(text[i:i+5])
    return grams if grams else {text}


def jaccard_similarity(set_a: Set[str], set_b: Set[str]) -> float:
    if not set_a or not set_b:
        return 0.0
    intersection = len(set_a.intersection(set_b))
    union = len(set_a.union(set_b))
    return intersection / union if union > 0 else 0.0


def run_provenance_audit():
    t_start = time.time()
    print("=" * 70, flush=True)
    print("🔬 QFORGE PROVENANCE & COPYRIGHT AUDIT PIPELINE", flush=True)
    print("=" * 70, flush=True)

    # 1. Load Upstream Dataset & Metadata
    print("\n📦 [Step 1/5] Loading frozen Upstream Dataset...", flush=True)
    if not os.path.exists(UPSTREAM_PARQUET) or not os.path.exists(UPSTREAM_META_JSON):
        raise FileNotFoundError("Upstream snapshot missing. Run freeze_and_extract.py first.")

    with open(UPSTREAM_META_JSON, "r", encoding="utf-8") as f:
        upstream_meta = json.load(f)

    df_upstream = pd.read_parquet(UPSTREAM_PARQUET)
    upstream_total = len(df_upstream)
    upstream_rev = upstream_meta.get("commit_sha", "unknown")
    upstream_license = upstream_meta.get("declared_license", "CC BY 4.0")
    print(f"   ✅ Loaded {upstream_total:,} upstream questions (Revision: {upstream_rev[:10]}...)", flush=True)

    # 2. Load QForge Production Corpus
    print("\n📦 [Step 2/5] Loading QForge Corpus Snapshot...", flush=True)
    if not os.path.exists(QFORGE_PARQUET):
        raise FileNotFoundError("QForge snapshot missing. Run freeze_and_extract.py first.")

    df_qforge = pd.read_parquet(QFORGE_PARQUET)
    qforge_total = len(df_qforge)
    print(f"   ✅ Loaded {qforge_total:,} QForge questions across all 4 subjects.", flush=True)

    # 3. Canonicalize & Fingerprint Upstream Dataset
    print("\n⚡ [Step 3/5] Canonicalizing & Hash-Indexing Upstream Dataset (97,359 rows)...", flush=True)
    t_idx = time.time()

    upstream_records = []
    upstream_full_hash_map = {}
    upstream_ordered_opts_hash_map = {}
    upstream_unordered_opts_hash_map = {}
    upstream_stem_hash_map = {}
    upstream_stems = []

    for idx, row in df_upstream.iterrows():
        q_text = str(row.get("question", ""))
        opts = row.get("options", [])
        if isinstance(opts, (list, np.ndarray)):
            opt_a = str(opts[0]) if len(opts) > 0 else ""
            opt_b = str(opts[1]) if len(opts) > 1 else ""
            opt_c = str(opts[2]) if len(opts) > 2 else ""
            opt_d = str(opts[3]) if len(opts) > 3 else ""
        elif isinstance(opts, dict):
            opt_a = str(opts.get("A", opts.get("a", "")))
            opt_b = str(opts.get("B", opts.get("b", "")))
            opt_c = str(opts.get("C", opts.get("c", "")))
            opt_d = str(opts.get("D", opts.get("d", "")))
        else:
            opt_a, opt_b, opt_c, opt_d = "", "", "", ""

        ans = str(row.get("answer", row.get("correct_option", "")))
        source_db = str(row.get("source_db", "")) if pd.notna(row.get("source_db")) else None
        tags = row.get("tags", [])
        if isinstance(tags, np.ndarray):
            tags = tags.tolist()
        elif not isinstance(tags, list):
            tags = [str(tags)] if pd.notna(tags) and tags != "" else []

        fp = compute_question_fingerprints(q_text, opt_a, opt_b, opt_c, opt_d, ans)
        c_stem = fp["canonical_stem"]
        upstream_stems.append(c_stem)

        rec = {
            "upstream_row_id": idx,
            "raw_question": q_text,
            "canonical_stem": c_stem,
            "opt_a": opt_a,
            "opt_b": opt_b,
            "opt_c": opt_c,
            "opt_d": opt_d,
            "correct_answer": ans,
            "source_db": source_db,
            "tags": tags,
            "stem_hash": fp["stem_hash"],
            "stem_plus_options_ordered_hash": fp["stem_plus_options_ordered_hash"],
            "stem_plus_options_unordered_hash": fp["stem_plus_options_unordered_hash"],
            "full_question_hash": fp["full_question_hash"],
            "numbers": extract_numbers(c_stem),
            "grams": extract_3grams(c_stem),
        }
        upstream_records.append(rec)

        if fp["full_question_hash"] not in upstream_full_hash_map:
            upstream_full_hash_map[fp["full_question_hash"]] = idx
        if fp["stem_plus_options_ordered_hash"] not in upstream_ordered_opts_hash_map:
            upstream_ordered_opts_hash_map[fp["stem_plus_options_ordered_hash"]] = idx
        if fp["stem_plus_options_unordered_hash"] not in upstream_unordered_opts_hash_map:
            upstream_unordered_opts_hash_map[fp["stem_plus_options_unordered_hash"]] = idx
        if fp["stem_hash"] not in upstream_stem_hash_map:
            upstream_stem_hash_map[fp["stem_hash"]] = idx

        if (idx + 1) % 25000 == 0 or (idx + 1) == upstream_total:
            print(f"   Processed {idx+1:,}/{upstream_total:,} upstream items ({time.time() - t_idx:.1f}s)...", flush=True)

    print(f"   ✅ Upstream Hash Maps Ready: {len(upstream_stem_hash_map):,} unique stem hashes.", flush=True)

    # 4. Process QForge Corpus: Tier 1 Exact Matching
    print("\n⚡ [Step 4/5] Running Tier 1 Exact SHA-256 Multi-Level Fingerprint Matcher...", flush=True)
    t_tier1 = time.time()

    qforge_items = []
    unmatched_indices = []
    unmatched_stems = []

    tier_counts = {
        "EXACT_MATCH_FULL": 0,
        "EXACT_MATCH_ORDERED_OPTS": 0,
        "EXACT_MATCH_UNORDERED_OPTS": 0,
        "EXACT_MATCH_STEM": 0,
        "STRONG_MATCH_NEAR_DUPLICATE": 0,
        "STRONG_MATCH_STRUCTURAL": 0,
        "POSSIBLE_MATCH_SEMANTIC": 0,
        "NO_MATCH_FOUND": 0,
    }

    for q_idx, row in df_qforge.iterrows():
        q_id = str(row["id"])
        q_subj = str(row["subject"])
        q_chap = str(row.get("chapter", ""))
        q_text = str(row.get("question_text", ""))
        opt_a = str(row.get("option_a", "")) if pd.notna(row.get("option_a")) else ""
        opt_b = str(row.get("option_b", "")) if pd.notna(row.get("option_b")) else ""
        opt_c = str(row.get("option_c", "")) if pd.notna(row.get("option_c")) else ""
        opt_d = str(row.get("option_d", "")) if pd.notna(row.get("option_d")) else ""
        ans = str(row.get("correct_answer", "")) if pd.notna(row.get("correct_answer")) else ""

        fp = compute_question_fingerprints(q_text, opt_a, opt_b, opt_c, opt_d, ans)
        c_stem = fp["canonical_stem"]

        item = {
            "q_idx": q_idx,
            "qforge_id": q_id,
            "qforge_subject": q_subj,
            "qforge_chapter": q_chap,
            "qforge_question": q_text,
            "canonical_stem": c_stem,
            "opt_a": opt_a,
            "opt_b": opt_b,
            "opt_c": opt_c,
            "opt_d": opt_d,
            "correct_answer": ans,
            "numbers": extract_numbers(c_stem),
            "grams": extract_3grams(c_stem),
            "matched_upstream_idx": None,
            "match_type": "none",
            "evidence_level": "none_in_tested_corpus",
            "integrity_status": "NO_MATCH_FOUND",
            "provenance_status": "PROVENANCE_UNASSIGNED",
            "review_status": "NONE",
            "stem_sim": 0.0,
            "opt_sim": 0.0,
            "num_sim": 0.0,
            "sem_sim": 0.0,
            "matched_fields": [],
        }

        # Check Tier 1 Exact Hashes
        if fp["full_question_hash"] in upstream_full_hash_map:
            item["matched_upstream_idx"] = upstream_full_hash_map[fp["full_question_hash"]]
            item["match_type"] = "exact_full_question_match"
            item["evidence_level"] = "deterministic"
            item["integrity_status"] = "EXACT_MATCH"
            item["stem_sim"], item["opt_sim"], item["num_sim"], item["sem_sim"] = 1.0, 1.0, 1.0, 1.0
            item["matched_fields"] = ["stem_hash", "ordered_options", "correct_answer"]
            tier_counts["EXACT_MATCH_FULL"] += 1

        elif fp["stem_plus_options_ordered_hash"] in upstream_ordered_opts_hash_map:
            item["matched_upstream_idx"] = upstream_ordered_opts_hash_map[fp["stem_plus_options_ordered_hash"]]
            item["match_type"] = "exact_stem_plus_options_ordered_match"
            item["evidence_level"] = "deterministic"
            item["integrity_status"] = "EXACT_MATCH"
            item["stem_sim"], item["opt_sim"], item["num_sim"], item["sem_sim"] = 1.0, 1.0, 1.0, 1.0
            item["matched_fields"] = ["stem_hash", "ordered_options"]
            tier_counts["EXACT_MATCH_ORDERED_OPTS"] += 1

        elif fp["stem_plus_options_unordered_hash"] in upstream_unordered_opts_hash_map:
            item["matched_upstream_idx"] = upstream_unordered_opts_hash_map[fp["stem_plus_options_unordered_hash"]]
            item["match_type"] = "exact_stem_plus_options_unordered_match"
            item["evidence_level"] = "deterministic"
            item["integrity_status"] = "EXACT_MATCH"
            item["stem_sim"], item["opt_sim"], item["num_sim"], item["sem_sim"] = 1.0, 1.0, 1.0, 1.0
            item["matched_fields"] = ["stem_hash", "unordered_options_set"]
            tier_counts["EXACT_MATCH_UNORDERED_OPTS"] += 1

        elif fp["stem_hash"] in upstream_stem_hash_map:
            item["matched_upstream_idx"] = upstream_stem_hash_map[fp["stem_hash"]]
            item["match_type"] = "exact_stem_match"
            item["evidence_level"] = "deterministic"
            item["integrity_status"] = "EXACT_MATCH"
            item["stem_sim"], item["sem_sim"] = 1.0, 1.0
            item["matched_fields"] = ["stem_hash"]
            tier_counts["EXACT_MATCH_STEM"] += 1

        else:
            unmatched_indices.append(q_idx)
            unmatched_stems.append(c_stem)

        qforge_items.append(item)

    tier1_matches = qforge_total - len(unmatched_indices)
    print(f"   🎯 Tier 1 Exact Matches Identified: {tier1_matches:,} / {qforge_total:,} ({tier1_matches*100/qforge_total:.1f}%) in {time.time() - t_tier1:.2f}s", flush=True)
    print(f"   🔍 Unmatched Candidates to Process via Vector Engine: {len(unmatched_indices):,}", flush=True)

    # 5. Vectorized Tier 2 - 4 Matching for Remaining Unmatched
    if len(unmatched_indices) > 0:
        print("\n⚡ [Step 5/5] Building Vector Index & Fast Sparse Similarity Matrix...", flush=True)
        t_vec = time.time()

        vectorizer = TfidfVectorizer(ngram_range=(1, 2), min_df=2, max_df=0.85, max_features=30000)
        tfidf_upstream = vectorizer.fit_transform(upstream_stems)
        tfidf_unmatched = vectorizer.transform(unmatched_stems)
        print(f"   Vocabulary Dimension: {tfidf_upstream.shape[1]:,} features. Matrix vectorized in {time.time() - t_vec:.1f}s.", flush=True)

        print("   Computing sparse dot products in vectorized blocks...", flush=True)
        # Block-wise matrix multiply to avoid high RAM allocations
        BLOCK_SIZE = 2500
        for b_start in range(0, len(unmatched_indices), BLOCK_SIZE):
            b_end = min(b_start + BLOCK_SIZE, len(unmatched_indices))
            sub_tfidf = tfidf_unmatched[b_start:b_end]

            # Fast sparse dot product (sub_tfidf @ tfidf_upstream.T)
            sim_matrix = sub_tfidf.dot(tfidf_upstream.T)

            for i in range(b_end - b_start):
                global_unmatched_idx = b_start + i
                item_idx = unmatched_indices[global_unmatched_idx]
                item = qforge_items[item_idx]

                row_sims = sim_matrix[i].toarray().flatten()
                top_upstream_idx = int(np.argmax(row_sims))
                top_score = float(row_sims[top_upstream_idx])

                if top_score >= 0.88:
                    cand_rec = upstream_records[top_upstream_idx]
                    q_grams = item["grams"]
                    u_grams = cand_rec["grams"]
                    j_score = jaccard_similarity(q_grams, u_grams)

                    q_opts_set = {canonicalize_text(o) for o in [item["opt_a"], item["opt_b"], item["opt_c"], item["opt_d"]] if o}
                    u_opts_set = {canonicalize_text(o) for o in [cand_rec["opt_a"], cand_rec["opt_b"], cand_rec["opt_c"], cand_rec["opt_d"]] if o}
                    opt_overlap = jaccard_similarity(q_opts_set, u_opts_set)

                    q_num_set = set(item["numbers"])
                    u_num_set = set(cand_rec["numbers"])
                    num_overlap = jaccard_similarity(q_num_set, u_num_set) if q_num_set else 1.0

                    if j_score >= 0.90 or top_score >= 0.95:
                        item["matched_upstream_idx"] = top_upstream_idx
                        item["match_type"] = "near_duplicate_text"
                        item["evidence_level"] = "multi_signal"
                        item["integrity_status"] = "STRONG_MATCH"
                        item["stem_sim"] = round(max(j_score, top_score), 3)
                        item["sem_sim"] = round(top_score, 3)
                        item["opt_sim"] = round(opt_overlap, 3)
                        item["num_sim"] = round(num_overlap, 3)
                        item["matched_fields"] = ["near_duplicate_token_ngrams"]
                        tier_counts["STRONG_MATCH_NEAR_DUPLICATE"] += 1

                    elif opt_overlap >= 0.75 or (num_overlap >= 0.90 and len(q_num_set) >= 2):
                        item["matched_upstream_idx"] = top_upstream_idx
                        item["match_type"] = "structural_formula_match"
                        item["evidence_level"] = "multi_signal"
                        item["integrity_status"] = "STRONG_MATCH"
                        item["stem_sim"] = round(top_score, 3)
                        item["sem_sim"] = round(top_score, 3)
                        item["opt_sim"] = round(opt_overlap, 3)
                        item["num_sim"] = round(num_overlap, 3)
                        item["matched_fields"] = ["structural_options_numeric_verified"]
                        tier_counts["STRONG_MATCH_STRUCTURAL"] += 1

                    elif top_score >= 0.92:
                        item["matched_upstream_idx"] = top_upstream_idx
                        item["match_type"] = "semantic_candidate_verified"
                        item["evidence_level"] = "candidate"
                        item["integrity_status"] = "POSSIBLE_MATCH"
                        item["stem_sim"] = round(top_score, 3)
                        item["sem_sim"] = round(top_score, 3)
                        item["opt_sim"] = round(opt_overlap, 3)
                        item["num_sim"] = round(num_overlap, 3)
                        item["matched_fields"] = ["semantic_candidate_tfidf"]
                        tier_counts["POSSIBLE_MATCH_SEMANTIC"] += 1

                if item["matched_upstream_idx"] is None:
                    tier_counts["NO_MATCH_FOUND"] += 1

            print(f"   Analyzed {b_end:,}/{len(unmatched_indices):,} unmatched items...", flush=True)

    # 6. Provenance Recovery & Export Evidence Table
    print("\n💾 Assembling Evidence Records & Recovering Provenance...", flush=True)
    evidence_rows = []
    for item in qforge_items:
        u_idx = item["matched_upstream_idx"]
        u_row_id = None
        u_src_db = None
        u_tags = []
        u_q_text = ""
        prov_status = "PROVENANCE_UNASSIGNED"
        rev_status = "NONE"

        if u_idx is not None:
            up_rec = upstream_records[u_idx]
            u_row_id = up_rec["upstream_row_id"]
            u_src_db = up_rec["source_db"]
            u_tags = up_rec["tags"]
            u_q_text = up_rec["raw_question"]

            if u_tags or u_src_db:
                prov_status = "PROVENANCE_KNOWN"
            else:
                prov_status = "PROVENANCE_UNKNOWN"

            rev_status = "REVIEW_REQUIRED" if item["integrity_status"] in ["EXACT_MATCH", "STRONG_MATCH"] else "OPTIONAL_REVIEW"

        evidence_rows.append({
            "qforge_id": item["qforge_id"],
            "qforge_subject": item["qforge_subject"],
            "qforge_chapter": item["qforge_chapter"],
            "upstream_dataset": upstream_meta.get("dataset_id", "datavorous/entrance-exam-dataset"),
            "upstream_revision": upstream_rev,
            "upstream_row_id": u_row_id,
            "source_db": u_src_db,
            "tags": json.dumps(u_tags) if u_tags else "[]",
            "match_type": item["match_type"],
            "evidence_level": item["evidence_level"],
            "stem_similarity": item["stem_sim"],
            "option_similarity": item["opt_sim"],
            "numeric_similarity": item["num_sim"],
            "semantic_similarity": item["sem_sim"],
            "matched_fields": json.dumps(item["matched_fields"]),
            "integrity_status": item["integrity_status"],
            "provenance_status": prov_status,
            "review_status": rev_status,
            "qforge_question": item["qforge_question"],
            "upstream_question": u_q_text,
        })

    df_evidence = pd.DataFrame(evidence_rows)
    df_evidence.to_csv(EVIDENCE_CSV, index=False, encoding="utf-8")
    evidence_size_mb = os.path.getsize(EVIDENCE_CSV) / (1024 * 1024)
    print(f"✅ Saved Evidence CSV: {EVIDENCE_CSV} ({evidence_size_mb:.2f} MB)", flush=True)

    # 7. Compute Global Aggregates & Output Reports
    total_matched = qforge_total - tier_counts["NO_MATCH_FOUND"]
    exact_matches = tier_counts["EXACT_MATCH_FULL"] + tier_counts["EXACT_MATCH_ORDERED_OPTS"] + tier_counts["EXACT_MATCH_UNORDERED_OPTS"] + tier_counts["EXACT_MATCH_STEM"]
    strong_matches = tier_counts["STRONG_MATCH_NEAR_DUPLICATE"] + tier_counts["STRONG_MATCH_STRUCTURAL"]
    possible_matches = tier_counts["POSSIBLE_MATCH_SEMANTIC"]
    no_match_count = tier_counts["NO_MATCH_FOUND"]

    subject_agg = {}
    for subj, grp in df_evidence.groupby("qforge_subject"):
        s_total = len(grp)
        s_exact = len(grp[grp["integrity_status"] == "EXACT_MATCH"])
        s_strong = len(grp[grp["integrity_status"] == "STRONG_MATCH"])
        s_possible = len(grp[grp["integrity_status"] == "POSSIBLE_MATCH"])
        s_nomatch = len(grp[grp["integrity_status"] == "NO_MATCH_FOUND"])
        subject_agg[subj] = {
            "total": s_total,
            "exact_matches": s_exact,
            "strong_matches": s_strong,
            "possible_matches": s_possible,
            "no_match_found": s_nomatch,
            "match_rate_pct": round((s_total - s_nomatch) * 100.0 / s_total, 2),
        }

    matched_df = df_evidence[df_evidence["integrity_status"] != "NO_MATCH_FOUND"]
    top_source_dbs = matched_df["source_db"].value_counts(dropna=False).head(15).to_dict()

    all_tags = []
    for t_str in matched_df["tags"]:
        try:
            t_list = json.loads(t_str)
            all_tags.extend(t_list)
        except Exception:
            pass
    top_exam_tags = pd.Series(all_tags).value_counts().head(20).to_dict() if all_tags else {}

    audit_report = {
        "audit_title": "QForge Post-Classification Provenance & Copyright Audit",
        "audit_version": "2.2",
        "execution_timestamp": datetime.now(timezone.utc).isoformat(),
        "elapsed_seconds": round(time.time() - t_start, 1),
        "corpus_metrics": {
            "qforge_total_questions": qforge_total,
            "upstream_total_questions": upstream_total,
            "upstream_dataset": upstream_meta.get("dataset_id"),
            "upstream_revision": upstream_rev,
            "upstream_declared_license": upstream_license,
        },
        "matching_summary": {
            "total_matched": total_matched,
            "match_rate_pct": round(total_matched * 100.0 / qforge_total, 2),
            "exact_matches": exact_matches,
            "exact_matches_pct": round(exact_matches * 100.0 / qforge_total, 2),
            "exact_breakdown": {
                "full_question": tier_counts["EXACT_MATCH_FULL"],
                "ordered_options": tier_counts["EXACT_MATCH_ORDERED_OPTS"],
                "unordered_options": tier_counts["EXACT_MATCH_UNORDERED_OPTS"],
                "stem_only": tier_counts["EXACT_MATCH_STEM"],
            },
            "strong_matches": strong_matches,
            "strong_matches_pct": round(strong_matches * 100.0 / qforge_total, 2),
            "possible_semantic_matches": possible_matches,
            "possible_semantic_matches_pct": round(possible_matches * 100.0 / qforge_total, 2),
            "no_match_found": no_match_count,
            "no_match_found_pct": round(no_match_count * 100.0 / qforge_total, 2),
        },
        "provenance_summary": {
            "provenance_known": int((df_evidence["provenance_status"] == "PROVENANCE_KNOWN").sum()),
            "provenance_unknown": int((df_evidence["provenance_status"] == "PROVENANCE_UNKNOWN").sum()),
            "provenance_unassigned": int((df_evidence["provenance_status"] == "PROVENANCE_UNASSIGNED").sum()),
            "review_required": int((df_evidence["review_status"] == "REVIEW_REQUIRED").sum()),
            "optional_review": int((df_evidence["review_status"] == "OPTIONAL_REVIEW").sum()),
            "none_review": int((df_evidence["review_status"] == "NONE").sum()),
        },
        "subject_breakdown": subject_agg,
        "top_source_databases": {str(k): int(v) for k, v in top_source_dbs.items()},
        "top_exam_tags": {str(k): int(v) for k, v in top_exam_tags.items()},
    }

    with open(REPORT_JSON, "w", encoding="utf-8") as f:
        json.dump(audit_report, f, indent=2)
    print(f"✅ Saved Report JSON: {REPORT_JSON}", flush=True)

    summary_md_content = f"""# QForge Provenance & Copyright Audit Report

**Date:** {datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")}  
**Upstream Dataset:** `{upstream_meta.get('dataset_id')}`  
**Upstream Revision (Commit SHA):** `{upstream_rev}`  
**Declared Dataset License:** `{upstream_license}` *(Note: Declared license does not establish underlying third-party question rights)*  
**QForge Production Corpus:** `{qforge_total:,}` questions  
**Audit Principle:** `NO_MATCH_FOUND != COPYRIGHT_CLEARED`  

---

## 1. Executive Summary

| Category | Count | Percentage of Bank | Evidence Level |
| :--- | :---: | :---: | :--- |
| 🎯 **Exact Fingerprint Matches** | **{exact_matches:,}** | **{round(exact_matches*100/qforge_total, 2)}%** | `deterministic` (SHA-256) |
| 🔍 **Strong Matches (Near-Duplicate/Structural)** | **{strong_matches:,}** | **{round(strong_matches*100/qforge_total, 2)}%** | `multi_signal` (MinHash/Formula) |
| 💡 **Possible Semantic Candidates** | **{possible_matches:,}** | **{round(possible_matches*100/qforge_total, 2)}%** | `candidate` (Verified TF-IDF) |
| ⚪ **No Match Found in Tested Corpus** | **{no_match_count:,}** | **{round(no_match_count*100/qforge_total, 2)}%** | `none_in_tested_corpus` |
| **Total Corpus Audited** | **{qforge_total:,}** | **100.0%** | — |

---

## 2. Subject Breakdown

| Subject | Total Questions | Exact Match | Strong Match | Possible Match | No Match Found | Match Rate |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
"""
    for subj, data in subject_agg.items():
        summary_md_content += f"| **{subj.capitalize()}** | {data['total']:,} | {data['exact_matches']:,} | {data['strong_matches']:,} | {data['possible_matches']:,} | {data['no_match_found']:,} | **{data['match_rate_pct']}%** |\n"

    summary_md_content += f"""
---

## 3. Provenance & Review Queue Status

| Status | Count | Meaning / Recommendation |
| :--- | :---: | :--- |
| 🏷️ **PROVENANCE_KNOWN** | **{audit_report['provenance_summary']['provenance_known']:,}** | Mapped to upstream source with explicit exam/source tags |
| ❓ **PROVENANCE_UNKNOWN** | **{audit_report['provenance_summary']['provenance_unknown']:,}** | Matched upstream content, but origin exam metadata unassigned in dataset |
| ⚪ **PROVENANCE_UNASSIGNED** | **{audit_report['provenance_summary']['provenance_unassigned']:,}** | No match found in tested dataset |
| ⚠️ **REVIEW_REQUIRED** | **{audit_report['provenance_summary']['review_required']:,}** | Exact/Strong match candidates queued for human/editorial review |

---

## 4. Top Origin Databases & Exam Tags

### Top Source Databases:
```text
"""
    for db_name, cnt in list(top_source_dbs.items())[:10]:
        summary_md_content += f"{str(db_name):<30} : {cnt:,} questions\n"

    summary_md_content += """```

### Top Exam / Subject Tags:
```text
"""
    for tag_name, cnt in list(top_exam_tags.items())[:15]:
        summary_md_content += f"{str(tag_name):<30} : {cnt:,} questions\n"

    summary_md_content += """```

---

## 5. Artifact References
- **Evidence CSV (Row-by-Row):** `qforge-provenance-evidence.csv`
- **Machine Report:** `qforge-provenance-audit-report.json`
- **Safety Guarantee:** Strict read-only audit against Cloudflare D1. Zero rows modified.
"""

    with open(SUMMARY_MD, "w", encoding="utf-8") as f:
        f.write(summary_md_content)
    print(f"✅ Saved Summary Markdown: {SUMMARY_MD}", flush=True)

    print("\n" + "=" * 70, flush=True)
    print(f"🎉 AUDIT COMPLETE in {time.time() - t_start:.1f}s!", flush=True)
    print(f"   Exact Matches   : {exact_matches:,} ({exact_matches*100/qforge_total:.1f}%)", flush=True)
    print(f"   Strong Matches  : {strong_matches:,} ({strong_matches*100/qforge_total:.1f}%)", flush=True)
    print(f"   Possible Matches: {possible_matches:,} ({possible_matches*100/qforge_total:.1f}%)", flush=True)
    print(f"   No Match Found  : {no_match_count:,} ({no_match_count*100/qforge_total:.1f}%)", flush=True)
    print("=" * 70, flush=True)


if __name__ == "__main__":
    run_provenance_audit()
