// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { guard } from "../_shared/auth.ts";
import { admin } from "../_shared/db.ts";
import { body, json, preflight } from "../_shared/http.ts";

/**
 * /functions/v1/tenants
 *   GET    list tenants for the header switcher (settings.view)
 *   PATCH  update the caller's own tenant profile    (settings.manage)
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

Deno.serve(async (req: Request) => {
  const pf = preflight(req);
  if (pf) return pf;

  try {
    switch (req.method) {
      case "GET":
        return await list(req);
      case "PATCH":
      case "PUT":
        return await update(req);
      default:
        return json(req, { error: "Method not allowed" }, 405);
    }
  } catch (err) {
    return json(req, { error: (err as Error).message ?? "Unexpected error" }, 500);
  }
});

/** GET — list every tenant (used by the header switcher). */
async function list(req: Request): Promise<Response> {
  const g = await guard(req, { permission: "settings.view" });
  if (!g.ok) return g.response;

  // Only the caller's own restaurant.
  //
  // This returned every row in the table, so any owner could read the name,
  // slug, plan and active flag of every other restaurant on the platform — and
  // the header's dropdown offered to switch to them, which then failed with a
  // 403 because guard() resolves the tenant from the session and ignores the
  // requested id. A profile belongs to exactly one restaurant (profiles.tenant_id),
  // so one row is all there is to return.
  const { data, error } = await admin()
    .from("tenants")
    .select("id, name, slug, tagline, plan, active")
    .eq("id", g.session.tenantId);
  if (error) return json(req, { error: error.message }, 500);
  return json(req, data ?? []);
}

/** PATCH — update the caller's own tenant profile fields. */
async function update(req: Request): Promise<Response> {
  const g = await guard(req, { permission: "settings.manage" });
  if (!g.ok) return g.response;
  const tenantId = g.session.tenantId;

  const b = await body(req);
  const src = (b?.tenant as Record<string, any>) ?? b ?? {};

  const patch: Record<string, any> = {};
  if (src.name !== undefined) patch.name = src.name;
  if (src.tagline !== undefined) patch.tagline = src.tagline;
  if (src.logo !== undefined) patch.logo = src.logo;
  if (src.currency !== undefined) patch.currency = src.currency;
  if (src.currencySymbol !== undefined) patch.currency_symbol = src.currencySymbol;
  if (src.address !== undefined) patch.address = src.address;
  if (src.phone !== undefined) patch.phone = src.phone;
  if (src.email !== undefined) patch.email = src.email;
  if (src.taxRate !== undefined) patch.tax_rate = src.taxRate;
  if (src.serviceCharge !== undefined) patch.service_charge = src.serviceCharge;

  if (Object.keys(patch).length === 0) {
    return json(req, { error: "No tenant fields to update" }, 400);
  }

  const { data, error } = await admin()
    .from("tenants")
    .update(patch)
    .eq("id", tenantId) // tenant scoping — never a client-supplied id
    .select()
    .single();
  if (error) return json(req, { error: error.message }, 500);

  return json(req, mapTenant(data));
}
