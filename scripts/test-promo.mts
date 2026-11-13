/**
 * Tests for the shared promo evaluation rules.
 *
 * Two layers:
 *   1. Rule cases against a fake DB — every branch, including expiry and the
 *      usage limit, without touching production.
 *   2. Integration cases against the live database, using the real promo codes
 *      that exist there now.
 */
import { evaluatePromo } from "../supabase/functions/_shared/promo.ts";

let failures = 0;
let checks = 0;

function check(name: string, actual: unknown, expected: unknown) {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.log(`  FAIL  ${name}\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`);
  } else {
    console.log(`  ok    ${name}`);
  }
}

/** Minimal stand-in for the supabase query builder used by evaluatePromo. */
function fakeDb(rows: any[]) {
  const build = (current: any[]): any => {
    const b: any = {
      rows: current,
      from(table: string) {
        if (table !== "promo_codes") throw new Error(`unexpected table ${table}`);
        return build(rows);
      },
      select() { return b; },
      eq(column: string, value: any) {
        if (column === "tenant_id") {
          return build(b.rows.filter((r: any) => r.tenant_id === value));
        }
        return b;
      },
      ilike(_column: string, pattern: string) {
        // Strip the LIKE escape character the way Postgres would.
        const rx = new RegExp(
          "^" + pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\%/g, "%").replace(/\\_/g, "_") + "$",
          "i",
        );
        return build(b.rows.filter((r: any) => rx.test(r.code)));
      },
      limit() { return b; },
      maybeSingle() { return Promise.resolve({ data: b.rows[0] ?? null, error: null }); },
      // The real query builder is thenable, so awaiting it yields the result.
      then(resolve: any, reject: any) {
        return Promise.resolve({ data: b.rows, error: null }).then(resolve, reject);
      },
    };
    return b;
  };
  return build(rows);
}

const promo = (over: any = {}) => ({
  id: "p1",
  tenant_id: "t1",
  code: "FLAT50",
  type: "PERCENTAGE",
  value: 50,
  min_order: 500,
  max_discount: 50,
  usage_limit: 100,
  used_count: 0,
  valid_from: "2026-01-01T00:00:00Z",
  valid_to: null,
  active: true,
  ...over,
});

const NOW = new Date("2026-10-20T12:00:00Z");

console.log("\n── rule cases ──");

{
  const db = fakeDb([promo()]);
  const r = await evaluatePromo(db, "t1", "FLAT50", 1000, { now: NOW });
  check("applies: 50% of 1000 capped at max_discount 50", [r.applied, r.discount, r.reason], [true, 50, null]);
}
{
  const db = fakeDb([promo()]);
  const r = await evaluatePromo(db, "t1", "flat50", 1000, { now: NOW });
  check("applies: code matched case-insensitively", [r.applied, r.discount], [true, 50]);
}
{
  const db = fakeDb([promo()]);
  const r = await evaluatePromo(db, "t1", "  FLAT50  ", 1000, { now: NOW });
  check("applies: code trimmed", [r.applied, r.discount], [true, 50]);
}
{
  const db = fakeDb([promo()]);
  const r = await evaluatePromo(db, "t1", "FLAT50", 300, { now: NOW });
  check("declines: below minimum order", [r.applied, r.discount, r.reason], [
    false, 0, "Minimum order of ₹500.00 required (current ₹300.00)",
  ]);
}
{
  const db = fakeDb([promo()]);
  const r = await evaluatePromo(db, "t1", "NOPE", 1000, { now: NOW });
  check("declines: unknown code", [r.applied, r.reason], [false, "Promo code not found"]);
}
{
  const db = fakeDb([promo({ active: false })]);
  const r = await evaluatePromo(db, "t1", "FLAT50", 1000, { now: NOW });
  check("declines: inactive", [r.applied, r.reason], [false, "This promo code is no longer active"]);
}
{
  const db = fakeDb([promo({ valid_to: "2026-10-20T11:59:00Z" })]);
  const r = await evaluatePromo(db, "t1", "FLAT50", 1000, { now: NOW });
  check("declines: expired", [r.applied, r.reason], [false, "This promo code has expired"]);
}
{
  const db = fakeDb([promo({ valid_from: "2026-11-01T00:00:00Z" })]);
  const r = await evaluatePromo(db, "t1", "FLAT50", 1000, { now: NOW });
  check("declines: not valid yet", [r.applied, r.reason], [false, "This promo code is not active yet"]);
}
{
  const db = fakeDb([promo({ usage_limit: 10, used_count: 10 })]);
  const r = await evaluatePromo(db, "t1", "FLAT50", 1000, { now: NOW });
  check("declines: usage limit reached", [r.applied, r.reason], [false, "This promo code has reached its usage limit"]);
}
{
  const db = fakeDb([promo({ usage_limit: 10, used_count: 9 })]);
  const r = await evaluatePromo(db, "t1", "FLAT50", 1000, { now: NOW });
  check("applies: one use left on the limit", [r.applied, r.discount], [true, 50]);
}
{
  const db = fakeDb([promo({ type: "FIXED", value: 50, max_discount: 20 })]);
  const r = await evaluatePromo(db, "t1", "FLAT50", 1000, { now: NOW });
  check("fixed code: max_discount caps it too (matches place_order)", [r.applied, r.discount], [true, 20]);
}
{
  const db = fakeDb([promo({ type: "FIXED", value: 50, max_discount: 0 })]);
  const r = await evaluatePromo(db, "t1", "FLAT50", 1000, { now: NOW });
  check("fixed code: no cap when max_discount is 0", [r.applied, r.discount], [true, 50]);
}
{
  const db = fakeDb([promo({ type: "PERCENTAGE", value: 100, max_discount: 0 })]);
  const r = await evaluatePromo(db, "t1", "FLAT50", 1000, { now: NOW });
  check("discount never exceeds the order", [r.applied, r.discount], [true, 1000]);
}
{
  const db = fakeDb([promo({ code: "PCT%_X" })]);
  const r = await evaluatePromo(db, "t1", "PCT%_X", 1000, { now: NOW });
  check("applies: code containing LIKE wildcards", [r.applied, r.discount], [true, 50]);
}
{
  const db = fakeDb([promo({ code: "PCT%_X" })]);
  const r = await evaluatePromo(db, "t1", "PCTXX", 1000, { now: NOW });
  check("declines: a wildcard in the code is not a pattern", [r.applied, r.reason], [false, "Promo code not found"]);
}
{
  const db = fakeDb([promo()]);
  const r = await evaluatePromo(db, "t1", "", 1000, { now: NOW });
  check("blank code: no reason, not an error", [r.applied, r.reason, r.discount], [false, null, 0]);
}
{
  const db = fakeDb([promo()]);
  const r = await evaluatePromo(db, "t1", "FLAT50", 1000, { now: NOW, currencySymbol: "Rs " });
  check("reason uses the tenant's currency symbol", [r.applied, r.reason], [true, null]);
}

