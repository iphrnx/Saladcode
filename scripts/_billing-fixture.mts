/**
 * The billing fixture backend — the local "staging" the billing pages are
 * tested against.
 *
 *   npx tsx scripts/_billing-fixture.mts        # http://127.0.0.1:8791
 *   GET /__fixture/state?name=trial             # switch scenario
 *
 * It serves the same routes the real edge functions serve, in the same
 * shapes, and it derives the answers with the PRODUCTION rules imported from
 * `_shared/billing-manage.ts` — `buildRenewal`, `buildUpcoming`,
 * `summariseTotals`, `directoryFrom`. So the page under test is not reacting
 * to hand-written strings: it is reacting to what the server would really
 * decide for each state. What it does NOT do is talk to Razorpay or Postgres;
 * the mandate states below are the values a live fetch would have returned.
 *
 * Nothing here runs against production. The app points at it with
 * NEXT_PUBLIC_EDGE_BASE, and no Supabase credential is involved.
 */
import { createServer } from "node:http";
import {
  buildRenewal,
  buildUpcoming,
  classifyMandate,
  directoryFrom,
  summariseTotals,
  type LiveMandate,
  type ManagePlan,
  type ScheduledChange,
} from "../supabase/functions/_shared/billing-manage.ts";

const PORT = Number(process.env.FIXTURE_PORT ?? 8791);

const DAY = 86_400_000;
const iso = (offsetDays: number, hourUtc = 4) => {
  const d = new Date(Date.now() + offsetDays * DAY);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
};

const PLANS = [
  { id: "starter", name: "Starter", billing_mode: "recurring", price_monthly: 999, price_yearly: 9990, currency: "INR" },
  { id: "pro", name: "Pro", billing_mode: "recurring", price_monthly: 2499, price_yearly: 24990, currency: "INR" },
  { id: "starter-onetime", name: "Starter — one-time", billing_mode: "onetime", price_monthly: 999, price_yearly: 0, currency: "INR" },
];
const DIRECTORY = directoryFrom(PLANS);

type Scenario = {
  plan: ManagePlan;
  trial?: { startedAt: string; endsAt: string; days: number };
  mandate: LiveMandate | null;
  scheduled: ScheduledChange[];
  payments: Array<Record<string, unknown>>;
};

const payment = (over: Record<string, unknown> = {}) => ({
  id: "pay_row_1",
  amount: 999,
  currency: "INR",
  status: "succeeded",
  payment_method: "upi",
  transaction_id: "pay_Ttz79MR5wVAvHD",
  plan_id: "starter",
  billing_period: "monthly",
  created_at: iso(-6),
  razorpay_payment_id: "pay_Ttz79MR5wVAvHD",
  razorpay_order_id: "order_Ttz7",
  failure_reason: null,
  document: {
    invoice_number: "INV-2026-27-00001",
    invoice_date: iso(-6).slice(0, 10),
    period_start: iso(-6),
    period_end: iso(24),
    description: "Starter — Monthly",
    seller_name: "The Salad",
    seller_address: null,
    seller_email: null,
    seller_phone: null,
    buyer_name: "Demo Kitchen",
    buyer_email: "owner@demo.kitchen",
    buyer_address: null,
  },
  refundDocument: null,
  ...over,
});

const basePlan = (over: Partial<ManagePlan> = {}): ManagePlan => ({
  planId: "starter",
  planName: "Starter",
  status: "active",
  isPaid: true,
  isTrial: false,
  isRestricted: false,
  billingInterval: "monthly",
  paymentMode: "autopay",
  billingMode: "recurring",
  currentPeriodEnd: iso(24),
  cancelAtPeriodEnd: false,
  priceMonthly: 999,
  priceYearly: 9990,
  currency: "INR",
  ...over,
});

const liveMandate = (over: Partial<LiveMandate> = {}): LiveMandate => ({
  subscriptionId: "sub_Ttz8c4Ee6CBAl6",
  state: "active",
  status: "active",
  totalCycles: 12,
  chargesMade: 2,
  cyclesRemaining: 10,
  currentPeriodEnd: iso(24),
  endAt: iso(354),
  chargeable: true,
  ...over,
});

const scheduledChange = (over: Partial<ScheduledChange> = {}): ScheduledChange => ({
  checkoutId: "co_sched_1",
  planId: "pro",
  planName: "Pro",
  interval: "monthly",
  paymentMode: "autopay",
  amount: 2499,
  currency: "INR",
  scheduledStartAt: iso(24),
  mandateId: "sub_SchedPro01",
  mandateState: classifyMandate("authenticated", 12),
  ...over,
});

