// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { admin, asUser } from "../_shared/db.ts";
import { guard, staffSession } from "../_shared/auth.ts";
import { DEFAULT_ROLES } from "../_shared/permissions.ts";
import { MENU_THEME_KEY, normaliseMenuTheme } from "../_shared/menu-theme.ts";
import { appOrigin, body, json, preflight, subPath } from "../_shared/http.ts";
import { trialFields } from "../_shared/plans.ts";
import { dispatchPending, queueForTenant } from "../_shared/email.ts";
import { clientIp } from "../_shared/ip.ts";
import { pruneSessionsForDevice, stampSession } from "../_shared/sessions.ts";

/**
 * The session id GoTrue put in the access token it just issued. Read, not
 * verified: the token was produced by Supabase seconds ago in this same
 * request, and it only ever identifies the caller's own session.
 */
function sessionIdFromJwt(accessToken: string | undefined): string | null {
  if (!accessToken) return null;
  try {
    const payload = JSON.parse(
      atob(accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
    );
    return typeof payload.session_id === "string" ? payload.session_id : null;
  } catch {
    return null;
  }
}

/**
 * /functions/v1/auth
 *   POST /login      sign in with email + password
 *   POST /logout     clear the session
 *   POST /register   create an auth user + tenant + default roles + owner profile
 *   GET  /me         resolve the signed-in owner (401 when there is none)
 *
 * Deliberately public — these routes are what *establish* a session, so they
 * cannot themselves be behind `guard()`. They never take a tenant id from the
 * client: the tenant is looked up through the authenticated profile row.
 *
 * A `session` object (the Supabase Auth session) is added to the login and
 * register responses so a client can persist the bearer token that every other
 * edge function expects in `Authorization`. The pre-existing fields (`user`,
 * `tenant`, `role`) are unchanged.
 */

/** Default system roles seeded for every new tenant. */
/** Anon-key client, used only for the credential handshake with Supabase Auth. */
function anon() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "restaurant"
  );
}

function bearer(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  const token = header.slice(7).trim();
  return token || null;
}

Deno.serve(async (req: Request) => {
  const pf = preflight(req);
  if (pf) return pf;

  const url = new URL(req.url);
  const seg = subPath(req, "auth")[0] ?? url.searchParams.get("action") ??
    url.searchParams.get("id");

  try {
    if (req.method === "POST") {
      switch (seg) {
        case "login":
          return await login(req);
        case "logout":
          return await logout(req);
        case "register":
          return await register(req);
        default:
          return json(req, { error: "Method not allowed" }, 405);
      }
    }
    if (req.method === "GET") {
      // `/auth` with no segment resolves the current owner, like `/auth/me`.
      return await me(req);
    }
    if (req.method === "PATCH" || req.method === "PUT") {
      if (seg === "profile") return await updateProfile(req);
      return json(req, { error: "Method not allowed" }, 405);
    }
    return json(req, { error: "Method not allowed" }, 405);
  } catch (err) {
    return json(req, { error: (err as Error).message ?? "Unexpected error" }, 500);
  }
});

