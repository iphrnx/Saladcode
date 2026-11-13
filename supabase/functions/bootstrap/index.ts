// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { guard } from "../_shared/auth.ts";
import { staffTopic } from "../_shared/realtime.ts";
import { admin } from "../_shared/db.ts";
import { toCamel } from "../_shared/case.ts";
import { json, preflight } from "../_shared/http.ts";
import { resolvePlan } from "../_shared/plans.ts";
import { ONBOARDING_DRAFT_KEY } from "../_shared/settings-keys.ts";
import { effectiveDishBasePrice, normalizeStoredPortions } from "../_shared/portions.ts";
import { listAuthSessions, listStaffSessions } from "../_shared/sessions.ts";

import { cleanIp } from "../_shared/ip.ts";
import { actorMaps, presentLog } from "../_shared/security-identity.ts";
import { auditStats } from "../_shared/audit.ts";
/**
 * /functions/v1/bootstrap  (GET, dashboard.view)
 *
 * Returns the entire dashboard payload for the caller's tenant in one round
 * trip: tenant, settings, users, roles, staff, categories, menu, tables,
 * orders, reservations, promos, sessions, security logs and a summary.
 *
 * Every read is scoped to `g.session.tenantId`; the Next.js version it replaces
 * already did this, and the owner/staff distinction now comes straight from the
 * resolved session instead of a second cookie lookup.
 */

