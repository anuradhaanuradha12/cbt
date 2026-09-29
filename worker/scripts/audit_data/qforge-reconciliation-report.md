# QForge Upstream Provenance & Content Rights Reconciliation Report

**Audit Date:** 2026-09-29  
**Upstream Dataset:** `datavorous/entrance-exam-dataset`  
**Upstream Revision:** `a66a9e715abf764de34755619c6f8068ddf5807d` (Commit SHA)  
**Declared Upstream License:** `CC BY 4.0` *(Verbatim claim from Hugging Face repository; does not establish third-party rights)*  
**QForge Production Corpus:** `86,737` questions (100% remote Cloudflare D1 snapshot)  
**Audit Principle:** `NO_MATCH_FOUND != COPYRIGHT_CLEARED` and `NO_MATCH_FOUND != SYNTHETIC_VERIFIED`

---

## ⚠️ Critical Audit Limitations & Disclaimers

> **Audit Limitation (Matched Cohort):** An upstream dataset match establishes content correspondence with the frozen corpus. It does not independently establish ownership, authorship, copyright clearance, sublicensing authority, or commercial-use rights for the underlying content.

> **Unmatched-Content Limitation:** `PROVENANCE_UNASSIGNED` means only that no sufficiently supported correspondence was identified within the tested corpus and matching methods. It is not evidence that the content is synthetic, original, public domain, copyright-free, or commercially cleared.

---

## 1. High-Level Reconciliation Summary

```text
QForge Production Corpus (86,737 Questions)
  │
  ├── 80,953 (93.33%) ─── UPSTREAM_MATCH_CONFIRMED (Matched Upstream Corpus)
  │                        ├── 64,568 (74.44%)  Tier 1 Exact Hash Match (SHA-256)
  │                        ├── 15,085 (17.39%)  Tier 2/3 Strong Near-Duplicate (MinHash/Formula)
  │                        └──  1,300 ( 1.50%)  Tier 4 Semantic Candidate (Verified TF-IDF)
  │
  └──  5,784 ( 6.67%) ─── PROVENANCE_UNASSIGNED (No Match in Tested Upstream Corpus)
                           ├── 2,734 (47.27%)  Mathematics
                           ├── 1,972 (34.09%)  Chemistry
                           ├── 1,008 (17.43%)  Physics
                           └──    70 ( 1.21%)  Biology
```

---

## 2. Phase 14: Evidence Layers for Rights & Provenance

| Evidence Layer | Question | Current Status & Evidence |
| :--- | :--- | :--- |
| **Layer 1: QForge → Upstream** | Does this question exist in the frozen upstream corpus? | **80,953 questions matched** (`64,568` exact hashes, `15,085` near-duplicates, `1,300` semantic) |
| **Layer 2: Upstream → Claimed License** | What license did the dataset publisher declare? | `CC BY 4.0` declared on Hugging Face at revision `a66a9e715a...` |
| **Layer 3: Upstream → Underlying Content** | Did the publisher have authority to license underlying exam questions? | **Pending Legal / Provenance Review** (Sourced from entrance exams such as JEE, NEET, BITSAT) |
| **Layer 4: QForge-Local Content** | Where did the 5,784 unmatched questions come from? | **Phase 14A Target** (Mining generation history, prompt logs, and import batches) |

---

## 3. Granular Analysis of Matched Questions (80,953 Rows)

All 80,953 matched questions are linked directly to their respective upstream row ID, `source_db`, and raw tags JSON.

### A. Exam Distribution
| Exam Authority / Stream | Question Count | % of Matched Corpus | Notes |
| :--- | :---: | :---: | :--- |
| **NEET / AIPMT** | **43,335** | **53.53%** | Medical entrance (Heavy Biology & Chemistry) |
| **JEE Main / AIEEE** | **27,208** | **33.61%** | Engineering entrance |
| **NDA** | **2,748** | **3.39%** | National Defence Academy |
| **BITSAT** | **2,443** | **3.02%** | Birla Institute entrance |
| **WBJEE** | **1,589** | **1.96%** | West Bengal Joint Entrance |
| **JEE Advanced / IIT JEE** | **1,331** | **1.64%** | Engineering advanced tier |
| **State CET / Other** | **829** | **1.02%** | EAMCET, UPSEE, VITEEE |
| **MHT CET** | **364** | **0.45%** | Maharashtra CET |
| **AIIMS** | **334** | **0.41%** | AIIMS MBBS past papers |
| **KCET** | **196** | **0.24%** | Karnataka CET |
| **COMEDK** | **81** | **0.10%** | Karnataka Private Medical/Engineering |
| **Other / General Entrance** | **495** | **0.61%** | Untagged sub-competitions |