async function login(req: Request): Promise<Response> {
  const b = await body(req);
  const { email, password } = b;

  if (!email || !password) {
    return json(req, { error: "Email and password are required" }, 400);
  }

  const supabase = anon();
  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
    email: String(email).toLowerCase().trim(),
    password: String(password),
  });

  if (authError || !authData?.user) {
    // Audit the failed attempt. "Failed Logins" on the Security page used to
    // count only staff PIN failures because nothing recorded owner password
    // failures. If the email matches a profile, the attempt belongs to that
    // tenant's log; unknown emails have no tenant to scope a row to and are
    // skipped (Supabase rate-limits the sign-in attempts themselves). Best
    // effort: logging must never block the auth response.
    try {
      const db = admin();
      const { data: p } = await db
        .from("profiles")
        .select("id, tenant_id")
        .eq("email", String(email).toLowerCase().trim())
        .maybeSingle();
      if (p?.tenant_id) {
        // A failed attempt is not that person's action. The row belongs to the
        // restaurant so its owner can see someone tried, but `user_id` stays
        // null: attributing it would blame the account holder for a stranger's
        // attempt. The email the attempt used goes in `meta` and is shown as an
        // *attempted* identity.
        await db.from("security_logs").insert({
          tenant_id: p.tenant_id,
          user_id: null,
          action: "LOGIN_FAILED",
          ip: clientIp(req),
          user_agent: req.headers.get("user-agent") || "unknown",
          meta: `Failed login for ${String(email).toLowerCase().trim()}`,
        });
      }
    } catch {
      /* never fail the auth response over an audit row */
    }
    // Supabase answers a correct password for an address that has not
    // confirmed its email with a distinct error. Swallowing it into the
    // generic 401 told the owner their password was wrong — the account was
    // fine, the confirmation link just had not been clicked. The distinction
    // is already public: Supabase's own endpoint reports it to any caller.
    if (/email.{0,24}not.{0,24}confirm|not.{0,24}confirmed/i.test(authError?.message ?? "")) {
      return json(
        req,
        {
          error:
            "Please confirm your email address first — we sent you a link when you signed up. Check your inbox and spam folder.",
          code: "email_not_confirmed",
        },
        403,
      );
    }
    return json(req, { error: "Invalid email or password" }, 401);
  }

  const db = admin();

  /**
   * One round trip, not three.
   *
   * The profile, its restaurant and its role were three separate reads — the
   * profile first, then the other two in parallel behind it. Every one of them
   * is a network hop from the edge function to Postgres, and all three are
   * needed before the response can be built. Joined, they cost one hop.
   */
  const { data: profileRow, error: profileError } = await db
    .from("profiles")
    .select("*, tenant:tenants(*), roleRef:roles!profiles_role_id_fkey(*)")
    .eq("id", authData.user.id)
    .maybeSingle();

  if (profileError) return json(req, { error: profileError.message }, 500);
  if (!profileRow) return json(req, { error: "Invalid email or password" }, 401);

  const profile = profileRow as any;
  const pick = (rel: any) => (Array.isArray(rel) ? rel[0] : rel);
  const tenant = pick(profile.tenant);
  const role = pick(profile.roleRef);
  // A profile without a role row (pre-roles accounts) falls back to its text
  // column, exactly as the separate query did.
  const roleRow = role ?? (profile.role_id ? { id: profile.role_id, name: profile.role } : null);

  if (!profile.active) {
    return json(
      req,
      { error: "Your account has been deactivated. Contact your manager." },
      403,
    );
  }

  /**
   * The two writes go together, and neither can fail the login.
   *
   * They were two more serial round trips on the critical path — around half
   * the handler's time — for a timestamp nobody waits for and an audit row
   * that is worth having but is not the login. Run in parallel they cost one
   * hop; a failure is logged rather than turned into "invalid password",
   * which is what a failed audit insert used to look like to the person
   * trying to sign in.
   */
  const [updateRes, logRes] = await Promise.all([
    db.from("profiles").update({ last_login: new Date().toISOString() }).eq("id", profile.id),
    db.from("security_logs").insert({
      tenant_id: profile.tenant_id,
      user_id: profile.id,
      action: "LOGIN",
      ip: clientIp(req),
      user_agent: req.headers.get("user-agent") || "unknown",
      meta: `Login via email/password`,
    }),
  ]);
  if (updateRes.error) console.error("auth: could not stamp last_login", updateRes.error.message);
  if (logRes.error) console.error("auth: could not write the login audit row", logRes.error.message);

  /**
   * One session per browser.
   *
   * GoTrue mints a new auth.sessions row on every sign-in and keeps the old
   * ones forever, so an owner who signed in fifteen times saw fifteen "active
   * sessions" — all of them real, all from the same laptop. The session just
   * created is the one kept; the previous ones from this same browser are
   * retired. Other devices carry other user agents and are untouched, so
   * "signed in on my phone and my laptop" still shows two rows.
   *
   * Off the critical path: the login has already succeeded, and a failure
   * here must never turn a correct password into an error.
   */
  try {
    const sessionId = sessionIdFromJwt(authData.session?.access_token);
    const agent = req.headers.get("user-agent");
    const addr = clientIp(req);
    // Retire first — it matches on the browser's own user agent, which is what
    // the older sessions from this browser carry. Then stamp this session with
    // the same agent, so the page shows Safari/macOS instead of the runtime.
    const pruning = pruneSessionsForDevice(admin(), profile.id, sessionId, agent)
      .then(() => stampSession(admin(), sessionId, agent, addr))
      .catch((e) => {
        console.error("auth: could not tidy the session list", (e as Error).message);
      });
    try {
      (globalThis as any).EdgeRuntime?.waitUntil?.(pruning);
    } catch {
      /* no waitUntil — the fire-and-forget promise still runs */
    }
  } catch {
    /* never fail a login over session hygiene */
  }

  return json(req, {
    user: {
      id: profile.id,
      name: profile.name,
      email: profile.email,
      role: profile.role,
      roleId: profile.role_id,
      tenantId: profile.tenant_id,
      avatar: profile.avatar,
    },
    tenant: tenant
      ? {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        tagline: tenant.tagline,
        currencySymbol: tenant.currency_symbol,
        // Whether setup ever finished. The client routes a confirmed owner
        // back into the wizard at the exact step, not into an empty dashboard.
        onboardingDone: tenant.onboarding_done ?? false,
      }
      : null,
    role: roleRow
      ? {
        id: (roleRow as any).id,
        name: (roleRow as any).name ?? profile.role ?? null,
        permissions: (roleRow as any).permissions ?? null,
      }
      : null,
    // Edge functions are stateless — hand the client the Supabase Auth session
    // so it can send the bearer token on subsequent calls.
    session: authData.session ?? null,
  });
}

