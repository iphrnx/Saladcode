# Architecture & Codebase Map

## Directory Structure

```
Saladcode/
├── docs/                       # Architecture, audit, deployment, and migration docs
├── public/                     # Static assets and marketing screenshots
├── scripts/                    # 127 test, verification, deployment, and ops scripts
├── src/
│   ├── app/                    # Next.js App Router pages, SEO routes, and Super Admin proxy APIs
│   ├── components/
│   │   ├── app/                # Authenticated owner shell (header, sidebar, search, notifications)
│   │   ├── auth/               # Owner login, email confirmation, password reset, magic-link forwarder
│   │   ├── landing/            # Marketing landing page & legal shell
│   │   ├── marketing/          # Feature & comparison page shell
│   │   ├── onboarding/         # Multi-step restaurant onboarding wizard
│   │   ├── public/             # Diner-facing QR menu & live order tracker
│   │   ├── shared/             # Dialogs & drawers (bill, table check, session payment, order detail, image upload)
│   │   ├── staff/              # Staff PIN login & role-scoped staff shell
│   │   ├── superadmin/         # Super Admin shell, charts, sidebar, search
│   │   ├── ui/                 # shadcn/ui & Radix primitives
│   │   └── views/              # Core app views (dashboard, orders, menu, qr, promos, analytics, roles, security, settings)
│   └── lib/                    # Client utilities, permissions, pricing, cart, Supabase clients, hooks
└── supabase/
    ├── functions/              # 27 Deno Edge Functions + _shared/ (40 modules)
    ├── migrations/             # 85 SQL migrations (0001–0085)
    └── reset-to-empty.sql      # Strips demo seed data for clean production starts
```

## Routing Model (`src/app/`)

- **Main App (`src/app/page.tsx`)**: Uses `?view=` query-parameter routing inside a single client shell (`AuthGate` + `PageContent`) for `dashboard`, `onboarding`, `login`, `staff-login`, `staff-dashboard`, `menu` (public QR diner view), `reset-password`, `confirm-email`, and the landing page.
- **Marketing & Legal Pages**:
  - `/features`, `/features/pos-billing`, `/features/qr-ordering`, `/features/kitchen-display`, `/features/gst-billing`, `/features/analytics`
  - `/compare/petpooja-alternative`
  - `/contact`, `/privacy`, `/terms`, `/cookies`
  - `/robots.ts`, `/sitemap.ts`
- **Super Admin Panel (`/superadmin/*`)**:
  - `/superadmin/login`
  - `/superadmin` (overview), `/analytics`, `/audit`, `/conversion`, `/crm`, `/crm/[id]`, `/emails`, `/issues`, `/payments`, `/reports`, `/retention`, `/settings`, `/usage`
- **Next.js API Routes (`src/app/api/`)**:
  - `/api/auth/callback`, `/api/auth/otp`, `/api/auth/verify-otp` (Super Admin & owner auth helpers)
  - `/api/superadmin/[...path]`, `/api/superadmin/logout` (same-origin proxy to `super-admin` Edge Function)

## Supabase Edge Functions (`supabase/functions/`)

27 functions sharing `supabase/functions/_shared/`:

- **Auth & Tenant**: `auth`, `bootstrap`, `onboarding`, `tenants`, `settings`, `security`, `staff`, `roles`
- **Menu & Orders**: `menu`, `categories`, `orders`, `table-session`, `tables`, `qr`, `bill`, `promos`, `reservations`, `reviews`
- **Analytics & AI**: `analytics`, `ai-extract-menu`, `ai-generate-image`
- **Billing & Platform**: `plans`, `subscriptions`, `razorpay-webhook`, `emails`, `super-admin`, `health`

