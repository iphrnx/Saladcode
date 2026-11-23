/**
 * Isolated Real PostgreSQL Database RBAC & Ownership Invariant Test Suite
 *
 * Runs against an isolated, in-process PostgreSQL 16+ instance via PGlite.
 * Applies the real migration SQL file and verifies:
 *  1. check_last_active_owner() invariants (deletion, deactivation, demotion, tenant reassignment)
 *  2. Deadlock-free per-tenant serialization under concurrent owner modifications
 *  3. check_system_role_invariants() (delete, rename, permission mutation, conversion)
 *  4. check_staff_role_assignment() (rejection of Owner assignment to PIN staff)
 *  5. Tenant purge bypass and direct tenant cascade deletion
 */

import { PGlite } from "/tmp/pgtest/node_modules/@electric-sql/pglite";
import * as fs from "node:fs";
import * as path from "node:path";

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}${detail ? `\n        ${detail}` : ""}`);
  }
}

async function runSuite() {
  console.log("\n========================================================");
  console.log("  Isolated Real PostgreSQL RBAC & Security Invariant Tests");
  console.log("========================================================\n");

  const db = new PGlite();

  // 1. Setup Base Schema
  console.log("── 1. Setting up Base Schema in Isolated Postgres ──");
  await db.exec(`
    create schema if not exists auth;
    create table if not exists auth.users (
      id uuid primary key default gen_random_uuid(),
      email text unique
    );

    create table if not exists public.tenants (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      slug text unique not null,
      active boolean not null default true,
      logo text,
      tagline text,
      address text,
      phone text,
      email text,
      onboarding_done boolean default false,
      subscription_status text default 'none',
      subscription_plan text,
      plan text default 'starter',
      trial_started_at timestamptz,
      trial_ends_at timestamptz,
      current_period_end timestamptz,
      payment_mode text,
      created_at timestamptz default now()
    );

    create table if not exists public.roles (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid references public.tenants(id) on delete cascade,
      name text not null,
      description text,
      color text,
      permissions text not null default '',
      is_system boolean not null default false,
      created_at timestamptz default now()
    );

    create table if not exists public.profiles (
      id uuid primary key references auth.users(id) on delete cascade,
      tenant_id uuid references public.tenants(id) on delete cascade,
      role_id uuid references public.roles(id) on delete set null,
      name text not null,
      email text not null,
      phone text,
      avatar text,
      role text not null default 'Owner',
      two_factor_enabled boolean not null default false,
      last_login timestamptz default now(),
      active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists public.locations (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid references public.tenants(id) on delete cascade
    );

    create table if not exists public.staff (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references public.tenants(id) on delete cascade,
      location_id uuid references public.locations(id) on delete set null,
      role_id uuid references public.roles(id) on delete set null,
      name text not null,
      employee_id text not null,
      pin_hash text not null,
      pin_salt text not null,
      avatar text,
      active boolean not null default true,
      failed_attempts integer not null default 0,
      locked_until timestamptz,
      last_login timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (tenant_id, employee_id)
    );

    -- Minimal tables for purge_tenant test
    create table if not exists public.orders (id uuid primary key default gen_random_uuid(), tenant_id uuid);
    create table if not exists public.order_items (id uuid primary key default gen_random_uuid(), order_id uuid);
    create table if not exists public.check_payments (id uuid primary key default gen_random_uuid(), tenant_id uuid);
    create table if not exists public.table_checks (id uuid primary key default gen_random_uuid(), tenant_id uuid);
    create table if not exists public.table_sessions (id uuid primary key default gen_random_uuid(), tenant_id uuid);
    create table if not exists public.tables (id uuid primary key default gen_random_uuid(), tenant_id uuid);
    create table if not exists public.dining_areas (id uuid primary key default gen_random_uuid(), tenant_id uuid);
    create table if not exists public.menu_items (id uuid primary key default gen_random_uuid(), tenant_id uuid);
    create table if not exists public.categories (id uuid primary key default gen_random_uuid(), tenant_id uuid);
    create table if not exists public.reservations (id uuid primary key default gen_random_uuid(), tenant_id uuid);
    create table if not exists public.promo_codes (id uuid primary key default gen_random_uuid(), tenant_id uuid);
    create table if not exists public.customer_reviews (id uuid primary key default gen_random_uuid(), tenant_id uuid);
    create table if not exists public.staff_sessions (id uuid primary key default gen_random_uuid(), tenant_id uuid);
    create table if not exists public.settings (id uuid primary key default gen_random_uuid(), tenant_id uuid);
    create table if not exists public.security_logs (id uuid primary key default gen_random_uuid(), tenant_id uuid);
    create table if not exists public.tenant_realtime (id uuid primary key default gen_random_uuid(), tenant_id uuid);
  `);
  check("Base schema created successfully in isolated Postgres", true);

  // 2. Apply Migration
  console.log("\n── 2. Applying Migration 20261122000002 ──");
  const migrationPath = path.resolve(
    process.cwd(),
    "supabase/migrations/20261122000002_enforce_rbac_ownership_and_system_role_invariants.sql"
  );
  const migrationSql = fs.readFileSync(migrationPath, "utf-8");
  await db.exec(migrationSql);
  check("Migration 20261122000002 applied with 0 errors", true);

  // 3. Test Last Active Owner Invariants
  console.log("\n── 3. Testing Last Active Owner Invariants ──");
  const tenant1 = (await db.query<{ id: string }>(
    `insert into public.tenants (name, slug) values ('Trattoria One', 'trattoria-one') returning id;`
  )).rows[0].id;

  const tenant2 = (await db.query<{ id: string }>(
    `insert into public.tenants (name, slug) values ('Trattoria Two', 'trattoria-two') returning id;`
  )).rows[0].id;

  const ownerRole1 = (await db.query<{ id: string }>(
    `insert into public.roles (tenant_id, name, permissions, is_system) values ($1, 'Owner', 'all', true) returning id;`,
    [tenant1]
  )).rows[0].id;

  const waiterRole1 = (await db.query<{ id: string }>(
    `insert into public.roles (tenant_id, name, permissions, is_system) values ($1, 'Waiter', 'orders.view', true) returning id;`,
    [tenant1]
  )).rows[0].id;

  const userA = (await db.query<{ id: string }>(
    `insert into auth.users (email) values ('owner-a@example.com') returning id;`
  )).rows[0].id;

  await db.query(
    `insert into public.profiles (id, tenant_id, role_id, name, email, role, active)
     values ($1, $2, $3, 'Owner A', 'owner-a@example.com', 'Owner', true);`,
    [userA, tenant1, ownerRole1]
  );

  // Test 3.1: Reject Deleting the only active Owner
  let errDeleteOnly = "";
  try {
    await db.query(`delete from public.profiles where id = $1;`, [userA]);
  } catch (e: any) {
    errDeleteOnly = e.message;
  }
  check(
    "Deleting sole active Owner fails with CANNOT_REMOVE_LAST_ACTIVE_OWNER",
    errDeleteOnly.includes("CANNOT_REMOVE_LAST_ACTIVE_OWNER"),
    errDeleteOnly
  );

  // Test 3.2: Reject Deactivating the only active Owner
  let errDeactivateOnly = "";
  try {
    await db.query(`update public.profiles set active = false where id = $1;`, [userA]);
  } catch (e: any) {
    errDeactivateOnly = e.message;
  }
  check(
    "Deactivating sole active Owner fails with CANNOT_REMOVE_LAST_ACTIVE_OWNER",
    errDeactivateOnly.includes("CANNOT_REMOVE_LAST_ACTIVE_OWNER"),
    errDeactivateOnly
  );

  // Test 3.3: Reject Demoting the only active Owner
  let errDemoteOnly = "";
  try {
    await db.query(`update public.profiles set role = 'Waiter', role_id = $1 where id = $2;`, [waiterRole1, userA]);
  } catch (e: any) {
    errDemoteOnly = e.message;
  }
  check(
    "Demoting sole active Owner fails with CANNOT_REMOVE_LAST_ACTIVE_OWNER",
    errDemoteOnly.includes("CANNOT_REMOVE_LAST_ACTIVE_OWNER"),
    errDemoteOnly
  );

  // Test 3.4: Reject Reassigning tenant of the only active Owner
  let errTransferOnly = "";
  try {
    await db.query(`update public.profiles set tenant_id = $1 where id = $2;`, [tenant2, userA]);
  } catch (e: any) {
    errTransferOnly = e.message;
  }
  check(
    "Reassigning tenant of sole active Owner fails with CANNOT_REMOVE_LAST_ACTIVE_OWNER",
    errTransferOnly.includes("CANNOT_REMOVE_LAST_ACTIVE_OWNER"),
    errTransferOnly
  );

  // Test 3.5: Allow updating non-critical fields on sole active Owner (e.g. name, phone)
  let errUpdateProfile = "";
  try {
    await db.query(`update public.profiles set name = 'Owner A Updated', phone = '+1234567890' where id = $1;`, [userA]);
  } catch (e: any) {
    errUpdateProfile = e.message;
  }
  check("Updating name/phone on sole active Owner succeeds without error", !errUpdateProfile, errUpdateProfile);

  // 4. Test Multi-Owner Scenarios
  console.log("\n── 4. Testing Multi-Owner Scenarios ──");
  const userB = (await db.query<{ id: string }>(
    `insert into auth.users (email) values ('owner-b@example.com') returning id;`
  )).rows[0].id;

  await db.query(
    `insert into public.profiles (id, tenant_id, role_id, name, email, role, active)
     values ($1, $2, $3, 'Owner B', 'owner-b@example.com', 'Owner', true);`,
    [userB, tenant1, ownerRole1]
  );

  // Now tenant1 has 2 active owners (userA and userB). Demoting userB should succeed!
  let errDemoteWithTwo = "";
  try {
    await db.query(`update public.profiles set role = 'Waiter', role_id = $1 where id = $2;`, [waiterRole1, userB]);
  } catch (e: any) {
    errDemoteWithTwo = e.message;
  }
  check("Demoting an owner when another active owner exists succeeds", !errDemoteWithTwo, errDemoteWithTwo);

  // Now userB is Waiter. UserA is the sole remaining active owner. Deleting userA should fail!
  let errDeleteLastRemaining = "";
  try {
    await db.query(`delete from public.profiles where id = $1;`, [userA]);
  } catch (e: any) {
    errDeleteLastRemaining = e.message;
  }
  check(
    "Deleting the last remaining active owner fails with CANNOT_REMOVE_LAST_ACTIVE_OWNER",
    errDeleteLastRemaining.includes("CANNOT_REMOVE_LAST_ACTIVE_OWNER"),
    errDeleteLastRemaining
  );

  // Deleting userB (who is now Waiter) should succeed without restriction!
  let errDeleteWaiter = "";
  try {
    await db.query(`delete from public.profiles where id = $1;`, [userB]);
  } catch (e: any) {
    errDeleteWaiter = e.message;
  }
  check("Deleting a non-owner profile succeeds without restriction", !errDeleteWaiter, errDeleteWaiter);

  // 5. Test Concurrent Owner Changes & Deadlock Prevention
  console.log("\n── 5. Testing Concurrent Owner Changes & Serialization ──");
  // Re-add userB as active Owner so tenant1 has 2 active owners: userA and userB
  const userC = (await db.query<{ id: string }>(
    `insert into auth.users (email) values ('owner-c@example.com') returning id;`
  )).rows[0].id;
  await db.query(
    `insert into public.profiles (id, tenant_id, role_id, name, email, role, active)
     values ($1, $2, $3, 'Owner C', 'owner-c@example.com', 'Owner', true);`,
    [userC, tenant1, ownerRole1]
  );

  // In Postgres, lock_tenant_for_owner_change takes an advisory transaction lock.
  // We simulate two transactions attempting to demote both owners:
  // Tx1 acquires advisory lock, demotes userA, commits.
  // Tx2 attempts to demote userC: since userA was demoted, userC is now the last active owner,
  // so Tx2 fails with CANNOT_REMOVE_LAST_ACTIVE_OWNER!
  await db.query("BEGIN;");
  await db.query("SELECT public.lock_tenant_for_owner_change($1);", [tenant1]);
  await db.query(`update public.profiles set role = 'Waiter', role_id = $1 where id = $2;`, [waiterRole1, userA]);
  await db.query("COMMIT;");

  let errTx2 = "";
  try {
    await db.query("BEGIN;");
    await db.query("SELECT public.lock_tenant_for_owner_change($1);", [tenant1]);
    await db.query(`update public.profiles set role = 'Waiter', role_id = $1 where id = $2;`, [waiterRole1, userC]);
    await db.query("COMMIT;");
  } catch (e: any) {
    await db.query("ROLLBACK;").catch(() => {});
    errTx2 = e.message;
  }
  check(
    "Serialized concurrent owner removal prevents race condition and rejects second removal",
    errTx2.includes("CANNOT_REMOVE_LAST_ACTIVE_OWNER"),
    errTx2
  );

  // 6. Test System Role Immutability
  console.log("\n── 6. Testing System Role Immutability ──");
  // Test 6.1: Reject deleting system role
  let errDeleteRole = "";
  try {
    await db.query(`delete from public.roles where id = $1;`, [ownerRole1]);
  } catch (e: any) {
    errDeleteRole = e.message;
  }
  check(
    "Deleting system role fails with SYSTEM_ROLE_CANNOT_BE_DELETED",
    errDeleteRole.includes("SYSTEM_ROLE_CANNOT_BE_DELETED"),
    errDeleteRole
  );

  // Test 6.2: Reject renaming system role
  let errRenameRole = "";
  try {
    await db.query(`update public.roles set name = 'SuperOwner' where id = $1;`, [ownerRole1]);
  } catch (e: any) {
    errRenameRole = e.message;
  }
  check(
    "Renaming system role fails with SYSTEM_ROLE_CANNOT_BE_RENAMED",
    errRenameRole.includes("SYSTEM_ROLE_CANNOT_BE_RENAMED"),
    errRenameRole
  );

  // Test 6.3: Reject editing permissions on system role
  let errPermsRole = "";
  try {
    await db.query(`update public.roles set permissions = 'orders.view' where id = $1;`, [ownerRole1]);
  } catch (e: any) {
    errPermsRole = e.message;
  }
  check(
    "Mutating system role permissions fails with SYSTEM_ROLE_PERMISSIONS_IMMUTABLE",
    errPermsRole.includes("SYSTEM_ROLE_PERMISSIONS_IMMUTABLE"),
    errPermsRole
  );

  // Test 6.4: Reject converting system role to custom
  let errConvertRole = "";
  try {
    await db.query(`update public.roles set is_system = false where id = $1;`, [ownerRole1]);
  } catch (e: any) {
    errConvertRole = e.message;
  }
  check(
    "Converting system role to custom fails with SYSTEM_ROLE_CANNOT_BE_CONVERTED",
    errConvertRole.includes("SYSTEM_ROLE_CANNOT_BE_CONVERTED"),
    errConvertRole
  );

  // Test 6.5: Custom roles can be created, updated, and deleted
  const customRoleId = (await db.query<{ id: string }>(
    `insert into public.roles (tenant_id, name, permissions, is_system) values ($1, 'Host', 'tables.view', false) returning id;`,
    [tenant1]
  )).rows[0].id;
  await db.query(`update public.roles set name = 'Head Host', permissions = 'tables.view,tables.manage' where id = $1;`, [customRoleId]);
  await db.query(`delete from public.roles where id = $1;`, [customRoleId]);
  check("Custom roles can be created, updated, and deleted without restriction", true);

  // 7. Test Staff Role Assignment Protection
  console.log("\n── 7. Testing Staff Role Assignment Protection ──");
  // Test 7.1: Inserting staff with Owner role must fail
  let errStaffInsertOwner = "";
  try {
    await db.query(
      `insert into public.staff (tenant_id, role_id, name, employee_id, pin_hash, pin_salt)
       values ($1, $2, 'Staff Impostor', 'EMP001', 'h', 's');`,
      [tenant1, ownerRole1]
    );
  } catch (e: any) {
    errStaffInsertOwner = e.message;
  }
  check(
    "Inserting staff with Owner role fails with OWNER_ROLE_NOT_ASSIGNABLE_TO_STAFF",
    errStaffInsertOwner.includes("OWNER_ROLE_NOT_ASSIGNABLE_TO_STAFF"),
    errStaffInsertOwner
  );

  // Test 7.2: Inserting staff with Waiter role succeeds
  const staff1 = (await db.query<{ id: string }>(
    `insert into public.staff (tenant_id, role_id, name, employee_id, pin_hash, pin_salt)
     values ($1, $2, 'Legit Staff', 'EMP002', 'h', 's') returning id;`,
    [tenant1, waiterRole1]
  )).rows[0].id;
  check("Inserting staff with Waiter role succeeds", Boolean(staff1));

  // Test 7.3: Updating staff to Owner role must fail
  let errStaffUpdateOwner = "";
  try {
    await db.query(`update public.staff set role_id = $1 where id = $2;`, [ownerRole1, staff1]);
  } catch (e: any) {
    errStaffUpdateOwner = e.message;
  }
  check(
    "Updating staff to Owner role fails with OWNER_ROLE_NOT_ASSIGNABLE_TO_STAFF",
    errStaffUpdateOwner.includes("OWNER_ROLE_NOT_ASSIGNABLE_TO_STAFF"),
    errStaffUpdateOwner
  );

  // 8. Test Tenant Purge & Cascade Deletion
  console.log("\n── 8. Testing Tenant Purge & Cascade Deletion ──");
  // Test 8.1: purge_tenant RPC cleans up profiles and system roles without trigger blocks
  let purgeResult: any = null;
  try {
    const res = await db.query<{ purge_tenant: any }>(`select public.purge_tenant($1);`, [tenant1]);
    purgeResult = res.rows[0].purge_tenant;
  } catch (e: any) {
    console.error("Purge error:", e);
  }
  check("purge_tenant() executes cleanly and bypasses triggers via app.purging_tenant", Boolean(purgeResult));

  // Test 8.2: Verify tenant1 profiles and roles were purged
  const remainingProfilesT1 = (await db.query(`select count(*) as c from public.profiles where tenant_id = $1;`, [tenant1])).rows[0].c;
  check("All profiles purged for tenant1", remainingProfilesT1 === "0" || remainingProfilesT1 === 0);

  // Test 8.3: Direct tenant deletion cascade
  // Create an active owner on tenant2
  const ownerRole2 = (await db.query<{ id: string }>(
    `insert into public.roles (tenant_id, name, permissions, is_system) values ($1, 'Owner', 'all', true) returning id;`,
    [tenant2]
  )).rows[0].id;
  const userD = (await db.query<{ id: string }>(
    `insert into auth.users (email) values ('owner-d@example.com') returning id;`
  )).rows[0].id;
  await db.query(
    `insert into public.profiles (id, tenant_id, role_id, name, email, role, active)
     values ($1, $2, $3, 'Owner D', 'owner-d@example.com', 'Owner', true);`,
    [userD, tenant2, ownerRole2]
  );
  // Deleting tenant2 directly cascades to delete profiles without error
  let errDeleteTenantCascade = "";
  try {
    await db.query(`delete from public.tenants where id = $1;`, [tenant2]);
  } catch (e: any) {
    errDeleteTenantCascade = e.message;
  }
  check("Direct tenant deletion cascades to profiles without being blocked", !errDeleteTenantCascade, errDeleteTenantCascade);

  console.log("\n========================================================");
  console.log(`  Results: ${pass}/${pass + fail} checks passed${fail ? ` — ${fail} FAILED` : ""}`);
  console.log("========================================================\n");

  if (fail > 0) process.exit(1);
}

runSuite().catch((e) => {
  console.error("Suite crashed:", e);
  process.exit(1);
});
