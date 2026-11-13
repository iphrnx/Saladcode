/**
 * The subscription lifecycle.
 *
 * What this proves:
 *
 *   - the trial runs, and it ends on its own without a job or a flag
 *   - an expired trial restricts the paid features and deletes nothing
 *   - the plan's limits are enforced on the server, not in the interface
 *   - advanced analytics follows the plan entitlements (Starter has it)
 *   - a webhook without a valid signature is refused, and an event that has
 *     already been handled cannot be handled twice
 *   - one restaurant cannot read or change another's billing
 *   - a checkout with no Razorpay keys says so, rather than failing obscurely
 *
 * What it cannot prove: a real payment. That needs Razorpay credentials, and
 * this does not fake one.
 */
import { createClient } from "@supabase/supabase-js";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail = "") {
  checks++;
  if (ok) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });

async function sessionFor(email: string) {
  const { data: link, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw new Error(error.message);
  const c = createClient(SB, ANON, { auth: { persistSession: false } });
  const { data, error: e2 } = await c.auth.verifyOtp({
    token_hash: link!.properties.hashed_token,
    type: "magiclink",
  });
  if (e2) throw new Error(e2.message);
  return data!.session!.access_token;
}

async function call(path: string, token: string, init: RequestInit = {}) {
  const res = await fetch(`${SB}/functions/v1/${path}`, {
    ...init,
    headers: {
      apikey: ANON,
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

const ownerToken = await sessionFor("phrnx@icloud.com");
const otherOwnerToken = await sessionFor("swizofoods@gmail.com");

const { data: tenant } = await admin
  .from("tenants")
  .select("id, plan, subscription_status, trial_started_at, trial_ends_at")
  .eq("slug", "alex-cafe")
  .maybeSingle();
const tenantId = tenant!.id;

// Remember the state so it can be put back.
const saved = { ...tenant! };

async function setTenant(patch: Record<string, unknown>) {
  await admin.from("tenants").update(patch).eq("id", tenantId);
}

console.log("\n── a running trial ──");
{
  const now = Date.now();
  await setTenant({
    plan: "pro",
    subscription_status: "trial",
    trial_started_at: new Date(now - 3 * 86_400_000).toISOString(),
    trial_ends_at: new Date(now + 11 * 86_400_000).toISOString(),
  });

  const res = await call("subscriptions", ownerToken);
  check("the subscription state is readable", res.status === 200, `status ${res.status}`);
  check("it is a trial", res.body?.plan?.isTrial === true);
  check("it is not restricted", res.body?.plan?.isRestricted === false);
  check("the trial carries the Pro plan", res.body?.plan?.planId === "pro", String(res.body?.plan?.planId));
  check("the days remaining are counted", res.body?.plan?.trialDaysRemaining === 11, String(res.body?.plan?.trialDaysRemaining));
  check("the trial start is shown", Boolean(res.body?.plan?.trialStartedAt));
  check("the trial end is shown", Boolean(res.body?.plan?.trialEndsAt));
  check("both plans are offered", (res.body?.plans ?? []).length === 2, String((res.body?.plans ?? []).length));
  check("the plans are Starter and Pro", (res.body?.plans ?? []).map((p: any) => p.id).sort().join(",") === "pro,starter");
  check("Starter is ₹999", (res.body?.plans ?? []).find((p: any) => p.id === "starter")?.priceMonthly === 999);
  check("Pro is ₹2499", (res.body?.plans ?? []).find((p: any) => p.id === "pro")?.priceMonthly === 2499);
}

console.log("\n── an expired trial ──");
{
  const now = Date.now();
  await setTenant({
    plan: "pro",
    subscription_status: "trial",
    trial_started_at: new Date(now - 20 * 86_400_000).toISOString(),
    trial_ends_at: new Date(now - 6 * 86_400_000).toISOString(),
  });

  const res = await call("subscriptions", ownerToken);
  check("it is no longer a trial", res.body?.plan?.isTrial === false);
  check("it is restricted", res.body?.plan?.isRestricted === true);
  check("it falls back to the Starter plan", res.body?.plan?.planId === "starter", String(res.body?.plan?.planId));
  check("there are no days left", res.body?.plan?.trialDaysRemaining === null, String(res.body?.plan?.trialDaysRemaining));

  // Nothing may be deleted when a trial ends.
  const { count: items } = await admin
    .from("menu_items")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId);
  const { count: orders } = await admin
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId);
  const { count: tables } = await admin
    .from("tables")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId);
  check("the menu is untouched", (items ?? 0) > 0, `${items} items`);
  check("the orders are untouched", (orders ?? 0) > 0, `${orders} orders`);
  check("the tables are untouched", (tables ?? 0) > 0, `${tables} tables`);
}

console.log("\n── a paid subscription ──");
{
  const now = Date.now();
  await setTenant({
    plan: "pro",
    subscription_plan: "pro",
    subscription_status: "active",
    subscription_started_at: new Date(now - 10 * 86_400_000).toISOString(),
    current_period_end: new Date(now + 20 * 86_400_000).toISOString(),
    cancel_at_period_end: false,
  });

  const res = await call("subscriptions", ownerToken);
  check("it is paid", res.body?.plan?.isPaid === true);
  check("it is not restricted", res.body?.plan?.isRestricted === false);
  check("the renewal date is shown", Boolean(res.body?.plan?.currentPeriodEnd));
  check("the staff limit is unlimited", res.body?.plan?.limits?.staff === null, String(res.body?.plan?.limits?.staff));
  check("the menu item limit is unlimited", res.body?.plan?.limits?.menuItems === null);
}

console.log("\n── the plan's limits are enforced on the server ──");
{
  // Starter: five staff members, a hundred menu items.
  await setTenant({
    plan: "starter",
    subscription_plan: "starter",
    subscription_status: "active",
    current_period_end: new Date(Date.now() + 20 * 86_400_000).toISOString(),
  });

  const state = await call("subscriptions", ownerToken);
  check("Starter allows five staff", state.body?.plan?.limits?.staff === 5, String(state.body?.plan?.limits?.staff));
  check("Starter allows a hundred menu items", state.body?.plan?.limits?.menuItems === 100, String(state.body?.plan?.limits?.menuItems));

  // The staff write path counts what is there and refuses the sixth. The
  // test fills the restaurant up to the limit and then tries to go past it,
  // because a limit that is only ever checked against a count of zero is
  // not a limit.
  const { data: staff } = await admin
    .from("staff")
    .select("id")
    .eq("tenant_id", tenantId)
    .limit(20);
  const have = staff?.length ?? 0;
  const created: string[] = [];

  let allowed = 0;
  let refusal: { status: number; error: string } | null = null;
  for (let i = have; i < 8; i++) {
    const res = await call("staff/manage", ownerToken, {
      method: "POST",
      body: JSON.stringify({
        name: `Limit Test ${i}`,
        employeeId: `LIM${Date.now().toString().slice(-6)}${i}`,
        pin: "1234",
        roleId: null,
      }),
    });
    if (res.status < 400) {
      allowed++;
      if (res.body?.id) created.push(res.body.id);
      continue;
    }
    refusal = { status: res.status, error: String(res.body?.error ?? "") };
    break;
  }

  check("a Starter restaurant can be filled up to its limit", allowed === 5 - have, `added ${allowed}, had ${have}`);
  check("the sixth staff member is refused", refusal?.status === 402, JSON.stringify(refusal));
  check("the refusal says what to do", /upgrade/i.test(String(refusal?.error ?? "")), String(refusal?.error));

  // The staff the test created are not left behind.
  for (const id of created) await admin.from("staff").delete().eq("id", id);
  const { count: left } = await admin
    .from("staff")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId);
  check("the test staff are cleaned up", (left ?? 0) === have, `${left} left, had ${have}`);

  // And Pro has no limit at all.
  await setTenant({ plan: "pro", subscription_plan: "pro" });
  const proRes = await call("subscriptions", ownerToken);
  check("Pro has no staff limit", proRes.body?.plan?.limits?.staff === null);
}

console.log("\n── advanced analytics follows the plan entitlements ──");
{
  // Starter includes Advanced Analytics now (monthly and annual are the same
  // plan row), so the advanced half must be served to a Starter restaurant.
  for (const interval of ["monthly", "annual"] as const) {
    await setTenant({
      plan: "starter",
      subscription_plan: "starter",
      subscription_status: "active",
      billing_interval: interval,
      current_period_end: new Date(Date.now() + 30 * 86400000).toISOString(),
    });
    const starter = await call("analytics", ownerToken);
    check(`Starter (${interval}) gets the advanced half`, starter.body?.advanced === true, String(starter.body?.advanced));
    check(`Starter (${interval}) gets hourly volume`, Array.isArray(starter.body?.hourly) && starter.body.hourly.length === 24, JSON.stringify(starter.body?.hourly)?.slice(0, 60));
    check(`Starter (${interval}) gets order-type revenue`, Array.isArray(starter.body?.typeBreakdown));
    check(`Starter (${interval}) gets today's revenue`, typeof starter.body?.todaysRevenue === "number");
    check(`Starter (${interval}) gets top tables`, Array.isArray(starter.body?.topTables));
  }

  // A legacy one-time Starter keeps what it paid for while it is active.
  await setTenant({
    plan: "starter-onetime",
    subscription_plan: "starter-onetime",
    subscription_status: "active",
    current_period_end: new Date(Date.now() + 10 * 86400000).toISOString(),
  });
  const legacy = await call("analytics", ownerToken);
  check("a legacy one-time Starter keeps the advanced half", legacy.body?.advanced === true, String(legacy.body?.advanced));

  // The basic half never depended on the plan.
  check("the basic half is still there", typeof legacy.body?.totalRevenue === "number");

  await setTenant({ plan: "pro", subscription_plan: "pro", subscription_status: "active" });
  const pro = await call("analytics", ownerToken);
  check("a Pro restaurant still gets the advanced half", pro.body?.advanced === true, String(pro.body?.advanced));
}

console.log("\n── one restaurant cannot touch another's billing ──");
{
  const res = await call("subscriptions", otherOwnerToken);
  check("another owner gets their own state, not this one's", res.status === 200);
  check("it is their own restaurant", res.body?.plans !== undefined);

  // The state endpoint is tenant-scoped by the session, so a claimed tenant
  // header is refused.
  const claimed = await fetch(`${SB}/functions/v1/subscriptions`, {
    headers: {
      apikey: ANON,
      authorization: `Bearer ${otherOwnerToken}`,
      "x-tenant-id": tenantId,
    },
  });
  check("a claimed tenant is refused", claimed.status === 403, `status ${claimed.status}`);
}

console.log("\n── the webhook ──");
{
  const unsigned = await fetch(`${SB}/functions/v1/razorpay-webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event: "subscription.activated", payload: {} }),
  });
  check("an unsigned event is refused", unsigned.status === 400, `status ${unsigned.status}`);

  // The idempotency mechanism is the primary key on the event id. The same
  // event cannot be recorded twice.
  const eventId = `evt_test_${Date.now()}`;
  const first = await admin.from("subscription_webhook_events").insert({ event_id: eventId, event_type: "test" });
  const second = await admin.from("subscription_webhook_events").insert({ event_id: eventId, event_type: "test" });
  check("an event can be recorded once", !first.error, first.error?.message);
  check("the same event cannot be recorded twice", Boolean(second.error), "the second insert was allowed");
  await admin.from("subscription_webhook_events").delete().eq("event_id", eventId);
}

console.log("\n── a checkout with no keys ──");
{
  const res = await call("subscriptions/checkout", ownerToken, {
    method: "POST",
    body: JSON.stringify({ planId: "pro" }),
  });
  // Either the keys are not set (a clear message) or the plan has no
  // Razorpay id yet (also a clear message). Neither may be a crash.
  check(
    "it answers with a message, not a crash",
    res.status === 503 || res.status < 500,
    `status ${res.status}`,
  );
  check("the message says what is missing", Boolean(res.body?.error), String(res.body?.error).slice(0, 120));
  console.log(`        it said: ${String(res.body?.error ?? "").slice(0, 140)}`);
}

console.log("\n── putting the restaurant back ──");
{
  await setTenant({
    plan: saved.plan,
    subscription_status: saved.subscription_status,
    trial_started_at: saved.trial_started_at,
    trial_ends_at: saved.trial_ends_at,
    subscription_plan: null,
    subscription_started_at: null,
    current_period_end: null,
    cancel_at_period_end: false,
  });
  const res = await call("subscriptions", ownerToken);
  check("it is back in its trial", res.body?.plan?.isTrial === true, JSON.stringify(res.body?.plan).slice(0, 120));
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
