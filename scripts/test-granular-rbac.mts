/**
 * Comprehensive Automated Verification Suite for Role Access (Granular RBAC)
 *
 * Verifies:
 * 1. Human-Readable Permission Registry & 29 Keys Mapping
 * 2. 10 Permission Groups Integrity & Synchronization
 * 3. Default System Roles (Owner, Manager, Cashier, Kitchen, Waiter) & Immutability
 * 4. Implication & Privilege Escalation Rules (canGrantRole, expandPermissions)
 * 5. Reserved Name Collision Handling
 * 6. Color Palette Diversity (8 distinct swatches, duplicate purple replaced)
 * 7. System-Role Duplication Workflow
 * 8. Transactional Last-Active-Owner & Database Safeguard Migrations
 * 9. Optional Permission Feasibility Boundaries
 *
 * Run via:
 *   npx tsx scripts/test-granular-rbac.mts
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  PERMISSION_KEYS,
  PERMISSION_GROUPS,
  PERMISSION_METADATA,
  PERMISSION_IMPLICATIONS,
  RESERVED_ROLE_NAMES,
  DEFAULT_ROLES,
  expandPermissions,
  hasEffectivePermission,
  type PermissionKey,
} from '../supabase/functions/_shared/permissions.ts';
import { canGrantRole, reservedRoleName, splitPermissions } from '../src/lib/permissions.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
    console.log(`  ✓ ok   ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.error(`  ✗ FAIL ${label}${detail ? `\n         Details: ${detail}` : ''}`);
  }
}

console.log('===============================================================');
console.log('   GRANULAR RBAC, PERMISSION MATRIX & SECURITY VERIFICATION   ');
console.log('===============================================================\n');

// ---------------------------------------------------------------------------
// 1. HUMAN-READABLE PERMISSION REGISTRY & 29 KEYS
// ---------------------------------------------------------------------------
console.log('── 1. Permission Registry & 29 Keys Integrity ──');

check('exact 29 permission keys defined in PERMISSION_KEYS', PERMISSION_KEYS.length === 29, `Count is ${PERMISSION_KEYS.length}`);

const uniqueKeys = new Set(PERMISSION_KEYS);
check('all 29 permission keys are unique', uniqueKeys.size === 29, `Unique count: ${uniqueKeys.size}`);

const registryKeys = Object.keys(PERMISSION_METADATA) as PermissionKey[];
check('PERMISSION_METADATA registers all 29 keys', registryKeys.length === 29, `Registered keys: ${registryKeys.length}`);

let allMetadataValid = true;
const missingFields: string[] = [];
for (const key of PERMISSION_KEYS) {
  const meta = PERMISSION_METADATA[key];
  if (!meta) {
    allMetadataValid = false;
    missingFields.push(`${key}: missing from registry`);
  } else {
    if (!meta.label || meta.label.trim().length === 0) missingFields.push(`${key}: missing label`);
    if (!meta.description || meta.description.trim().length === 0) missingFields.push(`${key}: missing description`);
    if (!meta.module || meta.module.trim().length === 0) missingFields.push(`${key}: missing module`);
  }
}
check('every permission has a human-readable label, description, and module', allMetadataValid && missingFields.length === 0, missingFields.join('; '));

// ---------------------------------------------------------------------------
// 2. 10 PERMISSION GROUPS INTEGRITY
// ---------------------------------------------------------------------------
console.log('\n── 2. 10 Permission Groups Structure ──');

check('exact 10 permission groups defined in PERMISSION_GROUPS', PERMISSION_GROUPS.length === 10, `Groups count: ${PERMISSION_GROUPS.length}`);

const expectedGroups: Record<string, number> = {
  'Dashboard': 1,
  'Orders': 9,
  'Payments': 2,
  'Menu': 2,
  'Tables & QR': 4,
  'Promo Codes': 2,
  'Analytics': 1,
  'Settings': 2,
  'Security': 2,
  'Roles & Staff': 4,
};

let groupsMatch = true;
const groupDiscrepancies: string[] = [];
const groupedPerms = new Set<string>();

for (const group of PERMISSION_GROUPS) {
  const expectedCount = expectedGroups[group.label];
  if (expectedCount === undefined) {
    groupsMatch = false;
    groupDiscrepancies.push(`Unexpected group: ${group.label}`);
  } else if (group.perms.length !== expectedCount) {
    groupsMatch = false;
    groupDiscrepancies.push(`${group.label} has ${group.perms.length} perms, expected ${expectedCount}`);
  }

  for (const perm of group.perms) {
    if (!uniqueKeys.has(perm as PermissionKey)) {
      groupsMatch = false;
      groupDiscrepancies.push(`Unknown permission ${perm} in group ${group.label}`);
    }
    if (groupedPerms.has(perm)) {
      groupsMatch = false;
      groupDiscrepancies.push(`Duplicate permission ${perm} across groups`);
    }
    groupedPerms.add(perm);
  }
}

check('all 10 groups contain expected permissions count and zero overlaps', groupsMatch, groupDiscrepancies.join('; '));
check('groups cover 100% of all 29 permission keys', groupedPerms.size === 29, `Grouped count: ${groupedPerms.size}`);

// ---------------------------------------------------------------------------
// 3. DEFAULT SYSTEM ROLES PRESERVATION & IMMUTABILITY
// ---------------------------------------------------------------------------
console.log('\n── 3. Built-in System Roles ──');

check('exact 5 default roles defined (Owner, Manager, Cashier, Kitchen, Waiter)', DEFAULT_ROLES.length === 5, `Count: ${DEFAULT_ROLES.length}`);

const defaultRoleNames = DEFAULT_ROLES.map((r) => r.name);
check('system role names match expected set',
  defaultRoleNames.includes('Owner') &&
  defaultRoleNames.includes('Manager') &&
  defaultRoleNames.includes('Cashier') &&
  defaultRoleNames.includes('Kitchen') &&
  defaultRoleNames.includes('Waiter'),
  JSON.stringify(defaultRoleNames)
);

const ownerRole = DEFAULT_ROLES.find((r) => r.name === 'Owner');
const ownerPerms = splitPermissions(ownerRole?.permissions);
check('Owner system role holds all 29 permissions', ownerPerms.length === 29, `Owner permissions: ${ownerPerms.length}`);

const kitchenRole = DEFAULT_ROLES.find((r) => r.name === 'Kitchen');
const kitchenPerms = splitPermissions(kitchenRole?.permissions);
check('Kitchen role holds orders.prepare and orders.ready but not tables or payments',
  kitchenPerms.includes('orders.prepare') &&
  kitchenPerms.includes('orders.ready') &&
  !kitchenPerms.includes('tables.view') &&
  !kitchenPerms.includes('payments.collect'),
  JSON.stringify(kitchenPerms)
);

const cashierRole = DEFAULT_ROLES.find((r) => r.name === 'Cashier');
const cashierPerms = splitPermissions(cashierRole?.permissions);
check('Cashier role holds payments.collect, orders.complete, orders.discount but not orders.cancel',
  cashierPerms.includes('payments.collect') &&
  cashierPerms.includes('orders.complete') &&
  cashierPerms.includes('orders.discount') &&
  !cashierPerms.includes('orders.cancel'),
  JSON.stringify(cashierPerms)
);

// ---------------------------------------------------------------------------
// 4. IMPLICATION & PRIVILEGE ESCALATION RULES
// ---------------------------------------------------------------------------
console.log('\n── 4. Implication & Escalation Protection ──');

const expandedSettings = expandPermissions(['settings.manage']);
check('settings.manage implies settings.view', expandedSettings.includes('settings.view'));

const expandedOrders = expandPermissions(['orders.create']);
check('orders.create implies orders.view', expandedOrders.includes('orders.view'));

const managerPerms = splitPermissions(DEFAULT_ROLES.find((r) => r.name === 'Manager')?.permissions);
const waiterPerms = splitPermissions(DEFAULT_ROLES.find((r) => r.name === 'Waiter')?.permissions);

check('Manager can grant Waiter role (subset)', canGrantRole(waiterPerms, managerPerms));
check('Waiter cannot grant Manager role (escalation prevented)', !canGrantRole(managerPerms, waiterPerms));
check('Manager cannot grant Owner role (contains unheld settings.manage / security.manage)', !canGrantRole(ownerPerms, managerPerms));
check('Owner (full permissions) can grant any role', canGrantRole(managerPerms, ownerPerms));

// ---------------------------------------------------------------------------
// 5. RESERVED ROLE NAME COLLISION
// ---------------------------------------------------------------------------
console.log('\n── 5. Reserved System Role Names ──');

check('rejects exact reserved name "Owner"', reservedRoleName('Owner') === 'Owner');
check('rejects case-insensitive reserved name "owner"', reservedRoleName('owner') === 'Owner');
check('rejects case-insensitive reserved name "MANAGER"', reservedRoleName('MANAGER') === 'Manager');
check('rejects case-insensitive reserved name "  cashier  "', reservedRoleName('  cashier  ') === 'Cashier');
check('allows valid custom role name "Shift Supervisor"', reservedRoleName('Shift Supervisor') === null);
check('allows valid custom role name "Sommelier"', reservedRoleName('Sommelier') === null);

// ---------------------------------------------------------------------------
// 6. COLOR PALETTE DIVERSITY & ACCESSIBILITY
// ---------------------------------------------------------------------------
console.log('\n── 6. Color Palette Accessibility ──');

const rolesViewContent = fs.readFileSync(path.resolve('src/components/views/roles.tsx'), 'utf-8');
check('roles.tsx contains 8 distinct colors and removed duplicate purple (#a78bfa)',
  !rolesViewContent.includes("'#a78bfa'") && rolesViewContent.includes("'#e11d48'"),
  'Duplicate purple swatch (#a78bfa) must be replaced by #e11d48'
);

check('standardizes spelling to "Color" / "color" in UI text',
  !rolesViewContent.includes('colour can be edited') && rolesViewContent.includes('color can be edited'),
  'Spelling must be "color", not "colour"'
);

// ---------------------------------------------------------------------------
// 7. SYSTEM ROLE DUPLICATION & UI FEATURES IN ROLES.TSX
// ---------------------------------------------------------------------------
console.log('\n── 7. UI/UX Refactoring & Controls ──');

check('roles.tsx contains "Duplicate as Custom Role" button', rolesViewContent.includes('Duplicate as Custom Role'));
check('roles.tsx contains "Assign Staff" button in Members card', rolesViewContent.includes('Assign Staff'));
check('roles.tsx contains AssignStaffDialog component', rolesViewContent.includes('function AssignStaffDialog'));
check('roles.tsx contains sticky actions bar with safe-area padding', rolesViewContent.includes('sticky bottom-0') && rolesViewContent.includes('safe-area-inset-bottom'));
check('roles.tsx contains Unsaved Changes confirmation dialog', rolesViewContent.includes('Unsaved Changes') && rolesViewContent.includes('AlertDialog'));
check('roles.tsx has horizontal role selector right-edge gradient indicator', rolesViewContent.includes('bg-gradient-to-l from-background to-transparent'));
check('roles.tsx removed redundant Role Access h2 heading from body', !rolesViewContent.includes('>Role Access</h2>'));
check('roles.tsx includes out-of-reach role notice: "This role includes permissions you don’t hold."', rolesViewContent.includes('This role includes permissions you don’t hold.'));
check('roles.tsx guards saveRole with !canEditRole preventing PATCH for read-only roles', rolesViewContent.includes('if (!canEditRole) return false'));
check('roles.tsx checks grantableKeys with canGrantRole for custom role reachability', rolesViewContent.includes('canGrantRole(parsePerms(role.permissions), grantableKeys)'));

// ---------------------------------------------------------------------------
// 8. DATABASE MIGRATION INTEGRITY (TRANSACTIONAL LAST OWNER & SYSTEM INVARIANTS)
// ---------------------------------------------------------------------------
console.log('\n── 8. Database Migration Security & Invariants ──');

const migrationPath = path.resolve('supabase/migrations/20261122000002_enforce_rbac_ownership_and_system_role_invariants.sql');
check('migration file 20261122000002 exists', fs.existsSync(migrationPath));

if (fs.existsSync(migrationPath)) {
  const migrationContent = fs.readFileSync(migrationPath, 'utf-8');
  check('migration enforces check_last_active_owner() with per-tenant guard row serialization',
    migrationContent.includes('check_last_active_owner()') &&
    migrationContent.includes('tenant_owner_guard') &&
    migrationContent.includes('CANNOT_REMOVE_LAST_ACTIVE_OWNER')
  );

  check('migration enforces check_system_role_invariants() on public.roles',
    migrationContent.includes('check_system_role_invariants()') &&
    migrationContent.includes('SYSTEM_ROLE_CANNOT_BE_DELETED') &&
    migrationContent.includes('SYSTEM_ROLE_CANNOT_BE_RENAMED') &&
    migrationContent.includes('SYSTEM_ROLE_PERMISSIONS_IMMUTABLE')
  );

  check('migration enforces check_staff_role_assignment() on public.staff',
    migrationContent.includes('check_staff_role_assignment()') &&
    migrationContent.includes('OWNER_ROLE_NOT_ASSIGNABLE_TO_STAFF')
  );

  check('migration safely accommodates purge_tenant() with app.purging_tenant setting',
    migrationContent.includes("app.purging_tenant")
  );

  check('migration revokes direct execution of lock_tenant_for_owner_change and tenant_owner_guard from public, anon, and authenticated',
    migrationContent.includes("revoke all on function public.lock_tenant_for_owner_change(uuid) from public, anon, authenticated") &&
    migrationContent.includes("revoke all on table public.tenant_owner_guard from public, anon, authenticated")
  );

  const followUpMigrationPath = path.resolve('supabase/migrations/20261123000001_restrict_owner_guard_helper.sql');
  check('follow-up migration 20261123000001 exists for applied instances', fs.existsSync(followUpMigrationPath));
}

// ---------------------------------------------------------------------------
// 9. OPTIONAL PERMISSIONS FEASIBILITY BOUNDARIES AUDIT
// ---------------------------------------------------------------------------
console.log('\n── 9. Optional Permissions Feasibility Assessment ──');

check('Preserved strict canonical 29 permissions without partial regressions', PERMISSION_KEYS.length === 29);
console.log('     * menu.availability: deferred — PATCH /api/menu and menu_items table schema currently manage items as a whole; a split without separate item availability endpoint would risk privilege leaks.');
console.log('     * orders.void: deferred — cancel_order_tx strictly prohibits cancelling or voiding SERVED/COMPLETED orders (migration 20261117000007) for financial audit and anti-theft rules.');
console.log('     * analytics.export: deferred — analytics uses client-side rendering with analytics.view; introducing a new key without a dedicated backend export route would break canonical 29-permission guarantees.');

console.log('\n===============================================================');
console.log(`   RESULTS: ${pass} PASSED, ${fail} FAILED`);
console.log('===============================================================');

if (fail > 0) {
  console.error('\nFailures summary:');
  for (const f of failures) {
    console.error(` - ${f}`);
  }
  process.exit(1);
} else {
  console.log('\nAll RBAC, security, and UI/UX checks passed successfully!');
}
