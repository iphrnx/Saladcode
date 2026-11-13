/**
 * Security dashboard rules, tested without a database or a network.
 *
 *   - client IP resolution: the trusted-source order (cf-connecting-ip,
 *     leftmost XFF), spoofed chains, internal egress never surfacing,
 *     IPv4/IPv6 normalization, CIDR masks, stored-chain cleanup
 *   - user-agent parsing: browser / OS / device for real agent strings
 *   - session mapping: sign-in time and last-activity stay two fields
 *   - audit stats: 24h failed-login window and 7d event window, with the
 *     tenant filter and error propagation exercised through a fake db
 *
 *   npm run test:security-offline
 */
import {
  cleanIp,
  clientIp,
  normalizeIp,
  resolveClientIp,
} from "../supabase/functions/_shared/ip.ts";
import { parseUserAgent } from "../supabase/functions/_shared/user-agent.ts";
import { wireSessionFromRow, wireStaffSessionFromRow, mergeSameDevice } from "../supabase/functions/_shared/sessions.ts";
import { auditStats } from "../supabase/functions/_shared/audit.ts";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean) {
  if (cond) passed++;
  else failures.push(name);
}
function req(headers: Record<string, string>): Request {
  return new Request("https://fn.test/", { headers });
}

// ---------- IP resolution: spoofing ----------
{
  // The measured Supabase gateway behaviour (2026-10-31 probe): a spoofed
  // client chain is discarded and cf-connecting-ip carries the real peer.
  const spoofed = req({
    "cf-connecting-ip": "64.181.235.175",
    "x-forwarded-for": "9.9.9.9, 1.1.1.1",
  });
  check("spoof: cf header wins over a forged chain", resolveClientIp(spoofed) === "64.181.235.175");

  const noCf = req({ "x-forwarded-for": "64.181.235.175,64.181.235.175, 3.2.54.140" });
  check("gateway chain: leftmost is the client", resolveClientIp(noCf) === "64.181.235.175");
  check("gateway chain: egress pool never returned", resolveClientIp(noCf) !== "3.2.54.140");

  const egressOnly = req({ "x-forwarded-for": "  , 3.2.54.140" });
  check("blank client entry is not an IP", resolveClientIp(egressOnly) === "unknown");

  check("no headers → unknown", resolveClientIp(req({})) === "unknown");
  check("clientIp is the same resolver", clientIp(noCf) === resolveClientIp(noCf));
}

// ---------- IP normalization ----------
{
  const cases: Array<[string, string | null]> = [
    ["13.233.224.229/32", "13.233.224.229"],
    ["203.0.113.7", "203.0.113.7"],
    ["999.1.2.3", null],
    ["1.2.3.256", null],
    ["::ffff:152.59.187.220", "152.59.187.220"],
    ["FE80::0202:B3FF:FE1E:8329", "fe80::202:b3ff:fe1e:8329"],
    ["fe80::1%eth0", "fe80::1"],
    ["[2001:db8::1]", "2001:db8::1"],
    ["2001:db8::1/64", "2001:db8::1"],
    ["1.2.3.4; DROP TABLE", null],
    ["example.com", null],
    ["", null],
    [null as any, null],
    ["::1", "::1"],
  ];
  for (const [raw, want] of cases) {
    check(`normalizeIp(${JSON.stringify(raw)})`, normalizeIp(raw) === want);
  }
  check(
    "cleanIp takes the first entry of a stored chain",
    cleanIp("152.59.187.220,152.59.187.220, 13.248.105.42") === "152.59.187.220",
  );
  check("cleanIp strips inet masks from history", cleanIp("13.233.224.229/32") === "13.233.224.229");
}

