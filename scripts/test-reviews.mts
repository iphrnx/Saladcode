/**
 * Tests for the internal review system.
 *
 * Google Reviews is gone: diners rate at the end of a table session and the
 * review lands in our own customer_reviews table. These tests pin that flow:
 *
 *   1. Database layer (safe before any deploy): the rating check constraint,
 *      the one-review-per-session unique index, and the RLS policies — public
 *      read for an active tenant, no public write.
 *   2. Edge layer (needs the current reviews + table-session functions
 *      deployed): submit, duplicate rejection, the reviews_enabled gate, the
 *      session-end payload (reviewsEnabled / averageRating / reviewCount), and
 *      the owner list shape (createdAt, not Google's createTime).
 *
 * The tests build a scratch tenant and clean it up afterwards. Run the DB
 * half alone with DB_ONLY=1.
 *
 *   npx tsx --env-file=.env.local scripts/test-reviews.mts
 */
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const DB_ONLY = !!process.env.DB_ONLY;

let bad = 0;
let checks = 0;

function check(name: string, ok: boolean, detail = "") {
  checks++;
  if (!ok) {
    bad++;
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  } else {
    console.log(`  ok    ${name}`);
  }
}

const { createClient } = await import("@supabase/supabase-js");
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const anon = createClient(URL, ANON, { auth: { persistSession: false } });

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(`${URL}/functions/v1/${path}`, {
    ...init,
    headers: {
      apikey: ANON,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ── scratch tenant ───────────────────────────────────────────────────────
const stamp = Date.now();
const { data: tenant } = await admin
  .from("tenants")
  .insert({ name: `Reviews Test ${stamp}`, slug: `reviews-test-${stamp}`, active: true })
  .select("id")
  .single();
const { data: table } = await admin
  .from("tables")
  .insert({ tenant_id: tenant!.id, name: "T1", area: "Test Area" })
  .select("id")
  .single();

const mkSession = async (status: string) => {
  const { data: s } = await admin
    .from("table_sessions")
    .insert({ tenant_id: tenant!.id, table_id: table!.id, token: `rev-test-${stamp}-${Math.random().toString(36).slice(2)}`, status })
    .select("id, token")
    .single();
  return s!;
};

try {
  // ── 1. database layer ─────────────────────────────────────────────────
  console.log("\n── database: constraints and policies ──");
  {
    const s = await mkSession("ENDED");

    const oob = await admin.from("customer_reviews").insert({
      tenant_id: tenant!.id, table_id: table!.id, table_session_id: s.id,
      rating: 6, author_name: "Guest",
    });
    check("rating 6 is rejected by the check constraint", !!oob.error, String(oob.error?.code));

    const zero = await admin.from("customer_reviews").insert({
      tenant_id: tenant!.id, table_id: table!.id, table_session_id: s.id,
      rating: 0, author_name: "Guest",
    });
    check("rating 0 is rejected by the check constraint", !!zero.error, String(zero.error?.code));

    const okInsert = await admin.from("customer_reviews").insert({
      tenant_id: tenant!.id, table_id: table!.id, table_session_id: s.id,
      rating: 5, author_name: "Guest", comment: "Great", tags: "Delicious Food, Fast Service",
    });
    check("a valid review inserts", !okInsert.error, String(okInsert.error?.message));

    const dup = await admin.from("customer_reviews").insert({
      tenant_id: tenant!.id, table_id: table!.id, table_session_id: s.id,
      rating: 4, author_name: "Guest",
    });
    check("a second review for the same session is rejected", !!dup.error, String(dup.error?.code));
    check("the duplicate is a unique violation (23505)", dup.error?.code === "23505", String(dup.error?.code));

    // RLS: reviews are never readable client-side — migration 0059 revoked
    // anon SELECT so the review summary reaches diners only through the
    // session-authorized edge functions (service-role reads).
    const read = await anon.from("customer_reviews").select("id, rating").eq("tenant_id", tenant!.id);
    check("anon cannot read reviews (server-side reads only)", !!read.error, String(read.error?.message));

    const write = await anon.from("customer_reviews").insert({
      tenant_id: tenant!.id, table_id: table!.id, table_session_id: s.id,
      rating: 1, author_name: "Sneak",
    });
    check("anon cannot write a review", !!write.error, String(write.error?.message));

    // A paused restaurant's reviews are not public either — still denied.
    await admin.from("tenants").update({ active: false }).eq("id", tenant!.id);
    const readInactive = await anon.from("customer_reviews").select("id").eq("tenant_id", tenant!.id);
    check(
      "anon cannot read reviews of an inactive tenant either",
      !!readInactive.error,
      String(readInactive.error?.message ?? JSON.stringify(readInactive.data)),
    );
    await admin.from("tenants").update({ active: true }).eq("id", tenant!.id);
  }

  if (!DB_ONLY) {
    // ── 2. edge layer: the diner flow ────────────────────────────────────
    console.log("\n── edge: submit, duplicate, gate ──");
    {
      const s = await mkSession("ENDED");

      const submit = await call("reviews", {
        method: "POST",
        body: JSON.stringify({ tableSessionToken: s.token, rating: 4, authorName: "Test Diner", comment: "Loved it", tags: ["Delicious Food"] }),
      });
      check("a diner can submit a review", submit.status === 200 || submit.status === 201, `status ${submit.status} ${JSON.stringify(submit.body).slice(0, 160)}`);
      check("the submitted review echoes back with createdAt", !!submit.body?.review?.createdAt, JSON.stringify(submit.body).slice(0, 160));

      const again = await call("reviews", {
        method: "POST",
        body: JSON.stringify({ tableSessionToken: s.token, rating: 2 }),
      });
      check("a replayed submission is a 409", again.status === 409, `status ${again.status}`);

      const badToken = await call("reviews", {
        method: "POST",
        body: JSON.stringify({ tableSessionToken: "no-such-token", rating: 4 }),
      });
      check("an unknown session token is a 401", badToken.status === 401, `status ${badToken.status}`);

      const badRating = await call("reviews", {
        method: "POST",
        body: JSON.stringify({ tableSessionToken: (await mkSession("ENDED")).token, rating: 9 }),
      });
      check("an out-of-range rating is a 400", badRating.status === 400, `status ${badRating.status}`);

      // The owner pauses review collection; a stale form must not get through.
      await admin.from("settings").insert({ tenant_id: tenant!.id, key: "reviews_enabled", value: "false" });
      const paused = await call("reviews", {
        method: "POST",
        body: JSON.stringify({ tableSessionToken: (await mkSession("ENDED")).token, rating: 4 }),
      });
      check("a review is declined with 403 while collection is paused", paused.status === 403, `status ${paused.status} ${JSON.stringify(paused.body).slice(0, 120)}`);
      await admin.from("settings").update({ value: "true" }).eq("tenant_id", tenant!.id).eq("key", "reviews_enabled");

      const resumed = await call("reviews", {
        method: "POST",
        body: JSON.stringify({ tableSessionToken: (await mkSession("ENDED")).token, rating: 5 }),
      });
      check("collection works again once unpaused", resumed.status === 200 || resumed.status === 201, `status ${resumed.status}`);
    }

    console.log("\n── edge: the session-end payload ──");
    {
      const s = await mkSession("ENDED");
      await call("reviews", {
        method: "POST",
        body: JSON.stringify({ tableSessionToken: s.token, rating: 4 }),
      });

      const v = await call(
        `table-session/validate?tenantId=${tenant!.id}&tableId=${table!.id}&sessionToken=${s.token}`,
      );
      check("an ended session fails validation", v.status >= 400, `status ${v.status}`);
      check("the payload says reviews are enabled", v.body?.reviewsEnabled === true, JSON.stringify(v.body).slice(0, 200));
      check("the payload carries the live average", typeof v.body?.averageRating === "number" && v.body.averageRating > 0, String(v.body?.averageRating));
      check("the payload carries the review count", typeof v.body?.reviewCount === "number" && v.body.reviewCount >= 1, String(v.body?.reviewCount));

      // Paused: the diner page needs to know to hide the whole block.
      await admin.from("settings").update({ value: "false" }).eq("tenant_id", tenant!.id).eq("key", "reviews_enabled");
      const vPaused = await call(
        `table-session/validate?tenantId=${tenant!.id}&tableId=${table!.id}&sessionToken=${s.token}`,
      );
      check("a paused restaurant reports reviewsEnabled false", vPaused.body?.reviewsEnabled === false, JSON.stringify(vPaused.body).slice(0, 200));
      await admin.from("settings").update({ value: "true" }).eq("tenant_id", tenant!.id).eq("key", "reviews_enabled");
    }
  }
} finally {
  // Usage and billing tables reference tenants without a cascade; clear the
  // scratch rows so the tenant delete can go through (reset-to-empty.sql
  // does the same).
  for (const t of ["feature_usage", "subscription_payments", "subscription_audit_logs", "subscription_webhook_events", "ai_request_logs"]) {
    await admin.from(t).delete().eq("tenant_id", tenant!.id);
  }
  // Deleting the tenant cascades to tables, sessions, reviews and settings.
  await admin.from("tenants").delete().eq("id", tenant!.id);
  const { data: left } = await admin.from("customer_reviews").select("id").eq("tenant_id", tenant!.id);
  check("scratch data cleaned up", (left ?? []).length === 0, JSON.stringify(left));
}

console.log(`\n${checks - bad}/${checks} checks passed${bad ? ` — ${bad} FAILED` : ""}`);
process.exit(bad ? 1 : 0);
