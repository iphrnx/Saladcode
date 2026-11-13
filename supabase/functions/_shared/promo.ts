// deno-lint-ignore-file no-explicit-any
/**
 * Promo evaluation — the single authority on whether a promo code applies.
 *
 * Three engines used to decide this independently, and they disagreed:
 *
 *   - the POS client checked case, expiry, usage limit and minimum order, and
 *     showed the cashier a discounted total;
 *   - the orders edge function checked only `active` and the minimum order, and
 *     matched codes case-sensitively;
 *   - the database function place_order() had the full rule set.
 *
 * So a cashier could apply a code, watch the total drop, and have the server
 * create the order at full price with nothing said about it. Everything now
 * comes from here: the edge function uses it to decide and to explain, and the
 * POS asks it before showing a discount.
 *
 * The rule set mirrors the database function place_order() exactly, including
 * the `max_discount` cap applying to fixed-amount codes as well as
 * percentages. The diner RPC path and the staff edge-function path must never
 * disagree about money.
 */

export type PromoEvaluation = {
  /** True only when every rule passed and a discount may be applied. */
  applied: boolean;
  /** Written for a cashier to read out to a customer. Null when applied. */
  reason: string | null;
  /** The discount for the given itemsTotal. 0 when not applied. */
  discount: number;
  /** The promo code as stored, or null when no code matched. */
  code: string | null;
  /** The matched promo row, or null. */
  promo: any | null;
};

type Reason = {
  notFound: string;
  inactive: string;
  notYetValid: string;
  expired: string;
  usageLimit: string;
  minOrder: (required: string, current: string) => string;
};

const REASON: Reason = {
  notFound: "Promo code not found",
  inactive: "This promo code is no longer active",
  notYetValid: "This promo code is not active yet",
  expired: "This promo code has expired",
  usageLimit: "This promo code has reached its usage limit",
  minOrder: (required, current) => `Minimum order of ${required} required (current ${current})`,
};

export type EvaluatePromoOptions = {
  /** Currency symbol used in the human-readable reason. Defaults to ₹. */
  currencySymbol?: string;
  /** Injectable clock, so the rules can be tested without waiting. */
  now?: Date;
};

/**
 * Decide whether `rawCode` applies to an order worth `itemsTotal`.
 *
 * Throws only on a database error. A promo that does not qualify is a normal
 * outcome, not an error — it comes back with `applied: false` and a reason.
 */
export async function evaluatePromo(
  db: any,
  tenantId: string,
  rawCode: string | null | undefined,
  itemsTotal: number,
  opts: EvaluatePromoOptions = {},
): Promise<PromoEvaluation> {
  const symbol = opts.currencySymbol ?? "₹";
  const now = opts.now ?? new Date();
  const code = (rawCode ?? "").trim();

  if (!code) {
    return { applied: false, reason: null, discount: 0, code: null, promo: null };
  }

  // Escape LIKE wildcards so a code containing % or _ matches literally
  // instead of becoming a pattern that matches other codes.
  const pattern = code.replace(/[\\%_]/g, (m) => `\\${m}`);

  const { data: candidates, error } = await db
    .from("promo_codes")
    .select("*")
    .eq("tenant_id", tenantId)
    .ilike("code", pattern)
    .limit(2);

  if (error) throw new Error(error.message);

  // ILIKE is case-insensitive, but the stored code is the authority on what the
  // customer said out loud. Compare exactly before trusting a row, and pick
  // deterministically if two codes differ only in case.
  const promo =
    (candidates ?? []).find((p: any) => p.code.trim().toUpperCase() === code.toUpperCase()) ?? null;

  if (!promo) {
    return { applied: false, reason: REASON.notFound, discount: 0, code: null, promo: null };
  }

  const declined = (reason: string): PromoEvaluation => ({
    applied: false,
    reason,
    discount: 0,
    code: promo.code,
    promo,
  });

  if (!promo.active) return declined(REASON.inactive);

  if (promo.valid_from && new Date(promo.valid_from).getTime() > now.getTime()) {
    return declined(REASON.notYetValid);
  }

  if (promo.valid_to && new Date(promo.valid_to).getTime() <= now.getTime()) {
    return declined(REASON.expired);
  }

  if (promo.usage_limit > 0 && (promo.used_count ?? 0) >= promo.usage_limit) {
    return declined(REASON.usageLimit);
  }

  if (itemsTotal < promo.min_order) {
    return declined(
      REASON.minOrder(
        `${symbol}${promo.min_order.toFixed(2)}`,
        `${symbol}${itemsTotal.toFixed(2)}`,
      ),
    );
  }

  // Mirrors place_order(): max_discount caps fixed-amount codes too, and the
  // discount can never exceed the order.
  let discount = promo.type === "PERCENTAGE" ? (itemsTotal * promo.value) / 100 : promo.value;
  if (promo.max_discount > 0) discount = Math.min(discount, promo.max_discount);
  discount = Math.min(discount, itemsTotal);

  return {
    applied: true,
    reason: null,
    discount: Math.max(0, discount),
    code: promo.code,
    promo,
  };
}
