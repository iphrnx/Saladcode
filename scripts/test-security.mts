/**
 * Security-page session tests.
 *
 * The Security page used to read a `user_sessions` table that nothing ever
 * wrote to: "Active Sessions" was always 0 and "Revoke All Sessions" deleted
 * from the empty table while reporting success. These tests pin the real
 * behaviour against auth.sessions — at the database level (the SECURITY
 * DEFINER functions from migration 0036) and, once the edge functions are
 * deployed, through the /functions/v1/security and /bootstrap endpoints.
 *
 * The DB half runs against the live database and is safe before a deploy (the
 * functions are additive). The edge half needs the reworked functions live:
 * run with DB_ONLY=1 to skip it.
 *
 *   NEXT_PUBLIC_SUPABASE_URL=… npx tsx scripts/test-security.mts
 */
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const DB_ONLY = !!process.env.DB_ONLY;
const SITE = process.env.SITE_URL ?? "https://www.thesalad.in";

let bad = 0;
let checks = 0;

const { createClient } = await import("@supabase/supabase-js");
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });

function check(name: string, ok: boolean, detail = "") {
  checks++;
  if (!ok) {
    bad++;
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  } else {
    console.log(`  ok    ${name}`);
  }
}

/** The `session_id` claim inside a Supabase access token. */
function jwtSessionId(token: string): string {
  const payload = JSON.parse(
    Buffer.from(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(),
  );
  return payload.session_id as string;
}

/**
 * Mint a session as a *distinct device*.
 *
 * The device grouping and device-level revocation key on the raw user agent,
 * so sessions created through the same client (supabase-js from this suite)
 * all share one agent and read as one device — revoking one then revokes the
 * whole group, which is correct product behaviour but makes the suite revoke
 * its own caller mid-test. Each mint therefore presents a different agent,
 * so every session is its own device and the suite can revoke one without
 * touching another.
 */
let deviceSerial = 0;
async function sessionFor(email: string) {
  deviceSerial += 1;
  const uas = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
    "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  ];
  const ua = uas[(deviceSerial - 1) % uas.length];
  const gl = await fetch(`${URL}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}`, "content-type": "application/json" },
    body: JSON.stringify({ type: "magiclink", email, redirect_to: `${SITE}/?view=dashboard` }),
  }).then((r) => r.json());
  const v = await fetch(`${URL}/auth/v1/verify?token=${gl.hashed_token}&type=magiclink&redirect_to=${encodeURIComponent(`${SITE}/?view=dashboard`)}`, {
    headers: { apikey: ANON, "user-agent": ua },
    redirect: "manual",
  });
  const frag = new URLSearchParams((v.headers.get("location") || "").split("#")[1]);
  const token = frag.get("access_token");
  return { access_token: token, session_id: jwtSessionId(token), user: { id: "" } };
}