async function logout(req: Request): Promise<Response> {
  // The session lives entirely in the client (bearer token); there is nothing
  // to revoke server-side. Kept for parity with the Next.js route.
  return json(req, { success: true });
}

/**
 * PATCH /auth/profile — the owner's own name, phone and avatar.
 *
 * The login email is not in this list and cannot be: it lives in
 * `auth.users`, is proved by Supabase Auth, and `profiles.email` only mirrors
 * it. A request that tries to change it is refused rather than silently
 * ignored — a client that believes it changed the address should find out
 * that it did not, because the next thing it would do is tell the owner their
 * sign-in email had moved.
 *
 * Everything else about a person's identity — which restaurant they own, what
 * role they hold, whether they are a super admin — is keyed on the auth UUID
 * and is not writable here either.
 */
async function updateProfile(req: Request): Promise<Response> {
  const g = await guard(req);
  if (!g.ok) return g.response;
  if (g.session.kind !== "owner") {
    return json(req, { error: "Staff accounts are managed by the restaurant, not here." }, 403);
  }

  const b = await body(req);
  if (b.email !== undefined) {
    return json(
      req,
      {
        error:
          "Your sign-in email cannot be changed here. It is your verified account address; contact support if it needs to move.",
        field: "email",
      },
      400,
    );
  }

  const patch: Record<string, unknown> = {};
  if (typeof b.name === "string") patch.name = b.name.trim().slice(0, 120);
  if (typeof b.phone === "string") patch.phone = b.phone.trim().slice(0, 32);
  if (typeof b.avatar === "string") patch.avatar = b.avatar;
  if (Object.keys(patch).length === 0) {
    return json(req, { error: "Nothing to update." }, 400);
  }
  patch.updated_at = new Date().toISOString();

  const { data, error } = await admin()
    .from("profiles")
    .update(patch)
    .eq("id", g.session.subjectId)
    .eq("tenant_id", g.session.tenantId) // tenant scoping
    .select("id, name, email, phone, avatar")
    .single();
  if (error) return json(req, { error: error.message }, 500);

  return json(req, { ok: true, profile: data });
}

