# CBT Platform

A multi-tenant, white-labeled **Computer-Based Testing (CBT) platform** for colleges (JEE/NEET/KCET) built entirely on the Cloudflare edge stack.

## Overview

Over the past few months, we've built a multi-tenant Computer-Based Testing platform designed for engineering and medical entrance exams. 
Instead of traditional VMs or containers, the platform runs entirely on Cloudflare's edge using Workers, D1, KV, and R2.

Building everything on an edge-native architecture allows for a lightweight platform with minimal infrastructure overhead, significantly reduced latency for end-users, and scalable multi-tenancy.

## Core Features

- **Progressive Web App (PWA):** Fully responsive on mobile. Can be installed directly to the home screen (Standalone Mode) on iOS and Android.
- **Multi-Tenant Architecture:** Capable of serving multiple colleges from a single deployment with absolute data isolation.
- **Strict Anti-Cheat:** 
  - **PC:** Enforces Fullscreen API, disables copy/paste, right-click, and tracks tab-switching.
  - **Mobile:** Zero-tolerance policy on app switching or minimizing.
- **Real-time Analytics Dashboard:** Real-time dashboards (Average Score, Peak Engagement, Attempt details).
- **Dynamic Exam Generation:** Automated exam generation and quotas based on specific test formats.
- **AI-Assisted Question Workflow:** Proprietary Question Forge workflow for automated, high-quality question generation and review.
- **Exam Scheduling & Waiting Room:** Scheduled exams unlock exactly at start time. Includes a pre-exam instruction screen.

## Stack

| Layer    | Technology                                |
| -------- | ----------------------------------------- |
| Runtime  | Cloudflare Workers (TypeScript)           |
| Database | Cloudflare D1 (SQLite)                    |
| Cache    | Cloudflare KV                             |
| Media    | Cloudflare R2                             |
| Frontend | Vanilla HTML/CSS/JS (Zero build steps)    |

## Why Edge Computing?

By moving the entire testing platform to Cloudflare Workers, we achieved:
- **Ultra-low latency** for exam delivery and submission.
- **Simplified scaling** without needing to manage Kubernetes clusters or auto-scaling groups.
- **Global distribution** out-of-the-box, ensuring students experience consistent performance regardless of their physical location.

*For internal documentation, architecture blueprints, API references, and deployment procedures, please refer to the internal repository documentation.*
