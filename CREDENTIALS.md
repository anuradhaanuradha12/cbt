# 🔐 QForge CBT Platform — System Credentials & App Guide

This document contains authentication credentials, account roles, and infrastructure access details for the **QForge CBT Platform** (Local and Cloudflare Production environments).

> **🔑 Unified Demo Password**: All demo accounts in both **Local** and **Remote (Production)** databases use the exact same password: **`demo12345`**.

---

## 👥 User Accounts & Credentials (Local & Remote)

All accounts share the standard password: **`demo12345`**

| Role | Name | Login Email (ID) | Scope / Subject | Password | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Admin / Superuser** | Platform Admin | `admin@cbt.local` | `global` | `demo12345` | Full platform administration |
| **Admin / Superuser** | Platform Admin | `admin@example.com` | `global` | `demo12345` | Secondary admin account |
| **Principal / Admin** | Principal | `principal@cbt.local` | `global` | `demo12345` | Exam review & publishing |
| **Faculty (Physics)** | Dr. Demo Faculty | `faculty@qforge-demo.edu` | `physics` (`ngi`) | `demo12345` | NGI Demo College faculty |
| **Faculty (Physics)** | Physics Teacher | `teacher@cbt.local` | `physics` (`global`) | `demo12345` | Subject faculty |
| **Faculty (Physics)** | Physics Teacher | `faculty_physics@cbt.local`| `physics` (`global`) | `demo12345` | Subject faculty |
| **Student** | Demo Student | `student@qforge-demo.edu` | `ngi` | `demo12345` | NGI Demo Student |
| **Student** | Test Student | `student@cbt.local` | `global` | `demo12345` | Test Student |
| **Student** | Test Student 1 | `student1@cbt.local` | `global` | `demo12345` | Test Student |

---

## 🛠️ Multi-Tenant Access Control

- **`college_id` Scoping**:
  - `global`: Full system-level visibility (superadmins and system evaluators).
  - Specific College ID (e.g. `ngi`, `stepvista`): Restricts students and faculty to their respective college exams, question banks, and submissions.
- **Faculty Subject Isolation**:
  - Faculty accounts can only manage questions and create exams matching their assigned `subject` (e.g., `physics`, `chemistry`, `mathematics`, `biology`).

---

## ☁️ Cloudflare Edge Infrastructure Configuration

| Resource | Resource Name / ID | Binding Name | Purpose |
| :--- | :--- | :--- | :--- |
| **D1 Database** | `cbt-platform`<br>`220c5793-3f10-460a-b5fc-8f3223feee43` | `DB` | Main database (86,730+ questions, users, exams, submissions) |
| **D1 Database** | `cbt-qforge`<br>`bbe7c7a4-acbf-42c3-ba60-17e34e5bf9bb` | `QFORGE_DB` | AI Question Forge drafts & approved questions |
| **Decision AI** | TypeSafe System One (`jev-latest`) | `TYPESAFE_API_KEY` | Question difficulty classification & calibration |
| **Fast Cache** | `cbt-worker-CBT_KV`<br>`9ceb8c5eef2541fcbc7485301a4b23b0` | `CBT_KV` | Session caching & sanitized exam caching |

| **R2 Bucket** | `cbt-media` | `CBT_R2` | Storage for diagrams, figures, and question images |

---

## 🚀 Quick Execution Commands

### Local Development
```bash
# In ./worker directory
npm run dev
# Starts local worker on http://127.0.0.1:8787
```

### Production Deployment
```bash
# In ./worker directory
npx wrangler deploy
```