### B. Year & Paper Provenance
- **Questions with Explicit Year Tag:** **25,309 (31.26%)**
  - **Recent Papers (2020–2024):** 7,700 questions (e.g. `NEET 2023 (All India)`, `JEE Main 2024 (27 Jan Shift 1)`)
  - **Historical Papers (1980–2019):** 17,609 questions
- **Questions with General Topic Bank Tag (Year Null):** **55,644 (68.74%)**
  - Carried general chapter/exam tags without specific exam session dates.

### C. Origin Database Distribution (`source_db`)
- `MarksBatch2_P3.db` : 16,676 questions
- `MarksBatch2_P4.db` : 16,299 questions
- `MarksBatch2_P2.db` : 14,102 questions
- `MarksBatch2_P1.db` : 10,386 questions
- `MarksBatch0.db`    : 8,028 questions
- `MarksBatch1_P1.db` : 7,958 questions
- `MarksBatch1_P2.db` : 6,085 questions
- Directory prefix variants (`db\MarksBatch*`): ~1,419 questions

---

## 4. Investigation of the Unmatched Cohort (5,784 Questions)

The 5,784 questions that returned `NO_MATCH_FOUND` against `datavorous/entrance-exam-dataset` require distinct classification rather than automatically assuming they are synthetic:

### A. Subject & Chapter Distribution
- **Mathematics (2,734 questions / 47.3%):** Concentrated in heavy calculus and algebra topics (`Definite Integration` [189], `Binomial Theorem` [177], `Sequences and Series` [172], `Limits` [152], `Determinants` [147], `Differential Equations` [141]).
- **Chemistry (1,972 questions / 34.1%):** Concentrated in `Electrochemistry` [188], `Ionic Equilibrium` [152], `Thermodynamics` [151].
- **Physics (1,008 questions / 17.4%):** Spread across mechanics and electrodynamics.
- **Biology (70 questions / 1.2%):** Almost zero unmatched (<0.32% of total biology), showing Biology was near-100% sourced from the upstream crawl.

### B. Phase 14A Action Plan: Reconciling Unmatched Origin
Rather than guessing, Phase 14A will mine the local repository for:
1. **Generation Scripts & Logs:** Identifying batch timestamps and model prompts.
2. **Supplemental Import Files:** Checking for auxiliary JSON/CSV files.
3. **Heavy Formula Rendering Divergence:** Checking if integral/matrix LaTeX formatting led to missed matches.

---

## 5. Future D1 Schema Architecture (Queryable Projection)

When D1 is eventually updated, it should serve strictly as a **queryable projection** of the frozen audit evidence:

```sql
-- Upstream Provenance Linkage
ALTER TABLE questions ADD COLUMN upstream_dataset TEXT;
ALTER TABLE questions ADD COLUMN upstream_revision TEXT;
ALTER TABLE questions ADD COLUMN upstream_row_id TEXT;
ALTER TABLE questions ADD COLUMN source_db TEXT;
ALTER TABLE questions ADD COLUMN raw_tags TEXT;

-- Parsed Metadata (Fact-Based)
ALTER TABLE questions ADD COLUMN exam_name TEXT;
ALTER TABLE questions ADD COLUMN exam_year INTEGER;
ALTER TABLE questions ADD COLUMN exam_shift TEXT;

-- Audit Classification
ALTER TABLE questions ADD COLUMN provenance_status TEXT;
ALTER TABLE questions ADD COLUMN provenance_match_type TEXT;
ALTER TABLE questions ADD COLUMN provenance_evidence_level TEXT;
```

---

## 6. Audit Artifacts & Safety Guarantee
- **Immutable Evidence CSV:** [`worker/scripts/audit_data/qforge-provenance-evidence.csv`](file:///d:/Websites/CBT/worker/scripts/audit_data/qforge-provenance-evidence.csv) (62.63 MB, 86,737 rows)
- **JSON Audit Report:** [`worker/scripts/audit_data/qforge-provenance-audit-report.json`](file:///d:/Websites/CBT/worker/scripts/audit_data/qforge-provenance-audit-report.json)
- **Summary Report:** [`worker/scripts/audit_data/qforge-provenance-summary.md`](file:///d:/Websites/CBT/worker/scripts/audit_data/qforge-provenance-summary.md)
- **D1 Status:** **Strictly read-only; 0 rows modified.**
