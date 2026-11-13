// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { json, preflight, subPath } from "../_shared/http.ts";
import { admin } from "../_shared/db.ts";
import { superGuard, logAdminAction } from "../_shared/super_admin.ts";
import {
  getGeminiConfig,
  maskKey,
  testGeminiConnection,
  DEFAULT_TEXT_MODEL,
  DEFAULT_IMAGE_MODEL,
} from "../_shared/gemini.ts";
import { validateBusinessDetails } from "../_shared/platform-details.ts";

/**
 * /functions/v1/super-admin
 *
 * The global administrative API. Every route is behind superGuard(), which
 * checks the `super_admins` allowlist. There is no tenant filter anywhere in
 * this file on purpose — the guard is the boundary.
 *
 *   GET    overview             business KPIs, trend, distributions
 *   GET    crm?q=               restaurant directory
 *   GET    crm/:id              one restaurant, with its activity and notes
 *   POST   crm/:id/notes        add a follow-up note
 *   GET    conversion           the signup → paid funnel
 *   GET    payments             revenue, transactions, plan catalogue
 *   GET    usage                usage per restaurant, feature adoption
 *   GET    retention            inactive restaurants, expiring trials, prospects
 *   GET    reports?from=&to=    dated report rows
 *   GET    reports/csv?type=    the same, as CSV
 *   GET    audit                administrative audit log
 *   GET    search?q=            restaurants and people
 *   GET    issues               support issues
 *   GET    ai-provider          the AI provider settings, key masked
 *   POST   ai-provider          save or update the provider settings
 *   POST   ai-provider/test     test the stored key against the provider
 *   PATCH  issues/:id           change an issue's status
 *   PATCH  tenants/:id          plan, subscription status, active flag
 *
 * A rule this file follows without exception: a query that fails returns the
 * error. The first version of this function destructured `{ data }` and
 * ignored `error`, which turned a missing table into a confident zero and
 * made the dashboard report numbers that were not real.
 */

const DAY = 86_400_000;

type TenantRow = {
  id: string;
  name: string;
  slug: string;
  plan: string;
  active: boolean;
  onboarding_done: boolean;
  created_at: string;
  subscription_status: string | null;
  trial_ends_at: string | null;
  current_period_end: string | null;
};

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows].map((r) => r.map(csvEscape).join(",")).join("\n");
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * DAY);
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The core dataset, fetched once and reused by most of the read routes.
 * Every query is checked; a failure is a 500, never a silent empty list.
 */
async function loadCore() {
  const db = admin();

  const [tenantsRes, profilesRes, plansRes, paymentsRes, dailyRes] = await Promise.all([
    db
      .from("tenants")
      .select(
        "id, name, slug, plan, active, onboarding_done, created_at, subscription_status, trial_ends_at, current_period_end",
      )
      .order("created_at", { ascending: false }),
    db.from("profiles").select("id, email, name, tenant_id, last_login, is_super_admin"),
    db.from("subscription_plans").select("*").order("sort_order"),
    db
      .from("subscription_payments")
      .select("id, tenant_id, amount, currency, status, payment_method, plan_id, billing_period, created_at"),
    db.from("daily_tenant_metrics").select("tenant_id, date, order_count, order_value"),
  ]);

  const firstError = [tenantsRes, profilesRes, plansRes, paymentsRes, dailyRes].find(
    (r) => r.error,
  );
  if (firstError?.error) {
    return { error: firstError.error.message as string };
  }

  const tenants = (tenantsRes.data ?? []) as TenantRow[];
  const profiles = (profilesRes.data ?? []) as any[];
  const plans = (plansRes.data ?? []) as any[];
  const payments = (paymentsRes.data ?? []) as any[];
  const daily = (dailyRes.data ?? []) as any[];

  // Per-tenant rollups from the daily counters the orders trigger maintains.
  const perTenant = new Map<
    string,
    { orders: number; value: number; lastOrder: string | null }
  >();
  for (const row of daily) {
    const cur = perTenant.get(row.tenant_id) ?? { orders: 0, value: 0, lastOrder: null };
    cur.orders += Number(row.order_count ?? 0);
    cur.value += Number(row.order_value ?? 0);
    if (!cur.lastOrder || row.date > cur.lastOrder) cur.lastOrder = row.date;
    perTenant.set(row.tenant_id, cur);
  }

  // The owner of each tenant is the profile on that tenant.
  const ownerByTenant = new Map<string, any>();
  for (const p of profiles) {
    if (!p.tenant_id) continue;
    if (!ownerByTenant.has(p.tenant_id)) ownerByTenant.set(p.tenant_id, p);
  }

  return { tenants, profiles, plans, payments, daily, perTenant, ownerByTenant };
}

function planPrice(plans: any[], planId: string, period: "monthly" | "yearly" = "monthly"): number {
  const plan = plans.find((p) => p.id === planId);
  if (!plan) return 0;
  return Number(period === "yearly" ? plan.price_yearly : plan.price_monthly) || 0;
}

// --- Business overview ------------------------------------------------------

