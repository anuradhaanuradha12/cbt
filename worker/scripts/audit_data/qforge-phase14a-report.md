# QForge Phase 14A — Unmatched Cohort Reconciliation Report

**Audit Date:** 2026-09-29  
**Cohort Size:** `5,784` questions (`6.67%` of total 86,737 QForge bank)  
**Investigation Principle:** Do not guess origin or label records as `is_synthetic` without an empirical evidence trail.

---

## 1. Executive Summary & Cohort Taxonomy

Our empirical investigation into the 5,784 unmatched questions (`PROVENANCE_UNASSIGNED`) reveals that they are not a single monolithic group. Instead, they divide into **four distinct, measurable sub-cohorts**:

```text
5,784 Unmatched Questions (PROVENANCE_UNASSIGNED)
  │
  ├── 1,476 (25.52%) ─── Transformed Upstream (Encoding / Mojibake Divergence)
  │                      └── Questions with CP1252/UTF-8 corrupted symbols (âˆ, Ï€, â‰) that failed canonical string matching
  │
  ├──   283 ( 4.89%) ─── Visual / Image-Dependent Questions ([IMG: ...])
  │                      └── Questions whose core mathematical or chemical content resided in diagram placeholders
  │
  ├──   108 ( 1.87%) ─── Ultra-Short / Truncated Stems (<35 characters)
  │                      └── Stems lacking sufficient lexical tokens for semantic TF-IDF thresholding
  │
  └── 3,917 (67.72%) ─── Genuine Unassigned Cohort (Likely Synthetic / Supplemental Imports)
                         ├── Mathematics : 1,942 questions (Advanced Integration, Series, Limits)
                         ├── Chemistry   : 1,328 questions (Electrochemistry, Equilibrium, Thermodynamics)
                         ├── Physics     :   604 questions
                         └── Biology     :    43 questions
```

---

## 2. Granular Breakdown by Sub-Cohort

### Sub-Cohort A: Transformed Upstream via Encoding Corruption (`1,476` rows / 25.5%)
- **Symptom:** Questions containing CP1252-to-UTF8 mojibake strings (e.g., `âˆ€xâˆˆ2,3` for $\forall x \in [2,3]$, `Ï€` for $\pi$, `â€‰Ω` for $\Omega$).
- **Root Cause:** During legacy ingestion into SQLite/D1, certain mathematical Unicode symbols were double-encoded. The standard normalizer did not reverse-transcode these specific mojibake sequences, causing SHA-256 and TF-IDF matching against the clean upstream Parquet to fail.
- **Evidence Assessment:** These are **demonstrably transformed upstream records** rather than synthetic questions.

### Sub-Cohort B: Image-Dependent Formula Stems (`283` rows / 4.9%)
- **Symptom:** Questions formatted as `The reaction \n\n [IMG:/images/external/...] \n\n is called:...`
- **Root Cause:** In the upstream dataset, chemical reaction diagrams and circuit diagrams were either HTML `<img>` tags or Base64 blobs. During QForge ingestion, these were extracted to R2 image key placeholders.
- **Evidence Assessment:** Identical generic stems (`The reaction is called:`) exist hundreds of times across organic chemistry, creating ambiguity below the 0.90 similarity threshold.

### Sub-Cohort C: Ultra-Short / Truncated Stems (`108` rows / 1.9%)
- **Symptom:** Stems with fewer than 35 characters total (e.g. `Evaluate:` or pure numeric formulas).
- **Evidence Assessment:** Insufficient n-gram entropy to distinguish from false positives.

### Sub-Cohort D: Genuine Unassigned / Synthetic Batch Candidates (`3,917` rows / 67.7%)
- **Subject Concentration:** Heavily skewed to **Mathematics** (49.6%) and **Chemistry** (33.9%). Biology has only 43 questions.
- **Chapter Clusters:**
  - `Definite Integration` (189 questions)
  - `Electrochemistry` (188 questions)
  - `Binomial Theorem` (177 questions)
  - `Sequences and Series` (172 questions)
  - `Ionic Equilibrium` (152 questions)
  - `Limits` (152 questions)
- **Characteristics:** Cleanly formatted LaTeX, standard MCQ options, high mathematical density without corresponding matches in the upstream dataset.
- **Status:** Retained as `PROVENANCE_UNASSIGNED (CANDIDATE_SYNTHETIC)` pending discovery of generation seed/prompt logs.

---

## 3. Evidence Status Recommendations

| Sub-Cohort | Count | Recommended Audit Status | Next Technical Action |
| :--- | :---: | :--- | :--- |
| **Encoding Mojibake** | 1,476 | `TRANSFORMED_UPSTREAM_ENCODING` | Add CP1252 reverse-transcoding filter to recover upstream row IDs |
| **Image-Dependent** | 283 | `TRANSFORMED_UPSTREAM_IMAGE_EXTRACT` | Match via Option tuples + image filename hashes |
| **Ultra-Short Stems** | 108 | `PROVENANCE_INSUFFICIENT_ENTROPY` | Manual editorial review queue |
| **Candidate Synthetic** | 3,917 | `PROVENANCE_UNASSIGNED (CANDIDATE_SYNTHETIC)` | Preserve external record; do not label boolean `is_synthetic` without log verification |

---

## 4. Output Artifacts
- **Phase 14A Detailed Report:** [`worker/scripts/audit_data/qforge-phase14a-report.md`](file:///d:/Websites/CBT/worker/scripts/audit_data/qforge-phase14a-report.md)
- **Immutable Evidence CSV:** [`worker/scripts/audit_data/qforge-provenance-evidence.csv`](file:///d:/Websites/CBT/worker/scripts/audit_data/qforge-provenance-evidence.csv)