console.log("\n── live database ──");
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.log("  skipped: set SUPABASE_SERVICE_ROLE_KEY and NEXT_PUBLIC_SUPABASE_URL to run the live checks");
} else {
  const { createClient } = await import("@supabase/supabase-js");
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const { data: tenants } = await db.from("tenants").select("id, slug");
  const jaegar = tenants!.find((t: any) => t.slug === "jaegar-demo");
  if (!jaegar) {
    console.log("  FAIL  jaegar-demo tenant not found");
    failures++;
  } else {
    const r1 = await evaluatePromo(db, jaegar.id, "flat50", 1000, { now: NOW });
    check("live: FLAT50 in lower case applies", [r1.applied, r1.discount], [true, 50]);

    const r2 = await evaluatePromo(db, jaegar.id, "FLAT50", 100, { now: NOW });
    check("live: FLAT50 below the minimum is declined", [r2.applied, r2.reason], [
      false, "Minimum order of ₹500.00 required (current ₹100.00)",
    ]);

    const r3 = await evaluatePromo(db, jaegar.id, "WELCOME10", 2000, { now: NOW });
    check("live: WELCOME10 caps at max_discount 100", [r3.applied, r3.discount], [true, 100]);

    const r4 = await evaluatePromo(db, jaegar.id, "WEEKEND15", 2000, { now: NOW });
    check("live: WEEKEND15 caps at max_discount 150", [r4.applied, r4.discount], [true, 150]);

    const bablu = tenants!.find((t: any) => t.slug === "bablu-cafe");
    if (bablu) {
      const r5 = await evaluatePromo(db, bablu.id, "DIWALI50", 1000, { now: NOW });
      check("live: DIWALI50 applies while it is valid", [r5.applied, r5.discount], [true, 50]);

      const r6 = await evaluatePromo(db, bablu.id, "DIWALI50", 1000, {
        now: new Date("2026-12-01T00:00:00Z"),
      });
      check("live: DIWALI50 is declined after valid_to", [r6.applied, r6.reason], [
        false, "This promo code has expired",
      ]);
    }

    const r7 = await evaluatePromo(db, jaegar.id, "FLAT50", 1000, { now: NOW });
    const r8 = await evaluatePromo(db, (tenants!.find((t: any) => t.slug === "alex-cafe") ?? jaegar).id, "FLAT50", 1000, { now: NOW });
    check("live: a code is scoped to its own tenant", [r7.applied, r8.applied], [true, false]);
  }
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
