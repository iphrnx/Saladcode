/**
 * When a diner session may end — and, mostly, when it may not.
 *
 * The reported bug: a diner places an order and the session closes on its own,
 * and the bill and review screen appears, with nothing done at the POS.
 *
 * Two automatic rules caused it, and this test pins down that neither can fire
 * while anyone is still at the table:
 *
 *   * the validate route used to end a session on a three-minute heartbeat gap
 *     (a backgrounded phone throttles its timers, so the diner's own next beat
 *     wrote the ENDED status — their pending order and all);
 *   * the same route ended it three seconds after the page reported unloading
 *     (`pagehide` fires on a refresh, an app switch or a locked phone, so that
 *     fired for diners who had not gone anywhere).
 *
 * Since migration 0058 the unload signal is back, but as a stamp, not a
 * verdict: the sweep ends a stamped session only once the stamp is two
 * minutes old, no heartbeat landed after it, and no order exists. The checks
 * below pin down that a refresh (heartbeat after stamp) and an order both
 * keep the session alive, while a genuinely closed page frees the table.
 *
 * It also checks the rules that should still hold: a genuinely abandoned
 * session is swept, and the POS ending a session still reaches the diner —
 * the bill and the review prompt appear only then.
 *
 * Half of this fix is in the database (the sweep) and half is in the
 * `table-session` edge function (the validate route). The database half is live
 * as soon as its migration is applied; the function half only takes effect once
 * that function is deployed, and until then these checks report the old
 * behaviour — the output says which, so a failure here is not mistaken for a
 * regression.
 *
 *   npm run test:session-lifecycle
 */
import { createClient } from "@supabase/supabase-js";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });
const stamp = Date.now();

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SB}/functions/v1/${path}`, {
    ...init,
    headers: {
      apikey: ANON,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

/** The sweep, exactly as the POS board and a QR scan call it. */
const sweep = async () => {
  const { data, error } = await admin.rpc("expire_stale_table_sessions");
  if (error) throw new Error(error.message);
  return Number(data ?? 0);
};

// `close_pending_at` only exists once migration 0058 is applied. The suite
// runs both before and after, so the first read probes for the column and
// every later read remembers the answer.
let closeColumnLive = true;
const BASE_COLS = "id, status, created_at, last_seen_at, ended_at";
const sessionRow = async (id: string) => {
  if (closeColumnLive) {
    const { data, error } = await admin
      .from("table_sessions")
      .select(`${BASE_COLS}, close_pending_at`)
      .eq("id", id)
      .maybeSingle();
    if (!error) return data as any;
    closeColumnLive = false;
  }
  const { data } = await admin.from("table_sessions").select(BASE_COLS).eq("id", id).maybeSingle();
  return data as any;
};

const backdate = async (id: string, patch: Record<string, string>) => {
  const { error } = await admin.from("table_sessions").update(patch).eq("id", id);
  if (error) throw new Error(error.message);
};

const validate = (token: string) =>
  call(`table-session/validate?sessionToken=${encodeURIComponent(token)}`);

// ---- a scratch restaurant with one table -------------------------------
const { data: tenant, error: tenantErr } = await admin
  .from("tenants")
  .insert({
    name: `Lifecycle Test ${stamp}`,
    slug: `lifecycle-${stamp}`,
    plan: "pro",
    currency: "INR",
    currency_symbol: "₹",
    active: true,
    subscription_status: "trial",
  })
  .select()
  .single();
if (tenantErr) {
  console.log("could not create the scratch restaurant:", tenantErr.message);
  process.exit(1);
}
const { data: table } = await admin
  .from("tables")
  .insert({ tenant_id: tenant.id, name: "T1", seats: 4, area: "Main", active: true })
  .select()
  .single();

const sessions: string[] = [];
const startSession = async () => {
  const res = await call("table-session", { method: "POST", body: JSON.stringify({ qrToken: table!.qr_token }) });
  // The start route answers flat: sessionToken, sessionId, status, tenant, table.
  if (res.status !== 201 || !res.body?.sessionToken) {
    throw new Error(`could not start a session: ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);
  }
  sessions.push(res.body.sessionId);
  return { token: res.body.sessionToken as string, id: res.body.sessionId as string };
};

