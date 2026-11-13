// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { guard } from "../_shared/auth.ts";
import { admin } from "../_shared/db.ts";
import { body, json, preflight } from "../_shared/http.ts";

import { clientIp } from "../_shared/ip.ts";
import { dispatchPending, queueForTenant } from "../_shared/email.ts";
/**
 * /functions/v1/settings
 *   GET  { tenant, settings }   (settings.view)
 *   PUT  update tenant + settings (settings.manage)
 */

function mapTenant(t: any) {
  if (!t) return null;
  return {
    id: t.id,
    name: t.name,
    slug: t.slug,
    logo: t.logo,
    tagline: t.tagline,
    currency: t.currency,
    currencySymbol: t.currency_symbol,
    address: t.address,
    phone: t.phone,
    email: t.email,
    taxRate: t.tax_rate,
    serviceCharge: t.service_charge,
    plan: t.plan,
    active: t.active,
    onboardingDone: t.onboarding_done,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

/**
 * DELETE — permanently remove a restaurant.
 *
 * The order matters: the confirmation email is queued and *delivered* before
 * anything is destroyed, because after `purge_tenant` there is no address left
 * to write to and nobody to tell. If the provider will not take the message,
 * the deletion is refused rather than performed silently — the owner can retry
 * in a minute instead of losing an account they were never told about.
 *
 * The purge itself leaves a tombstone row so invoices and payments (which a
 * business must keep) still reference something, and keeps the email_events
 * record as the delivery history for this one message.
 */
async function remove(req: Request): Promise<Response> {
  const g = await guard(req, { permission: "settings.manage" });
  if (!g.ok) return g.response;
  // Only the owner may destroy the restaurant — a manager holding
  // settings.manage does not get to end the business's account.
  if (g.session.kind !== "owner") {
    return json(req, { error: "Only the restaurant owner can delete the account." }, 403);
  }

  const db = admin();
  const tenantId = g.session.tenantId;

  try {
    const queued = await queueForTenant(db, tenantId, {
      eventKey: `account_deleted:${tenantId}:${new Date().toISOString()}`,
      eventType: "account_deleted",
      planName: null,
      payload: { deletedAt: new Date().toISOString() },
    });

    if (!queued) {
      return json(
        req,
        { error: "We could not reach your email address to confirm the deletion, so nothing was deleted. Please try again." },
        502,
      );
    }

    const sent = await dispatchPending(db, 1);
    if (sent.sent < 1) {
      return json(
        req,
        {
          error:
            "The deletion confirmation could not be sent, so nothing was deleted. Please try again in a moment.",
          retryable: true,
        },
        502,
      );
    }

    const { data: purged, error: purgeError } = await db.rpc("purge_tenant", { p_tenant_id: tenantId });
    if (purgeError) {
      console.error("settings: purge failed", purgeError.message);
      return json(req, { error: "Could not delete the account. Nothing was changed." }, 500);
    }

    return json(req, { ok: true, deleted: true, removed: purged });
  } catch (err) {
    console.error("settings: delete failed", (err as Error)?.message);
    return json(req, { error: "Could not delete the account. Nothing was changed." }, 500);
  }
}

async function loadSettings(tenantId: string): Promise<Record<string, string>> {
  const { data } = await admin()
    .from("settings")
    .select("key, value")
    .eq("tenant_id", tenantId);
  const settingsMap: Record<string, string> = {};
  for (const s of data ?? []) settingsMap[s.key] = s.value;
  return settingsMap;
}

Deno.serve(async (req: Request) => {
  const pf = preflight(req);
  if (pf) return pf;

  try {
    switch (req.method) {
      case "GET":
        return await get(req);
      case "PUT":
      case "PATCH":
        return await put(req);
      case "DELETE":
        return await remove(req);
      default:
        return json(req, { error: "Method not allowed" }, 405);
    }
  } catch (err) {
    return json(req, { error: (err as Error).message ?? "Unexpected error" }, 500);
  }
});

async function get(req: Request): Promise<Response> {
  const g = await guard(req, { permission: "settings.view" });
  if (!g.ok) return g.response;
  const tenantId = g.session.tenantId;

  const db = admin();

  const { data: tenant, error: tenantError } = await db
    .from("tenants")
    .select("*")
    .eq("id", tenantId)
    .maybeSingle();
  if (tenantError) return json(req, { error: tenantError.message }, 500);

  const { data: settings, error: settingsError } = await db
    .from("settings")
    .select("key, value")
    .eq("tenant_id", tenantId);
  if (settingsError) return json(req, { error: settingsError.message }, 500);

  const settingsMap: Record<string, string> = {};
  for (const s of settings ?? []) settingsMap[s.key] = s.value;
  return json(req, { tenant: mapTenant(tenant), settings: settingsMap });
}

async function put(req: Request): Promise<Response> {
  const g = await guard(req, { permission: "settings.manage" });
  if (!g.ok) return g.response;
  const tenantId = g.session.tenantId;

  const b = await body(req);
  const db = admin();

  const tenantPayload = b.tenant as Record<string, any> | undefined;
  if (tenantPayload) {
    const { error } = await db
      .from("tenants")
      .update({
        name: tenantPayload.name,
        tagline: tenantPayload.tagline,
        address: tenantPayload.address,
        phone: tenantPayload.phone,
        email: tenantPayload.email,
        currency: tenantPayload.currency,
        currency_symbol: tenantPayload.currencySymbol,
        tax_rate: tenantPayload.taxRate,
        service_charge: tenantPayload.serviceCharge,
        logo: tenantPayload.logo,
      })
      .eq("id", tenantId); // tenant scoping
    if (error) return json(req, { error: error.message }, 500);
  }

  const settingsPayload = b.settings as Record<string, unknown> | undefined;
  if (settingsPayload) {
    // One upsert for every key. This used to await a separate upsert per key,
    // so a tab that saves a dozen preferences made a dozen sequential round
    // trips to Postgres and the Save button sat on "Saving…" for six seconds
    // on a request that had nothing to do.
    const rows = Object.entries(settingsPayload).map(([key, value]) => ({
      tenant_id: tenantId,
      key,
      value: String(value),
    }));
    if (rows.length > 0) {
      const { error } = await db
        .from("settings")
        .upsert(rows, { onConflict: "tenant_id,key" });
      if (error) return json(req, { error: error.message }, 500);

      // If Auto Accept Orders was enabled, auto-accept any pending activation orders
      if (settingsPayload.auto_accept_orders === "true") {
        await db
          .from("orders")
          .update({ status: "PENDING" })
          .eq("tenant_id", tenantId)
          .eq("status", "PENDING_ACTIVATION");

        await db
          .from("order_items")
          .update({ status: "PENDING" })
          .eq("status", "PENDING_ACTIVATION");

        await db
          .from("table_sessions")
          .update({ activation_status: "ACTIVE", activated_at: new Date().toISOString() })
          .eq("tenant_id", tenantId)
          .eq("activation_status", "PENDING");
      }
    }
  }

  // log it
  const { error: logError } = await db.from("security_logs").insert({
    tenant_id: tenantId,
    action: "SETTINGS_CHANGE",
    meta: "Updated restaurant settings",
    // The request's own details, as every other audit entry records them —
    // these two were hardcoded, which made the log look complete and be wrong.
    ip: clientIp(req),
    user_agent: req.headers.get("user-agent") || "unknown",
  });
  if (logError) return json(req, { error: logError.message }, 500);

  const { data: tenant, error: tenantError } = await db
    .from("tenants")
    .select("*")
    .eq("id", tenantId)
    .maybeSingle();
  if (tenantError) return json(req, { error: tenantError.message }, 500);

  const settingsMap = await loadSettings(tenantId);
  return json(req, { tenant: mapTenant(tenant), settings: settingsMap });
}
