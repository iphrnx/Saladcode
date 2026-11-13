/**
 * Migrate every role in every tenant to the granular RBAC key set.
 *
 * System roles take the new DEFAULT_ROLES spec (Kitchen/Cashier/Waiter are
 * deliberately slimmed per the workflow redesign — that IS the change being
 * approved). Custom roles are migrated *preserving everything they had*:
 *
 *   old `orders.manage`  => orders.view, orders.create, orders.edit,
 *                           orders.cancel, orders.complete, orders.prepare,
 *                           orders.ready, orders.serve, orders.discount,
 *                           payments.collect      (the full order + collect set)
 *   old `tables.manage`  => stays (table CRUD) + table-sessions.manage (the
 *                           session-ending it used to include)
 *   hard DELETE          => intentionally moves to owner-tier (roles.manage);
 *                           cancellation (orders.cancel) preserves the row.
 *
 * Dry-run by default — prints the full old→new diff and touches nothing.
 *
 *   node --env-file=.env.local node_modules/.bin/tsx scripts/migrate-rbac-granular.mts          # dry run
 *   node --env-file=.env.local node_modules/.bin/tsx scripts/migrate-rbac-granular.mts --apply   # apply
 */
import { createClient } from "@supabase/supabase-js";
import { DEFAULT_ROLES } from "../supabase/functions/_shared/permissions.ts";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const APPLY = process.argv.includes("--apply");
const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });

/** The granular preserve-all expansion of an old, coarse custom role. */
function migrateCustom(permissions: string): string {
  const raw = permissions.trim();
  const hadJson = raw.startsWith("[");
  const old = hadJson
    ? (JSON.parse(raw) as string[])
    : raw.split(",").map((p) => p.trim()).filter(Boolean);
  const kept = old.filter((p) => p !== "orders.manage");
  const out = new Set(kept);
  if (old.includes("orders.manage")) {
    for (const k of [
      "orders.view", "orders.create", "orders.edit", "orders.cancel",
      "orders.complete", "orders.prepare", "orders.ready", "orders.serve",
      "orders.discount", "payments.collect",
    ]) out.add(k);
  }
  if (old.includes("tables.manage")) out.add("table-sessions.manage");
  // Owner custom? A system Owner keeps full access via DEFAULT_ROLES below.
  return [...out].join(",");
}

const { data: roles, error } = await admin
  .from("roles")
  .select("id, tenant_id, name, is_system, permissions");
if (error) {
  console.error("read roles failed:", error.message);
  process.exit(1);
}

console.log(`\n=== GRANULAR RBAC MIGRATION (${APPLY ? "APPLY" : "DRY RUN — no changes"}) ===\n`);

let changed = 0;
const defaultByRole = new Map(DEFAULT_ROLES.map((r) => [r.name, r.permissions]));

for (const row of roles ?? []) {
  const next = row.is_system
    ? defaultByRole.get(row.name as string)
    : migrateCustom(String(row.permissions ?? ""));
  if (next === undefined) {
    console.log(`  SKIP  ${row.name.padEnd(10)} (unknown system role name — left as-is)`);
    continue;
  }
  const old = String(row.permissions ?? "");
  if (old === next) continue;
  changed++;
  console.log(`  ${row.is_system ? "SYS" : "CUS"}  ${String(row.name).padEnd(12)} [${row.tenant_id.slice(0, 8)}…]`);
  console.log(`      old: ${old}`);
  console.log(`      new: ${next}`);
  if (APPLY) {
    const { error: upErr } = await admin
      .from("roles")
      .update({ permissions: next })
      .eq("id", row.id);
    if (upErr) console.log(`      UPDATE FAILED: ${upErr.message}`);
  }
}

console.log(`\n${changed} role rows ${APPLY ? "updated" : "would change"}.`);
if (!APPLY) {
  console.log("Re-run with --apply to update them. Production must be approved first.");
}