const SCENARIOS: Record<string, Scenario> = {
  // A fresh restaurant, two days from the end of its trial.
  trial: {
    plan: basePlan({
      status: "trial", isPaid: false, isTrial: true, paymentMode: null,
      subscriptionPlan: "pro", planName: "Pro", planId: "pro",
      currentPeriodEnd: null, priceMonthly: 2499, priceYearly: 24990,
    }),
    trial: { startedAt: iso(-12), endsAt: iso(2), days: 14 },
    mandate: null,
    scheduled: [],
    payments: [],
  },

  // Paid monthly on a live AutoPay mandate.
  autopay: {
    plan: basePlan({}),
    trial: { startedAt: iso(-32), endsAt: iso(-18), days: 14 },
    mandate: liveMandate({}),
    scheduled: [],
    payments: [payment({ amount: 999 }), payment({ id: "pay_row_0", transaction_id: "pay_prev01", razorpay_payment_id: "pay_prev01", created_at: iso(-54) })],
  },

  // The phantom: payment_mode says autopay, Razorpay has no mandate. This is
  // the row that used to read "Monthly · AutoPay".
  "autopay-unverified": {
    plan: basePlan({}),
    mandate: null,
    scheduled: [],
    payments: [payment({ amount: 999 })],
  },

  // Phrnxs Cafe in production: an annual plan bought once.
  "pay-once-annual": {
    plan: basePlan({
      billingInterval: "annual", paymentMode: "pay_once",
      currentPeriodEnd: iso(388), priceMonthly: 999, priceYearly: 9990,
    }),
    trial: { startedAt: iso(-32), endsAt: iso(-18), days: 14 },
    mandate: null,
    scheduled: [],
    payments: [payment({ amount: 9990, plan_id: "starter", billing_period: "annual" })],
  },

  // Lelo Khalo in production: active, retired one-time plan, mode NULL.
  "legacy-onetime": {
    plan: basePlan({
      planId: "starter-onetime", planName: "Starter — one-time", billingMode: "onetime",
      paymentMode: null, billingInterval: "monthly", currentPeriodEnd: iso(21),
    }),
    trial: { startedAt: iso(-30), endsAt: iso(-16), days: 14 },
    mandate: null,
    scheduled: [],
    payments: [payment({ amount: 999, plan_id: "starter-onetime", billing_period: "monthly" })],
  },

  "past-due": {
    plan: basePlan({ status: "past_due", currentPeriodEnd: iso(-2) }),
    mandate: liveMandate({ state: "cancelled", status: "halted" }),
    scheduled: [],
    payments: [payment({ amount: 999 }), payment({ id: "pay_fail", amount: 999, status: "failed", transaction_id: "pay_fail01", razorpay_payment_id: "pay_fail01", failure_reason: "Card declined", created_at: iso(-2), document: null })],
  },

  pending: {
    plan: basePlan({ status: "pending", currentPeriodEnd: iso(-1) }),
    mandate: liveMandate({}),
    scheduled: [],
    payments: [payment({ amount: 999 })],
  },

  // Cancelled, with a verified replacement already scheduled.
  "cancelled-scheduled": {
    plan: basePlan({ status: "cancelled", cancelAtPeriodEnd: true, currentPeriodEnd: iso(9) }),
    mandate: liveMandate({ state: "authorised", status: "authenticated", chargesMade: 0 }),
    scheduled: [scheduledChange({})],
    payments: [payment({ amount: 999 })],
  },

  // The trial ran out and nothing was bought.
  restricted: {
    plan: basePlan({
      status: "expired", isPaid: false, isTrial: false, isRestricted: true,
      subscriptionPlan: null, paymentMode: null, currentPeriodEnd: null,
      planName: "Starter", planId: "starter",
    }),
    trial: { startedAt: iso(-40), endsAt: iso(-26), days: 14 },
    mandate: null,
    scheduled: [],
    payments: [],
  },

  // A refunded payment, so the totals card has all three figures.
  "diner-active": {
    plan: basePlan({}),
    mandate: liveMandate({}),
    scheduled: [],
    payments: [payment({ amount: 999 })],
  },

  "diner-ended": {
    plan: basePlan({}),
    mandate: liveMandate({}),
    scheduled: [],
    payments: [payment({ amount: 999 })],
  },

  "pos-sessions": {
    plan: basePlan({}),
    mandate: liveMandate({}),
    scheduled: [],
    payments: [payment({ amount: 999 })],
  },

  "orders-session": {
    plan: basePlan({}),
    mandate: liveMandate({}),
    scheduled: [],
    payments: [payment({ amount: 999 })],
  },

  "orders-held": {
    plan: basePlan({}),
    mandate: liveMandate({}),
    scheduled: [],
    payments: [payment({ amount: 999 })],
  },

  "pos-bills": {
    plan: basePlan({}),
    mandate: liveMandate({}),
    scheduled: [],
    payments: [payment({ amount: 999 })],
  },

  "pos-check": {
    plan: basePlan({}),
    mandate: liveMandate({}),
    scheduled: [],
    payments: [payment({ amount: 999 })],
  },

  "pos-approve": {
    plan: basePlan({}),
    mandate: liveMandate({}),
    scheduled: [],
    payments: [payment({ amount: 999 })],
  },

  "orders-session": {
    plan: basePlan({}),
    mandate: liveMandate({}),
    scheduled: [],
    payments: [payment({ amount: 999 })],
  },

  "orders-held": {
    plan: basePlan({}),
    mandate: liveMandate({}),
    scheduled: [],
    payments: [payment({ amount: 999 })],
  },

  "pos-bills": {
    plan: basePlan({}),
    mandate: liveMandate({}),
    scheduled: [],
    payments: [payment({ amount: 999 })],
  },

  "pos-check": {
    plan: basePlan({}),
    mandate: liveMandate({}),
    scheduled: [],
    payments: [payment({ amount: 999 })],
  },

  refunded: {
    plan: basePlan({}),
    mandate: liveMandate({}),
    scheduled: [],
    payments: [
      payment({ amount: 999, status: "refunded", refundDocument: { refund_number: "RFND-2026-27-00001", refund_date: iso(-3).slice(0, 10), original_invoice_number: "INV-2026-27-00001", original_invoice_date: iso(-6).slice(0, 10), razorpay_refund_id: "rfnd_01" } }),
      payment({ id: "pay_row_2", amount: 2499, plan_id: "pro", transaction_id: "pay_pro01", razorpay_payment_id: "pay_pro01", created_at: iso(-40) }),
    ],
  },
};

