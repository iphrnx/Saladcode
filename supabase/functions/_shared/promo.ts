// deno-lint-ignore-file no-explicit-any
/**
 * Promo evaluation and status determination — the single authority across
 * the Admin Panel, Create/Edit modal, POS checkout, and Supabase backend.
 *
 * All dates are evaluated as calendar dates in Asia/Kolkata (IST).
 * valid_until is inclusive for the entire selected date through 23:59:59.999 IST.
 */

export type PromoStatus = 'expired' | 'exhausted' | 'paused' | 'scheduled' | 'active';

const istFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Return the calendar date in Asia/Kolkata as a deterministic YYYY-MM-DD string.
 * Uses Intl.DateTimeFormat with formatToParts to avoid implicit timezone shifts.
 */
export function getISTDateString(date: Date = new Date()): string {
  const parts = istFormatter.formatToParts(date);
  let year = '';
  let month = '';
  let day = '';
  for (const part of parts) {
    if (part.type === 'year') year = part.value;
    else if (part.type === 'month') month = part.value;
    else if (part.type === 'day') day = part.value;
  }
  return `${year}-${month}-${day}`;
}

/**
 * Convert string, number, or Date input to a deterministic YYYY-MM-DD date string in IST.
 * Date-only strings ('YYYY-MM-DD') are preserved as-is.
 */
export function toISTDateString(val: string | number | Date | null | undefined): string | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return trimmed;
    }
    const d = new Date(trimmed);
    if (isNaN(d.getTime())) return null;
    return getISTDateString(d);
  }
  if (typeof val === 'number') {
    const d = new Date(val);
    if (isNaN(d.getTime())) return null;
    return getISTDateString(d);
  }
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return null;
    return getISTDateString(val);
  }
  return null;
}

/** 00:00:00.000 IST for the given YYYY-MM-DD date. */
export function istStartOfDayISO(dateStr: string): string {
  return `${dateStr}T00:00:00.000+05:30`;
}

/** 23:59:59.999 IST for the given YYYY-MM-DD date. */
export function istEndOfDayISO(dateStr: string): string {
  return `${dateStr}T23:59:59.999+05:30`;
}

/**
 * Normalize promo code input: uppercase and alphanumeric with underscores/hyphens.
 */
export function normalizePromoCode(code: string | null | undefined): string {
  return (code ?? '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
}

/**
 * Pure, reusable status logic with strict priority:
 * 1. expired — valid_until exists and today is later than valid_until.
 * 2. exhausted — usage_limit != null && redemptions >= usage_limit (usage_limit > 0).
 * 3. paused — is_active === false.
 * 4. scheduled — valid_from exists and today is earlier than valid_from.
 * 5. active — otherwise.
 *
 * Accepts both camelCase and snake_case properties for compatibility across UI & DB.
 */
export function getPromoStatus(
  promo: {
    valid_to?: string | Date | null;
    valid_until?: string | Date | null;
    validTo?: string | Date | null;
    validUntil?: string | Date | null;
    valid_from?: string | Date | null;
    validFrom?: string | Date | null;
    usage_limit?: number | string | null;
    usageLimit?: number | string | null;
    used_count?: number | string | null;
    usedCount?: number | string | null;
    redemptions?: number | string | null;
    active?: boolean | null;
    is_active?: boolean | null;
    isActive?: boolean | null;
  } | null | undefined,
  todayIST?: string,
): PromoStatus {
  if (!promo) return 'expired';

  const today = todayIST ?? getISTDateString();

  // 1. expired — valid_until exists and today is later than valid_until
  const validUntilStr = toISTDateString(
    promo.valid_until ?? promo.validUntil ?? promo.valid_to ?? promo.validTo,
  );
  if (validUntilStr && today > validUntilStr) {
    return 'expired';
  }

  // 2. exhausted — usage_limit != null && redemptions >= usage_limit
  const rawLimit = promo.usage_limit ?? promo.usageLimit;
  const rawRedemptions = promo.redemptions ?? promo.used_count ?? promo.usedCount;
  if (rawLimit !== null && rawLimit !== undefined && rawLimit !== '') {
    const limit = Number(rawLimit);
    const redemptions = Number(rawRedemptions ?? 0);
    if (limit > 0 && redemptions >= limit) {
      return 'exhausted';
    }
  }

  // 3. paused — is_active === false
  const isActive = promo.is_active ?? promo.isActive ?? promo.active;
  if (isActive === false) {
    return 'paused';
  }

  // 4. scheduled — valid_from exists and today is earlier than valid_from
  const validFromStr = toISTDateString(promo.valid_from ?? promo.validFrom);
  if (validFromStr && today < validFromStr) {
    return 'scheduled';
  }

  // 5. active — otherwise
  return 'active';
}

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
 * Uses deterministic IST calendar comparisons and the shared getPromoStatus logic.
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
  const todayIST = getISTDateString(now);
  const code = (rawCode ?? "").trim();

  if (!code) {
    return { applied: false, reason: null, discount: 0, code: null, promo: null };
  }

  // Escape LIKE wildcards so a code containing % or _ matches literally
  const pattern = code.replace(/[\\%_]/g, (m) => `\\${m}`);

  const { data: candidates, error } = await db
    .from("promo_codes")
    .select("*")
    .eq("tenant_id", tenantId)
    .ilike("code", pattern)
    .limit(2);

  if (error) throw new Error(error.message);

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

  const status = getPromoStatus(promo, todayIST);
  if (status === 'paused') return declined(REASON.inactive);
  if (status === 'scheduled') return declined(REASON.notYetValid);
  if (status === 'expired') return declined(REASON.expired);
  if (status === 'exhausted') return declined(REASON.usageLimit);

  if (itemsTotal < promo.min_order) {
    return declined(
      REASON.minOrder(
        `${symbol}${promo.min_order.toFixed(2)}`,
        `${symbol}${itemsTotal.toFixed(2)}`,
      ),
    );
  }

  // For percentage promotions: discount = subtotal * (value / 100), capped at max_discount.
  // For flat promotions: discount = value (capped at max_discount if specified).
  // In all cases: discount is capped at itemsTotal and >= 0.
  let discount = promo.type === "PERCENTAGE" ? (itemsTotal * promo.value) / 100 : promo.value;
  const maxDiscount = Number(promo.max_discount ?? promo.maxDiscount ?? 0);
  if (maxDiscount > 0) discount = Math.min(discount, maxDiscount);
  discount = Math.min(itemsTotal, Math.max(0, discount));

  return {
    applied: true,
    reason: null,
    discount: +discount.toFixed(2),
    code: promo.code,
    promo,
  };
}