// ---------- User-Agent parsing ----------
{
  const matrix: Array<[string, { browser: string | null; os: string | null; device: string | null }]> = [
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      { browser: "Chrome", os: "macOS", device: "Desktop" }],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
      { browser: "Safari", os: "iOS", device: "Phone" }],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
      { browser: "Edge", os: "Windows", device: "Desktop" }],
    ["Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
      { browser: "Samsung Internet", os: "Android", device: "Phone" }],
    ["Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      { browser: "Chrome", os: "Android", device: "Tablet" }],
    ["Mozilla/5.0 (iPad; CPU OS 17_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.7 Mobile/15E148 Safari/604.1",
      { browser: "Safari", os: "iPadOS", device: "Tablet" }],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
      { browser: "Firefox", os: "Linux", device: "Desktop" }],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.37 Mobile/15E148 Safari/604.1",
      { browser: "Chrome", os: "iOS", device: "Phone" }],
    ["Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      { browser: "Chrome", os: "ChromeOS", device: "Desktop" }],
    ["okhttp/4.12.0", { browser: null, os: null, device: null }],
    // An agent that names no browser must not invent one: "Browser" and
    // "Device" used to be the fallback words, and a row of script/test
    // sign-ins rendered as one fake "Browser · Device" device.
    ["node", { browser: null, os: null, device: null }],
    ["curl/8.7.1", { browser: null, os: null, device: null }],
    ["Mozilla/5.0 (compatible)", { browser: null, os: null, device: null }],
    ["Deno/2.9.8", { browser: null, os: null, device: null }],
  ];
  for (const [ua, want] of matrix) {
    const got = parseUserAgent(ua);
    check(
      `agent(${ua.slice(0, 40)}…) browser/os/device`,
      got.browser === want.browser && got.os === want.os && got.device === want.device,
    );
  }
  check("null agent → nulls", JSON.stringify(parseUserAgent(null)) === JSON.stringify({ browser: null, os: null, device: null }));
}

// ---------- Session mapping: two timestamps, not one ----------
{
  const row = {
    id: "sess-1",
    user_id: "u-1",
    name: "Z Hut",
    email: "zhut@demo.com",
    created_at: "2026-10-29T04:00:00Z",
    updated_at: "2026-10-31T05:00:00Z",
    user_agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    ip: "13.233.224.229/32",
  };
  const wire = wireSessionFromRow(row, "sess-1");
  check("sign-in time preserved as createdAt", wire.createdAt === row.created_at);
  check("last activity preserved separately", wire.lastActive === row.updated_at);
  check("the two times are not conflated", wire.createdAt !== wire.lastActive);
  check("current session flagged", wire.current === true);
  check("other session not flagged", wireSessionFromRow(row, "sess-2").current === false);
  check("null current → not current", wireSessionFromRow(row, null).current === false);
  check("os parsed into the wire shape", wire.os === "macOS");
  check("inet mask cleaned", wire.ip === "13.233.224.229");
}

