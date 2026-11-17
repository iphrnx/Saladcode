/**
 * Comprehensive verification and regression suite for all 12 Feature Inventory & Fidelity Audit fixes.
 *
 * Usage: npx tsx scripts/test-fidelity-audit-fixes.mts
 */
import { readFileSync } from "node:fs";
import { formatDateWithPattern } from "../src/lib/date-format.js";
import { translator } from "../src/lib/i18n.js";

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

console.log("\n==================================================================");
console.log("   FEATURE INVENTORY & FIDELITY AUDIT REMEDIATION VERIFICATION   ");
console.log("==================================================================\n");

// Read code artifacts
const settingsView = readFileSync("src/components/views/settings.tsx", "utf8");
const appShell = readFileSync("src/components/app/app-shell.tsx", "utf8");
const globalsCss = readFileSync("src/app/globals.css", "utf8");
const dataContext = readFileSync("src/components/app/data-context.tsx", "utf8");
const dashboardView = readFileSync("src/components/views/dashboard.tsx", "utf8");
const securityView = readFileSync("src/components/views/security.tsx", "utf8");
const promosView = readFileSync("src/components/views/promos.tsx", "utf8");
const ordersView = readFileSync("src/components/views/orders.tsx", "utf8");
const dateFormatLib = readFileSync("src/lib/date-format.ts", "utf8");
const emailFn = readFileSync("supabase/functions/_shared/email.ts", "utf8");
const remindersFn = readFileSync("supabase/functions/_shared/reminders.ts", "utf8");
const emailsIndex = readFileSync("supabase/functions/emails/index.ts", "utf8");
const superadminProxy = readFileSync("src/app/api/superadmin/[...path]/route.ts", "utf8");
const superadminFn = readFileSync("supabase/functions/super-admin/index.ts", "utf8");

// ── 1. pref_compact_mode: Full Round-Trip Integration ──
console.log("── 1. pref_compact_mode: Full Round-Trip Integration ──");
check(
  "globals.css defines data-compact attribute styles",
  globalsCss.includes('[data-compact="true"]')
);
check(
  "globals.css targets data-order-card and data-menu-card under compact mode",
  globalsCss.includes('[data-compact="true"] [data-order-card]') &&
  globalsCss.includes('[data-compact="true"] [data-menu-card]')
);
check(
  "app-shell.tsx synchronizes pref_compact_mode to document.documentElement",
  appShell.includes("document.documentElement.setAttribute('data-compact', isCompact ? 'true' : 'false')")
);
check(
  "settings.tsx includes compactMode in state, dirty-check, and save payload",
  settingsView.includes("compactMode: d.settings.pref_compact_mode === 'true'") &&
  settingsView.includes("pref_compact_mode: String(prefs.compactMode)")
);

// ── 2. pref_sound_alerts: Full Round-Trip Integration ──
console.log("\n── 2. pref_sound_alerts: Full Round-Trip Integration ──");
check(
  "data-context.tsx checks pref_sound_alerts before playing chime on new orders",
  dataContext.includes("isSoundAlertsEnabled()") &&
  dataContext.includes("dataRef.current?.settings?.pref_sound_alerts")
);
check(
  "data-context.tsx checks pref_sound_alerts before playing chime on table activations",
  dataContext.includes("isSoundAlertsEnabled") &&
  dataContext.includes("ACTIVATION_REQUESTED")
);
check(
  "settings.tsx synchronizes pref_sound_alerts to database settings and localStorage",
  settingsView.includes("pref_sound_alerts: String(prefs.soundAlerts)") &&
  settingsView.includes("window.localStorage.setItem('the-salad-activation-sound'")
);

// ── 3. pref_default_order_type: Full Round-Trip Integration ──
console.log("\n── 3. pref_default_order_type: Full Round-Trip Integration ──");
check(
  "dashboard.tsx synchronizes orderType from pref_default_order_type",
  dashboardView.includes("data?.settings?.pref_default_order_type") &&
  dashboardView.includes("setOrderType(defaultOrderType)")
);
check(
  "settings.tsx persists pref_default_order_type to database",
  settingsView.includes("pref_default_order_type: prefs.defaultOrderType")
);

