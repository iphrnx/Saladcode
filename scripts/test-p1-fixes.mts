/**
 * Regression test suite for P1 application code fixes:
 *  1. reminders.ts: orders.total (not total_amount) & daily digest revenue calculation
 *  2. subscriptions/index.ts: profiles.name (not full_name)
 *  3. super-admin/index.ts: no profiles.is_super_admin; uses super_admins allowlist
 *  4. superadmin-server.ts: port 3001 local dev origin, production lockdown, anti-spoofing
 */
import * as fs from "node:fs";
import * as assert from "node:assert/strict";
import { allowedAdminOrigins, resolveAdminOrigin } from "../src/lib/superadmin-server";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  FAIL  ${name}: ${err?.message ?? err}`);
  }
}

// 1. reminders.ts
const remindersSrc = fs.readFileSync("supabase/functions/_shared/reminders.ts", "utf8");
check("reminders.ts does not reference orders.total_amount", () => {
  assert.equal(/\btotal_amount\b/.test(remindersSrc), false);
});
check("reminders.ts selects orders.total and sums o.total", () => {
  assert.equal(/\.select\("id, total, status"\)/.test(remindersSrc), true);
  assert.equal(/Number\(o\.total\)/.test(remindersSrc), true);
});

// 2. subscriptions/index.ts
const subsSrc = fs.readFileSync("supabase/functions/subscriptions/index.ts", "utf8");
check("subscriptions/index.ts does not reference profiles.full_name", () => {
  assert.equal(/\bfull_name\b/.test(subsSrc), false);
});
check("subscriptions/index.ts selects profiles(email, name) and reads profile?.name", () => {
  assert.equal(/\.select\("email, name"\)/.test(subsSrc), true);
  assert.equal(/profile\?\.name/.test(subsSrc), true);
});

// 3. super-admin/index.ts & _shared/super_admin.ts
const saSrc = fs.readFileSync("supabase/functions/super-admin/index.ts", "utf8");
const saGuardSrc = fs.readFileSync("supabase/functions/_shared/super_admin.ts", "utf8");
check("super-admin/index.ts does not select profiles.is_super_admin", () => {
  assert.equal(/\bis_super_admin\b/.test(saSrc), false);
});
check("superGuard authorizes strictly via public.super_admins", () => {
  assert.equal(/\.from\("super_admins"\)/.test(saGuardSrc), true);
});

// 4. superadmin-server.ts
check("resolveAdminOrigin permits localhost:3001 and 127.0.0.1:3001 in development", () => {
  const req1 = new Request("http://localhost:3001/api/auth/otp", {
    headers: { host: "localhost:3001" },
  });
  assert.equal(resolveAdminOrigin(req1, "development"), "http://localhost:3001");

  const req2 = new Request("http://127.0.0.1:3001/api/auth/otp", {
    headers: { host: "127.0.0.1:3001" },
  });
  assert.equal(resolveAdminOrigin(req2, "development"), "http://127.0.0.1:3001");
});

check("resolveAdminOrigin rejects localhost/127.0.0.1 in production", () => {
  const prodOrigins = allowedAdminOrigins("production");
  assert.equal(prodOrigins.some((o) => o.includes("localhost") || o.includes("127.0.0.1")), false);

  const reqLocal3001 = new Request("http://localhost:3001/api/auth/otp", {
    headers: { host: "localhost:3001" },
  });
  assert.equal(resolveAdminOrigin(reqLocal3001, "production"), "https://www.thesalad.in");

  const reqProd = new Request("https://thesalad.in/api/auth/otp", {
    headers: { host: "thesalad.in", "x-forwarded-proto": "https" },
  });
  assert.equal(resolveAdminOrigin(reqProd, "production"), "https://thesalad.in");
});

check("resolveAdminOrigin rejects spoofed prefix-matching hosts", () => {
  const reqSpoof = new Request("https://thesalad.in.evil.com/api/auth/otp", {
    headers: { host: "thesalad.in.evil.com", "x-forwarded-proto": "https" },
  });
  assert.equal(resolveAdminOrigin(reqSpoof, "development"), "https://www.thesalad.in");
  assert.equal(resolveAdminOrigin(reqSpoof, "production"), "https://www.thesalad.in");
});

console.log(`\nP1 regression tests: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