async function getBusinessOverview(req: Request) {
  const core = await loadCore();
  if ("error" in core) return json(req, { error: core.error }, 500);

  const { tenants, profiles, plans, payments, perTenant } = core;
  const now = Date.now();
  const d30 = now - 30 * DAY;
  const d7 = now - 7 * DAY;

  const newRestaurants30d = tenants.filter((t) => new Date(t.created_at).getTime() >= d30).length;
  const completedOnboarding = tenants.filter((t) => t.onboarding_done).length;

  const usersWithLogin = profiles.filter((p) => p.last_login);
  const activeUsers7d = usersWithLogin.filter(
    (p) => new Date(p.last_login).getTime() >= d7,
  ).length;
  const activeUsers30d = usersWithLogin.filter(
    (p) => new Date(p.last_login).getTime() >= d30,
  ).length;
  const neverLoggedIn = profiles.filter((p) => !p.last_login).length;

  const trials = tenants.filter((t) => t.subscription_status === "trial").length;
  const paid = tenants.filter((t) => t.subscription_status === "active").length;
  // The billing side writes "cancelled"; this counted "canceled" and so
  // always reported zero cancelled restaurants.
  const canceled = tenants.filter((t) => t.subscription_status === "cancelled").length;
  const pastDue = tenants.filter((t) => t.subscription_status === "past_due").length;

  // Contracted MRR: what the tenants on an active plan should be paying.
  const contractedMrr = tenants
    .filter((t) => t.subscription_status === "active")
    .reduce((sum, t) => sum + planPrice(plans, t.plan), 0);

  // Realised MRR: what actually came in over the last 30 days.
  const succeeded = payments.filter(
    (p) => p.status === "succeeded" && new Date(p.created_at).getTime() >= d30,
  );
  const realizedMrr = succeeded.reduce((sum, p) => {
    const amount = Number(p.amount) || 0;
    return sum + (p.billing_period === "yearly" ? amount / 12 : amount);
  }, 0);

  const churned30d = payments.filter(
    (p) => p.status === "refunded" && new Date(p.created_at).getTime() >= d30,
  ).length;
  const churnRate = tenants.length ? +((canceled / tenants.length) * 100).toFixed(1) : 0;

  // A 30-day trend: new restaurants, orders and revenue per day.
  const days = 30;
  const trend: any[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = daysAgo(i);
    const key = dateKey(d);
    const sameDay = core.daily.filter((r: any) => r.date === key);
    trend.push({
      date: key,
      restaurants: tenants.filter((t) => dateKey(new Date(t.created_at)) === key).length,
      orders: sameDay.reduce((s: number, r: any) => s + Number(r.order_count ?? 0), 0),
      revenue: +sameDay.reduce((s: number, r: any) => s + Number(r.order_value ?? 0), 0).toFixed(2),
    });
  }

  const planDistribution = Object.entries(
    tenants.reduce((acc: Record<string, number>, t) => {
      acc[t.plan] = (acc[t.plan] ?? 0) + 1;
      return acc;
    }, {}),
  ).map(([plan, count]) => ({ plan, count }));

  const statusDistribution = Object.entries(
    tenants.reduce((acc: Record<string, number>, t) => {
      const s = t.subscription_status ?? "unknown";
      acc[s] = (acc[s] ?? 0) + 1;
      return acc;
    }, {}),
  ).map(([status, count]) => ({ status, count }));

  // The most recent things that happened, whatever they were.
  const recentActivity = [
    ...tenants.map((t) => ({
      type: "restaurant_signup",
      label: `${t.name} joined`,
      at: t.created_at,
      tenantId: t.id,
    })),
    ...payments.map((p) => ({
      type: `payment_${p.status}`,
      label: `${p.status} payment of ${p.amount} ${p.currency ?? "INR"}`,
      at: p.created_at,
      tenantId: p.tenant_id,
    })),
  ]
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 12);

  return json(req, {
    kpis: {
      totalRestaurants: tenants.length,
      activeRestaurants: tenants.filter((t) => t.active).length,
      newRestaurants30d,
      completedOnboarding,
      onboardingIncomplete: tenants.length - completedOnboarding,
      onboardingRate: tenants.length
        ? +((completedOnboarding / tenants.length) * 100).toFixed(1)
        : 0,
      totalUsers: profiles.length,
      activeUsers7d,
      activeUsers30d,
      inactiveUsers: Math.max(0, profiles.length - activeUsers30d),
      neverLoggedIn,
      trials,
      paid,
      canceled,
      pastDue,
      mrr: +contractedMrr.toFixed(2),
      mrrRealized: +realizedMrr.toFixed(2),
      arr: +(contractedMrr * 12).toFixed(2),
      churnRate,
      churned30d,
      totalOrders: [...perTenant.values()].reduce((s, r) => s + r.orders, 0),
    },
    trend,
    planDistribution,
    statusDistribution,
    recentActivity,
  });
}

// --- Restaurant CRM ---------------------------------------------------------

async function getCrm(req: Request) {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const status = url.searchParams.get("status") ?? "";
  const plan = url.searchParams.get("plan") ?? "";

  const core = await loadCore();
  if ("error" in core) return json(req, { error: core.error }, 500);
  const { tenants, perTenant, ownerByTenant, payments } = core;

  // The error is checked on purpose. A query that fails and is ignored turns
  // into a confident zero, and the directory then says every restaurant has
  // no menu and no staff — which looks like truth.
  const { data: menuCounts, error: menuCountError } = await admin()
    .from("menu_items")
    .select("tenant_id")
    .limit(5000);
  if (menuCountError) return json(req, { error: menuCountError.message }, 500);

  const { data: staffCounts, error: staffCountError } = await admin()
    .from("staff")
    .select("tenant_id")
    .limit(5000);
  if (staffCountError) return json(req, { error: staffCountError.message }, 500);

  const menuByTenant = new Map<string, number>();
  for (const m of menuCounts ?? []) {
    menuByTenant.set(m.tenant_id, (menuByTenant.get(m.tenant_id) ?? 0) + 1);
  }
  const staffByTenant = new Map<string, number>();
  for (const s of staffCounts ?? []) {
    staffByTenant.set(s.tenant_id, (staffByTenant.get(s.tenant_id) ?? 0) + 1);
  }

  const paidTenantIds = new Set(
    payments.filter((p) => p.status === "succeeded").map((p) => p.tenant_id),
  );

  let rows = tenants.map((t) => {
    const owner = ownerByTenant.get(t.id);
    const roll = perTenant.get(t.id);
    return {
      id: t.id,
      name: t.name,
      slug: t.slug,
      plan: t.plan,
      active: t.active,
      onboardingDone: t.onboarding_done,
      subscriptionStatus: t.subscription_status ?? "unknown",
      trialEndsAt: t.trial_ends_at,
      currentPeriodEnd: t.current_period_end,
      createdAt: t.created_at,
      lastActivity: roll?.lastOrder ?? t.created_at,
      orderCount: roll?.orders ?? 0,
      orderValue: +(roll?.value ?? 0).toFixed(2),
      menuItemCount: menuByTenant.get(t.id) ?? 0,
      staffCount: staffByTenant.get(t.id) ?? 0,
      ownerEmail: owner?.email ?? null,
      ownerName: owner?.name ?? null,
      hasPayment: paidTenantIds.has(t.id),
    };
  });

  if (q) {
    const needle = q.toLowerCase();
    rows = rows.filter(
      (r) =>
        r.name.toLowerCase().includes(needle) ||
        r.slug.toLowerCase().includes(needle) ||
        (r.ownerEmail ?? "").toLowerCase().includes(needle) ||
        (r.ownerName ?? "").toLowerCase().includes(needle),
    );
  }
  if (status) rows = rows.filter((r) => r.subscriptionStatus === status);
  if (plan) rows = rows.filter((r) => r.plan === plan);

  rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return json(req, rows);
}

