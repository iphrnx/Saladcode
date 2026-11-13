// Audit statistics for the Security dashboard. The page used to derive its
// cards from the last 50 log rows it happened to receive, so "Failed
// Logins" meant "failures among the most recent 50 events of any kind" —
// a number that moves with unrelated activity and tells no window. These
// counts are computed server-side over explicit windows so the card and
// the label always agree.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export interface AuditStats {
  /** LOGIN_FAILED rows in the trailing 24 hours. */
  failedLogins24h: number;
  /** All audit rows in the trailing 7 days. */
  auditEvents7d: number;
}

export async function auditStats(
  db: SupabaseClient,
  tenantId: string,
): Promise<AuditStats> {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [failed, events] = await Promise.all([
    db
      .from("security_logs")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("action", "LOGIN_FAILED")
      .gte("created_at", since24h),
    db
      .from("security_logs")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .gte("created_at", since7d),
  ]);

  if (failed.error) throw new Error(failed.error.message);
  if (events.error) throw new Error(events.error.message);
  return {
    failedLogins24h: failed.count ?? 0,
    auditEvents7d: events.count ?? 0,
  };
}
