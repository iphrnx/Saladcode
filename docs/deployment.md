# Deploying The Salad

Two things get deployed:

| Piece | Where | How |
|---|---|---|
| The Next.js app | Cloudflare Workers | `npm run deploy` (`opennextjs-cloudflare build && wrangler deploy`) |
| The API | Supabase Edge Functions | `node scripts/deploy-all-fns.mjs` |
| The database | Supabase Postgres | migrations in `supabase/migrations/` |

The browser app talks to Supabase for data **and** calls the edge functions for
the API. Because those calls are cross-origin, each edge function answers CORS
with an explicit origin — set `ALLOWED_ORIGINS` to the deployed domain or the
browser will block the responses.

---

## 1. Database

Migrations live in `supabase/migrations/` (starting from `20261113000000_baseline_schema.sql`) and are applied in filename order via `supabase db push` or the Supabase SQL editor. For local development seed data, use `supabase/seed.sql` (never run seed fixtures against a production database).

### Database connection security — SSL is enforced

**"Enforce SSL on incoming connections" is enabled** on the Supabase project.
Nothing in this codebase is affected, because no application component opens a
direct Postgres connection:

- The Next.js app, the Edge Functions, the migration tooling and the ops/test
  scripts all reach the database through Supabase's **HTTPS/WSS APIs**
  (PostgREST, GoTrue, Realtime, Management API) — TLS already, independent of
  the toggle.
- There are no PostgreSQL drivers (`pg`, `postgres.js`, ORMs) in the
  dependencies, and no `DATABASE_URL`/connection string is configured for any
  deployed component. Keep it that way.

If a **future** change needs a direct PostgreSQL connection (a worker, a BI
tool, a one-off `psql` run), it must use **verified TLS with the Supabase CA
certificate**:

1. Download the CA certificate: Supabase Dashboard → Project Settings →
   Database → SSL configuration → *Download certificate*.
2. Connect with `sslmode=verify-full` and `sslrootcert` pointing at that file,
   e.g. `postgresql://...:6543/postgres?sslmode=verify-full&sslrootcert=/path/to/supabase-ca.crt`.

`sslmode=disable` and `sslmode=allow` will be refused outright; `require`
encrypts but does not verify the server identity, so it is not accepted for
new work. The CA certificate is a public certificate — do not commit private
keys or the database password alongside it.

## 2. Edge Functions

The functions authenticate themselves (`verify_jwt` is false at the platform
level) because staff sessions and the diner QR flow carry no Supabase JWT.

Set these secrets on the project first:

| Secret | Value | Needed by |
|---|---|---|
| `ALLOWED_ORIGINS` | your deployed origin, e.g. `https://www.thesalad.in` | every function |
| `GEMINI_API_KEY` | the Google AI Studio key | `ai-extract-menu`, `ai-generate-image` |
| `RAZORPAY_KEY_ID` | the Razorpay key id (test mode first) | `subscriptions`, `razorpay-webhook` |
| `RAZORPAY_KEY_SECRET` | the matching key secret | `subscriptions`, `razorpay-webhook` |
| `RAZORPAY_WEBHOOK_SECRET` | optional; falls back to the key secret | `razorpay-webhook` |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected
into every edge function by the platform — do not set them yourself.

### The credentials are secrets, not settings

Every credential above is a **Supabase edge function secret**. None of them is
stored in a table, and none of them is ever sent to the browser.

The Super Admin dashboard has no field for any of them. It can tell you
whether one is configured, which models to use, how the calls have been going
and what has gone wrong — and that is all it can do. Setting a key means
putting it in the secrets list above, not typing it into a page.

What lives in the database instead:

| Table | What it holds | Who can read it |
|---|---|---|
| `ai_provider_settings` | which Gemini models to use | the service role only |
| `ai_request_logs` | the shape of each AI call | the service role only |

### What else the dashboard needs

- **Razorpay**: create two recurring monthly plans and put their plan ids in
  Super Admin → Payments → Plans. Point the webhook at
  `https://<ref>.supabase.co/functions/v1/razorpay-webhook`.

Then:

```bash
node scripts/deploy-all-fns.mjs
# or one at a time
node scripts/deploy-fn.mjs menu
```

`deploy-all-fns.mjs` also deletes the retired `reservations` Edge Function from the target project (`SUPABASE_PROJECT_ID` or `NEXT_PUBLIC_SUPABASE_URL` ref) and treats an already-absent function as a clean no-op so fresh deployments and repeated runs succeed. When deploying functions individually, remove the retired endpoint explicitly (safe to re-run when absent):

```bash
npx supabase functions delete reservations --remote=<ref> --yes || true
```

## 3. Cloudflare Workers

Configure `wrangler.jsonc` and set these environment variables / secrets:

| Variable | Notes |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | publishable key — safe in the browser |
| `SUPABASE_SERVICE_ROLE_KEY` | **server only**, never `NEXT_PUBLIC_` |
| `NEXT_PUBLIC_SITE_URL` | the deployed origin, used for metadata and OG tags |

`open-next.config.ts` uses `npm run build:next` (`output: 'standalone'`) and `wrangler.jsonc` points to `.open-next/worker.js` with `nodejs_compat`. Deploy with `npm run deploy`.

## 4. Supabase Auth URLs

In **Authentication → URL Configuration**:

- **Site URL**: your deployed origin.
- **Redirect URLs**: add `https://<your-domain>/**` and
  `http://localhost:3001/**` for local development.

Also in **Authentication → Providers / Settings**, enable **leaked password
protection** — Supabase's own advisor flags it as off, and it is not reachable
through the API.

## 5. After the first deploy

1. Visit `/` and sign up. The first account creates its own tenant and the five
   default roles.
2. Confirm `https://<ref>.supabase.co/functions/v1/health` returns
   `{"status":"ok","database":"ok"}`.
3. Open one table's QR code and place a test order from a phone, so the diner
   path is exercised in production.

## Post-deploy checklist

- [ ] `npm run lint`, `npm run typecheck`, `npm run build` all clean locally
- [ ] `ALLOWED_ORIGINS` set to the real deployed origin
- [ ] Leaked password protection enabled
- [ ] Auth redirect URLs include the production origin
- [ ] Supabase advisors re-checked (Database → Advisors) with no new warnings
- [ ] Retired `reservations` Edge Function absent from the target Supabase project
- [ ] the `health` edge function returns 200
- [ ] One end-to-end diner order placed from a real phone