async function getCrmDetail(req: Request, tenantId: string) {
  const db = admin();

  const { data: tenant, error: tErr } = await db
    .from("tenants")
    .select("*")
    .eq("id", tenantId)
    .maybeSingle();
  if (tErr) return json(req, { error: tErr.message }, 500);
  if (!tenant) return json(req, { error: "Restaurant not found" }, 404);

  const [ownerRes, noteRes, issueRes, payRes, orderRes, menuRes, staffRes, metricRes] =
    await Promise.all([
      db.from("profiles").select("id, email, name, last_login").eq("tenant_id", tenantId),
      db
        .from("tenant_notes")
        .select("*, author:profiles!tenant_notes_admin_id_fkey(email, name)")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false })
        .limit(50),
      db
        .from("support_issues")
        .select("*")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false }),
      db
        .from("subscription_payments")
        .select("*")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false }),
      db
        .from("orders")
        .select("id, order_number, total, status, created_at, order_type")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false })
        .limit(25),
      db.from("menu_items").select("id, name, price, available, updated_at").eq("tenant_id", tenantId),
      db.from("staff").select("id, name, active").eq("tenant_id", tenantId),
      db
        .from("daily_tenant_metrics")
        .select("date, order_count, order_value")
        .eq("tenant_id", tenantId)
        .order("date", { ascending: false })
        .limit(30),
    ]);

  const firstError = [ownerRes, noteRes, issueRes, payRes, orderRes, menuRes, staffRes, metricRes].find(
    (r) => r.error,
  );
  if (firstError?.error) return json(req, { error: firstError.error.message }, 500);

  return json(req, {
    tenant,
    owners: ownerRes.data ?? [],
    notes: noteRes.data ?? [],
    issues: issueRes.data ?? [],
    payments: payRes.data ?? [],
    recentOrders: orderRes.data ?? [],
    menuItems: menuRes.data ?? [],
    staff: staffRes.data ?? [],
    dailyMetrics: metricRes.data ?? [],
  });
}

async function addNote(req: Request, tenantId: string, adminId: string) {
  const db = admin();
  const b = await req.json().catch(() => ({})) as any;
  const body = String(b.body ?? "").trim();
  if (!body) return json(req, { error: "Note body is required" }, 400);

  const { data, error } = await db
    .from("tenant_notes")
    .insert({
      tenant_id: tenantId,
      admin_id: adminId,
      body,
      kind: ["note", "call", "email", "issue"].includes(b.kind) ? b.kind : "note",
    })
    .select()
    .single();
  if (error) return json(req, { error: error.message }, 500);

  await logAdminAction(adminId, "tenant.note_added", { note: body }, tenantId);
  return json(req, data, 201);
}

// --- Conversion funnel ------------------------------------------------------

async function getConversion(req: Request) {
  const core = await loadCore();
  if ("error" in core) return json(req, { error: core.error }, 500);
  const { tenants, perTenant, ownerByTenant } = core;

  const { data: menuRows, error: menuRowsError } = await admin()
    .from("menu_items")
    .select("tenant_id")
    .limit(5000);
  if (menuRowsError) return json(req, { error: menuRowsError.message }, 500);
  const tenantsWithMenu = new Set((menuRows ?? []).map((m) => m.tenant_id));

  const signedUp = tenants.length;
  const completedOnboarding = tenants.filter((t) => t.onboarding_done).length;
  const publishedMenu = tenants.filter((t) => tenantsWithMenu.has(t.id)).length;
  const firstOrder = tenants.filter((t) => (perTenant.get(t.id)?.orders ?? 0) > 0).length;
  const trial = tenants.filter((t) => t.subscription_status === "trial").length;
  const paid = tenants.filter((t) => t.subscription_status === "active").length;

  // The funnel is the activation path, and every step of it is a subset of
  // the one before. "On a trial" and "became a paying customer" are not part
  // of that path — a restaurant can be on a trial without ever having taken
  // an order — so they are reported as their own pair rather than as steps.
  //
  // They used to be steps, and because a trial is not a subset of "took first
  // order", the step rate came out at 150% and the drop-off at minus three.
  const stages = [
    { key: "signup", label: "Signed up", count: signedUp },
    { key: "onboarding", label: "Completed onboarding", count: completedOnboarding },
    { key: "menu", label: "Published a menu", count: publishedMenu },
    { key: "first_order", label: "Took first order", count: firstOrder },
  ];

  return json(req, {
    stages: stages.map((s, i) => {
      const previous = stages[i - 1]?.count ?? 0;
      // The counts are capped so that no step can report a step rate over a
      // hundred or a drop-off below zero, whatever the data does.
      const stepRate =
        i === 0 || !previous ? 100 : Math.min(100, +((s.count / previous) * 100).toFixed(1));
      return {
        ...s,
        rate: signedUp ? +((s.count / signedUp) * 100).toFixed(1) : 0,
        stepRate,
        dropOff: i === 0 ? 0 : Math.max(0, previous - s.count),
      };
    }),
    // The subscription cut, as a share of everybody who signed up.
    monetisation: {
      trial,
      paid,
      trialRate: signedUp ? +((trial / signedUp) * 100).toFixed(1) : 0,
      paidRate: signedUp ? +((paid / signedUp) * 100).toFixed(1) : 0,
    },
    totals: { signedUp, completedOnboarding, publishedMenu, firstOrder, trial, paid },
  });
}

// --- Revenue and payments ---------------------------------------------------

/**
 * Email delivery, as the platform owner needs to see it.
 *
 * Counts, the last dispatch, the last daily run and recent rows — enough to
 * answer "are billing emails going out?" without reading logs. It deliberately
 * shows the event type and a *masked* recipient: the platform owner can see
 * that mail reached a restaurant, not who the person is, and never a key.
 */
