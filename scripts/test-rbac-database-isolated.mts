/**
 * Isolated Real PostgreSQL Database RBAC & Ownership Invariant Test Suite
 *
 * Runs against an isolated, standalone PostgreSQL instance via embedded-postgres & pg.
 * Uses two independent client connections to verify:
 *  1. check_last_active_owner() invariants (deletion, deactivation, demotion, tenant transfer)
 *  2. Overlapping concurrent transactions under READ COMMITTED (rechecks after commit, rejects last removal)
 *  3. Overlapping concurrent transactions under REPEATABLE READ (fails with serialization error 40001)
 *  4. Single remaining active owner guarantees across both isolation levels
 *  5. check_system_role_invariants() (delete, rename, permission mutation, conversion)
 *  6. check_staff_role_assignment() (rejection of Owner assignment to PIN staff)
 *  7. Tenant purge bypass and direct tenant cascade deletion
 */

import EmbeddedPostgres from "embedded-postgres";
import { Client } from "pg";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

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

  const port = 54340 + Math.floor(Math.random() * 500);
  const dataDir = path.join(os.tmpdir(), `pg_rbac_test_${Date.now()}_${Math.random().toString(36).slice(2)}`);

  console.log(`Starting isolated PostgreSQL instance on port ${port}...`);
  const pgServer = new EmbeddedPostgres({
    port,
    databaseDir: dataDir,
    user: "postgres",
    password: "password",
    persistent: false,
  });

  await pgServer.initialise();
  await pgServer.start();

  // Create two independent client connections
  const client1 = new Client({ port, host: "127.0.0.1", user: "postgres", password: "password", database: "postgres" });
  const client2 = new Client({ port, host: "127.0.0.1", user: "postgres", password: "password", database: "postgres" });

  await client1.connect();
  await client2.connect();

  try {
    // 1. Setup Base Schema
    console.log("\n── 1. Setting up Base Schema in Isolated Postgres ──");
    await client1.query(`
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

      do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
      do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
    `);
    check("Base schema created successfully", true);

    // 2. Apply Migration
    console.log("\n── 2. Applying Migration 20261122000002 ──");
    const migrationPath = path.resolve(
      process.cwd(),
      "supabase/migrations/20261122000002_enforce_rbac_ownership_and_system_role_invariants.sql"
    );
    const migrationSql = fs.readFileSync(migrationPath, "utf-8");
    await client1.query(migrationSql);
    check("Migration 20261122000002 applied with 0 errors", true);

    // 2.1 Verify Restricted Privileges
    console.log("\n── 2.1 Verifying Effective Privileges ──");
    const followUpPath = path.resolve(
      process.cwd(),
      "supabase/migrations/20261123000001_restrict_owner_guard_helper.sql"
    );
    if (fs.existsSync(followUpPath)) {
      const followUpSql = fs.readFileSync(followUpPath, "utf-8");
      await client1.query(followUpSql);
      check("Follow-up migration 20261123000001 applied with 0 errors", true);
    }

    const anonExecRes = await client1.query<{ has_priv: boolean }>(
      `select has_function_privilege('anon', 'public.lock_tenant_for_owner_change(uuid)', 'execute') as has_priv;`
    );
    check("anon role cannot execute public.lock_tenant_for_owner_change", anonExecRes.rows[0].has_priv === false);

    const authExecRes = await client1.query<{ has_priv: boolean }>(
      `select has_function_privilege('authenticated', 'public.lock_tenant_for_owner_change(uuid)', 'execute') as has_priv;`
    );
    check("authenticated role cannot execute public.lock_tenant_for_owner_change", authExecRes.rows[0].has_priv === false);

    const anonTableRes = await client1.query<{ has_priv: boolean }>(
      `select has_table_privilege('anon', 'public.tenant_owner_guard', 'select') as has_priv;`
    );
    check("anon role cannot select public.tenant_owner_guard", anonTableRes.rows[0].has_priv === false);

    const authTableRes = await client1.query<{ has_priv: boolean }>(
      `select has_table_privilege('authenticated', 'public.tenant_owner_guard', 'select') as has_priv;`
    );
    check("authenticated role cannot select public.tenant_owner_guard", authTableRes.rows[0].has_priv === false);

    // 3. Test Last Active Owner Invariants
    console.log("\n── 3. Testing Last Active Owner Invariants ──");
    const tenant1Res = await client1.query<{ id: string }>(
      `insert into public.tenants (name, slug) values ('Trattoria One', 'trattoria-one') returning id;`
    );
    const tenant1 = tenant1Res.rows[0].id;

    const tenant2Res = await client1.query<{ id: string }>(
      `insert into public.tenants (name, slug) values ('Trattoria Two', 'trattoria-two') returning id;`
    );
    const tenant2 = tenant2Res.rows[0].id;

    const ownerRole1Res = await client1.query<{ id: string }>(
      `insert into public.roles (tenant_id, name, permissions, is_system) values ($1, 'Owner', 'all', true) returning id;`,
      [tenant1]
    );
    const ownerRole1 = ownerRole1Res.rows[0].id;

    const waiterRole1Res = await client1.query<{ id: string }>(
      `insert into public.roles (tenant_id, name, permissions, is_system) values ($1, 'Waiter', 'orders.view', true) returning id;`,
      [tenant1]
    );
    const waiterRole1 = waiterRole1Res.rows[0].id;

    const userARes = await client1.query<{ id: string }>(
      `insert into auth.users (email) values ('owner-a@example.com') returning id;`
    );
    const userA = userARes.rows[0].id;

    await client1.query(
      `insert into public.profiles (id, tenant_id, role_id, name, email, role, active)
       values ($1, $2, $3, 'Owner A', 'owner-a@example.com', 'Owner', true);`,
      [userA, tenant1, ownerRole1]
    );

    // Test 3.1: Reject Deleting the only active Owner
    let errDeleteOnly = "";
    try {
      await client1.query(`delete from public.profiles where id = $1;`, [userA]);
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
      await client1.query(`update public.profiles set active = false where id = $1;`, [userA]);
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
      await client1.query(`update public.profiles set role = 'Waiter', role_id = $1 where id = $2;`, [waiterRole1, userA]);
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
      await client1.query(`update public.profiles set tenant_id = $1 where id = $2;`, [tenant2, userA]);
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
      await client1.query(`update public.profiles set name = 'Owner A Updated', phone = '+1234567890' where id = $1;`, [userA]);
    } catch (e: any) {
      errUpdateProfile = e.message;
    }
    check("Updating name/phone on sole active Owner succeeds without error", !errUpdateProfile, errUpdateProfile);

    // 4. Test Multi-Owner Scenarios
    console.log("\n── 4. Testing Multi-Owner Scenarios ──");
    const userBRes = await client1.query<{ id: string }>(
      `insert into auth.users (email) values ('owner-b@example.com') returning id;`
    );
    const userB = userBRes.rows[0].id;

    await client1.query(
      `insert into public.profiles (id, tenant_id, role_id, name, email, role, active)
       values ($1, $2, $3, 'Owner B', 'owner-b@example.com', 'Owner', true);`,
      [userB, tenant1, ownerRole1]
    );

    // Now tenant1 has 2 active owners (userA and userB). Demoting userB should succeed!
    let errDemoteWithTwo = "";
    try {
      await client1.query(`update public.profiles set role = 'Waiter', role_id = $1 where id = $2;`, [waiterRole1, userB]);
    } catch (e: any) {
      errDemoteWithTwo = e.message;
    }
    check("Demoting an owner when another active owner exists succeeds", !errDemoteWithTwo, errDemoteWithTwo);

    // Now userB is Waiter. UserA is the sole remaining active owner. Deleting userA should fail!
    let errDeleteLastRemaining = "";
    try {
      await client1.query(`delete from public.profiles where id = $1;`, [userA]);
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
      await client1.query(`delete from public.profiles where id = $1;`, [userB]);
    } catch (e: any) {
      errDeleteWaiter = e.message;
    }
    check("Deleting a non-owner profile succeeds without restriction", !errDeleteWaiter, errDeleteWaiter);

    // 5. Concurrent Owner Changes: READ COMMITTED
    console.log("\n── 5. Concurrent Owner Changes under READ COMMITTED ──");
    // Add User B back as active Owner so tenant1 has 2 active owners: User A and User B
    const userB2Res = await client1.query<{ id: string }>(
      `insert into auth.users (email) values ('owner-b2@example.com') returning id;`
    );
    const userB2 = userB2Res.rows[0].id;
    await client1.query(
      `insert into public.profiles (id, tenant_id, role_id, name, email, role, active)
       values ($1, $2, $3, 'Owner B2', 'owner-b2@example.com', 'Owner', true);`,
      [userB2, tenant1, ownerRole1]
    );

    // Overlap two independent transactions:
    // Client 1 begins transaction
    // Client 2 begins transaction
    await client1.query("BEGIN;");
    await client2.query("BEGIN;");

    // Client 1 executes demotion on User A (updates guard row and profile row)
    await client1.query(`update public.profiles set role = 'Waiter', role_id = $1 where id = $2;`, [waiterRole1, userA]);

    // Client 2 concurrently attempts demotion on User B2 -> blocks waiting on the guard row
    const pClient2RC = client2.query(`update public.profiles set role = 'Waiter', role_id = $1 where id = $2;`, [waiterRole1, userB2]).catch((e) => e);

    // Allow concurrency to settle, then commit Client 1
    await new Promise((r) => setTimeout(r, 100));
    await client1.query("COMMIT;");

    // Client 2 unblocks, re-evaluates committed state in READ COMMITTED, sees 0 remaining owners, and fails
    const errRC = await pClient2RC;
    await client2.query("ROLLBACK;");

    check(
      "READ COMMITTED: Second concurrent owner removal is rejected with CANNOT_REMOVE_LAST_ACTIVE_OWNER",
      errRC instanceof Error && errRC.message.includes("CANNOT_REMOVE_LAST_ACTIVE_OWNER"),
      errRC instanceof Error ? errRC.message : "No error thrown"
    );

    // Verify exactly one active owner remains
    const activeOwnersRC = (
      await client1.query(
        `select count(*) as c from public.profiles where tenant_id = $1 and active = true and role ilike 'owner';`,
        [tenant1]
      )
    ).rows[0].c;
    check("READ COMMITTED: Permitted demotion committed and exactly 1 active owner remains", Number(activeOwnersRC) === 1);

    // 6. Concurrent Owner Changes: REPEATABLE READ
    console.log("\n── 6. Concurrent Owner Changes under REPEATABLE READ ──");
    // Add User C as active Owner, so tenant1 now has 2 active owners: User B2 and User C
    const userCRes = await client1.query<{ id: string }>(
      `insert into auth.users (email) values ('owner-c@example.com') returning id;`
    );
    const userC = userCRes.rows[0].id;
    await client1.query(
      `insert into public.profiles (id, tenant_id, role_id, name, email, role, active)
       values ($1, $2, $3, 'Owner C', 'owner-c@example.com', 'Owner', true);`,
      [userC, tenant1, ownerRole1]
    );

    // Overlap two transactions with REPEATABLE READ:
    await client1.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;");
    await client2.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;");

    // Both take snapshots
    await client1.query(`select count(*) from public.profiles where tenant_id = $1;`, [tenant1]);
    await client2.query(`select count(*) from public.profiles where tenant_id = $1;`, [tenant1]);

    // Client 1 demotes User B2 -> updates guard row
    await client1.query(`update public.profiles set role = 'Waiter', role_id = $1 where id = $2;`, [waiterRole1, userB2]);

    // Client 2 attempts to demote User C -> attempts to update guard row and blocks
    const pClient2RR = client2.query(`update public.profiles set role = 'Waiter', role_id = $1 where id = $2;`, [waiterRole1, userC]).catch((e) => e);

    await new Promise((r) => setTimeout(r, 100));
    await client1.query("COMMIT;");

    // Client 2 unblocks; Postgres REPEATABLE READ detects concurrent update on guard row and throws 40001
    const errRR = await pClient2RR;
    await client2.query("ROLLBACK;");

    check(
      "REPEATABLE READ: Stale concurrent removal fails with serialization error 40001",
      errRR instanceof Error && (errRR as any).code === "40001",
      errRR instanceof Error ? `${(errRR as any).code}: ${errRR.message}` : "No error thrown"
    );

    // Verify exactly one active owner remains
    const activeOwnersRR = (
      await client1.query(
        `select count(*) as c from public.profiles where tenant_id = $1 and active = true and role ilike 'owner';`,
        [tenant1]
      )
    ).rows[0].c;
    check("REPEATABLE READ: Permitted demotion committed and exactly 1 active owner remains", Number(activeOwnersRR) === 1);

    // 7. Test System Role Immutability
    console.log("\n── 7. Testing System Role Immutability ──");
    // Test 7.1: Reject deleting system role
    let errDeleteRole = "";
    try {
      await client1.query(`delete from public.roles where id = $1;`, [ownerRole1]);
    } catch (e: any) {
      errDeleteRole = e.message;
    }
    check(
      "Deleting system role fails with SYSTEM_ROLE_CANNOT_BE_DELETED",
      errDeleteRole.includes("SYSTEM_ROLE_CANNOT_BE_DELETED"),
      errDeleteRole
    );

    // Test 7.2: Reject renaming system role
    let errRenameRole = "";
    try {
      await client1.query(`update public.roles set name = 'SuperOwner' where id = $1;`, [ownerRole1]);
    } catch (e: any) {
      errRenameRole = e.message;
    }
    check(
      "Renaming system role fails with SYSTEM_ROLE_CANNOT_BE_RENAMED",
      errRenameRole.includes("SYSTEM_ROLE_CANNOT_BE_RENAMED"),
      errRenameRole
    );

    // Test 7.3: Reject editing permissions on system role
    let errPermsRole = "";
    try {
      await client1.query(`update public.roles set permissions = 'orders.view' where id = $1;`, [ownerRole1]);
    } catch (e: any) {
      errPermsRole = e.message;
    }
    check(
      "Mutating system role permissions fails with SYSTEM_ROLE_PERMISSIONS_IMMUTABLE",
      errPermsRole.includes("SYSTEM_ROLE_PERMISSIONS_IMMUTABLE"),
      errPermsRole
    );

    // Test 7.4: Reject converting system role to custom
    let errConvertRole = "";
    try {
      await client1.query(`update public.roles set is_system = false where id = $1;`, [ownerRole1]);
    } catch (e: any) {
      errConvertRole = e.message;
    }
    check(
      "Converting system role to custom fails with SYSTEM_ROLE_CANNOT_BE_CONVERTED",
      errConvertRole.includes("SYSTEM_ROLE_CANNOT_BE_CONVERTED"),
      errConvertRole
    );

    // Test 7.5: Custom roles can be created, updated, and deleted
    const customRoleRes = await client1.query<{ id: string }>(
      `insert into public.roles (tenant_id, name, permissions, is_system) values ($1, 'Host', 'tables.view', false) returning id;`,
      [tenant1]
    );
    const customRoleId = customRoleRes.rows[0].id;
    await client1.query(`update public.roles set name = 'Head Host', permissions = 'tables.view,tables.manage' where id = $1;`, [customRoleId]);
    await client1.query(`delete from public.roles where id = $1;`, [customRoleId]);
    check("Custom roles can be created, updated, and deleted without restriction", true);

    // 8. Test Staff Role Assignment Protection
    console.log("\n── 8. Testing Staff Role Assignment Protection ──");
    // Test 8.1: Inserting staff with Owner role must fail
    let errStaffInsertOwner = "";
    try {
      await client1.query(
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

    // Test 8.2: Inserting staff with Waiter role succeeds
    const staff1Res = await client1.query<{ id: string }>(
      `insert into public.staff (tenant_id, role_id, name, employee_id, pin_hash, pin_salt)
       values ($1, $2, 'Legit Staff', 'EMP002', 'h', 's') returning id;`,
      [tenant1, waiterRole1]
    );
    check("Inserting staff with Waiter role succeeds", Boolean(staff1Res.rows[0]?.id));

    // Test 8.3: Updating staff to Owner role must fail
    let errStaffUpdateOwner = "";
    try {
      await client1.query(`update public.staff set role_id = $1 where id = $2;`, [ownerRole1, staff1Res.rows[0].id]);
    } catch (e: any) {
      errStaffUpdateOwner = e.message;
    }
    check(
      "Updating staff to Owner role fails with OWNER_ROLE_NOT_ASSIGNABLE_TO_STAFF",
      errStaffUpdateOwner.includes("OWNER_ROLE_NOT_ASSIGNABLE_TO_STAFF"),
      errStaffUpdateOwner
    );

    // 9. Test Tenant Purge & Cascade Deletion
    console.log("\n── 9. Testing Tenant Purge & Cascade Deletion ──");
    // Test 9.1: purge_tenant RPC cleans up profiles, system roles, and guard rows without trigger blocks
    let purgeResult: any = null;
    try {
      const res = await client1.query<{ purge_tenant: any }>(`select public.purge_tenant($1);`, [tenant1]);
      purgeResult = res.rows[0].purge_tenant;
    } catch (e: any) {
      console.error("Purge error:", e);
    }
    check("purge_tenant() executes cleanly and bypasses triggers via app.purging_tenant", Boolean(purgeResult));

    // Test 9.2: Verify tenant1 profiles and guard rows were purged
    const remainingProfilesT1 = (await client1.query(`select count(*) as c from public.profiles where tenant_id = $1;`, [tenant1])).rows[0].c;
    check("All profiles purged for tenant1", Number(remainingProfilesT1) === 0);

    const remainingGuardT1 = (await client1.query(`select count(*) as c from public.tenant_owner_guard where tenant_id = $1;`, [tenant1])).rows[0].c;
    check("Guard row purged for tenant1", Number(remainingGuardT1) === 0);

    // Test 9.3: Direct tenant deletion cascade
    // Create an active owner on tenant2
    const ownerRole2Res = await client1.query<{ id: string }>(
      `insert into public.roles (tenant_id, name, permissions, is_system) values ($1, 'Owner', 'all', true) returning id;`,
      [tenant2]
    );
    const ownerRole2 = ownerRole2Res.rows[0].id;
    const userDRes = await client1.query<{ id: string }>(
      `insert into auth.users (email) values ('owner-d@example.com') returning id;`
    );
    const userD = userDRes.rows[0].id;
    await client1.query(
      `insert into public.profiles (id, tenant_id, role_id, name, email, role, active)
       values ($1, $2, $3, 'Owner D', 'owner-d@example.com', 'Owner', true);`,
      [userD, tenant2, ownerRole2]
    );

    // Deleting tenant2 directly cascades to delete profiles and guard row without error
    let errDeleteTenantCascade = "";
    try {
      await client1.query(`delete from public.tenants where id = $1;`, [tenant2]);
    } catch (e: any) {
      errDeleteTenantCascade = e.message;
    }
    check("Direct tenant deletion cascades to profiles without being blocked", !errDeleteTenantCascade, errDeleteTenantCascade);

    console.log("\n========================================================");
    console.log(`  Results: ${pass}/${pass + fail} checks passed${fail ? ` — ${fail} FAILED` : ""}`);
    console.log("========================================================\n");
  } finally {
    await client1.end().catch(() => {});
    await client2.end().catch(() => {});
    await pgServer.stop().catch(() => {});
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  }

  if (fail > 0) process.exit(1);
}

runSuite().catch((e) => {
  console.error("Suite crashed:", e);
  process.exit(1);
});