async function call(path: string, token?: string, init: RequestInit = {}) {
  const res = await fetch(`${URL}/functions/v1/${path}`, {
    ...init,
    headers: {
      apikey: ANON,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const DEMO_EMAIL = "zhut@demo.com";

// ── the database functions (safe pre-deploy) ─────────────────────────────
console.log("\n── security_list_sessions / revoke (database level) ──");
{
  const { data: profile } = await admin
    .from("profiles")
    .select("id, tenant_id")
    .eq("email", DEMO_EMAIL)
    .single();
  const tenantId = profile!.tenant_id as string;

  // A session the test creates for itself — the only one it will revoke on
  // this tenant, so the owner's live sessions are never touched.
  const s1 = await sessionFor(DEMO_EMAIL);

  const { data: listed } = await admin.rpc("security_list_sessions", { p_tenant_id: tenantId });
  const ids = (listed ?? []).map((r: any) => r.id);
  check("list includes a freshly created session", ids.includes(s1.session_id));

  const { data: n } = await admin.rpc("security_revoke_session", {
    p_tenant_id: tenantId,
    p_session_id: s1.session_id,
  });
  check("revoke_session returns 1 for a real session", Number(n) === 1, `got ${n}`);

  const { data: listed2 } = await admin.rpc("security_list_sessions", { p_tenant_id: tenantId });
  check(
    "revoked session is gone from the list",
    !(listed2 ?? []).some((r: any) => r.id === s1.session_id),
  );

  const { data: n2 } = await admin.rpc("security_revoke_session", {
    p_tenant_id: tenantId,
    p_session_id: "00000000-0000-4000-8000-000000000000",
  });
  check("revoke_session returns 0 for a session that does not exist", Number(n2) === 0, `got ${n2}`);
}

console.log("\n── tenant scoping and revoke_all (throwaway tenant) ──");
let throwaway: { userId: string; tenantId: string; email: string } | null = null;
{
  // Register a real throwaway tenant through the production endpoint, so
  // revoke_all can be tested without touching anyone's live sessions.
  const stamp = Date.now();
  const email = `security-test-${stamp}@example.com`;
  const reg = await call("auth/register", undefined, {
    method: "POST",
    body: JSON.stringify({
      name: "Security Test",
      email,
      password: `test-password-${stamp}`,
      restaurantName: "Security Test Cafe",
    }),
  });
  check("register creates a throwaway tenant", reg.status === 200, JSON.stringify(reg.body).slice(0, 200));

  if (reg.status === 200) {
    const { data: p } = await admin
      .from("profiles")
      .select("id, tenant_id")
      .eq("email", email)
      .single();
    throwaway = { userId: p!.id, tenantId: p!.tenant_id, email };

    const demoProfile = (await admin
      .from("profiles")
      .select("tenant_id")
      .eq("email", DEMO_EMAIL)
      .single()).data!;

    // Two sessions for the throwaway owner.
    const a = await sessionFor(email);
    const b = await sessionFor(email);

    // Cross-tenant revoke: the demo tenant must not be able to revoke the
    // throwaway tenant's session.
    const { data: cross } = await admin.rpc("security_revoke_session", {
      p_tenant_id: demoProfile.tenant_id,
      p_session_id: a.session_id,
    });
    check("one tenant cannot revoke another tenant's session", Number(cross) === 0, `got ${cross}`);

    // register's signUp creates a session too, so the exact count is whatever
    // the list says right before the revoke — that equality is the real check.
    const { data: before } = await admin.rpc("security_list_sessions", {
      p_tenant_id: throwaway.tenantId,
    });
    const expected = (before ?? []).length;

    const { data: all } = await admin.rpc("security_revoke_all_sessions", {
      p_tenant_id: throwaway.tenantId,
    });
    check(
      "revoke_all returns every session of the tenant",
      Number(all) === expected && expected >= 2,
      `expected ${expected}, got ${all}`,
    );

    const { data: after } = await admin.rpc("security_list_sessions", {
      p_tenant_id: throwaway.tenantId,
    });
    check("revoke_all leaves the tenant with no sessions", (after ?? []).length === 0);
  }
}

// ── the edge functions (needs the reworked security + bootstrap deployed) ──
if (!DB_ONLY) {
  console.log("\n── GET /security and /bootstrap (edge level) ──");
  {
    const s = await sessionFor(DEMO_EMAIL);
    const sec = await call("security", s.access_token);
    check("GET /security answers 200", sec.status === 200, JSON.stringify(sec.body).slice(0, 200));

    const sessions = sec.body?.sessions ?? [];
    check(
      "the caller's own session is listed and badged current",
      sessions.some((x: any) => x.id === s.session_id && x.current === true),
      `session_id=${s.session_id}, got ${sessions.length} sessions`,
    );
    check(
      "sessions carry device/browser/ip/lastActive/user",
      sessions.every(
        (x: any) =>
          "device" in x && "browser" in x && "ip" in x && "lastActive" in x && x.user?.name,
      ),
    );

    const boot = await call("bootstrap", s.access_token);
    check("GET /bootstrap answers 200", boot.status === 200);
    const bootSessions = boot.body?.sessions ?? [];
    check(
      "bootstrap lists the caller's session as current too",
      bootSessions.some((x: any) => x.id === s.session_id && x.current === true),
      `got ${bootSessions.length} sessions`,
    );

    console.log("\n── DELETE /security (edge level) ──");
    const s2 = await sessionFor(DEMO_EMAIL);
    const del = await call(`security?sessionId=${s2.session_id}`, s.access_token, {
      method: "DELETE",
    });
    check("revoking a real session answers 200", del.status === 200, JSON.stringify(del.body).slice(0, 200));
    check("the response reports one session revoked", Number(del.body?.revoked) === 1, JSON.stringify(del.body));

    const gone = await call("security", s.access_token);
    check(
      "the revoked session is no longer listed",
      !(gone.body?.sessions ?? []).some((x: any) => x.id === s2.session_id),
    );

    const bogus = await call("security?sessionId=00000000-0000-4000-8000-000000000000", s.access_token, {
      method: "DELETE",
    });
    check(
      "revoking a session that does not exist answers 404, not success",
      bogus.status === 404,
      `got ${bogus.status}`,
    );

    console.log("\n── PATCH /security revoke_all (edge level) ──");
    if (throwaway) {
      const t = await sessionFor(throwaway.email);
      const before = await call("security", t.access_token);
      const count = (before.body?.sessions ?? []).length;
      const all = await call("security", t.access_token, {
        method: "PATCH",
        body: JSON.stringify({ action: "revoke_all" }),
      });
      check("revoke_all answers 200", all.status === 200, JSON.stringify(all.body).slice(0, 200));
      // The contract changed on purpose: revoke_all spares the session doing
      // the revoking, so an owner emptying the list is not signed out of the
      // page they just used. Everything else in the tenant goes.
      check(
        "revoke_all reports the sessions it revoked, not the caller's own",
        Number(all.body?.revoked) === count - 1,
        `had ${count}, revoked ${all.body?.revoked}`,
      );
      const after = await call("security", t.access_token);
      const left = after.body?.sessions ?? [];
      check("only the caller's own session survives", left.length === 1 && left[0]?.current === true, JSON.stringify(left.map((x: any) => x.current)));
    }

    console.log("\n── failed password logins are audited (edge level) ──");
    {
      const fail = await call("auth/login", undefined, {
        method: "POST",
        body: JSON.stringify({ email: DEMO_EMAIL, password: "definitely-wrong-password" }),
      });
      // A 5xx from GoTrue (546 = its rate-limit code, which the shared test
      // IP trips after repeated runs) means the wrong password never reached
      // the application's audit path — the attempt is platform-rejected before
      // our code sees it, so only a 401 is our code's answer to audit.
      check("wrong password answers 401 (or is platform rate-limited)", fail.status === 401 || fail.status === 546 || fail.status === 429, `got ${fail.status}`);

      if (fail.status === 401) {
        const { data: logs } = await admin
          .from("security_logs")
          .select("created_at")
          .eq("action", "LOGIN_FAILED")
          .gte("created_at", new Date(Date.now() - 60_000).toISOString())
          .order("created_at", { ascending: false })
          .limit(1);
        check("a LOGIN_FAILED row was just written", (logs ?? []).length === 1);
      } else {
        console.log("  skip  LOGIN_FAILED row (GoTrue rate-limited the attempt before the app saw it)");
      }
    }

    console.log("\n── the endpoint still refuses strangers ──");
    const anon = await call("security");
    check("anonymous GET /security answers 401", anon.status === 401, `got ${anon.status}`);
  }
}

// ── cleanup: remove the throwaway tenant and its auth user ──
if (throwaway) {
  // profiles.id is the auth user id.
  await admin.auth.admin.deleteUser(throwaway.userId);
  await admin.from("tenants").delete().eq("id", throwaway.tenantId);
  console.log(`\n  cleaned up throwaway tenant ${throwaway.email}`);
}

console.log(`\n${checks - bad}/${checks} checks passed`);
if (bad > 0) {
  console.log("SECURITY TESTS FAILED");
  process.exit(1);
}
