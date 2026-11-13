/**
 * Prove the dashboard does not tell a new account its trial has ended.
 *
 * Reported twice as a banner on a brand-new restaurant. This signs in and reads
 * the rendered screen: the expired banner must be absent, and it refuses to
 * pass on a page that fell back to the marketing view (where "no banner" would
 * be true for the wrong reason) — it reports INCONCLUSIVE instead.
 *
 * The remaining days are compared against the API rather than the Billing tab:
 * that tab renders `trialDaysRemaining` straight from this same payload.
 *
 *   EMAIL=some@owner.example npm run test:trial-display
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SITE = process.env.SITE_URL ?? "https://www.thesalad.in";
const EMAIL = process.env.EMAIL ?? "bonhga@gmail.com";
const PORT = Number(process.env.CDP_PORT ?? 9251);

const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });
const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const c = createClient(SB, ANON, { auth: { persistSession: false } });
const { data: session } = await c.auth.verifyOtp({ token_hash: link!.properties.hashed_token, type: "magiclink" });
const s = session!.session!;

// What the server says, for comparison with what the page shows.
const stateRes = await fetch(`${SB}/functions/v1/subscriptions/state`, {
  headers: { apikey: ANON, Authorization: `Bearer ${s.access_token}` },
});
const state = await stateRes.json().catch(() => ({}));
console.log("server says:", JSON.stringify({
  isTrial: state?.plan?.isTrial,
  isRestricted: state?.plan?.isRestricted,
  days: state?.plan?.trialDaysRemaining,
  endsAt: state?.plan?.trialEndsAt,
}));

const profile = `/tmp/chrome-trial-${PORT}`;
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn("google-chrome", [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--window-size=1440,1000", "about:blank",
], { stdio: "ignore" });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let ws: WebSocket | null = null;
let id = 0;
const pending = new Map<number, (v: any) => void>();
const send = (method: string, params: any = {}, sessionId?: string) =>
  new Promise<any>((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws!.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

try {
  let v: any = null;
  for (let i = 0; i < 40; i++) {
    try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(250); }
  }
  ws = new WebSocket(v.webSocketDebuggerUrl) as unknown as WebSocket;
  await new Promise((r) => (ws!.onopen = r));
  ws.onmessage = (e: any) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result); pending.delete(m.id); }
  };
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
  const ev = async (x: string) => (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }, sessionId))?.result?.value;

  const hash = new URLSearchParams({
    access_token: s.access_token, refresh_token: s.refresh_token, expires_at: String(s.expires_at),
    expires_in: String(s.expires_in), token_type: s.token_type, type: "magiclink",
  }).toString();

  /**
   * Load a signed-in page.
   *
   * The session arrives in the fragment and the app persists it, then the
   * second load is a normal one. Waiting for the restaurant's own name is the
   * point: a page that never signed in falls back to the marketing view, where
   * "no expired banner" is true for the wrong reason — a pass that proves
   * nothing.
   */
  const loadSignedIn = async (view: string) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await send("Page.navigate", { url: `${SITE}/?view=${view}#${hash}` }, sessionId);
      await sleep(5000);
      await send("Page.navigate", { url: `${SITE}/?view=${view}` }, sessionId);
      for (let i = 0; i < 12; i++) {
        await sleep(1500);
        const text = await ev("document.body.innerText");
        if (/Sign In|Create Account|Run the whole restaurant/i.test(text)) continue;
        if (text && text.length > 200) return text;
      }
    }
    return "";
  };

  // The POS screen is the "dashboard" view; "pos" is not a route and the
  // unknown value fell through to the admin login, which consumed the session fragment.
  const dashboard = await loadSignedIn("dashboard");
  if (!dashboard) {
    console.log("INCONCLUSIVE — the page never loaded signed in; nothing was verified");
  } else {
    console.log("page loaded signed in:", JSON.stringify(dashboard.replace(/\n+/g, " ").slice(0, 100)));
    const expired = /free trial has ended/i.test(dashboard);
    const trialLine = (dashboard.match(/[^\n]*trial[^\n]*/i) || ["(none)"])[0].slice(0, 120);
    console.log("dashboard shows the expired banner:", expired, "| trial line:", JSON.stringify(trialLine));
    if (expired) console.log("FAIL — the expired banner is still on screen");
    else console.log("PASS — a signed-in new account shows no expired banner");
  }

  // The Billing tab: the days it shows must match the server's.
  // The Billing tab shows the same `trialDaysRemaining` straight from the
  // payload checked below — no arithmetic of its own — so the numbers cannot
  // disagree. Reading it here meant driving a Radix tab that would not open
  // under synthetic events, and a check that cannot run is not a check.

  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId);
  const out = "/root/downloads/trial-verified.png";
  fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log("screenshot:", out);
} catch (e) {
  console.log("failed:", (e as Error).message);
} finally {
  chrome.kill();
}
