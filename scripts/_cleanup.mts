/**
 * Cleanup that cannot orphan a real order.
 *
 * `orders.table_session_id` is `on delete set null`, so deleting a session
 * silently detaches every order on it — the order stays, but it no longer
 * knows which table or sitting it belonged to, and "Start Preparing" then has
 * nothing to accept. A test script that deletes sessions by id did exactly
 * that to a live order on 8 Nov.
 *
 * So: a session with orders is ended, never deleted. Only a session this run
 * created and which nobody ordered on is removed outright.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export async function releaseSession(admin: SupabaseClient, sessionId: string): Promise<"deleted" | "ended"> {
  const { count } = await admin
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("table_session_id", sessionId);

  if ((count ?? 0) > 0) {
    // It has orders: end it, which is what a restaurant would do anyway.
    await admin
      .from("table_sessions")
      .update({ status: "ENDED", ended_at: new Date().toISOString() })
      .eq("id", sessionId);
    return "ended";
  }

  await admin.from("table_sessions").delete().eq("id", sessionId);
  return "deleted";
}

export async function releaseSessions(admin: SupabaseClient, ids: string[]): Promise<{ deleted: number; ended: number }> {
  let deleted = 0, ended = 0;
  for (const id of ids) {
    const outcome = await releaseSession(admin, id);
    if (outcome === "deleted") deleted++; else ended++;
  }
  return { deleted, ended };
}