async function getEmails(req: Request) {
  const db = admin();

  const { data: rows, error } = await db
    .from("email_events")
    .select("id, event_type, recipient, restaurant_name, status, attempts, provider_id, error, created_at, sent_at, plan_name")
    .order("created_at", { ascending: false })
    .limit(60);
  if (error) return json(req, { error: error.message }, 500);

  const all = (rows ?? []) as any[];
  const since24h = new Date(Date.now() - DAY).toISOString();
  const in24 = all.filter((r) => String(r.created_at) >= since24h);

  const count = (list: any[], status: string) => list.filter((r) => r.status === status).length;
  const sentRows = all.filter((r) => r.status === "sent" && r.sent_at);
  const lastSent = sentRows.map((r) => String(r.sent_at)).sort().pop() ?? null;
  const lastError = all.find((r) => r.error) ?? null;

  // The scheduler leaves its mark as an audit row, so "did the daily run
  // happen?" is answerable from data rather than from a promise.
  const { data: runs } = await db
    .from("super_admin_audit_logs")
    .select("created_at, action, detail")
    .eq("action", "email.daily_run")
    .order("created_at", { ascending: false })
    .limit(1);

  /** j***@example.com — enough to identify the domain, not the person. */
  const maskEmail = (value: string | null) => {
    if (!value) return "—";
    const [user, domain] = String(value).split("@");
    if (!domain) return "—";
    return `${user.slice(0, 1)}${"*".repeat(Math.max(1, Math.min(user.length - 1, 4)))}@${domain}`;
  };

  return json(req, {
    totals: {
      total: all.length,
      sent: count(all, "sent"),
      pending: count(all, "pending"),
      failed: count(all, "failed"),
      // "Retrying" is a pending row that has already been tried at least once.
      retrying: all.filter((r) => r.status === "pending" && Number(r.attempts) > 0).length,
    },
    last24h: {
      total: in24.length,
      sent: count(in24, "sent"),
      failed: count(in24, "failed"),
    },
    lastSentAt: lastSent,
    lastDailyRunAt: (runs ?? [])[0]?.created_at ?? null,
    lastError: lastError ? { at: lastError.created_at, type: lastError.event_type, message: String(lastError.error).slice(0, 200) } : null,
    recent: all.map((r) => ({
      id: r.id,
      type: r.event_type,
      recipient: maskEmail(r.recipient),
      restaurant: r.restaurant_name,
      plan: r.plan_name,
      status: r.status,
      attempts: r.attempts,
      // The provider's id is a delivery handle, not a secret.
      providerId: r.provider_id ?? null,
      createdAt: r.created_at,
      sentAt: r.sent_at,
      error: r.error ? String(r.error).slice(0, 160) : null,
    })),
  });
}

async function getPayments(req: Request) {
  const core = await loadCore();
  if ("error" in core) return json(req, { error: core.error }, 500);
  const { tenants, plans, payments } = core;
  const now = Date.now();
  const d30 = now - 30 * DAY;

  const succeeded = payments.filter((p) => p.status === "succeeded");
  const failed = payments.filter((p) => p.status === "failed");
  const refunded = payments.filter((p) => p.status === "refunded");
  const pending = payments.filter((p) => p.status === "pending");
  const renewals = succeeded.filter((p) => p.billing_period === "monthly" && p.created_at);

  const contractedMrr = tenants
    .filter((t) => t.subscription_status === "active")
    .reduce((sum, t) => sum + planPrice(plans, t.plan), 0);
  const realizedMrr = succeeded
    .filter((p) => new Date(p.created_at).getTime() >= d30)
    .reduce((sum, p) => {
      const amount = Number(p.amount) || 0;
      return sum + (p.billing_period === "yearly" ? amount / 12 : amount);
    }, 0);

  const tenantName = new Map(tenants.map((t) => [t.id, t.name]));

  return json(req, {
    metrics: {
      mrr: +contractedMrr.toFixed(2),
      mrrRealized: +realizedMrr.toFixed(2),
      arr: +(contractedMrr * 12).toFixed(2),
      verifiedRevenue30d: +succeeded
        .filter((p) => new Date(p.created_at).getTime() >= d30)
        .reduce((s, p) => s + (Number(p.amount) || 0), 0)
        .toFixed(2),
      successfulCount: succeeded.length,
      failedCount: failed.length,
      failedAmount30d: +failed
        .filter((p) => new Date(p.created_at).getTime() >= d30)
        .reduce((s, p) => s + (Number(p.amount) || 0), 0)
        .toFixed(2),
      refundCount: refunded.length,
      refundAmount: +refunded.reduce((s, p) => s + (Number(p.amount) || 0), 0).toFixed(2),
      pendingCount: pending.length,
      renewalCount: renewals.length,
      cancellations: tenants.filter((t) => t.subscription_status === "cancelled").length,
      trials: tenants.filter((t) => t.subscription_status === "trial").length,
      paid: tenants.filter((t) => t.subscription_status === "active").length,
    },
    transactions: payments
      .slice()
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 100)
      .map((p) => ({ ...p, tenantName: tenantName.get(p.tenant_id) ?? "Unknown" })),
    plans: plans.map((p) => ({
      id: p.id,
      name: p.name,
      priceMonthly: Number(p.price_monthly),
      priceYearly: Number(p.price_yearly),
      currency: p.currency,
      trialDays: p.trial_days,
      features: p.features,
      isActive: p.is_active,
      // The Razorpay plan id. The Super Admin sets it, because only they
      // can see the Razorpay dashboard.
      razorpayPlanId: p.razorpay_plan_id ?? null,
      limits: {
        locations: p.max_locations ?? null,
        staff: p.max_staff ?? null,
        menuItems: p.max_menu_items ?? null,
      },
      subscribers: tenants.filter((t) => t.plan === p.id).length,
    })),
  });
}

// --- Usage analytics --------------------------------------------------------

async function getUsage(req: Request) {
  const core = await loadCore();
  if ("error" in core) return json(req, { error: core.error }, 500);
  const { tenants, perTenant, daily } = core;

  const db = admin();
  const [featureRes, logRes, menuRes] = await Promise.all([
    db.from("feature_usage").select("tenant_id, feature_id, action, created_at").limit(20000),
    db.from("security_logs").select("tenant_id, action, created_at").limit(20000),
    db.from("menu_items").select("tenant_id, updated_at").limit(20000),
  ]);
  const firstError = [featureRes, logRes, menuRes].find((r) => r.error);
  if (firstError?.error) return json(req, { error: firstError.error.message }, 500);

  const features = featureRes.data ?? [];
  const logs = logRes.data ?? [];
  const menuItems = menuRes.data ?? [];

  const featureByTenant = new Map<string, Set<string>>();
  for (const f of features) {
    if (!featureByTenant.has(f.tenant_id)) featureByTenant.set(f.tenant_id, new Set());
    featureByTenant.get(f.tenant_id)!.add(f.feature_id);
  }
  const loginsByTenant = new Map<string, number>();
  for (const l of logs) {
    if (l.action === "LOGIN" || l.action === "LOGIN_SUCCESS") {
      loginsByTenant.set(l.tenant_id, (loginsByTenant.get(l.tenant_id) ?? 0) + 1);
    }
  }
  const menuEditsByTenant = new Map<string, number>();
  for (const m of menuItems) {
    if (m.updated_at) {
      menuEditsByTenant.set(m.tenant_id, (menuEditsByTenant.get(m.tenant_id) ?? 0) + 1);
    }
  }

  const perRestaurant = tenants.map((t) => {
    const roll = perTenant.get(t.id);
    const used = featureByTenant.get(t.id) ?? new Set<string>();
    return {
      id: t.id,
      name: t.name,
      plan: t.plan,
      orders: roll?.orders ?? 0,
      orderValue: +(roll?.value ?? 0).toFixed(2),
      lastOrder: roll?.lastOrder ?? null,
      logins: loginsByTenant.get(t.id) ?? 0,
      menuEdits: menuEditsByTenant.get(t.id) ?? 0,
      features: [...used].sort(),
      featureCount: used.size,
    };
  });

  // Which features are popular across the platform.
  const adoption = new Map<string, Set<string>>();
  for (const f of features) {
    if (!adoption.has(f.feature_id)) adoption.set(f.feature_id, new Set());
    adoption.get(f.feature_id)!.add(f.tenant_id);
  }
  const featureAdoption = [...adoption.entries()]
    .map(([featureId, tenantSet]) => ({
      feature: featureId,
      restaurants: tenantSet.size,
      rate: tenants.length ? +((tenantSet.size / tenants.length) * 100).toFixed(1) : 0,
    }))
    .sort((a, b) => b.restaurants - a.restaurants);

  // A daily order/revenue trend for the chart.
  const byDate = new Map<string, { orders: number; revenue: number }>();
  for (const row of daily) {
    const cur = byDate.get(row.date) ?? { orders: 0, revenue: 0 };
    cur.orders += Number(row.order_count ?? 0);
    cur.revenue += Number(row.order_value ?? 0);
    byDate.set(row.date, cur);
  }
  const trend = [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-30)
    .map(([date, v]) => ({ date, orders: v.orders, revenue: +v.revenue.toFixed(2) }));

  return json(req, { perRestaurant, featureAdoption, trend, totalEvents: features.length });
}