Deno.serve(async (req: Request) => {
  const pf = preflight(req);
  if (pf) return pf;

  try {
    if (req.method !== "GET") {
      return json(req, { error: "Method not allowed" }, 405);
    }

    // Authenticated, not permission-gated.
    //
    // bootstrap is the app shell's data loader, not the Dashboard module. It
    // used to require dashboard.view, which Waiter, Cashier and Kitchen do not
    // hold — so those roles loaded the staff shell from /staff/me and then got
    // a 403 for every module's data, leaving the screens empty. The module the
    // permission is named after is gated separately by the sidebar's `modules`
    // map; each endpoint still enforces its own permission for reads and writes.
    const g = await guard(req);
    if (!g.ok) return g.response;
    const tenantId = g.session.tenantId;

    const db = admin();

    // Sessions, the audit trail and audit stats are security-module data.
    // bootstrap is deliberately not permission-gated as a whole (the staff
    // shell loads through it), so these fields must be gated individually —
    // otherwise any staff PIN could read the owner's session list and the
    // tenant's audit history from the bootstrap payload.
    const canSeeSecurity =
      g.session.kind !== "staff" ||
      g.session.permissions.some((p: string) =>
        ["security.view", "security.manage"].includes(p),
      );

    const { data: tenantRow, error: tenantError } = await db
      .from("tenants")
      .select("*")
      .eq("id", tenantId)
      .maybeSingle();
    if (tenantError) return json(req, { error: tenantError.message }, 500);
    if (!tenantRow) return json(req, { error: "Tenant not found" }, 404);

    const [
      usersRes,
      rolesRes,
      categoriesRes,
      menuRes,
      tablesRes,
      ordersRes,
      reservationsRes,
      promosRes,
      securityLogsRes,
      staffRes,
      settingsRes,
      securityBundle,
      tableSessionsRes,
    ] = await Promise.all([
      db
        .from("profiles")
        .select("*, roleRef:roles(*)")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: true }),
      db.from("roles").select("*").eq("tenant_id", tenantId).order("created_at", {
        ascending: true,
      }),
      db.from("categories").select("*").eq("tenant_id", tenantId).order("sort_order", {
        ascending: true,
      }),
      db
        .from("menu_items")
        .select("*, category:categories(*)")
        .eq("tenant_id", tenantId)
        .order("sort_order", { ascending: true }),
      db.from("tables").select("*").eq("tenant_id", tenantId).order("name", {
        ascending: true,
      }),
      db
        .from("orders")
        .select("*, items:order_items(*), table:tables(*), servedBy:profiles(*)")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false })
        .limit(200),
      db
        .from("reservations")
        .select("*, table:tables(*)")
        .eq("tenant_id", tenantId)
        .order("date", { ascending: true }),
      db.from("promo_codes").select("*").eq("tenant_id", tenantId).order("created_at", {
        ascending: false,
      }),
      canSeeSecurity
        ? db
            .from("security_logs")
            .select("*, user:profiles(*)")
            .eq("tenant_id", tenantId)
            .order("created_at", { ascending: false })
            .limit(50)
        : Promise.resolve({ data: [], error: null }),
      db.from("staff").select("*, role:roles(*)").eq("tenant_id", tenantId).order("name", {
        ascending: true,
      }),
      // Settings and the security trio join the same wave. They used to run as
      // two further sequential rounds (settings, then three more queries), so
      // every bootstrap paid three round trips for data that depends on
      // nothing but `tenantId` and the caller's permissions.
      db.from("settings").select("key, value").eq("tenant_id", tenantId),
      canSeeSecurity
        ? Promise.all([
            listAuthSessions(db, tenantId, g.session.sessionId),
            listStaffSessions(db, tenantId),
            auditStats(db, tenantId),
          ])
        : Promise.resolve([] as [any, any, any]),
      // The sittings the Orders board groups by: when each table sat down and
      // whether it is still open. Read-only; no totals live here. Deliberately
      // named `tableSessions` — `sessions` in this payload is already the
      // sign-in list the Security page reads.
      db
        .from("table_sessions")
        .select("id, table_id, status, created_at, ended_at")
        .eq("tenant_id", tenantId)
        .or(`status.eq.ACTIVE,created_at.gte.${new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()}`),
    ]);

    if (usersRes.error) return json(req, { error: usersRes.error.message }, 500);
    if (rolesRes.error) return json(req, { error: rolesRes.error.message }, 500);
    if (categoriesRes.error) return json(req, { error: categoriesRes.error.message }, 500);
    if (menuRes.error) return json(req, { error: menuRes.error.message }, 500);
    if (tablesRes.error) return json(req, { error: tablesRes.error.message }, 500);
    if (ordersRes.error) return json(req, { error: ordersRes.error.message }, 500);
    if (reservationsRes.error) return json(req, { error: reservationsRes.error.message }, 500);
    if (promosRes.error) return json(req, { error: promosRes.error.message }, 500);
    if (securityLogsRes.error) return json(req, { error: securityLogsRes.error.message }, 500);
    if (staffRes.error) return json(req, { error: staffRes.error.message }, 500);

    // Real owner sessions (auth.sessions), scoped to this tenant's profiles —
    // fetched in the wave above. The old query read `user_sessions`, a table
    // nothing ever wrote to, so the Security page always showed 0 sessions.
    let sessions;
    let securityStats = null;
    if (canSeeSecurity) {
      const [authSessions, staffSessions, stats] = (securityBundle as [any[], any[], any]) ?? [];
      sessions = [...(authSessions ?? []), ...(staffSessions ?? [])].sort((a, b) =>
        String(b.lastActive).localeCompare(String(a.lastActive))
      );
      securityStats = stats ?? null;
    } else {
      sessions = [];
    }

    const { data: settingsRows, error: settingsError } = settingsRes;
    if (settingsError) return json(req, { error: settingsError.message }, 500);

    const settingsMap: Record<string, string> = {};
    for (const s of settingsRows ?? []) settingsMap[s.key] = s.value;

    // The onboarding draft is the wizard's unsaved work: the restaurant's
    // details, its menu and its tables, written before setup is complete. It is
    // owner work-in-progress, so it travels only to a caller who could open the
    // wizard — the same key the wizard's own endpoint now requires. Everything
    // else in `settings` is ordinary restaurant configuration the shell needs.
    const canSeeDraft = g.session.permissions.includes("settings.manage");
    if (!canSeeDraft) delete settingsMap[ONBOARDING_DRAFT_KEY];

    const tenant = toCamel(tenantRow);
    const users = toCamel(usersRes.data ?? []);
    const roles = toCamel(rolesRes.data ?? []);
    const categories = toCamel(categoriesRes.data ?? []);
    const menuItems = (menuRes.data ?? []).map((row: any) => {
      const item = toCamel<any>(row);
      const portions = normalizeStoredPortions(row?.portions);
      item.portions = portions;
      if (portions && portions.length > 0) {
        item.price = effectiveDishBasePrice(item.price, portions);
      }
      return item;
    });
    const tables = toCamel(tablesRes.data ?? []);
    const orders = toCamel(ordersRes.data ?? []);
    const reservations = toCamel(reservationsRes.data ?? []);
    const promos = toCamel(promosRes.data ?? []);
    // Clean legacy IPs (whole proxy chains) on read — see security/list.
    // The Security page renders this payload, so the actor is resolved here
    // with the same rules /security uses — a staff PIN action is named from the
    // staff record, a failed login is an attempted identity, never a person.
    const actorLookup = actorMaps(staffRes.data, usersRes.data);
    const securityLogs = toCamel(
      (securityLogsRes.data ?? []).map((l) => ({
        ...presentLog(l, actorLookup),
        ip: cleanIp(l.ip),
      })),
    );
    const staff = toCamel(staffRes.data ?? []);

    // The counters come from the server's aggregate, not from the 200-order
    // window above: on a day busier than that window, a JS reduce here
    // undercounted revenue and orders today. (tenant_order_summary, migration
    // 0060 — the same function the delta sync uses, so the numbers can never
    // disagree with each other.)
    const { data: summaryRow, error: summaryError } = await db.rpc(
      "tenant_order_summary",
      { p_tenant: tenantId },
    );
    if (summaryError) return json(req, { error: summaryError.message }, 500);
    const revenue = Number((summaryRow as any)?.revenue ?? 0);
    const ordersToday = Number((summaryRow as any)?.ordersToday ?? 0);
    const activeOrders = Number((summaryRow as any)?.activeOrders ?? 0);

    // Keyed by session id, the same shape the delta sync sends. Read-only
    // sitting facts — start, status, end — never money.
    const tableSessions: Record<string, {
      id: string;
      tableId: string;
      status: string;
      startedAt: string;
      endedAt: string | null;
    }> = {};
    for (const row of (tableSessionsRes as any)?.data ?? []) {
      tableSessions[row.id] = {
        id: row.id,
        tableId: row.table_id,
        status: row.status,
        startedAt: row.created_at,
        endedAt: row.ended_at ?? null,
      };
    }


    // A staff session is identified by `guard()`; fetch the extra staff fields
    // (employee id, avatar) the dashboard shows.
    let currentStaff: any = null;
    let staffPermissions: string[] = [];

    // users/roles/staff are a people directory. Only send them to a caller who
    // can actually reach the screens that show them.
    const canSeePeople =
      g.session.kind !== "staff" ||
      g.session.permissions.some((p: string) =>
        ["roles.view", "roles.manage", "staff.view", "staff.manage"].includes(p),
      );

    // The caller's effective permissions, regardless of session kind. Exposing
    // this explicitly matters because previously an owner and a staff member
    // with nothing granted both arrived as an empty list, so a client could not
    // tell "can do everything" from "can do nothing" and had to guess — and
    // guessing wrong is how a restricted role got a delete button.
    //
    // It is the session's list for both kinds, and it has to be: this is the
    // list the sidebar and the view gates read, while `guard()` re-derives it
    // from the profile's role on every request. Handing an owner-kind session
    // all nineteen keys regardless of the role on its profile meant a profile
    // with a limited role was shown every module and then refused by every
    // endpoint behind it. An owner's profile carries the Owner role, so an
    // owner still receives all nineteen.
    const effectivePermissions: string[] = [...g.session.permissions];
    if (g.session.kind === "staff") {
      const { data: staffRow } = await db
        .from("staff")
        .select("*")
        .eq("id", g.session.subjectId)
        .eq("tenant_id", tenantId)
        .maybeSingle();
      staffPermissions = g.session.permissions;
      currentStaff = {
        id: g.session.subjectId,
        name: g.session.name,
        employeeId: staffRow?.employee_id,
        role: g.session.roleName,
        avatar: staffRow?.avatar,
      };
    }

    const currentUser =
      (users as any[])[0] ||
      (currentStaff
        ? {
          id: currentStaff.id,
          name: currentStaff.name,
          email: `${currentStaff.employeeId}@staff.local`,
          role: currentStaff.role,
        }
        : null);

    // The plan in force, so the app knows whether to show the trial
    // countdown, the upgrade screen or nothing at all.
    const plan = await resolvePlan(tenantId);

    return json(req, {
      tenant,
      subscription: {
        planId: plan.planId,
        planName: plan.planName,
        status: plan.status,
        isPaid: plan.isPaid,
        isTrial: plan.isTrial,
        isRestricted: plan.isRestricted,
        trialStartedAt: plan.trialStartedAt,
        trialEndsAt: plan.trialEndsAt,
        trialDaysRemaining: plan.trialDaysRemaining,
        currentPeriodEnd: plan.currentPeriodEnd,
        cancelAtPeriodEnd: plan.cancelAtPeriodEnd,
        limits: plan.limits,
        features: plan.features,
        priceMonthly: plan.priceMonthly,
        priceYearly: plan.priceYearly,
        billingInterval: plan.billingInterval,
        paymentMode: plan.paymentMode,
        currency: plan.currency,
        subscriptionPlan: plan.subscriptionPlan,
        subscriptionStartedAt: plan.subscriptionStartedAt,
        billingMode: plan.billingMode,
      },
      settings: settingsMap,
      currentUser,
      currentStaff,
      staffPermissions,
      permissions: effectivePermissions,
      // The topic this restaurant's staff listen on. Issued only to a caller
      // who can read orders or the floor, and never derivable from the tenant
      // id — that is what stops a diner (who knows the tenant id) from
      // subscribing. Absent for anyone without those keys.
      realtimeTopic:
        effectivePermissions.some((p: string) => ["orders.view", "tables.view"].includes(p))
          ? await staffTopic(g.session.tenantId)
          : null,
      users: canSeePeople ? users : [],
      roles: canSeePeople ? roles : [],
      staff: canSeePeople ? staff : [],
      categories,
      menuItems,
      tables,
      orders,
      tableSessions,
      reservations,
      promos,
      sessions,
      securityLogs,
      securityStats,
      summary: {
        revenue: +revenue.toFixed(2),
        ordersToday,
        activeOrders,
        totalTables: tables.length,
        totalMenuItems: menuItems.length,
        pendingReservations: (reservations as any[]).filter((r) => r.status === "PENDING").length,
      },
    });
  } catch (err) {
    return json(req, { error: (err as Error).message ?? "Unexpected error" }, 500);
  }
});
