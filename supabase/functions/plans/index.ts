// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { admin } from "../_shared/db.ts";
import { json, preflight } from "../_shared/http.ts";

/**
 * GET /functions/v1/plans — PUBLIC.
 *
 * The plan catalogue, for the pricing on the landing page and the billing
 * tab. The pricing used to be written out by hand in two places, and the two
 * copies disagreed with each other and with the catalogue — the landing page
 * said fifty menu items where the catalogue said a hundred, and put AI menu
 * extraction under Pro when the plan includes it in Starter.
 *
 * This is the one copy. It is public because a price and a feature list are
 * marketing information, and it returns **only** the marketing fields: no
 * Razorpay plan id, no trial state, nothing about a restaurant.
 *
 * The table itself has no row level security policy, so this function — which
 * uses the service role — is the only thing that can read it.
 */

const PLAN_COLUMNS =
  "id, name, description, price_monthly, price_yearly, currency, features, trial_days, max_locations, max_staff, max_menu_items, is_popular, sort_order";

Deno.serve(async (req: Request) => {
  const pf = preflight(req);
  if (pf) return pf;

  if (req.method !== "GET") {
    return json(req, { error: "Method not allowed" }, 405);
  }

  try {
    const { data, error } = await admin()
      .from("subscription_plans")
      .select(PLAN_COLUMNS)
      .eq("is_active", true)
      .order("sort_order", { ascending: true });

    if (error) return json(req, { error: error.message }, 500);

    const plans = (data ?? []).map((p: any) => ({
      id: p.id,
      name: p.name,
      description: p.description ?? null,
      priceMonthly: Number(p.price_monthly ?? 0),
      priceYearly: Number(p.price_yearly ?? 0),
      currency: p.currency ?? "INR",
      features: Array.isArray(p.features) ? p.features : [],
      limits: {
        locations: p.max_locations ?? null,
        staff: p.max_staff ?? null,
        menuItems: p.max_menu_items ?? null,
      },
      popular: Boolean(p.is_popular),
    }));

    return json(req, { plans });
  } catch (e) {
    console.error("plans: could not read the catalogue", e);
    return json(req, { error: "Could not load the plans" }, 500);
  }
});
