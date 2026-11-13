# Codebase Audit & Production-Readiness Report

**Date:** 2026-11-12  
**Project:** The Salad (`the-salad` v0.2.1)

## 1. Executive Summary

- **Code Relevance:** Clean. All files in `src/` and `supabase/` belong to the multitenant restaurant SaaS platform (`The Salad`). There is no unrelated third-party or leftover template code.
- **TypeScript (`npm run typecheck`):** Passes with **0 errors**.
- **ESLint (`npm run lint`):** Passes with **0 errors** and **73 warnings** (primarily `react-hooks/set-state-in-effect` and `@next/next/no-location-assign-relative-destination`).
- **Production Readiness:** The application code is well-structured, but the **environment, database, and repository hygiene** are not yet production-ready (see findings below).

## 2. Dead Code, Clutter & Hygiene Findings

| Item | Status | Recommendation |
|---|---|---|
| `_drawer-test.mts` (repo root) | Stray scratch test script | Delete or move into `scripts/` |
| `src/lib/case.ts` | Unreferenced in `src/` (replaced by `supabase/functions/_shared/case.ts`) | Safe to remove |
| `scripts/` (127 files) | Contains 27 `_*.mts` ad-hoc scratch checks and 3 `shot-*.mts` scripts alongside `test-*.mts` and `verify-*.mts` | Archive or prune `_*.mts` scratch scripts |
| `.gitignore` | Was missing | Added standard Next.js/Node `.gitignore` |
| `.env.example` | Was missing (referenced by `README.md`) | Added `.env.example` |
| `README.md` | Was outdated (claimed `src/app/api/**` was deleted, listed non-existent `google-reviews` function, only listed migrations `0001`–`0007`) | Updated to match actual codebase |
| `supabase/migrations/0054_*` | Duplicate prefix (`0054_audit_admin_id_fkey.sql` and `0054_invoice_seller_backfill.sql`; `0010` and `0052` skipped) | Verify ordering before applying to a fresh DB |

## 3. Live Supabase Project Status (`jeuixphibaasbxgaexfg`)

Checked via Supabase MCP:
- **Tables (`public`):** `0` (empty)
- **Applied Migrations:** `0`
- **Deployed Edge Functions:** `0`

## 4. Production-Readiness Roadmap

1. **Database & Edge Functions (Supabase):**
   - Apply `supabase/migrations/0001`–`0085` to the target Supabase project (and run `reset-to-empty.sql` if starting without demo data).
   - Deploy all 27 Edge Functions and configure required secrets (`ALLOWED_ORIGINS`, `GEMINI_API_KEY`, `RAZORPAY_*`).
   - Create `.env.local` for local testing and verify `npm run build`.
2. **Code Quality & ESLint Warnings:**
   - Resolve the 73 ESLint warnings (`react-hooks/set-state-in-effect` in `src/components/views/settings.tsx` and `src/app/superadmin/*`, and `window.location.href` internal navigation warnings in `src/app/page.tsx` and `src/lib/sign-out.ts`).
3. **Bug Fixes, Features & UI/UX:**
   - Walk through critical user flows (Onboarding, POS/Orders, Table Checks, QR Diner Ordering, Billing/Subscriptions, Super Admin) against the live Supabase backend and address UI/UX polish items.
4. **Git & Deployment:**
   - Initialize git, commit clean codebase (excluding `node_modules/`, `.next/`, `.env*.local`), and push to `https://github.com/iphrnx/Saladcode.git`.