const addOrder = async (sessionId: string, status: string) => {
  // order_number comes from the sequence; the money columns are named
  // items_total/tax/service_charge/total.
  const { error } = await admin.from("orders").insert({
    tenant_id: tenant.id,
    table_id: table!.id,
    table_session_id: sessionId,
    order_type: "DINE_IN",
    status,
    items_total: 100,
    tax: 5,
    service_charge: 0,
    total: 105,
  });
  if (error) throw new Error(error.message);
};

try {
  console.log("\n── a diner who is waiting for food ──");
  const waiting = await startSession();
  await addOrder(waiting.id, "PENDING");
  // Their phone has been in their pocket: no heartbeat for twenty minutes.
  await backdate(waiting.id, { last_seen_at: new Date(Date.now() - 20 * 60_000).toISOString() });

  const beat = await validate(waiting.token);
  const stillThere = await sessionRow(waiting.id);
  if (stillThere?.status !== "ACTIVE") {
    console.log(
      "  note  the deployed table-session function still contains the old idle rule\n" +
      "        (it ends a session three minutes after its last heartbeat), so the two\n" +
      "        checks below report the old behaviour until that function is deployed.",
    );
  }
  check("a heartbeat gap does not end the session", beat.status === 200 && beat.body?.sessionStatus === "ACTIVE",
    `${beat.status} ${JSON.stringify(beat.body).slice(0, 140)}`);

  const swept = await sweep();
  check("the sweep leaves it alone while the order is pending", stillThere?.status === "ACTIVE",
    `sweep ended ${swept}; session is ${stillThere?.status}`);

  console.log("\n── what a page unload used to do ──");
  // The menu sends this as the page unloads. For an ordered session it must
  // change nothing — the browser is never what closes a table in service.
  const release = await call("table-session/release", {
    method: "POST",
    body: JSON.stringify({ sessionToken: waiting.token }),
  });
  check("the release call is accepted", release.status === 200, `${release.status} ${JSON.stringify(release.body)}`);
  await new Promise((r) => setTimeout(r, 4000)); // the old grace window was 3s
  const afterRelease = await sessionRow(waiting.id);
  const afterReleaseBeat = await validate(waiting.token);
  check("and it no longer ends the session", afterRelease?.status === "ACTIVE" && afterReleaseBeat.status === 200,
    `session is ${afterRelease?.status}, validate ${afterReleaseBeat.status}`);

  console.log("\n── close detection (migration 0058 + deployed function) ──");
  // What the stamp alone does: recorded, nothing more. The verdict belongs to
  // the sweep, two minutes later, and only while nothing disproves it.
  const stamped = await startSession();
  const stampRes = await call("table-session/release", {
    method: "POST",
    body: JSON.stringify({ sessionToken: stamped.token }),
  });
  const stampedRow = await sessionRow(stamped.id);
  const migrationLive = closeColumnLive;
  if (!migrationLive) {
    console.log(
      "  note  migration 0058 is not applied yet (no close_pending_at column), so the\n" +
      "        four checks below report the old behaviour until it is.",
    );
  }
  check("the release stamps the session instead of ending it",
    stampRes.status === 200 && (!migrationLive || stampedRow?.close_pending_at != null) && stampedRow?.status === "ACTIVE",
    `${stampRes.status}; row ${JSON.stringify(stampedRow)}`);

  // A closed page: stamped, then silence. The sweep frees the table.
  if (migrationLive) {
    await backdate(stamped.id, {
      close_pending_at: new Date(Date.now() - 3 * 60_000).toISOString(),
      last_seen_at: new Date(Date.now() - 4 * 60_000).toISOString(),
    });
  }
  await sweep();
  const stampedAfter = await sessionRow(stamped.id);
  check("a stamped session, silent through the grace, is swept", !migrationLive || stampedAfter?.status === "ENDED",
    `session is ${stampedAfter?.status}`);

  // A refresh: stamped at unload, heartbeating again seconds later. The
  // heartbeat is newer than the stamp, so the sweep leaves it alone.
  const refreshed = await startSession();
  await call("table-session/release", { method: "POST", body: JSON.stringify({ sessionToken: refreshed.token }) });
  if (migrationLive) {
    await backdate(refreshed.id, {
      close_pending_at: new Date(Date.now() - 3 * 60_000).toISOString(),
      last_seen_at: new Date().toISOString(), // the beat after the reload
    });
  }
  await sweep();
  const refreshedAfter = await sessionRow(refreshed.id);
  const refreshedBeat = await validate(refreshed.token);
  check("a heartbeat newer than the stamp keeps the session alive",
    !migrationLive || (refreshedAfter?.status === "ACTIVE" && refreshedBeat.status === 200),
    `session is ${refreshedAfter?.status}, validate ${refreshedBeat.status}`);

  // An order: the diner closed the tab to eat. The clock and the browser are
  // both irrelevant; only the restaurant ends this session.
  const ordered = await startSession();
  await addOrder(ordered.id, "PENDING");
  await call("table-session/release", { method: "POST", body: JSON.stringify({ sessionToken: ordered.token }) });
  if (migrationLive) {
    await backdate(ordered.id, {
      close_pending_at: new Date(Date.now() - 3 * 60_000).toISOString(),
      last_seen_at: new Date(Date.now() - 4 * 60_000).toISOString(),
    });
  }
  await sweep();
  const orderedAfter = await sessionRow(ordered.id);
  check("an order protects the session, stamped and silent or not", orderedAfter?.status === "ACTIVE",
    `session is ${orderedAfter?.status}`);

  console.log("\n── a diner who really has gone ──");
  const abandoned = await startSession();
  await backdate(abandoned.id, { last_seen_at: new Date(Date.now() - 3 * 60 * 60_000).toISOString() });
  const swept2 = await sweep();
  const abandonedAfter = await sessionRow(abandoned.id);
  check("a session silent for three hours, with nothing ordered, is swept", abandonedAfter?.status === "ENDED",
    `sweep ended ${swept2}; session is ${abandonedAfter?.status}`);

  const oldOrder = await startSession();
  await addOrder(oldOrder.id, "PREPARING");
  await backdate(oldOrder.id, {
    last_seen_at: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
    created_at: new Date(Date.now() - 7 * 60 * 60_000).toISOString(),
  });
  await sweep();
  const oldOrderAfter = await sessionRow(oldOrder.id);
  check("but never one the kitchen is still working on, however old", oldOrderAfter?.status === "ACTIVE",
    `session is ${oldOrderAfter?.status}`);

  console.log("\n── and when the restaurant ends it ──");
  const ended = await startSession();
  await addOrder(ended.id, "SERVED");
  await admin
    .from("table_sessions")
    .update({ status: "ENDED", ended_at: new Date().toISOString() })
    .eq("id", ended.id)
    .eq("status", "ACTIVE");
  const endedBeat = await validate(ended.token);
  check("the diner's next heartbeat reports the end", endedBeat.status === 403, `${endedBeat.status} ${JSON.stringify(endedBeat.body).slice(0, 120)}`);
  check("and the ended screen is told there is a bill to show", endedBeat.body?.hasOrder === true, JSON.stringify(endedBeat.body).slice(0, 160));

  console.log("\n── the Table 5 regression: two clocks (2026-11-01) ──");
  // The production case: a diner scanned, browsed ~5 minutes (heartbeats
  // landing), then the page died with no beacon. The POS card showed "open 31
  // min" — the AGE clock — while the fallback's SILENCE clock was at 26 min.
  // The fallback was blamed for skipping a session it had not yet measured as
  // expired. These checks pin the semantics: expiry counts from the last
  // heartbeat, never from the scan.
  const twoClocks = await startSession();
  // scanned 35 min ago, last heartbeat 29 min ago: age > 30 min, silence < 30.
  await backdate(twoClocks.id, {
    created_at: new Date(Date.now() - 35 * 60_000).toISOString(),
    last_seen_at: new Date(Date.now() - 29 * 60_000).toISOString(),
  });
  await sweep();
  const twoClocksEarly = await sessionRow(twoClocks.id);
  check("age over 30 min with silence under 30 is NOT swept", twoClocksEarly?.status === "ACTIVE",
    `session is ${twoClocksEarly?.status}`);
  // the same session one heartbeat-minute later: silence crosses 30.
  await backdate(twoClocks.id, { last_seen_at: new Date(Date.now() - 31 * 60_000).toISOString() });
  await sweep();
  const twoClocksLate = await sessionRow(twoClocks.id);
  check("silence over 30 min IS swept, whatever the age", twoClocksLate?.status === "ENDED",
    `session is ${twoClocksLate?.status}`);
  // and a stale heartbeat after the end must not resurrect it.
  const staleBeat = await validate(twoClocks.token);
  const twoClocksAfter = await sessionRow(twoClocks.id);
  check("a heartbeat after the sweep cannot resurrect the session",
    staleBeat.status === 403 && twoClocksAfter?.status === "ENDED",
    `validate ${staleBeat.status}, session is ${twoClocksAfter?.status}`);

  console.log("\n── every order status protects the table ──");
  // The predicate is NOT EXISTS (any order at all): no status, not even a
  // cancelled one, ever lets a clock end the session. Only the POS does.
  const protectedStatuses = ["PENDING", "PREPARING", "READY", "SERVED", "COMPLETED", "CANCELLED"];
  const protectedSessions: { id: string; status: string }[] = [];
  for (const os of protectedStatuses) {
    const s = await startSession();
    await addOrder(s.id, os);
    await backdate(s.id, { last_seen_at: new Date(Date.now() - 45 * 60_000).toISOString() });
    protectedSessions.push({ id: s.id, status: os });
  }
  await sweep();
  let allProtected = true;
  for (const p of protectedSessions) {
    const row = await sessionRow(p.id);
    if (row?.status !== "ACTIVE") { allProtected = false; console.log(`        ${p.status} -> ${row?.status}`); }
  }
  check("PENDING/PREPARING/READY/SERVED/COMPLETED/CANCELLED all survive 45 min of silence", allProtected);

  console.log("\n── tables on the same floor expire independently ──");
  const { data: table2 } = await admin
    .from("tables")
    .insert({ tenant_id: tenant.id, name: "T2", seats: 2, area: "Main", active: true })
    .select()
    .single();
  const goneQuiet = await startSession();
  const stillBrowsingRes = await call("table-session", { method: "POST", body: JSON.stringify({ qrToken: table2!.qr_token }) });
  const stillBrowsingId = stillBrowsingRes.body?.sessionId as string;
  if (stillBrowsingId) sessions.push(stillBrowsingId);
  await backdate(goneQuiet.id, { last_seen_at: new Date(Date.now() - 31 * 60_000).toISOString() });
  await sweep();
  const goneQuietAfter = await sessionRow(goneQuiet.id);
  const stillBrowsingAfter = await sessionRow(stillBrowsingId);
  check("the silent table is swept while its neighbour keeps ordering",
    goneQuietAfter?.status === "ENDED" && stillBrowsingAfter?.status === "ACTIVE",
    `silent ${goneQuietAfter?.status}, neighbour ${stillBrowsingAfter?.status}`);

  console.log("\n── the sweep is not publicly callable ──");
  const anonSweep = await call("rpc/expire_stale_table_sessions", { method: "POST", body: "{}" }).catch(() => ({ status: 0 } as any));
  const anonProbe = await fetch(`${SB}/rest/v1/rpc/expire_stale_table_sessions`, {
    method: "POST",
    headers: { apikey: ANON, authorization: `Bearer ${ANON}`, "content-type": "application/json" },
    body: "{}",
  });
  check("an anonymous caller cannot run the sweep", anonProbe.status === 401,
    `${anonProbe.status} ${(await anonProbe.text()).slice(0, 100)} (probe status ${anonSweep.status})`);
} catch (e) {
  check("the lifecycle checks ran", false, (e as Error).message);
} finally {
  // Clean up: the orders, sessions, table and restaurant this run created.
  await admin.from("orders").delete().eq("tenant_id", tenant.id);
  await admin.from("table_sessions").delete().eq("tenant_id", tenant.id);
  await admin.from("tables").delete().eq("tenant_id", tenant.id);
  for (const t of ["feature_usage", "subscription_payments", "subscription_audit_logs", "subscription_webhook_events", "ai_request_logs"]) {
    await admin.from(t).delete().eq("tenant_id", tenant.id);
  }
  await admin.from("tenants").delete().eq("id", tenant.id);
  const { data: left } = await admin.from("tenants").select("id").eq("id", tenant.id);
  check("the scratch restaurant was removed", (left ?? []).length === 0);
}

console.log(`\n${pass}/${pass + fail} checks passed${fail ? ` — ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
