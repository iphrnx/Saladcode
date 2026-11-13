/**
 * The AI onboarding usage limits, separated from the plumbing that enforces
 * them.
 *
 * Everything here is pure: no database, no network, no environment. The edge
 * functions read the env and the counters; this module turns those into a
 * decision. A rule that can only be exercised against a live database is a
 * rule nobody tests.
 *
 * The limits exist to stop quota drain and runaway AI costs: a stuck retry
 * loop or a scripted caller should hit a wall before the provider bill does.
 *
 * Environment variables (every one optional, defaults shown):
 *
 *   AI_MAX_MENU_SCANS_RPM          per-tenant menu extractions per minute (5)
 *   AI_MAX_DISH_IMAGES_RPM         per-tenant dish images per minute (20)
 *   AI_MAX_RPM_PER_TENANT          sets both per-minute limits at once when the
 *                                  per-action variables above are absent
 *   AI_MAX_MENU_SCANS_PER_TENANT   successful menu extractions per day (15)
 *   AI_MAX_DISH_IMAGES_PER_TENANT  successful dish images per day (60)
 *   AI_MAX_MENU_SCAN_IMAGES        pages accepted per extraction request (10)
 *
 * The payload cap defaults to 10 because that is the contract the onboarding
 * UI was built against ("Maximum 10 files allowed"). The recommended value is
 * 5 — set the env var and clamp the UI together, never one without the other.
 */

export type AiUsageAction = "extract" | "image";

export type AiLimits = {
  menuScansPerMinute: number;
  dishImagesPerMinute: number;
  menuScansPerDay: number;
  dishImagesPerDay: number;
  maxMenuScanImages: number;
};

const DEFAULTS: AiLimits = {
  menuScansPerMinute: 5,
  dishImagesPerMinute: 20,
  menuScansPerDay: 15,
  dishImagesPerDay: 60,
  maxMenuScanImages: 10,
};

/** A limit is a positive whole number; anything else falls back quietly. */
function parseLimit(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

export function resolveAiLimits(get: (key: string) => string | undefined): AiLimits {
  const rpmForAll = parseLimit(get("AI_MAX_RPM_PER_TENANT"));
  return {
    menuScansPerMinute:
      parseLimit(get("AI_MAX_MENU_SCANS_RPM")) ?? rpmForAll ?? DEFAULTS.menuScansPerMinute,
    dishImagesPerMinute:
      parseLimit(get("AI_MAX_DISH_IMAGES_RPM")) ?? rpmForAll ?? DEFAULTS.dishImagesPerMinute,
    menuScansPerDay:
      parseLimit(get("AI_MAX_MENU_SCANS_PER_TENANT")) ?? DEFAULTS.menuScansPerDay,
    dishImagesPerDay:
      parseLimit(get("AI_MAX_DISH_IMAGES_PER_TENANT")) ?? DEFAULTS.dishImagesPerDay,
    maxMenuScanImages:
      parseLimit(get("AI_MAX_MENU_SCAN_IMAGES")) ?? DEFAULTS.maxMenuScanImages,
  };
}

export type UsageDecision = { ok: true } | { ok: false; message: string };

const ACTION_LABEL: Record<AiUsageAction, string> = {
  extract: "menu scan",
  image: "dish image",
};

/**
 * Whether a request may proceed, given what the tenant has already done.
 *
 * The per-minute window counts every attempt, failed or not — burst
 * protection exists to stop a hammering caller, and a hammering caller
 * usually fails a lot. The daily cap counts only successful completions, so
 * a restaurant is never charged quota for a call that gave it nothing.
 */
export function usageDecision(opts: {
  action: AiUsageAction;
  limits: AiLimits;
  requestsLastMinute: number;
  successesToday: number;
}): UsageDecision {
  const label = ACTION_LABEL[opts.action];
  const perMinute = opts.action === "extract"
    ? opts.limits.menuScansPerMinute
    : opts.limits.dishImagesPerMinute;
  const perDay = opts.action === "extract"
    ? opts.limits.menuScansPerDay
    : opts.limits.dishImagesPerDay;

  if (opts.requestsLastMinute >= perMinute) {
    return {
      ok: false,
      message:
        `Too many ${label} requests — the limit is ${perMinute} per minute. Wait a moment and try again.`,
    };
  }
  if (opts.successesToday >= perDay) {
    return {
      ok: false,
      message:
        `Daily AI onboarding limit reached (${perDay} ${label}s per day). Try again tomorrow.`,
    };
  }
  return { ok: true };
}