let current = process.env.FIXTURE_STATE ?? "trial";
/** Simulate one failing dependency: "manage". */
let failing: string | null = process.env.FIXTURE_FAIL ?? null;
/** Set when the E2E presses Accept, so the next read shows the table accepted. */
let activationDone = false;
/** Flipped by the status-animation test to move an order on. */
let orderStage = 0;
/** A held order for the acceptance card, and whether it has been accepted. */
let heldAccepted = false;

/** The `publicPlan` shape both endpoints return. */
function planPayload(s: Scenario) {
  const p = s.plan;
  return {
    planId: p.planId ?? "starter",
    planName: p.planName,
    status: p.status,
    isPaid: p.isPaid,
    isTrial: p.isTrial,
    isRestricted: p.isRestricted,
    trialStartedAt: s.trial?.startedAt ?? null,
    trialEndsAt: s.trial?.endsAt ?? null,
    trialDaysRemaining: s.trial
      ? Math.max(0, Math.ceil((new Date(s.trial.endsAt).getTime() - Date.now()) / DAY))
      : null,
    subscriptionPlan: p.planId,
    subscriptionStartedAt: p.isPaid ? iso(-32) : null,
    currentPeriodEnd: p.currentPeriodEnd,
    cancelAtPeriodEnd: p.cancelAtPeriodEnd,
    limits: { locations: 1, staff: 10, menuItems: 300 },
    features: ["POS", "QR ordering", "Analytics"],
    priceMonthly: p.priceMonthly,
    priceYearly: p.priceYearly,
    billingInterval: p.billingInterval,
    paymentMode: p.paymentMode,
    currency: p.currency,
    billingMode: p.billingMode,
  };
}

const bundle = () => {
  const s = SCENARIOS[current] ?? SCENARIOS.trial;
  const plan = planPayload(s);
  const payments = s.payments;
  return {
    state: {
      plan,
      plans: PLANS.map((p) => ({
        id: p.id, name: p.name, description: null, priceMonthly: p.price_monthly,
        priceYearly: p.price_yearly, currency: p.currency, trialDays: 14,
        features: ["POS", "QR ordering"], limits: { locations: 1, staff: 10, menuItems: 300 },
        popular: p.id === "pro", razorpayPlanId: null, billingMode: p.billing_mode,
      })),
      restaurant: { name: "Demo Kitchen", email: "owner@demo.kitchen" },
      razorpayConfigured: true,
      planDirectory: DIRECTORY,
      totals: summariseTotals(payments as never),
      locationCount: 1,
      payments,
    },
    manage: {
      plan,
      renewal: buildRenewal(s.plan, s.scheduled, s.mandate),
      upcoming: buildUpcoming(s.plan, s.scheduled, s.mandate),
      scheduledChanges: s.scheduled,
      mandate: s.mandate,
      history: [
        { id: "h1", changeType: "activated", oldPlan: null, newPlan: s.plan.planId, oldPlanName: null, newPlanName: s.plan.planName, amountPaid: s.plan.isPaid ? s.plan.priceMonthly : null, createdAt: iso(-32) },
      ],
      totals: summariseTotals(payments as never),
      planDirectory: DIRECTORY,
      locationCount: 1,
      warnings: [],
    },
  };
};