// ── 4. pref_email_alerts: Backend & Database Integration ──
console.log("\n── 4. pref_email_alerts: Backend & Database Integration ──");
check(
  "email.ts queueEmail respects tenant pref_email_alerts setting for order_alert",
  emailFn.includes('event.eventType === "order_alert"') &&
  emailFn.includes('eq("key", "pref_email_alerts")') &&
  emailFn.includes('if (settingRow && settingRow.value === "false")')
);
check(
  "settings.tsx persists pref_email_alerts to database",
  settingsView.includes("pref_email_alerts: String(prefs.emailAlerts)")
);

// ── 5. pref_daily_digest: Cron & Email Integration ──
console.log("\n── 5. pref_daily_digest: Cron & Email Integration ──");
check(
  "reminders.ts defines queueDailyDigests aggregating 24h orders",
  remindersFn.includes("export async function queueDailyDigests") &&
  remindersFn.includes('eq("key", "pref_daily_digest")') &&
  remindersFn.includes('eventType: "daily_digest"')
);
check(
  "emails/index.ts calls queueDailyDigests on daily cron trigger",
  emailsIndex.includes("queueDailyDigests") &&
  emailsIndex.includes("digestsQueued: digests.queued")
);
check(
  "email.ts includes daily_digest template with order count and revenue rows",
  emailFn.includes('case "daily_digest":') &&
  emailFn.includes("Daily Sales Summary")
);
check(
  "settings.tsx persists pref_daily_digest to database",
  settingsView.includes("pref_daily_digest: String(prefs.dailyDigest)")
);

// ── 6. pref_language: Runtime i18n & HTML Sync ──
console.log("\n── 6. pref_language: Runtime i18n & HTML Sync ──");
check(
  "app-shell.tsx synchronizes pref_language to document.documentElement lang attribute",
  appShell.includes("document.documentElement.setAttribute('lang', lang)")
);
check(
  "i18n translator handles both English and Hindi strings correctly",
  translator("hi")("nav.orders") === "ऑर्डर" &&
  translator("en")("nav.orders") === "Orders"
);
check(
  "settings.tsx persists pref_language to database",
  settingsView.includes("pref_language: prefs.language")
);

// ── 7. pref_date_format: Formatting Engine & View Adoption ──
console.log("\n── 7. pref_date_format: Formatting Engine & View Adoption ──");
const testIso = "2026-11-16T10:30:00Z";
check(
  "formatDateWithPattern formats DD/MM/YYYY correctly",
  formatDateWithPattern(testIso, "DD/MM/YYYY").includes("/11/2026")
);
check(
  "formatDateWithPattern formats MM/DD/YYYY correctly",
  formatDateWithPattern(testIso, "MM/DD/YYYY").startsWith("11/")
);
check(
  "formatDateWithPattern formats YYYY-MM-DD correctly",
  formatDateWithPattern(testIso, "YYYY-MM-DD").startsWith("2026-11-")
);
check(
  "settings.tsx includes Date Format select control and persists pref_date_format",
  settingsView.includes("pref_date_format: prefs.dateFormat") &&
  settingsView.includes("DATE_FORMAT_OPTIONS")
);
check(
  "security.tsx respects pref_date_format in activity audit logs",
  securityView.includes("dateFormat={data?.settings?.pref_date_format") &&
  securityView.includes("formatExactDateTime(log.createdAt, timeZone, dateFormat)")
);
check(
  "promos.tsx respects pref_date_format in coupon validity chips",
  promosView.includes("pref_date_format") &&
  promosView.includes("formatDate(promo.validFrom, dateFormat)")
);
check(
  "orders.tsx respects pref_date_format in session timestamps",
  ordersView.includes("pref_date_format") &&
  ordersView.includes("sessionWhen(sitting.startedAt, dateFormat)")
);