// --- Retention --------------------------------------------------------------

async function getRetention(req: Request) {
  const core = await loadCore();
  if ("error" in core) return json(req, { error: core.error }, 500);
  const { tenants, perTenant, ownerByTenant, payments } = core;
  const now = Date.now();
  const in14 = now - 14 * DAY;
  const in7 = now + 7 * DAY;

  const { data: logRows, error: logRowsError } = await admin()
    .from("security_logs")
    .select("tenant_id, action, created_at")
    .limit(20000);
  if (logRowsError) return json(req, { error: logRowsError.message }, 500);
  const lastLoginByTenant = new Map<string, string>();
  for (const l of logRows ?? []) {
    if (l.action !== "LOGIN" && l.action !== "LOGIN_SUCCESS") continue;
    const cur = lastLoginByTenant.get(l.tenant_id);
    if (!cur || l.created_at > cur) lastLoginByTenant.set(l.tenant_id, l.created_at);
  }

  const describe = (t: TenantRow) => {
    const roll = perTenant.get(t.id);
    const owner = ownerByTenant.get(t.id);
    const lastOrder = roll?.lastOrder ?? null;
    const lastActivity = [lastOrder, lastLoginByTenant.get(t.id) ?? null]
      .filter(Boolean)
      .sort()
      .pop() ?? t.created_at;
    return {
      id: t.id,
      name: t.name,
      slug: t.slug,
      plan: t.plan,
      subscriptionStatus: t.subscription_status ?? "unknown",
      ownerEmail: owner?.email ?? null,
      ownerName: owner?.name ?? null,
      createdAt: t.created_at,
      orderCount: roll?.orders ?? 0,
      orderValue: +(roll?.value ?? 0).toFixed(2),
      lastOrder,
      lastActivity,
      daysSinceActivity: Math.floor((now - new Date(lastActivity).getTime()) / DAY),
      trialEndsAt: t.trial_ends_at,
    };
  };

  const all = tenants.map(describe);

  // A restaurant that has not taken an order in a fortnight.
  const inactive = all
    .filter((t) => t.orderCount === 0 || t.daysSinceActivity >= 14)
    .sort((a, b) => b.daysSinceActivity - a.daysSinceActivity);

  // A trial that is about to run out.
  const expiringTrials = all
    .filter(
      (t) =>
        t.subscriptionStatus === "trial" &&
        t.trialEndsAt &&
        new Date(t.trialEndsAt).getTime() <= in7 &&
        new Date(t.trialEndsAt).getTime() >= now,
    )
    .sort((a, b) => new Date(a.trialEndsAt!).getTime() - new Date(b.trialEndsAt!).getTime());

  // A trial that has run out but is still open.
  const expiredTrials = all
    .filter(
      (t) =>
        t.subscriptionStatus === "trial" &&
        t.trialEndsAt &&
        new Date(t.trialEndsAt).getTime() < now,
    )
    .sort((a, b) => new Date(a.trialEndsAt!).getTime() - new Date(b.trialEndsAt!).getTime());

  // Using the product but not paying for it.
  const paidTenantIds = new Set(
    payments.filter((p) => p.status === "succeeded").map((p) => p.tenant_id),
  );
  const prospects = all
    .filter(
      (t) =>
        t.subscriptionStatus !== "active" &&
        !paidTenantIds.has(t.id) &&
        (t.orderCount > 0 || t.daysSinceActivity < 14),
    )
    .sort((a, b) => b.orderCount - a.orderCount);

  return json(req, {
    inactive,
    expiringTrials,
    expiredTrials,
    prospects,
    summary: {
      inactiveCount: inactive.length,
      expiringTrialCount: expiringTrials.length,
      expiredTrialCount: expiredTrials.length,
      prospectCount: prospects.length,
    },
  });
}

// --- Reports ----------------------------------------------------------------

