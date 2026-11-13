# Deploying The Salad

Two things get deployed:

| Piece | Where | How |
|---|---|---|
| The Next.js app | Vercel | import the GitHub repo |
| The API | Supabase Edge Functions | `node scripts/deploy-all-fns.mjs` |
| The database | Supabase Postgres | migrations in `supabase/migrations/` |

The browser app talks to Supabase for data **and** calls the edge functions for
the API. Because those calls are cross-origin, each edge function answers CORS
with an explicit origin — set `ALLOWED_ORIGINS` to the Vercel domain or the
browser will block the responses.

---

## 1. Database

Migrations are applied in filename order. If you are reusing the existing
`supaletta` project, **nothing to do** — `0001`–`0007` are already applied.

For a fresh project, apply them in order. Then decide whether you want the demo
restaurant: `0004_seed_demo_tenant.sql` creates "Jaegar Resto" for development
only. A real restaurant should start empty:

```bash
psql "$DATABASE_URL?sslmode=verify-full&sslrootcert=$SUPABASE_CA_CERT" \
  -f supabase/reset-to-empty.sql
```

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
| `ALLOWED_ORIGINS` | your Vercel origin, e.g. `https://the-salad.vercel.app` | every function |
| `GEMINI_API_KEY` | the Google AI Studio key | `ai-extract-menu`, `ai-generate-image` |
| `GOOGLE_CLIENT_ID` | the OAuth client id of a **Web application** | `google-reviews` |
| `GOOGLE_CLIENT_SECRET` | the matching client secret | `google-reviews` |
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
| `google_oauth_config` | the redirect URI to register | the service role only |
| `google_oauth_tokens` | a restaurant's Google access and refresh tokens | the service role only |
| `google_oauth_states` | single-use sign-in states | the service role only |
| `ai_request_logs` | the shape of each AI call | the service role only |

The last three have **no row level security policy at all**, so no signed-in
user — restaurant owner or staff — can read them with PostgREST and their own
session. A restaurant's refresh token is a credential for their Google
account, and it is not theirs to read.

### What else the dashboard needs

- **Google**: create an OAuth client of type *Web application* and add the
  redirect URI from Super Admin → Settings. The Business Profile APIs are not
  self-service: request access per project, and approval needs a Business
  Profile that has been verified and active for 60+ days.
- **Razorpay**: create two recurring monthly plans and put their plan ids in
  Super Admin → Payments → Plans. Point the webhook at
  `https://<ref>.supabase.co/functions/v1/razorpay-webhook`.

Then:

```bash
node scripts/deploy-all-fns.mjs
# or one at a time
node scripts/deploy-fn.mjs menu
```

## 3. Vercel

Import `iphrnx/Saladcode` and set these environment variables (Production and
Preview):

| Variable | Notes |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | publishable key — safe in the browser |
| `SUPABASE_SERVICE_ROLE_KEY` | **server only**, never `NEXT_PUBLIC_` |
| `NEXT_PUBLIC_SITE_URL` | the deployed origin, used for metadata and OG tags |

`next.config.ts` uses `output: 'standalone'`, which Vercel detects on its own.
No `vercel.json` is needed.

## 4. Supabase Auth URLs

In **Authentication → URL Configuration**:

- **Site URL**: your Vercel origin.
- **Redirect URLs**: add `https://<your-domain>/**` and
  `http://localhost:3000/**` for local development.

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

- [ ] `npm run lint`, `npx tsc --noEmit`, `npm run build` all clean locally
- [ ] `ALLOWED_ORIGINS` set to the real Vercel origin
- [ ] Leaked password protection enabled
- [ ] Auth redirect URLs include the production origin
- [ ] Supabase advisors re-checked (Database → Advisors) with no new warnings
- [ ] the `health` edge function returns 200
- [ ] One end-to-end diner order placed from a real phone