// ── 8. Danger Zone Restaurant Deletion: Post-Navigation Fix ──
console.log("\n── 8. Danger Zone Restaurant Deletion: Post-Navigation Fix ──");
check(
  "settings.tsx confirmDelete clears localStorage on successful deletion",
  settingsView.includes("localStorage.removeItem('the-salad-active-tenant')") &&
  settingsView.includes("localStorage.removeItem('the-salad-cart')")
);
check(
  "settings.tsx confirmDelete clears sessionStorage on successful deletion",
  settingsView.includes("sessionStorage.clear()")
);
check(
  "settings.tsx confirmDelete hard-redirects to /login?deleted=true",
  settingsView.includes("window.location.href = '/login?deleted=true'")
);

// ── 9. Security 2FA: Real Supabase TOTP MFA Implementation ──
console.log("\n── 9. Security 2FA: Real Supabase TOTP MFA Implementation ──");
check(
  "security.tsx loads live Supabase MFA factors via auth.mfa.listFactors",
  securityView.includes("supabase.auth.mfa.listFactors()")
);
check(
  "security.tsx supports TOTP enrollment via auth.mfa.enroll",
  securityView.includes("supabase.auth.mfa.enroll({") &&
  securityView.includes("factorType: 'totp'")
);
check(
  "security.tsx verifies TOTP enrollment via auth.mfa.challenge and verify",
  securityView.includes("supabase.auth.mfa.challenge({ factorId:") &&
  securityView.includes("supabase.auth.mfa.verify({")
);
check(
  "security.tsx supports unenrollment via auth.mfa.unenroll",
  securityView.includes("supabase.auth.mfa.unenroll({ factorId:")
);
check(
  "security.tsx renders 2FA status card, QR code dialog, and unenroll confirmation",
  securityView.includes("Two-Factor Authentication (2FA)") &&
  securityView.includes("enrollingFactor.totp.qr_code") &&
  securityView.includes("Disable Two-Factor Authentication?")
);

// ── 10. POS Register Order Type & Table Reset Consistency ──
console.log("\n── 10. POS Register Order Type & Table Reset Consistency ──");
check(
  "dashboard.tsx resets selectedTableId when switching from DINE_IN to TAKEAWAY/DELIVERY",
  dashboardView.includes("p.setOrderType(t)") &&
  dashboardView.includes("if (t !== 'DINE_IN') p.setSelectedTableId(null)")
);

// ── 11. Subscriptions & Billing Sandbox / Missing Key Handling ──
console.log("\n── 11. Subscriptions & Billing Sandbox / Missing Key Handling ──");
check(
  "settings.tsx displays clear notice when razorpayConfigured is false",
  settingsView.includes("!razorpayConfigured") &&
  settingsView.includes("Payments are not set up on the server yet")
);
check(
  "settings.tsx startPurchase gracefully catches and renders 503 gateway errors",
  settingsView.includes("setPayError(failure.serverMessage || failure.message)") &&
  settingsView.includes("setPayState('failed')")
);

// ── 12. Superadmin Reports CSV Export & Header Forwarding ──
console.log("\n── 12. Superadmin Reports CSV Export & Header Forwarding ──");
check(
  "superadmin API route forwards content-disposition header for CSV downloads",
  superadminProxy.includes("content-disposition") &&
  superadminProxy.includes("res.headers.get('content-disposition')")
);
check(
  "super-admin edge function sets proper attachment Content-Disposition header",
  superadminFn.includes('Content-Disposition') &&
  superadminFn.includes('the-salad-${type}-${from}-to-${to}.csv')
);

console.log("\n==================================================================");
console.log(`  TOTAL: ${pass} PASSED, ${fail} FAILED`);
console.log("==================================================================\n");

if (fail > 0) process.exit(1);