async function me(req: Request): Promise<Response> {
  try {
    // A valid staff session decides the shell, before the owner bearer is
    // considered. A staff PIN user may hold the staff cookie in a browser that
    // also carries an owner session — a shared till, an owner testing their own
    // staff login — and the request would otherwise resolve as the owner and
    // give the staff member the owner dashboard. That must never happen: the
    // server answers "staff" and the client sends them to their own shell.
    const staff = await staffSession(req);
    if (staff) {
      const { data: staffRow } = await admin()
        .from("staff")
        .select("employee_id, avatar")
        .eq("id", staff.subjectId)
        .eq("tenant_id", staff.tenantId)
        .maybeSingle();
      return json(req, {
        authenticated: true,
        sessionKind: "staff",
        staff: {
          id: staff.subjectId,
          name: staff.name,
          role: staff.roleName,
          employeeId: staffRow?.employee_id ?? null,
          avatar: staffRow?.avatar ?? null,
        },
      });
    }

    const jwt = bearer(req);
    if (!jwt) return json(req, { authenticated: false }, 401);

    const { data: authData, error: authError } = await asUser(jwt).auth.getUser(jwt);
    if (authError || !authData?.user) {
      return json(req, { authenticated: false }, 401);
    }
    const user = authData.user;

    const db = admin();

    const { data: profile, error: profileError } = await db
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .maybeSingle();

    if (profileError) return json(req, { error: profileError.message }, 500);
    if (!profile || !profile.active) {
      return json(req, { authenticated: false }, 401);
    }

    const [tenantRes, roleRes, settingsRes] = await Promise.all([
      db.from("tenants").select("*").eq("id", profile.tenant_id).maybeSingle(),
      profile.role_id
        ? db.from("roles").select("*").eq("id", profile.role_id).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      // A few settings are keys rather than tenant columns, so they are read
      // from where they are written. The menu theme belongs here too: without it
      // in the list the field below read from a map that never held it, so every
      // restaurant was reported as having the light menu.
      db
        .from("settings")
        .select("key, value")
        .eq("tenant_id", profile.tenant_id)
        .in("key", ["gstin", "fssai", MENU_THEME_KEY]),
    ]);

    if (tenantRes.error) return json(req, { error: tenantRes.error.message }, 500);
    if (roleRes.error) return json(req, { error: roleRes.error.message }, 500);
    if (settingsRes.error) return json(req, { error: settingsRes.error.message }, 500);

    const settings: Record<string, string> = {};
    for (const row of (settingsRes.data ?? []) as any[]) {
      if (row?.key) settings[row.key] = row.value ?? "";
    }

    const tenant = tenantRes.data;
    const role = roleRes.data;

    return json(req, {
      authenticated: true,
      sessionKind: "owner",
      user: {
        id: profile.id,
        name: profile.name,
        email: profile.email,
        role: profile.role,
        roleId: profile.role_id,
        tenantId: profile.tenant_id,
        avatar: profile.avatar,
      },
      // The details the restaurant has already saved, so a screen that asks
      // for them can show what is there instead of asking again.
      tenant: tenant
        ? {
          id: tenant.id,
          name: tenant.name,
          slug: tenant.slug,
          logo: tenant.logo ?? "",
          phone: tenant.phone ?? "",
          email: tenant.email ?? "",
          address: tenant.address ?? "",
          currency: tenant.currency ?? "INR",
          currencySymbol: tenant.currency_symbol ?? "\u20b9",
          taxRate: Number(tenant.tax_rate ?? 0),
          serviceCharge: Number(tenant.service_charge ?? 0),
          gstin: settings.gstin ?? "",
          fssai: settings.fssai ?? "",
          // What the customer menu looks like. Without it the setup flow had
          // nothing to show but its own default, so a restaurant that had chosen
          // the dark menu was shown "Light Mode · Selected" — and saving that
          // step would have quietly put it back.
          menuTheme: normaliseMenuTheme(settings[MENU_THEME_KEY]),
          // Whether setup ever finished, so a screen that needs to route the
          // owner (login, email confirmation) can send them to the wizard
          // instead of an empty dashboard.
          onboardingDone: tenant.onboarding_done ?? false,
        }
        : null,
      role: role
        ? {
          id: role.id,
          name: role.name,
          permissions: role.permissions,
        }
        : null,
    });
  } catch {
    return json(req, { authenticated: false }, 401);
  }
}

