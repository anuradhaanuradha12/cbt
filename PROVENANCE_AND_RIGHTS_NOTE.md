# QForge Internal Rights, Licensing & Provenance Statement

**Effective Date:** 2026-09-29  
**Document Status:** Internal Governance & Compliance Note  
**Application:** QForge Question Bank & Computer-Based Testing (CBT) Platform  

---

## 1. Upstream Dataset & Provenance Baseline

QForge's baseline question bank of 86,737 questions was audited and reconciled against the frozen upstream corpus:
* **Dataset Name:** `datavorous/entrance-exam-dataset`
* **Frozen Revision (Commit SHA):** `a66a9e715abf764de34755619c6f8068ddf5807d`
* **Snapshot SHA-256 (Parquet):** `64b4b02d54a0f1be41b8e7b68db4cd412806a5b78cc84f9c80bd96a6d85ddad9`
* **Declared Publisher License:** `Creative Commons Attribution 4.0 International (CC BY 4.0)`

### Empirical Audit Summary:
* **80,953 questions (93.33%):** Empirically matched to the frozen upstream dataset (`UPSTREAM_MATCH_CONFIRMED`) with full upstream row IDs, `source_db`, and exam tags preserved in external audit evidence.
* **5,784 questions (6.67%):** Unmatched in the tested corpus (`PROVENANCE_UNASSIGNED`), comprising encoding-transformed upstream questions (25.5%), image-dependent items (4.9%), and candidate synthetic/supplemental batches (67.7%).

---

## 2. Creative Commons Attribution Notice (CC BY 4.0 Compliance)

To satisfy the attribution requirements of the declared CC BY 4.0 upstream dataset:

> **Attribution:**  
> Portions of the question bank in QForge are derived from the *Entrance Exam Dataset* by `datavorous`, published under the Creative Commons Attribution 4.0 International License (CC BY 4.0).  
> Original Repository: `https://huggingface.co/datasets/datavorous/entrance-exam-dataset` (Revision: `a66a9e715abf764de34755619c6f8068ddf5807d`).  
> Modifications: Text normalization, LaTeX formatting standardizations, image URL isolation, and algorithmic difficulty calibration.

---

## 3. Legal Position & Disclaimers for Institutional / Commercial Deployment

1. **No Implied Third-Party Clearance:**  
   QForge acknowledges that the upstream dataset publisher's declaration of CC BY 4.0 does not independently establish that underlying third-party exam authorities (e.g., NTA for JEE/NEET, IITs for JEE Advanced, BITS Pilani for BITSAT) granted redistribution rights to the dataset maintainer.
2. **Defensible Audit Boundary:**  
   QForge preserves complete, immutable cryptographic audit logs (`qforge-provenance-evidence.csv`, `qforge-provenance-audit-report.json`) establishing exact content correspondence without making unsupported claims of universal legal clearance (`NO_MATCH_FOUND != COPYRIGHT_CLEARED`).
3. **Statutory Exceptions Context (India Copyright Act, 1957 - Section 52):**  
   While Section 52(1)(h) and related provisions provide exceptions for educational instruction and examination questions conducted by educational institutions, commercial licensing of software to colleges operates under enterprise SaaS terms. This note and the accompanying audit trail provide clear inventory for formal legal counsel review prior to multi-institution commercial scaling.

---

## 4. Operational Guardrails

- Remote production D1 remains operational and unencumbered by unverified boolean flags.
- All provenance metadata is preserved externally in version-controlled audit artifacts.
- Editorial and institutional clients receive transparent attribution and question-level difficulty intelligence.