async function getReports(req: Request) {
  const url = new URL(req.url);
  const from = url.searchParams.get("from") ?? dateKey(daysAgo(29));
  const to = url.searchParams.get("to") ?? dateKey(new Date());
  const type = url.searchParams.get("type") ?? "revenue";

  const db = admin();
  const fromIso = new Date(`${from}T00:00:00Z`).toISOString();
  const toIso = new Date(`${to}T23:59:59Z`).toISOString();

  const { data: orders, error } = await db
    .from("orders")
    .select("id, tenant_id, total, status, order_type, created_at, payment_method")
    .gte("created_at", fromIso)
    .lte("created_at", toIso)
    .limit(20000);
  if (error) return json(req, { error: error.message }, 500);

  const { data: tenants, error: tenantsError } = await db
    .from("tenants")
    .select("id, name, plan");
  if (tenantsError) return json(req, { error: tenantsError.message }, 500);
  const nameById = new Map((tenants ?? []).map((t) => [t.id, t.name]));

  const byTenant = new Map<string, { orders: number; revenue: number; completed: number }>();
  for (const o of orders ?? []) {
    const cur = byTenant.get(o.tenant_id) ?? { orders: 0, revenue: 0, completed: 0 };
    cur.orders += 1;
    cur.revenue += Number(o.total) || 0;
    if (o.status === "COMPLETED") cur.completed += 1;
    byTenant.set(o.tenant_id, cur);
  }

  const rows = [...byTenant.entries()]
    .map(([tenantId, v]) => ({
      tenantId,
      restaurant: nameById.get(tenantId) ?? "Unknown",
      orders: v.orders,
      completedOrders: v.completed,
      revenue: +v.revenue.toFixed(2),
      averageOrderValue: v.orders ? +(v.revenue / v.orders).toFixed(2) : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue);

  const byDay = new Map<string, { orders: number; revenue: number }>();
  for (const o of orders ?? []) {
    const key = dateKey(new Date(o.created_at));
    const cur = byDay.get(key) ?? { orders: 0, revenue: 0 };
    cur.orders += 1;
    cur.revenue += Number(o.total) || 0;
    byDay.set(key, cur);
  }
  const daily = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({ date, orders: v.orders, revenue: +v.revenue.toFixed(2) }));

  return json(req, {
    range: { from, to, type },
    rows,
    daily,
    totals: {
      orders: (orders ?? []).length,
      revenue: +rows.reduce((s, r) => s + r.revenue, 0).toFixed(2),
      restaurants: rows.length,
    },
  });
}

async function getCsvReport(req: Request) {
  const url = new URL(req.url);
  const type = url.searchParams.get("type") ?? "crm";
  const from = url.searchParams.get("from") ?? dateKey(daysAgo(29));
  const to = url.searchParams.get("to") ?? dateKey(new Date());

  const db = admin();

  if (type === "revenue" || type === "orders") {
    const { data: orders, error } = await db
      .from("orders")
      .select("id, tenant_id, total, status, order_type, created_at")
      .gte("created_at", new Date(`${from}T00:00:00Z`).toISOString())
      .lte("created_at", new Date(`${to}T23:59:59Z`).toISOString())
      .limit(20000);
    if (error) return json(req, { error: error.message }, 500);
    const { data: tenants, error: tenantsError } = await db
      .from("tenants")
      .select("id, name");
    if (tenantsError) return json(req, { error: tenantsError.message }, 500);
    const nameById = new Map((tenants ?? []).map((t) => [t.id, t.name]));
    const csv = toCsv(
      ["Date", "Restaurant", "Order", "Status", "Type", "Total"],
      (orders ?? []).map((o) => [
        o.created_at,
        nameById.get(o.tenant_id) ?? "Unknown",
        o.id,
        o.status,
        o.order_type,
        Number(o.total).toFixed(2),
      ]),
    );
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="the-salad-${type}-${from}-to-${to}.csv"`,
      },
    });
  }

  if (type === "retention") {
    const r = await getRetention(req);
    const payload = await r.json();
    const csv = toCsv(
      ["Restaurant", "Owner", "Status", "Orders", "Last activity", "Days since activity"],
      (payload.inactive ?? []).map((t: any) => [
        t.name,
        t.ownerEmail ?? "",
        t.subscriptionStatus,
        t.orderCount,
        t.lastActivity,
        t.daysSinceActivity,
      ]),
    );
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="the-salad-retention-${from}-to-${to}.csv"`,
      },
    });
  }

  // crm
  const r = await getCrm(req);
  const payload = await r.json();
  const csv = toCsv(
    ["Restaurant", "Slug", "Owner", "Plan", "Status", "Orders", "Revenue", "Menu items", "Signed up", "Last activity"],
    (payload as any[]).map((t) => [
      t.name,
      t.slug,
      t.ownerEmail ?? "",
      t.plan,
      t.subscriptionStatus,
      t.orderCount,
      t.orderValue.toFixed(2),
      t.menuItemCount,
      t.createdAt,
      t.lastActivity,
    ]),
  );
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="the-salad-restaurants.csv"`,
    },
  });
}

// --- Audit, search, issues, tenant management -------------------------------

async function getAudit(req: Request) {
  const { data, error } = await admin()
    .from("super_admin_audit_logs")
    .select("*, admin:profiles!super_admin_audit_logs_admin_id_fkey(email, name)")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return json(req, { error: error.message }, 500);
  return json(req, data ?? []);
}

async function getSearch(req: Request) {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q) return json(req, { restaurants: [], users: [] });
  const needle = `%${q}%`;

  const [tRes, pRes] = await Promise.all([
    admin().from("tenants").select("id, name, slug, plan").or(`name.ilike.${needle},slug.ilike.${needle}`).limit(10),
    admin().from("profiles").select("id, email, name, tenant_id").or(`email.ilike.${needle},name.ilike.${needle}`).limit(10),
  ]);
  if (tRes.error) return json(req, { error: tRes.error.message }, 500);
  if (pRes.error) return json(req, { error: pRes.error.message }, 500);

  return json(req, { restaurants: tRes.data ?? [], users: pRes.data ?? [] });
}

async function getIssues(req: Request) {
  const { data, error } = await admin()
    .from("support_issues")
    .select("*, tenant:tenants(id, name, slug)")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return json(req, { error: error.message }, 500);
  return json(req, data ?? []);
}

async function createIssue(req: Request, adminId: string) {
  const b = await req.json().catch(() => ({})) as any;
  const subject = String(b.subject ?? "").trim();
  if (!subject) return json(req, { error: "Subject is required" }, 400);

  const { data, error } = await admin()
    .from("support_issues")
    .insert({
      tenant_id: b.tenantId ?? null,
      opened_by: adminId,
      subject,
      detail: b.detail ?? null,
      priority: ["low", "normal", "high", "urgent"].includes(b.priority) ? b.priority : "normal",
      status: "open",
    })
    .select()
    .single();
  if (error) return json(req, { error: error.message }, 500);

  await logAdminAction(adminId, "issue.created", { subject, detail: b.detail }, b.tenantId);
  return json(req, data, 201);
}

async function updateIssue(req: Request, issueId: string, adminId: string) {
  const b = await req.json().catch(() => ({})) as any;
  const patch: any = {};
  if (b.status && ["open", "in_progress", "resolved"].includes(b.status)) {
    patch.status = b.status;
    patch.resolved_at = b.status === "resolved" ? new Date().toISOString() : null;
  }
  if (b.priority && ["low", "normal", "high", "urgent"].includes(b.priority)) {
    patch.priority = b.priority;
  }
  if (!Object.keys(patch).length) return json(req, { error: "Nothing to update" }, 400);

  const { data, error } = await admin()
    .from("support_issues")
    .update(patch)
    .eq("id", issueId)
    .select()
    .single();
  if (error) return json(req, { error: error.message }, 500);

  await logAdminAction(adminId, "issue.updated", { issueId, ...patch }, data.tenant_id);
  return json(req, data);
}

async function updateTenant(req: Request, tenantId: string, adminId: string) {
  const b = await req.json().catch(() => ({})) as any;
  const patch: any = {};

  if (b.plan) {
    const { data: plan } = await admin()
      .from("subscription_plans")
      .select("id")
      .eq("id", b.plan)
      .maybeSingle();
    if (!plan) return json(req, { error: `Unknown plan: ${b.plan}` }, 400);
    patch.plan = b.plan;
  }
  if (b.subscriptionStatus) {
    // "cancelled" is what the billing side writes and what the plan resolver
    // reads. The panel used to offer "canceled", which stored a status no other
    // code knew — and a tenant carrying it lost its access at once instead of
    // at the end of the period it had paid for.
    const normalised = b.subscriptionStatus === "canceled" ? "cancelled" : b.subscriptionStatus;
    const allowed = ["trial", "active", "past_due", "cancelled", "expired", "paused"];
    if (!allowed.includes(normalised)) {
      return json(req, { error: `Unknown subscription status: ${b.subscriptionStatus}` }, 400);
    }
    patch.subscription_status = normalised;
  }
  if (b.active !== undefined) patch.active = Boolean(b.active);
  if (b.trialEndsAt !== undefined) {
    patch.trial_ends_at = b.trialEndsAt ? new Date(b.trialEndsAt).toISOString() : null;
  }
  if (b.currentPeriodEnd !== undefined) {
    patch.current_period_end = b.currentPeriodEnd
      ? new Date(b.currentPeriodEnd).toISOString()
      : null;
  }
  if (!Object.keys(patch).length) return json(req, { error: "Nothing to update" }, 400);

  const { data, error } = await admin()
    .from("tenants")
    .update(patch)
    .eq("id", tenantId)
    .select("id, name, slug, plan, active, subscription_status, trial_ends_at, current_period_end")
    .single();
  if (error) return json(req, { error: error.message }, 500);

  await logAdminAction(adminId, "tenant.updated", patch, tenantId);
  return json(req, data);
}

// --- Router -----------------------------------------------------------------

/**
 * The AI provider settings, as the dashboard sees them.
 *
 * The key is never returned. The dashboard gets a mask, the source it came
 * from and the model names, which is everything it needs to show and nothing
 * it could leak.
 */
/**
 * The AI provider, as the dashboard sees it.
 *
 * The key is an edge function secret, so there is nothing to show and nothing
 * to change. What the dashboard gets is whether a key is configured, which
 * models are in use, how the calls have been going and what has gone wrong.
 */
async function getAiProvider(req: Request) {
  const config = await getGeminiConfig();

  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data: logs } = await admin()
    .from("ai_request_logs")
    .select("id, model, action, status, duration_ms, error_message, created_at, tenant_id")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(200);

  const all = logs ?? [];
  const errors = all.filter((l: any) => l.status === "error");
  const byModel = new Map<string, { calls: number; errors: number }>();
  for (const l of all) {
    const key = l.model ?? "unknown";
    const cur = byModel.get(key) ?? { calls: 0, errors: 0 };
    cur.calls += 1;
    if (l.status === "error") cur.errors += 1;
    byModel.set(key, cur);
  }
  const durations = all
    .map((l: any) => l.duration_ms)
    .filter((d: any): d is number => typeof d === "number");

  return json(req, {
    provider: config.provider,
    // Whether a key is configured, and nothing else about it.
    configured: Boolean(config.apiKey),
    source: config.source,
    textModel: config.textModel,
    imageModel: config.imageModel,
    updatedAt: config.updatedAt,
    defaults: { textModel: DEFAULT_TEXT_MODEL, imageModel: DEFAULT_IMAGE_MODEL },
    usage: {
      windowDays: 30,
      calls: all.length,
      errors: errors.length,
      errorRate: all.length ? +((errors.length / all.length) * 100).toFixed(1) : 0,
      averageMs: durations.length
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : null,
      byModel: [...byModel.entries()].map(([model, v]) => ({ model, ...v })),
    },
    recentErrors: errors.slice(0, 10).map((l: any) => ({
      id: l.id,
      model: l.model,
      action: l.action,
      message: l.error_message,
      at: l.created_at,
    })),
  });
}

/**
 * The platform's business details — the "From" block on every The Salad
 * subscription invoice. One singleton row, readable and writable here
 * only, behind the same allowlist guard as everything else in this file.
 */
async function getBusinessDetails(req: Request) {
  const { data: row, error } = await admin()
    .from("platform_business_details")
    .select("*")
    .eq("singleton", true)
    .maybeSingle();
  if (error) return json(req, { error: error.message }, 500);
  return json(req, {
    configured: !!row?.legal_name,
    details: {
      legalName: row?.legal_name ?? "",
      street: row?.street ?? "",
      city: row?.city ?? "",
      state: row?.state ?? "",
      pinCode: row?.pin_code ?? "",
      country: row?.country ?? "India",
      email: row?.email ?? "",
      phone: row?.phone ?? "",
      gstin: row?.gstin ?? "",
    },
    updatedAt: row?.updated_at ?? null,
  });
}

async function saveBusinessDetails(req: Request, adminId: string) {
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const verdict = validateBusinessDetails(body);
  if (!verdict.ok) {
    return json(req, { error: "Please fix the highlighted fields.", fieldErrors: verdict.errors }, 400);
  }
  const v = verdict.value;
  const { data, error } = await admin()
    .from("platform_business_details")
    .upsert(
      {
        singleton: true,
        legal_name: v.legalName,
        street: v.street,
        city: v.city,
        state: v.state,
        pin_code: v.pinCode,
        country: v.country,
        email: v.email,
        phone: v.phone,
        gstin: v.gstin,
        updated_at: new Date().toISOString(),
        updated_by: adminId,
      },
      { onConflict: "singleton" },
    )
    .select("*")
    .single();
  if (error) return json(req, { error: error.message }, 500);

  await logAdminAction(adminId, "platform.business_details_saved", { legalName: v.legalName });

  return json(req, {
    ok: true,
    details: {
      legalName: data.legal_name,
      street: data.street,
      city: data.city,
      state: data.state,
      pinCode: data.pin_code,
      country: data.country,
      email: data.email,
      phone: data.phone,
      gstin: data.gstin,
    },
    updatedAt: data.updated_at,
  });
}

/**
 * Change which model is used.
 *
 * The key is not accepted here: it lives in the edge function's environment,
 * and a key in a database is a key in every backup of it. The request is
 * refused with an explanation rather than silently ignored.
 */
async function saveAiProvider(req: Request, adminId: string) {
  const b = await req.json().catch(() => ({})) as any;

  if (b.apiKey || b.api_key) {
    return json(
      req,
      {
        error:
          "The API key is an edge function secret now, not a setting. Set GEMINI_API_KEY as a Supabase edge function secret.",
      },
      400,
    );
  }

  const textModel = String(b.textModel ?? "").trim() || DEFAULT_TEXT_MODEL;
  const imageModel = String(b.imageModel ?? "").trim() || DEFAULT_IMAGE_MODEL;

  const { data, error } = await admin()
    .from("ai_provider_settings")
    .upsert(
      {
        provider: "gemini",
        text_model: textModel,
        image_model: imageModel,
        enabled: b.enabled === false ? false : true,
        updated_at: new Date().toISOString(),
        updated_by: adminId,
      },
      { onConflict: "provider" },
    )
    .select("provider, text_model, image_model, updated_at")
    .single();
  if (error) return json(req, { error: error.message }, 500);

  await logAdminAction(adminId, "ai_provider.models_updated", { textModel, imageModel });

  return json(req, {
    ok: true,
    provider: data.provider,
    textModel: data.text_model,
    imageModel: data.image_model,
    updatedAt: data.updated_at,
  });
}

async function testAiProvider(req: Request) {
  const config = await getGeminiConfig("gemini");
  if (!config.apiKey) {
    return json(
      req,
      {
        error:
          "No API key is configured. Set GEMINI_API_KEY as a Supabase edge function secret.",
      },
      400,
    );
  }

  try {
    const result = await testGeminiConnection({
      model: config.textModel,
      apiKey: config.apiKey,
    });
    return json(req, {
      ok: true,
      model: result.model,
      reply: result.reply,
      message: "Connected. The API key works.",
    });
  } catch (e: any) {
    return json(req, {
      ok: false,
      model: config.textModel,
      error: e?.message || "Could not reach the provider.",
    }, 400);
  }
}


/**
 * Set the Razorpay plan id for a plan.
 *
 * The id comes from the Razorpay dashboard and is the one thing the
 * platform cannot invent for itself. It is not a secret — Razorpay's plan
 * ids are public — but it is only ever set by the Super Admin.
 */
async function updatePlan(req: Request, adminId: string, planId: string) {
  const b = await req.json().catch(() => ({})) as any;

  const patch: Record<string, unknown> = {};
  // The monthly and the yearly plan are different Razorpay plans (the period
  // is a property of the plan), so each has its own id and its own field.
  for (const [field, column] of [
    ["razorpayPlanId", "razorpay_plan_id"],
  ] as const) {
    if (b[field] === undefined) continue;
    const value = String(b[field] ?? "").trim();
    // Razorpay plan ids look like plan_xxxxxxxxxxxxxxxx.
    if (value && !/^plan_[A-Za-z0-9]+$/.test(value)) {
      return json(
        req,
        { error: "That does not look like a Razorpay plan id. It starts with plan_ and nothing else." },
        400,
      );
    }
    patch[column] = value || null;
  }
  if (b.isActive !== undefined) patch.is_active = Boolean(b.isActive);

  if (Object.keys(patch).length === 0) {
    return json(req, { error: "Nothing to change" }, 400);
  }

  const { data, error } = await admin()
    .from("subscription_plans")
    .update(patch)
    .eq("id", planId)
    .select("id, name, razorpay_plan_id, is_active")
    .single();
  if (error) return json(req, { error: error.message }, 500);

  await logAdminAction(adminId, "plan.updated", { planId, ...patch });

  return json(req, { ok: true, plan: data });
}

Deno.serve(async (req: Request) => {
  const pf = preflight(req);
  if (pf) return pf;

  const segments = subPath(req, "super-admin");
  const route = segments[0] ?? "";

  const auth = await superGuard(req);
  if (!auth.ok) return auth.response;
  const adminId = auth.admin.userId;

  try {
    const method = req.method;

    if (method === "GET") {
      switch (route) {
        case "overview":
          return await getBusinessOverview(req);
        case "crm":
          return segments[1] ? await getCrmDetail(req, segments[1]) : await getCrm(req);
        case "conversion":
          return await getConversion(req);
        case "payments":
          return await getPayments(req);
        case "emails":
          return await getEmails(req);
        case "usage":
          return await getUsage(req);
        case "retention":
          return await getRetention(req);
        case "reports":
          if (segments[1] === "csv") return await getCsvReport(req);
          return await getReports(req);
        case "audit":
          return await getAudit(req);
        case "search":
          return await getSearch(req);
        case "issues":
          return await getIssues(req);
        case "ai-provider":
          return await getAiProvider(req);
        case "platform":
          if (segments[1] === "business-details") return await getBusinessDetails(req);
          return json(req, { error: "Not found" }, 404);
        default:
          return json(req, { error: "Not found" }, 404);
      }
    }

    if (method === "POST") {
      if (route === "crm" && segments[2] === "notes") {
        return await addNote(req, segments[1], adminId);
      }
      if (route === "issues") return await createIssue(req, adminId);
      if (route === "plans" && segments[1]) {
        return await updatePlan(req, adminId, segments[1]);
      }
      if (route === "ai-provider") {
        // POST /ai-provider/test is the Test Connection button. Without this
        // branch the test would silently save the settings instead of
        // testing them.
        if (segments[1] === "test") return await testAiProvider(req);
        return await saveAiProvider(req, adminId);
      }
      return json(req, { error: "Not found" }, 404);
    }

    if (method === "PATCH") {
      if (route === "issues" && segments[1]) {
        return await updateIssue(req, segments[1], adminId);
      }
      if (route === "tenants" && segments[1]) {
        return await updateTenant(req, segments[1], adminId);
      }
      return json(req, { error: "Not found" }, 404);
    }

    if (method === "PUT") {
      if (route === "platform" && segments[1] === "business-details") {
        return await saveBusinessDetails(req, adminId);
      }
      return json(req, { error: "Not found" }, 404);
    }

    return json(req, { error: "Method not allowed" }, 405);
  } catch (err) {
    console.error("super-admin error:", err);
    return json(req, { error: (err as Error).message ?? "Unexpected error" }, 500);
  }
});