// ---------- mergeSameDevice: the fold the dashboard shows ----------
{
  const base = {
    kind: "owner" as const,
    role: null,
    ip: null,
    location: null,
    user: { id: "u-1", name: "A", email: "a@x.com" },
    lastActive: "",
    createdAt: "",
    firstSeen: "",
  };
  const row = (id: string, uaAgent: string, created: string, current = false) => ({
    ...base,
    id,
    userId: "u-1",
    ...parseUserAgent(uaAgent),
    count: 1,
    ids: [id],
    current,
    lastActive: created,
    createdAt: created,
    firstSeen: created,
  });
  const merged = mergeSameDevice([
    row("a", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", "2026-11-01T09:00:00Z"),
    row("b", "node", "2026-11-02T09:00:00Z"),
    row("c", "node", "2026-11-03T09:00:00Z"),
    row("d", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", "2026-11-04T09:00:00Z"),
  ]);
  merged.sort((x, y) => x.id.localeCompare(y.id));
  const chrome = merged.find((r) => r.browser === "Chrome");
  const unknown = merged.find((r) => r.browser === null);
  check("two Chrome sign-ins fold into one row", chrome?.count === 2);
  check("the fold keeps every id", JSON.stringify(chrome?.ids) === JSON.stringify(["a", "d"]));
  check("unknown agents fold into one row", unknown?.count === 2);
  check("an unknown agent reports no invented browser", unknown?.browser === null);
  check("rows with different real devices stay apart", merged.length === 2, JSON.stringify(merged.map((r) => r.browser)));
  check("firstSeen is the older of the group",
    chrome?.firstSeen === "2026-11-01T09:00:00Z" && chrome.createdAt === "2026-11-04T09:00:00Z");
}



// ---------- Staff session mapping (PIN sessions: staff_sessions → staff → roles) ----------
{
  const row = {
    id: "ss-1",
    staff_id: "st-1",
    created_at: "2026-10-31T06:00:00Z",
    last_active: "2026-10-31T06:30:00Z",
    user_agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    ip: "152.59.187.220/32",
    staff: { id: "st-1", name: "Raj", employee_id: "raj001", active: true, role: { name: "Waiter" } },
  };
  const wire = wireStaffSessionFromRow(row);
  check("staff kind", wire.kind === "staff");
  check("staff role from embed", wire.role === "Waiter");
  check("staff name", wire.user.name === "Raj");
  check("staff username is employee id", wire.user.email === "raj001");
  check("staff UA parsed", wire.browser === "Safari" && wire.os === "iOS" && wire.device === "Phone");
  check("staff ip cleaned (inet mask stripped)", wire.ip === "152.59.187.220");
  check("staff sign-in vs activity distinct", wire.createdAt === row.created_at && wire.lastActive === row.last_active);
  check("staff never 'current' (owner badge only)", wire.current === false);
  check("owner mapping defaults", wireSessionFromRow({ id: "s", user_id: "u", user_agent: null, ip: null, created_at: "a", updated_at: "b", name: "n", email: "e" }, null).kind === "owner");
  check("owner role null", wireSessionFromRow({ id: "s", user_id: "u", user_agent: null, ip: null, created_at: "a", updated_at: "b", name: "n", email: "e" }, null).role === null);

  const noUa = wireStaffSessionFromRow({ id: "ss-2", staff_id: "st-2", created_at: "c", last_active: "l", user_agent: null, ip: null, staff: { id: "st-2", name: "Old", employee_id: "old1", role: { name: "Cashier" } } });
  check("pre-0055 session → unknown client", noUa.browser === null && noUa.os === null && noUa.device === null);
  check("role array embed tolerated", wireStaffSessionFromRow({ ...row, staff: { ...row.staff, role: [{ name: "Kitchen" }] } }).role === "Kitchen");
  check("missing staff join falls back", wireStaffSessionFromRow({ id: "x", staff_id: "st-9", created_at: "c", last_active: "l" }).user.name === "Staff");
}

// ---------- Audit stats: windows, tenant filter, errors ----------
{
  type Query = { table: string; filters: Array<[string, unknown]> };
  const seen: Query[] = [];
  const fakeDb = (counts: number[], failAt = -1) => {
    let i = 0;
    const builder = (table: string) => {
      const q: Query = { table, filters: [] };
      const idx = i++;
      const chain: any = {
        select: () => chain,
        eq: (k: string, v: unknown) => { q.filters.push([k, v]); return chain; },
        gte: (k: string, v: unknown) => { q.filters.push([k, v]); return chain; },
        then: (resolve: any) => {
          seen.push(q);
          const error = idx === failAt ? { message: "db down" } : null;
          return resolve({ count: counts[idx] ?? 0, error });
        },
      };
      return chain;
    };
    return { from: builder } as any;
  };

  const stats = await auditStats(fakeDb([3, 42]), "tenant-1");
  check("failedLogins24h from first query", stats.failedLogins24h === 3);
  check("auditEvents7d from second query", stats.auditEvents7d === 42);

  const failedQ = seen[0];
  check("failed query is tenant-scoped", failedQ.filters.some(([k, v]) => k === "tenant_id" && v === "tenant-1"));
  check("failed query filters LOGIN_FAILED", failedQ.filters.some(([k, v]) => k === "action" && v === "LOGIN_FAILED"));
  const cutoff = failedQ.filters.find(([k]) => k === "created_at")?.[1] as string;
  const ageMs = Date.now() - new Date(cutoff).getTime();
  check("failed query window is 24h ±1m", Math.abs(ageMs - 24 * 3600 * 1000) < 60_000);

  const eventsQ = seen[1];
  check("events query has no action filter (all audit rows)", !eventsQ.filters.some(([k]) => k === "action"));
  const cutoff7 = eventsQ.filters.find(([k]) => k === "created_at")?.[1] as string;
  check("events query window is 7d ±1m", Math.abs(Date.now() - new Date(cutoff7).getTime() - 7 * 24 * 3600 * 1000) < 60_000);

  let threw = false;
  try { await auditStats(fakeDb([0], 0), "tenant-1"); } catch { threw = true; }
  check("a failed count query throws (never silently zero)", threw);
}

if (failures.length) {
  console.error(`\n${failures.length} FAILED:`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`${passed}/${passed} checks passed`);
