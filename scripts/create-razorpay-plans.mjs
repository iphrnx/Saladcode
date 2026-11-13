#!/usr/bin/env node
/**
 * Creates the four recurring Razorpay plans this product sells, idempotently,
 * and prints the SQL that points the catalogue at them.
 *
 *   RAZORPAY_KEY_ID=... RAZORPAY_KEY_SECRET=... node scripts/create-razorpay-plans.mjs
 *
 * Safe to re-run: a plan with the same period, amount and product tag is
 * reused rather than duplicated. It never deletes anything, and it does not
 * touch the database itself — it prints the two `update` statements so a human
 * can read them before they run.
 */

const KEY_ID = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

if (!KEY_ID || !KEY_SECRET) {
  console.error("Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET (test keys are fine).");
  process.exit(1);
}

const auth = "Basic " + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString("base64");

async function api(path, init = {}) {
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    ...init,
    headers: { authorization: auth, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

const WANTED = [
  { plan: "starter", interval: "monthly", period: "monthly", amount: 99900, name: "The Salad Starter — Monthly" },
  { plan: "starter", interval: "annual", period: "yearly", amount: 999000, name: "The Salad Starter — Annual" },
  { plan: "pro", interval: "monthly", period: "monthly", amount: 249900, name: "The Salad Pro — Monthly" },
  { plan: "pro", interval: "annual", period: "yearly", amount: 2499000, name: "The Salad Pro — Annual" },
];

const existing = await api("/plans?count=100");
const found = {};

for (const want of WANTED) {
  const match = (existing.items ?? []).find(
    (p) => Number(p.item?.amount) === want.amount && p.period === want.period && p.item?.name === want.name,
  );
  if (match) {
    found[`${want.plan}:${want.interval}`] = match.id;
    console.log(`reuse  ${want.name}  ${match.id}`);
    continue;
  }
  const created = await api("/plans", {
    method: "POST",
    body: JSON.stringify({
      period: want.period,
      interval: 1,
      item: { name: want.name, amount: want.amount, currency: "INR", description: `${want.plan} plan, billed ${want.interval}` },
      notes: { the_salad_plan: want.plan, the_salad_interval: want.interval },
    }),
  });
  found[`${want.plan}:${want.interval}`] = created.id;
  console.log(`create ${want.name}  ${created.id}`);
}

console.log("\n-- run these once the ids above are confirmed:");
console.log(`update public.subscription_plans set razorpay_plan_id = '${found["starter:monthly"]}', razorpay_plan_id_yearly = '${found["starter:annual"]}' where id = 'starter';`);
console.log(`update public.subscription_plans set razorpay_plan_id = '${found["pro:monthly"]}', razorpay_plan_id_yearly = '${found["pro:annual"]}' where id = 'pro';`);