function bootstrap(b: ReturnType<typeof bundle>) {
  return {
    tenant: { id: "tenant_fixture", name: "Demo Kitchen", email: "owner@demo.kitchen", phone: "+91 90000 00000", currency: "INR" },
    subscription: b.state.plan,
    // A capability topic, as the real bootstrap issues it. The client opens a
    // private channel for it; the fixture has no Realtime server, so the
    // socket fails and the UI falls back to its poll — which is the point:
    // nothing on the page may depend on the socket being up.
    realtimeTopic: "staff:tenant_fixture:0123456789abcdef",
    settings: { timezone: "Asia/Kolkata", currency: "INR", tax_rate: "5" },
    currentUser: { id: "user_fixture", name: "Priyanshu", email: "owner@demo.kitchen", role: "OWNER" },
    // The owner's full key set. Without it every action button on the POS is
    // disabled, and a UI test clicks into nothing.
    permissions: [
      "dashboard.view", "orders.view", "orders.create", "orders.edit", "orders.cancel",
      "orders.complete", "orders.prepare", "orders.ready", "orders.serve", "orders.discount",
      "payments.collect", "payments.refund", "menu.view", "menu.manage",
      "tables.view", "tables.manage", "table-sessions.manage",
      "promos.view", "promos.manage", "analytics.view", "qr.manage",
      "settings.view", "settings.manage", "security.view", "security.manage",
      "roles.view", "roles.manage", "staff.view", "staff.manage",
    ],
    users: [{ id: "user_fixture", name: "Priyanshu", email: "owner@demo.kitchen", role: "OWNER" }],
    roles: [],
    staff: [],
    categories: [],
    menuItems: [],
    // Every table, so the floor can show the free ones too.
    tables: (current === "pos-sessions" || current === "pos-check" || current === "pos-bills") ? [
      { id: "t7", name: "Table 7", area: "Main Hall", seats: 4, active: true },
      { id: "t3", name: "Table 3", area: "Main Hall", seats: 2, active: true },
      { id: "t1", name: "Table 1", area: "Terrace", seats: 4, active: true },
      { id: "t9", name: "Table 9", area: "Terrace", seats: 2, active: true },
      { id: "t5", name: "Table 5", area: "Terrace", seats: 4, active: true },
    ] : [],
    orders: current === "orders-session" ? [
      { id: "o2179", orderNumber: 2179, status: "PENDING", tableSessionId: "sess-t3", checkId: "chk-t3", orderType: "DINE_IN", tableId: "t3", table: { id: "t3", name: "Table 3" },
        items: [{ id: "a", name: "Watermelon Blast", quantity: 1, price: 150, total: 150, status: "PENDING" }],
        itemsTotal: 150, discount: 0, tax: 7.5, serviceCharge: 0, total: 157.5, paymentStatus: "UNPAID", paymentMethod: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null },
      { id: "o2178", orderNumber: 2178, status: "PENDING", tableSessionId: "sess-t3", checkId: "chk-t3", orderType: "DINE_IN", tableId: "t3", table: { id: "t3", name: "Table 3" },
        items: [{ id: "b", name: "Blue Curacao", quantity: 1, price: 150, total: 150, status: "PENDING" }],
        itemsTotal: 150, discount: 0, tax: 7.5, serviceCharge: 0, total: 157.5, paymentStatus: "UNPAID", paymentMethod: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null },
      { id: "o2177", orderNumber: 2177, status: "READY", tableSessionId: "sess-t3", checkId: "chk-t3", orderType: "DINE_IN", tableId: "t3", table: { id: "t3", name: "Table 3" },
        items: [{ id: "c", name: "Green Apple", quantity: 1, price: 150, total: 150, status: "PENDING" }, { id: "d", name: "Blue Curacao", quantity: 1, price: 150, total: 150, status: "PENDING" }],
        itemsTotal: 300, discount: 0, tax: 15, serviceCharge: 0, total: 315, paymentStatus: "UNPAID", paymentMethod: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null },
      { id: "o2154", orderNumber: 2154, status: "COMPLETED", tableSessionId: "sess-t3", checkId: "chk-t3", orderType: "DINE_IN", tableId: "t3", table: { id: "t3", name: "Table 3" },
        items: [{ id: "e", name: "Fresh Lime Soda", quantity: 1, price: 100, total: 100, status: "PENDING" }, { id: "f", name: "Lemon Ice Tea", quantity: 1, price: 120, total: 120, status: "PENDING" }],
        itemsTotal: 220, discount: 0, tax: 11, serviceCharge: 0, total: 231, paymentStatus: "UNPAID", paymentMethod: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null },
      { id: "o2170", orderNumber: 2170, status: "PENDING_ACTIVATION", tableSessionId: "sess-t2", checkId: "chk-t2", orderType: "DINE_IN", tableId: "t2", table: { id: "t2", name: "Table 2" },
        items: [{ id: "g", name: "Crispy Crunch Burger", quantity: 1, price: 600, total: 600, status: "PENDING" }],
        itemsTotal: 600, discount: 0, tax: 30, serviceCharge: 0, total: 630, paymentStatus: "UNPAID", paymentMethod: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null },
    ] : current === "orders-held" ? [{
      id: "ord-held", orderNumber: 2171, status: heldAccepted ? "PENDING" : "PENDING_ACTIVATION",
      orderType: "DINE_IN", tableId: "t3", table: { id: "t3", name: "Table 3" },
      items: [{ id: "i1", name: "Ginger Tea", quantity: 1, price: 40, total: 40, status: "PENDING" }],
      itemsTotal: 40, discount: 0, tax: 2, serviceCharge: 0, total: 42,
      paymentStatus: "UNPAID", paymentMethod: null, customerName: null, customerPhone: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null,
    }] : [],
    reservations: [],
    promos: [],
    sessions: [],
    securityLogs: [],
    securityStats: { failedLogins24h: 0, auditEvents7d: 0 },
    summary: { revenue: 0, ordersToday: 0, activeOrders: 0, totalTables: 0, totalMenuItems: 0, pendingReservations: 0 },
  };
}

