/**
 * Test suite: Pricing plans and QR code limits verification
 *
 * 1. Verifies Starter is ₹999/month, 50 QR codes maximum in database.
 * 2. Verifies Pro is ₹2,499/month, 100 QR codes maximum in database.
 * 3. Verifies Enterprise (5999) plan is completely removed.
 * 4. Verifies GET /functions/v1/plans returns Starter (50 QR) and Pro (100 QR) with no Enterprise.
 * 5. Verifies landing page fallback plans display 50 and 100 QR limits and remove 5999 plan.
 *
 * Run: node --env-file=.env.local node_modules/.bin/tsx scripts/test-pricing-plans-and-qr-limits.mts
 */
import { createClient } from "@supabase/supabase-js";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

console.log("=== Testing Pricing Plans & QR Limits ===");

async function testDatabasePlans() {
  console.log("\n1. Verifying subscription_plans in Supabase...");
  const sb = createClient(SB, ANON);

  const { data: plans, error } = await sb
    .from("subscription_plans")
    .select("id, name, price_monthly, price_yearly, max_tables, features, is_active")
    .order("sort_order", { ascending: true });

  if (error) {
    console.error("Failed to query subscription_plans:", error);
    process.exit(1);
  }

  console.log(`Found ${plans?.length} plans:`, plans?.map((p) => p.id));

  // 1. Enterprise must NOT exist
  const enterprise = plans?.find((p) => p.id === "enterprise");
  if (enterprise) {
    console.error("FAIL: Enterprise plan still exists in subscription_plans!");
    process.exit(1);
  }
  console.log("✔ Enterprise plan (5999) is completely removed from database");

  // 2. Starter check
  const starter = plans?.find((p) => p.id === "starter");
  if (!starter) {
    console.error("FAIL: Starter plan not found!");
    process.exit(1);
  }
  if (Number(starter.price_monthly) !== 999) {
    console.error(`FAIL: Starter price is ${starter.price_monthly}, expected 999`);
    process.exit(1);
  }
  if (starter.max_tables !== 50) {
    console.error(`FAIL: Starter max_tables is ${starter.max_tables}, expected 50`);
    process.exit(1);
  }
  if (!starter.features.includes("50 QR codes maximum")) {
    console.error("FAIL: Starter features does not include '50 QR codes maximum'");
    process.exit(1);
  }
  console.log("✔ Starter plan: ₹999/mo, max_tables = 50, '50 QR codes maximum'");

  // 3. Pro check
  const pro = plans?.find((p) => p.id === "pro");
  if (!pro) {
    console.error("FAIL: Pro plan not found!");
    process.exit(1);
  }
  if (Number(pro.price_monthly) !== 2499) {
    console.error(`FAIL: Pro price is ${pro.price_monthly}, expected 2499`);
    process.exit(1);
  }
  if (pro.max_tables !== 100) {
    console.error(`FAIL: Pro max_tables is ${pro.max_tables}, expected 100`);
    process.exit(1);
  }
  if (!pro.features.includes("100 QR codes maximum")) {
    console.error("FAIL: Pro features does not include '100 QR codes maximum'");
    process.exit(1);
  }
  console.log("✔ Pro plan: ₹2,499/mo, max_tables = 100, '100 QR codes maximum'");
}

async function testPublicPlansApi() {
  console.log("\n2. Verifying Edge Function /functions/v1/plans endpoint...");
  const res = await fetch(`${SB}/functions/v1/plans`, {
    headers: { apikey: ANON },
  });
  if (!res.ok) {
    console.error(`FAIL: GET /functions/v1/plans returned ${res.status}`);
    process.exit(1);
  }
  const data = await res.json();
  const plans = data?.plans ?? [];
  console.log(`API returned ${plans.length} active plans:`, plans.map((p: any) => p.id));

  if (plans.length !== 2) {
    console.error(`FAIL: Expected exactly 2 plans, got ${plans.length}`);
    process.exit(1);
  }

  const enterprise = plans.find((p: any) => p.id === "enterprise");
  if (enterprise) {
    console.error("FAIL: Enterprise plan returned by /functions/v1/plans!");
    process.exit(1);
  }
  console.log("✔ Enterprise plan absent from /functions/v1/plans");

  const starter = plans.find((p: any) => p.id === "starter");
  if (!starter || starter.priceMonthly !== 999) {
    console.error("FAIL: Starter plan incorrect in /functions/v1/plans:", starter);
    process.exit(1);
  }
  if (!starter.features.includes("50 QR codes maximum")) {
    console.error("FAIL: Starter features missing '50 QR codes maximum' in /functions/v1/plans");
    process.exit(1);
  }
  console.log("✔ Starter verified in /functions/v1/plans: ₹999, '50 QR codes maximum'");

  const pro = plans.find((p: any) => p.id === "pro");
  if (!pro || pro.priceMonthly !== 2499) {
    console.error("FAIL: Pro plan incorrect in /functions/v1/plans:", pro);
    process.exit(1);
  }
  if (!pro.features.includes("100 QR codes maximum")) {
    console.error("FAIL: Pro features missing '100 QR codes maximum' in /functions/v1/plans");
    process.exit(1);
  }
  console.log("✔ Pro verified in /functions/v1/plans: ₹2,499, '100 QR codes maximum'");
}

async function testLandingPageFallback() {
  console.log("\n3. Verifying landing page fallback plans...");
  const fs = await import("fs");
  const landingCode = fs.readFileSync("src/components/landing/landing-page.tsx", "utf8");

  if (landingCode.includes("5999") || landingCode.includes("'enterprise'")) {
    console.error("FAIL: landing-page.tsx still references 5999 or enterprise plan!");
    process.exit(1);
  }
  console.log("✔ landing-page.tsx completely free of 5999 / enterprise plan");

  if (!landingCode.includes("'50 QR codes maximum'")) {
    console.error("FAIL: landing-page.tsx does not display '50 QR codes maximum' for Starter");
    process.exit(1);
  }
  if (!landingCode.includes("'100 QR codes maximum'")) {
    console.error("FAIL: landing-page.tsx does not display '100 QR codes maximum' for Pro");
    process.exit(1);
  }
  console.log("✔ landing-page.tsx displays '50 QR codes maximum' and '100 QR codes maximum'");
}

async function run() {
  await testDatabasePlans();
  await testPublicPlansApi();
  await testLandingPageFallback();
  console.log("\n=== ALL PRICING & QR LIMIT TESTS PASSED SUCCESSFULLY ===");
}

run().catch((e) => {
  console.error("Test execution failed:", e);
  process.exit(1);
});
