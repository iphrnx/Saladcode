// deno-lint-ignore-file no-explicit-any
import { admin } from "./db.ts";
import {
  resolveAiLimits,
  usageDecision,
  type AiLimits,
  type AiUsageAction,
  type UsageDecision,
} from "./ai-limits.ts";

/**
 * The pre-flight usage guard for the AI onboarding calls.
 *
 * The counters come from `ai_request_logs`, the table every AI call already
 * writes to — no new schema. Two counts per request: attempts inside the
 * last minute (burst protection) and successful completions since UTC
 * midnight (the daily cap). A success only exists in the table after the
 * call completes, which is exactly the "count only on success" rule.
 *
 * Fail-open by policy: if the count query itself fails, the request is
 * allowed and the error is logged. The guard exists to protect the quota,
 * and a quota check that can take onboarding down protects the wrong thing.
 */

export function aiLimitsFromEnv(): AiLimits {
  return resolveAiLimits((key) => Deno.env.get(key));
}

export async function checkAiUsage(
  tenantId: string,
  action: AiUsageAction,
): Promise<UsageDecision> {
  const limits = aiLimitsFromEnv();
  const sinceMinute = new Date(Date.now() - 60_000).toISOString();
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);

  try {
    const db = admin();
    const head = { count: "exact" as const, head: true };
    const [minute, day] = await Promise.all([
      db
        .from("ai_request_logs")
        .select("id", head)
        .eq("tenant_id", tenantId)
        .eq("action", action)
        .gte("created_at", sinceMinute),
      db
        .from("ai_request_logs")
        .select("id", head)
        .eq("tenant_id", tenantId)
        .eq("action", action)
        .eq("status", "ok")
        .gte("created_at", dayStart.toISOString()),
    ]);

    if (minute.error) throw minute.error;
    if (day.error) throw day.error;

    const decision = usageDecision({
      action,
      limits,
      requestsLastMinute: minute.count ?? 0,
      successesToday: day.count ?? 0,
    });
    if (!decision.ok) {
      console.warn(
        `[AI Guard] ${action} blocked for tenant ${tenantId}: ${decision.message}`,
      );
    }
    return decision;
  } catch (e) {
    console.error(
      `[AI Guard] usage check failed, allowing the request: ${(e as Error)?.message ?? e}`,
    );
    return { ok: true };
  }
}