/**
 * CORS for a credentialed request.
 *
 * `edgeFetch` sends `credentials: 'include'` (the staff cookie depends on it),
 * and a browser refuses a wildcard origin on a credentialed request — the
 * fetch fails as a bare `ERR_FAILED` with nothing in the server log, which is
 * exactly how the first run of this harness went wrong. So: echo the origin
 * and allow credentials.
 */
const corsFor = (req: import("node:http").IncomingMessage) => ({
  "Access-Control-Allow-Origin": req.headers.origin ?? "*",
  "Access-Control-Allow-Credentials": "true",
  // Echo what the browser asked for: the diner sends `x-session-token`, the
  // POS `x-tenant-id`, staff `x-staff-session`. Listing them by hand is how
  // the preflight for a new header silently starts failing.
  "Access-Control-Allow-Headers":
    (req.headers["access-control-request-headers"] as string | undefined) ??
    "apikey,authorization,content-type,x-tenant-id,x-staff-session,x-session-token",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  Vary: "Origin",
});

const json = (
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  body: unknown,
  status = 200,
) => {
  res.writeHead(status, { "Content-Type": "application/json", ...corsFor(req) });
  res.end(JSON.stringify(body));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  // The app talks to `${NEXT_PUBLIC_EDGE_BASE}/functions/v1/<route>`; a bare
  // `/api/<route>` is accepted too so the fixture can be curled directly.
  const raw = url.pathname.replace(/^\/functions\/v1/, "/api");
  const path = raw === "" ? "/api" : raw;

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsFor(req));
    res.end();
    return;
  }

  if (current === "orders-held" && path === "/api/orders/ord-held/accept" && req.method === "POST") {
    heldAccepted = true;
    // The real endpoint answers with the order it changed; the card replaces
    // itself from it rather than waiting for a refetch.
    return json(req, res, {
      ok: true, already: false, status: "PENDING",
      order: {
        id: "ord-held", orderNumber: 2171, status: "PENDING", orderType: "DINE_IN",
        tableId: "t3", table: { id: "t3", name: "Table 3" },
        items: [{ id: "i1", name: "Ginger Tea", quantity: 1, price: 40, total: 40, status: "PENDING" }],
        itemsTotal: 40, discount: 0, tax: 2, serviceCharge: 0, total: 42,
        paymentStatus: "UNPAID", paymentMethod: null, customerName: null, customerPhone: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null,
      },
    });
  }
  if (current === "orders-held" && path === "/api/orders/ord-held/reject" && req.method === "POST") {
    heldAccepted = false;
    return json(req, res, { ok: true, status: "CANCELLED" });
  }

  if (path === "/__fixture/advance") {
    orderStage += 1;
    return json(req, res, { stage: orderStage });
  }

  if (path === "/__fixture/state") {
    const name = url.searchParams.get("name");
    if (url.searchParams.has("fail")) failing = url.searchParams.get("fail") || null;
    if (name) {
      if (!SCENARIOS[name]) return json(req, res, { error: `unknown scenario ${name}`, known: Object.keys(SCENARIOS) }, 404);
      current = name;
      // Selecting a scenario resets the stateful bits, so one run cannot leak
      // into the next — a suite that only passes the second time is worse than
      // no suite.
      activationDone = false;
      orderStage = 0;
      heldAccepted = false;
    }
    return json(req, res, { current, failing, known: Object.keys(SCENARIOS) });
  }

  // The diner's session-ended screen, and the bill behind its View Bill
  // button. The session is seeded into sessionStorage by the check script;
  // the server answers "INVALID" with hasOrder, which is exactly what this
  // screen is built from.
  // A live menu, so the order tracker can be exercised in the header.
  if (current === "diner-active") {
    if (path === "/api/table-session/validate") {
      return json(req, res, {
        sessionStatus: "ACTIVE",
        activationStatus: "ACTIVE",
        session: { id: "s-live", token: "fixture-session-token", status: "ACTIVE", tenantId: "tenant_fixture", tableId: "table_fixture", createdAt: new Date().toISOString(), endedAt: null, activationStatus: "ACTIVE" },
        tenant: { id: "tenant_fixture", name: "Demo Kitchen", tagline: "South Indian", currencySymbol: "₹", taxRate: 5, serviceCharge: 0, logo: null },
        table: { id: "table_fixture", name: "Table 4", seats: 4, area: "Main Hall", active: true },
        social: {},
        theme: "light",
        categories: [{ id: "c1", tenantId: "tenant_fixture", name: "All", icon: null, sortOrder: 1 }],
        menuItems: [{
          id: "m1", tenantId: "tenant_fixture", categoryId: "c1", name: "Masala Dosa",
          description: "Crisp dosa", price: 160, portions: [], image: null, available: true,
          prepTime: 15, tags: "", calories: null, sortOrder: 1, rating: 4.5,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          category: { id: "c1", tenantId: "tenant_fixture", name: "All", icon: null, sortOrder: 1 },
        }],
      });
    }
    if (path === "/api/table-session/orders") {
      const stage = ["PREPARING", "READY", "SERVED", "COMPLETED"][Math.min(orderStage, 3)];
      return json(req, res, {
        sessionId: "s-live",
        orders: [
          { id: "o1", orderNumber: 2149, status: stage, total: 640, createdAt: new Date().toISOString(), items: [{ name: "Paneer Tikka", quantity: 2, portion: "Full", total: 640, status: "PENDING" }] },
          { id: "o2", orderNumber: 2150, status: "READY", total: 670, createdAt: new Date().toISOString(), items: [{ name: "Masala Dosa", quantity: 2, portion: null, total: 670, status: "PENDING" }] },
        ],
      });
    }
  }

  if (current === "diner-ended") {
    if (path === "/api/table-session/validate") {
      return json(req, res, {
        error: "Session ended. Please scan the table QR code again to continue.",
        sessionStatus: "INVALID",
        hasOrder: true,
        orderId: "order_fixture_1",
        orderNumber: 2149,
        reviewsEnabled: true,
        averageRating: 4.6,
        reviewCount: 12,
      }, 403);
    }
    // The diner's consolidated document — what the bill dialog asks for first.
    if (path === "/api/bill/check" && url.searchParams.get("format") === "document") {
      return json(req, res, {
        restaurant: { name: "Demo Kitchen", tagline: null, logo: null, address: null, phone: null, email: null, currency: "INR", currencySymbol: "₹", gstin: "29ABCDE1234F1Z5", fssai: null },
        billNumber: "INV-0000007",
        invoiceNumber: "INV-0000007",
        orderNumber: null,
        orderNumbers: [2149, 2150],
        invoiceDate: new Date().toISOString(),
        completedAt: null,
        table: { name: "Table 4", seats: 4, area: "Main Hall" },
        orderType: "DINE_IN",
        customerName: null,
        customerPhone: null,
        servedBy: null,
        items: [
          { name: "Paneer Tikka", portion: "Full", portionId: null, quantity: 1, unitPrice: 640, total: 640, notes: null, orderNumber: 2149 },
          { name: "Masala Dosa", portion: null, portionId: null, quantity: 1, unitPrice: 670, total: 670, notes: null, orderNumber: 2150 },
        ],
        subtotal: 1250, discount: 0, promoCode: null, taxableAmount: 1250,
        taxBreakup: { rate: 5, cgstRate: 2.5, sgstRate: 2.5, cgstAmount: 30, sgstAmount: 30, totalTax: 60 },
        serviceCharge: 0,
        grandTotal: 1310,
        paidTotal: 500,
        outstanding: 810,
        payments: [{ amount: 500, method: "CASH", createdAt: new Date().toISOString() }],
        paymentMethod: "CASH",
        paymentStatus: "UNPAID",
        orderStatus: "OPEN",
        checkStatus: "OPEN",
        terms: ["Consolidated bill for the table."],
      });
    }

    if (path === "/api/table-session/bill") {
      return json(req, res, { ok: true, orderId: "order_fixture_1", orderNumber: 2149 });
    }
    if (path === "/api/reviews") {
      return json(req, res, { ok: true, id: "review_fixture_1" }, 201);
    }
    if (path.startsWith("/api/bill/")) {
      return json(req, res, {
        id: "order_fixture_1",
        orderNumber: 2149,
        tableName: "Table 4",
        createdAt: new Date().toISOString(),
        items: [{ id: "i1", name: "Paneer Tikka", quantity: 2, price: 320, total: 640 }],
        itemsTotal: 640, discount: 0, tax: 32, serviceCharge: 0, total: 672,
        paymentMethod: "UPI", paymentStatus: "PAID",
        tenant: { name: "Demo Kitchen" }, table: { name: "Table 4" },
      });
    }
  }

  // The POS floor board: one table per state, so the card layout can be
  // measured in all three at once.
  // Two diners at one table, both waiting, plus the accept call that clears
  // both at once — the multi-device case, driven through the real UI.
  if (current === "pos-approve") {
    if (path === "/api/table-session/active") {
      const now = Date.now();
      const iso = (min: number) => new Date(now - min * 60_000).toISOString();
      return json(req, res, [
        {
          id: "s-a", tableId: "t3", table: { id: "t3", name: "Table 3", area: "Main Hall", seats: 4 },
          sessions: [
            { id: "s-a", tableId: "t3", status: "ACTIVE", activationStatus: activationDone ? "ACTIVE" : "PENDING", createdAt: iso(3), lastSeenAt: iso(0), _count: { orders: activationDone ? 1 : 0, held: activationDone ? 0 : 1 } },
            { id: "s-b", tableId: "t3", status: "ACTIVE", activationStatus: activationDone ? "ACTIVE" : "PENDING", createdAt: iso(2), lastSeenAt: iso(0), _count: { orders: activationDone ? 1 : 0, held: activationDone ? 0 : 1 } },
          ],
        },
      ]);
    }
    if (path === "/api/table-session/approve" && req.method === "POST") {
      activationDone = true;
      return json(req, res, { ok: true, released: 2, already: false });
    }
    if (path === "/api/table-session/end" && req.method === "POST") {
      return json(req, res, {
        error: "2 orders on this table are still open, 2 unpaid. Settle them first, or close the table anyway.",
        code: "outstanding",
        outstanding: [{ id: "o1", orderNumber: 2149, status: "SERVED", paymentStatus: "UNPAID" }],
      }, 409);
    }
  }

  // The consolidated bill for the E2E: two orders, one payment, live totals.
  if (current === "pos-check") {
    let paid = 0;
    const check = () => {
      const total = 1310;
      return {
        checkId: "chk_1", status: paid >= total ? "PAID" : "OPEN", tableId: "t3",
        invoiceNumber: paid >= total ? "INV-0000007" : null, invoiceDate: null, gstin: "29ABCDE1234F1Z5",
        orderCount: 2,
        totals: { subtotal: 1250, discount: 0, tax: 60, serviceCharge: 0, total, paid, outstanding: Math.max(0, total - paid), cgst: 30, sgst: 30 },
        orders: [
          { id: "o1", orderNumber: 2149, status: "SERVED", total: 640, items: [{ id: "i1", name: "Paneer Tikka", portion: "Full", quantity: 2, total: 640 }] },
          { id: "o2", orderNumber: 2150, status: "SERVED", total: 670, items: [{ id: "i2", name: "Masala Dosa", portion: null, quantity: 2, total: 670 }] },
        ],
        payments: paid > 0 ? [{ id: "p1", amount: paid, method: "CASH", created_at: new Date().toISOString() }] : [],
      };
    };
    if (path === "/api/bill/check") return json(req, res, check());
    if (path === "/api/bill/payment" && req.method === "POST") {
      const body = JSON.parse(String(await new Promise((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d)); })) || "{}");
      paid += Number(body.amount) || 0;
      return json(req, res, { ok: true, deduplicated: false, paymentId: "p1", outstanding: Math.max(0, 1310 - paid) }, 201);
    }
    if (path === "/api/bill/finalize" && req.method === "POST") {
      paid = 1310;
      return json(req, res, { ok: true, already: false, invoiceNumber: "INV-0000007", total: 1310 });
    }
  }

  // The floor board plus a bill nobody has settled — the shape the endpoint
  // returns now, so the "Awaiting payment" strip can be exercised.
  if (current === "pos-bills" && path === "/api/bill/check") {
    return json(req, res, {
      checkId: "chk-old", status: "OPEN", tableId: url.searchParams.get("tableId") ?? "t1",
      invoiceNumber: null, invoiceDate: null, gstin: null, orderCount: 1,
      totals: { subtotal: 460, discount: 0, tax: 20, serviceCharge: 0, total: 480, paid: 0, outstanding: 480, cgst: 10, sgst: 10 },
      orders: [{ id: "o1", orderNumber: 2149, status: "SERVED", total: 480, items: [{ id: "i1", name: "Paneer Tikka", portion: null, quantity: 1, total: 480 }] }],
      payments: [],
    });
  }

  if (current === "pos-bills" && path === "/api/table-session/active") {
    const now = Date.now();
    const iso = (min: number) => new Date(now - min * 60_000).toISOString();
    return json(req, res, {
      sessions: [
        {
          id: "s-active", tableId: "t7", table: { id: "t7", name: "Table 7", area: "Main Hall", seats: 4 },
          sessions: [{ id: "s-active", tableId: "t7", status: "ACTIVE", activationStatus: "ACTIVE", createdAt: iso(18), lastSeenAt: iso(1), _count: { orders: 2, held: 0 } }],
          check: { total: 860, paid: 500, outstanding: 360, status: "OPEN" },
        },
      ],
      pendingBills: [
        { checkId: "chk-old", tableId: "t1", tableName: "Table 1", area: "Terrace", status: "UNSETTLED", total: 480, paid: 0, outstanding: 480, openedAt: iso(120), unsettledAt: iso(60) },
        { checkId: "chk-part", tableId: "t4", tableName: "Table 4", area: "Main Hall", status: "OPEN", total: 300, paid: 100, outstanding: 200, openedAt: iso(30), unsettledAt: null },
      ],
    });
  }

  if ((current === "pos-sessions" || current === "pos-check") && path === "/api/table-session/active") {
    const now = Date.now();
    const iso = (min: number) => new Date(now - min * 60_000).toISOString();
    return json(req, res, [
      {
        id: "s-active", tableId: "t7", table: { id: "t7", name: "Table 7", area: "Main Hall", seats: 4 },
        sessions: [{ id: "s-active", tableId: "t7", status: "ACTIVE", activationStatus: "ACTIVE", createdAt: iso(18), lastSeenAt: iso(1), _count: { orders: 3, held: 0 } }],
        check: { total: 860, paid: 860, outstanding: 0, status: "OPEN" },
      },
      {
        id: "s-pending", tableId: "t3", table: { id: "t3", name: "Table 3", area: "Main Hall", seats: 2 },
        sessions: [{ id: "s-pending", tableId: "t3", status: "ACTIVE", activationStatus: "PENDING", createdAt: iso(2), lastSeenAt: iso(0), _count: { orders: 0, held: 1 } }],
      },
      {
        id: "s-closed", tableId: "t1", table: { id: "t1", name: "Table 1", area: "Terrace", seats: 4 },
        sessions: [{ id: "s-closed", tableId: "t1", status: "ENDED", activationStatus: "ACTIVE", createdAt: iso(75), lastSeenAt: iso(3), closedAt: iso(1), _count: { orders: 2, held: 0 } }],
      },
      {
        id: "s-done", tableId: "t5", table: { id: "t5", name: "Table 5", area: "Terrace", seats: 4 },
        sessions: [{ id: "s-done", tableId: "t5", status: "ENDED", activationStatus: "ACTIVE", createdAt: iso(90), lastSeenAt: iso(5), closedAt: iso(2), _count: { orders: 1, held: 0 } }],
        check: { total: 200, paid: 200, outstanding: 0, status: "PAID" },
      },
    ]);
  }

  if (path === "/api/auth/me") return json(req, res, { sessionKind: "owner", user: { id: "user_fixture", email: "owner@demo.kitchen" } });
  if (path === "/api/staff/me") return json(req, res, { error: "no staff session" }, 401);

  const b = bundle();
  if (path === "/api/bootstrap") return json(req, res, bootstrap(b));
  if (path === "/api/subscriptions" || path === "/api/subscriptions/state") return json(req, res, b.state);
  if (path === "/api/subscriptions/manage") {
    // ?fail=manage exercises the page's failure path: the verified payload is
    // the one call the view cannot substitute a guess for.
    if (url.searchParams.get("fail") === "manage" || failing === "manage") {
      return json(req, res, { error: "Razorpay could not be reached" }, 502);
    }
    return json(req, res, b.manage);
  }

  // Anything else the settings shell asks for (reviews, security) is empty
  // rather than an error, so the page cannot fail for a reason under test.
  if (req.method === "GET") return json(req, res, []);
  return json(req, res, { ok: true });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`billing fixture on http://127.0.0.1:${PORT} — state: ${current}`);
  console.log(`scenarios: ${Object.keys(SCENARIOS).join(", ")}`);
});
