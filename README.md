# The Salad

A multitenant restaurant platform: point-of-sale (POS), live order flow, QR table ordering, table checks & sitting management, kitchen display, staff PIN sessions with granular RBAC, Razorpay subscriptions & GST invoicing, and a Super Admin operations panel.

## Tech Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (`16.4.3`, App Router, standalone output) |
| UI | React 19, Tailwind CSS v4, shadcn/ui, Radix UI, Recharts, Framer Motion |
| Database & Auth | Supabase Postgres, Supabase Auth (owners & super admins), Supabase Realtime |
| API | 27 Supabase Edge Functions (Deno) + Next.js `/api/auth/*` & `/api/superadmin/*` proxy routes |
| Billing & AI | Razorpay Subscriptions & Webhooks, Google Gemini (menu extraction & image generation) |
| Hosting | Vercel (Next.js) + Supabase (Postgres + Edge Functions + Storage) |

> **Note:** There is no Prisma at runtime. `docs/legacy-prisma-schema.txt` is kept for historical reference only.

## Architecture Overview

```
Browser ──┬─ anon key ──► Supabase Postgres (RLS-enforced public reads)
          ├─ Realtime ──► orders / order_items / table_sessions / table_checks
          ├─ /functions/v1/* ──► Supabase Edge Functions (service role + guard())
          └─ /api/superadmin/* ──► Next.js App Router proxy ──► super-admin Edge Function
```

### Auth & Security Model

1. **Owners / Managers**: Authenticate via Supabase Auth (`profiles.id = auth.users.id`). Edge functions validate the JWT via `guard()` in `supabase/functions/_shared/auth.ts`.
2. **Floor Staff**: Authenticate with a 4-digit PIN (scrypt-hashed with per-staff salt, rate-limited with lockout) carried in an HttpOnly `tablo-staff-session` cookie.
3. **Diners (QR Ordering)**: No account required. Scanning a table QR calls `table-session` (`start_table_session()` RPC), and `orders` (`place_order()` / `create_order_tx()`) recomputes all item prices, taxes, service charges, and promos server-side in Postgres.
4. **Super Admins**: Authenticate via `/superadmin/login` (`/api/auth/otp`, `/api/auth/verify-otp`, `/api/auth/callback`) and call `/api/superadmin/*` which proxies to the `super-admin` Edge Function.

For a full breakdown of all routes, components, and edge functions, see [`docs/architecture.md`](docs/architecture.md).

## Local Setup

```bash
npm install
cp .env.example .env.local   # fill in your Supabase URL, anon key, and service role key
npm run dev
```

### Required Environment Variables (`.env.local`)

| Variable | Purpose | Scope |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL | Public |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon / publishable key | Public |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role secret | Server-only (never `NEXT_PUBLIC_`) |

### Supabase Edge Function Secrets

Set these in Supabase Dashboard → Edge Functions → Secrets (see [`docs/deployment.md`](docs/deployment.md) for details):

- `ALLOWED_ORIGINS` (or `SITE_URL`) — required for browser CORS
- `GEMINI_API_KEY` — for `ai-extract-menu` and `ai-generate-image`
- `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` — for `subscriptions` and `razorpay-webhook`

Deploy Edge Functions with:

```bash
node scripts/deploy-all-fns.mjs     # deploy all functions
node scripts/deploy-fn.mjs menu      # deploy a single function
```

## Database & Migrations

Migrations live in `supabase/migrations/` (`0001_swixo_init.sql` through `0085_payment_methods.sql`).

- Apply migrations in filename order via Supabase CLI (`supabase db push`) or the Supabase MCP/SQL editor.
- `0004_seed_demo_tenant.sql` seeds a development demo restaurant (**Jaegar Resto**). For a clean production database, run `supabase/reset-to-empty.sql` over verified TLS (`sslmode=verify-full`).

## Common Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start Next.js dev server on `:3000` |
| `npm run build` | Production build + standalone asset copy |
| `npm start` | Run standalone production server |
| `npm run typecheck` | Run `tsc --noEmit` |
| `npm run lint` | Run ESLint across the repository |
| `npm run smoke` | Run preflight smoke checks (`scripts/smoke-preflight.mts`) |

## Project Documentation

- [`docs/architecture.md`](docs/architecture.md) — Codebase structure, routes, views, libraries, and Edge Functions
- [`docs/audit-report.md`](docs/audit-report.md) — Codebase audit, dead-code findings, and production-readiness checklist
- [`docs/deployment.md`](docs/deployment.md) — Production deployment, SSL, and Edge Function secrets guide
- [`docs/supabase-migration-guide.md`](docs/supabase-migration-guide.md) — Notes on the Supabase migration