async function register(req: Request): Promise<Response> {
  try {
    const b = await body(req);
    const { name, email, password, restaurantName } = b;

    if (!email || !password || !name) {
      return json(req, { error: "Name, email, and password are required" }, 400);
    }

    const cleanEmail = String(email).toLowerCase().trim();
    const cleanName = String(name).trim();

    const supabase = anon();
    /**
     * Sign the address up, with one self-heal for an orphaned address.
     *
     * GoTrue can create the auth user and still fail the call — most often
     * when the confirmation email hits a send limit. The row that leaves
     * behind has no tenant and no profile, and every later signup with the
     * same address is told "account exists" — a dead end the owner cannot
     * climb out of. A duplicate that has no profile is exactly that orphan:
     * delete it and let this attempt start clean. A duplicate WITH a profile
     * is a real account, and the normal duplicate answer stands.
     */
    let authData: any = null;
    let authError: any = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      ({ data: authData, error: authError } = await supabase.auth.signUp({
        email: cleanEmail,
        password: String(password),
        options: {
          data: { name: cleanName },
          // Where the confirmation email lands. Without this the link falls
          // back to the project's Site URL — a bare host that 404s on the
          // Supabase domain — and the first sign-in never reached the app.
          emailRedirectTo: `${appOrigin(req)}/?view=confirm-email`,
        },
      }));

      const looksDuplicate =
        (authError && /already|registered|exists/i.test(authError.message ?? "")) ||
        (!authError &&
          Array.isArray(authData?.user?.identities) &&
          authData.user.identities.length === 0);

      // The call failed AFTER GoTrue created the user (the email send is what
      // failed). Take the row back so a retry starts clean — but never touch
      // a row that looks like somebody's real account.
      if (authError && !looksDuplicate && authData?.user?.id) {
        try {
          await admin().auth.admin.deleteUser(authData.user.id);
        } catch {
          /* best effort — the original error is the one that matters */
        }
      }

      if (!looksDuplicate) break;

      const db0 = admin();
      const { data: existingProfile } = await db0
        .from("profiles")
        .select("id")
        .eq("email", cleanEmail)
        .maybeSingle();
      if (existingProfile || attempt > 0) break;
      const { data: list } = await db0.auth.admin.listUsers({ perPage: 1000 });
      const orphan = (list?.users ?? []).find(
        (u) => u.email?.toLowerCase() === cleanEmail,
      );
      if (!orphan) break;
      await db0.auth.admin.deleteUser(orphan.id);
    }

    if (authError) {
      if (/rate.?limit|too many requests/i.test(authError.message ?? "")) {
        // Supabase default SMTP email rate limit reached. Fall back to admin link generation
        // which creates the user and token without exhausting or failing on the shared SMTP limit.
        try {
          const db0 = admin();
          const { data: list } = await db0.auth.admin.listUsers({ perPage: 1000 });
          const existing = (list?.users ?? []).find(
            (u) => u.email?.toLowerCase() === cleanEmail,
          );
          if (existing) {
            const { data: p } = await db0.from("profiles").select("id").eq("id", existing.id).maybeSingle();
            if (!p) {
              await db0.auth.admin.deleteUser(existing.id);
            }
          }
          const linkRes = await db0.auth.admin.generateLink({
            type: "signup",
            email: cleanEmail,
            password: String(password),
            options: {
              data: { name: cleanName },
              redirectTo: `${appOrigin(req)}/?view=confirm-email`,
            },
          });
          if (!linkRes.error && linkRes.data?.user) {
            authData = { user: linkRes.data.user, session: null };
            authError = null;
            console.log(`auth: fallback generateLink succeeded for ${cleanEmail}: ${linkRes.data.properties?.action_link}`);
          }
        } catch (linkErr) {
          console.error("auth: fallback generateLink error", linkErr);
        }
      }
    }

    if (authError) {
      if (/rate.?limit|too many requests/i.test(authError.message ?? "")) {
        return json(
          req,
          {
            error:
              "Too many signups right now — the confirmation email could not be sent. Wait a few minutes and try again.",
          },
          429,
        );
      }
      if (/already|registered|exists/i.test(authError.message || "")) {
        return json(req, { error: "An account with this email already exists" }, 400);
      }
      return json(req, { error: authError.message || "Registration failed" }, 500);
    }

    const authUser = authData?.user;
    // Supabase returns a user with an empty identities array for an address
    // that already exists (enumeration protection). Treat that as a duplicate.
    if (
      !authUser ||
      (Array.isArray(authUser.identities) && authUser.identities.length === 0)
    ) {
      return json(req, { error: "An account with this email already exists" }, 400);
    }

    const db = admin();

    /**
     * Roll back whatever this attempt created. A failure part-way through
     * signup used to strand the address: the auth user (and maybe a tenant)
     * existed, no profile did, and every retry was told "account exists".
     * Everything here is best-effort — the failure that brought us here is
     * the one that matters.
     */
    let createdTenantId: string | null = null;
    const rollbackSignup = async (error: string, status = 500) => {
      try {
        await db.from("profiles").delete().eq("id", authUser.id);
      } catch { /* best effort */ }
      if (createdTenantId) {
        try {
          await db.from("roles").delete().eq("tenant_id", createdTenantId);
        } catch { /* best effort */ }
        try {
          await db.from("tenants").delete().eq("id", createdTenantId);
        } catch { /* best effort */ }
      }
      try {
        await db.auth.admin.deleteUser(authUser.id);
      } catch { /* best effort */ }
      return json(req, { error }, status);
    };

    // Derive a unique slug from the restaurant name.
    const cleanRestName = (restaurantName || `${cleanName}'s Restaurant`).trim();
    const baseSlug = slugify(String(cleanRestName));
    let slug = baseSlug;
    for (let i = 0; i < 5; i++) {
      const { data: existing, error: slugError } = await db
        .from("tenants")
        .select("id")
        .eq("slug", slug)
        .maybeSingle();
      if (slugError) return await rollbackSignup(slugError.message);
      if (!existing) break;
      slug = `${baseSlug}-${Math.random().toString(36).substring(2, 7)}`;
    }

    // Create the tenant.
    // The trial needs its own clock. The column default is the status
    // ('trial'), but the two dates have no default, so a tenant created
    // without them was a trial that had already ended — which is what every
    // account registered while this insert omitted them was told.
    const trial = await trialFields();
    const { data: tenant, error: tenantError } = await db
      .from("tenants")
      .insert({
        name: cleanRestName,
        slug,
        plan: "pro",
        ...trial,
        // India-first defaults. The onboarding flow can change these, but a new
        // restaurant must not start out priced in dollars.
        currency: "INR",
        currency_symbol: "₹",
        active: true,
      })
      .select()
      .single();
    if (tenantError) return await rollbackSignup(tenantError.message);
    createdTenantId = tenant.id;

    // Create the default system roles.
    const { data: roles, error: rolesError } = await db
      .from("roles")
      .insert(DEFAULT_ROLES.map((r) => ({ ...r, tenant_id: tenant.id })))
      .select();
    if (rolesError) return await rollbackSignup(rolesError.message);

    const ownerRole = (roles ?? []).find((r) => r.name === "Owner");

    // Create the owner's profile, keyed by the auth user id.
    const { data: profile, error: profileError } = await db
      .from("profiles")
      .insert({
        id: authUser.id,
        tenant_id: tenant.id,
        name: cleanName,
        email: cleanEmail,
        role: "OWNER",
        role_id: ownerRole?.id ?? null,
        active: true,
      })
      .select()
      .single();
    if (profileError) return await rollbackSignup(profileError.message);

    // Log the security event.
    const { error: logError } = await db.from("security_logs").insert({
      tenant_id: tenant.id,
      user_id: profile.id,
      action: "REGISTER",
      ip: clientIp(req),
      user_agent: req.headers.get("user-agent") || "unknown",
      meta: "Registered new account and created tenant",
    });
    if (logError) return await rollbackSignup(logError.message);

    // Welcome mail, with the trial's real end date from the row just written.
    try {
      await queueForTenant(db, tenant.id, {
        eventKey: `trial_started:${tenant.id}`,
        eventType: "trial_started",
        recipient: profile.email,
        recipientName: profile.name,
        restaurantName: tenant.name,
        payload: { trialEndsAt: trial.trial_ends_at, days: 14 },
      });
      await dispatchPending(db, 5);
    } catch (e) {
      console.error("auth: welcome email failed", (e as Error)?.message);
    }

    return json(req, {
      user: {
        id: profile.id,
        name: profile.name,
        email: profile.email,
        role: profile.role,
        roleId: profile.role_id,
        tenantId: profile.tenant_id,
      },
      tenant: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        currencySymbol: tenant.currency_symbol,
      },
      // Only present when email confirmation is disabled; see login().
      session: authData.session ?? null,
    });
  } catch (error: any) {
    console.error("Registration error:", error);
    return json(req, { error: error.message || "Registration failed" }, 500);
  }
}
