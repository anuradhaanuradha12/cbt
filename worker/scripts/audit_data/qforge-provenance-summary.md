# QForge Provenance & Copyright Audit Report

**Date:** 2026-09-29 17:06:25 UTC  
**Upstream Dataset:** `datavorous/entrance-exam-dataset`  
**Upstream Revision (Commit SHA):** `a66a9e715abf764de34755619c6f8068ddf5807d`  
**Declared Dataset License:** `cc-by-4.0` *(Note: Declared license does not establish underlying third-party question rights)*  
**QForge Production Corpus:** `86,737` questions  
**Audit Principle:** `NO_MATCH_FOUND != COPYRIGHT_CLEARED`  

---

## 1. Executive Summary

| Category | Count | Percentage of Bank | Evidence Level |
| :--- | :---: | :---: | :--- |
| 🎯 **Exact Fingerprint Matches** | **64,568** | **74.44%** | `deterministic` (SHA-256) |
| 🔍 **Strong Matches (Near-Duplicate/Structural)** | **15,085** | **17.39%** | `multi_signal` (MinHash/Formula) |
| 💡 **Possible Semantic Candidates** | **1,300** | **1.5%** | `candidate` (Verified TF-IDF) |
| ⚪ **No Match Found in Tested Corpus** | **5,784** | **6.67%** | `none_in_tested_corpus` |
| **Total Corpus Audited** | **86,737** | **100.0%** | — |

---

## 2. Subject Breakdown

| Subject | Total Questions | Exact Match | Strong Match | Possible Match | No Match Found | Match Rate |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Biology** | 21,693 | 20,951 | 631 | 41 | 70 | **99.68%** |
| **Chemistry** | 28,294 | 21,824 | 4,025 | 473 | 1,972 | **93.03%** |
| **Mathematics** | 15,018 | 9,689 | 2,352 | 243 | 2,734 | **81.8%** |
| **Physics** | 21,732 | 12,104 | 8,077 | 543 | 1,008 | **95.36%** |

---

## 3. Provenance & Review Queue Status

| Status | Count | Meaning / Recommendation |
| :--- | :---: | :--- |
| 🏷️ **PROVENANCE_KNOWN** | **80,953** | Mapped to upstream source with explicit exam/source tags |
| ❓ **PROVENANCE_UNKNOWN** | **0** | Matched upstream content, but origin exam metadata unassigned in dataset |
| ⚪ **PROVENANCE_UNASSIGNED** | **5,784** | No match found in tested dataset |
| ⚠️ **REVIEW_REQUIRED** | **79,653** | Exact/Strong match candidates queued for human/editorial review |

---

## 4. Top Origin Databases & Exam Tags

### Top Source Databases:
```text
MarksBatch2_P3.db              : 16,676 questions
MarksBatch2_P4.db              : 16,299 questions
MarksBatch2_P2.db              : 14,102 questions
MarksBatch2_P1.db              : 10,386 questions
MarksBatch0.db                 : 8,028 questions
MarksBatch1_P1.db              : 7,958 questions
MarksBatch1_P2.db              : 6,085 questions
db\MarksBatch2_P1.db           : 384 questions
db\MarksBatch2_P2.db           : 319 questions
db\MarksBatch2_P3.db           : 275 questions
```

### Top Exam / Subject Tags:
```text
['Chemistry', 'p Block Elements (Group 15, 16, 17 & 18)', 'NEET'] : 827 questions
['Chemistry', 'Biomolecules', 'NEET'] : 821 questions
['Biology', 'Principles of Inheritance and Variation', 'NEET'] : 743 questions
['Biology', 'Sexual Reproduction in Flowering Plants', 'NEET'] : 683 questions
['Chemistry', 'd and f Block Elements', 'NEET'] : 671 questions
['Biology', 'Human Health and Diseases', 'NEET'] : 659 questions
['Biology', 'Biological Classification', 'NEET'] : 630 questions
['Biology', 'Human Reproduction', 'NEET'] : 628 questions
['Biology', 'Molecular Basis of Inheritance', 'NEET'] : 627 questions
['Chemistry', 'General Organic Chemistry', 'NEET'] : 623 questions
['Biology', 'Chemical Coordination and Integration', 'NEET'] : 619 questions
['Chemistry', 'Chemical Bonding and Molecular Structure', 'NEET'] : 607 questions
['Chemistry', 's Block Elements', 'NEET'] : 569 questions
['Biology', 'Evolution', 'NEET'] : 569 questions
['Chemistry', 'Coordination Compounds', 'NEET'] : 554 questions
```

---

## 5. Artifact References
- **Evidence CSV (Row-by-Row):** `qforge-provenance-evidence.csv`
- **Machine Report:** `qforge-provenance-audit-report.json`
- **Safety Guarantee:** Strict read-only audit against Cloudflare D1. Zero rows modified.
