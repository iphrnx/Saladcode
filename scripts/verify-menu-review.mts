/**
 * The menu review step, after extraction normalisation — checked in a real
 * browser against the running dev build.
 *
 * Seeds a draft shaped exactly like the new ai-extract-menu response:
 *   - Chicken Tikka: two portion lines merged into one dish, dish price =
 *     lowest portion price, both portions visible as priced chips
 *   - Tandoori Chicken: the screenshot bug — base price unreadable but two
 *     readable portion prices, so the dish must show a real price, not ₹0
 *   - Chicken Wings: one portion line, kept as a single priced variant
 *   - Mystery Curry: nothing readable anywhere — must show ₹— and the amber
 *     flag, never ₹0
 *   - Masala Dosa: a plain single-price dish, untouched
 *
 *   npm run test:menu-review
 */
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { DEFAULT_ROLES } from "../supabase/functions/_shared/permissions.ts";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SITE = process.env.SITE_URL ?? "http://localhost:3000";
// A fresh account per run: the test must land in onboarding, so it cannot be
// an account that already has a restaurant — or one that is a super admin.
const EMAIL = `menureview-${Date.now()}@example.com`;
const PASSWORD = `MR${Math.random().toString(36).slice(2)}!x`;
const PORT = Number(process.env.CDP_PORT ?? 10413);
const PROFILE = `/tmp/chrome-menu-review-${PORT}`;

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });
const { data: created, error: createError } = await admin.auth.admin.createUser({
  email: EMAIL,
  password: PASSWORD,
  email_confirm: true,
});
if (createError || !created.user) throw new Error(`test user: ${createError?.message}`);
// What /register builds for a real signup — tenant, system roles, owner
// profile — with onboarding deliberately unfinished so the app lands in the
// wizard. Cleaned up at the end of the run.
const { data: tenant, error: tenantError } = await admin
  .from("tenants")
  .insert({
    name: "Menu Review Test Cafe",
    slug: `menu-review-${Date.now()}`,
    plan: "pro",
    // trialFields() inline: the shared module pulls in Deno-side deps tsx
    // cannot resolve, and the values are just dates.
    subscription_status: "trial",
    subscription_plan: null,
    trial_started_at: new Date().toISOString(),
    trial_ends_at: new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString(),
    currency: "INR",
    currency_symbol: "₹",
    active: true,
  })
  .select()
  .single();
if (tenantError || !tenant) throw new Error(`test tenant: ${tenantError?.message}`);
const { error: rolesError } = await admin
  .from("roles")
  .insert(DEFAULT_ROLES.map((r) => ({ ...r, tenant_id: tenant.id })));
if (rolesError) throw new Error(`test roles: ${rolesError.message}`);
const { error: profileError } = await admin.from("profiles").insert({
  id: created.user.id,
  tenant_id: tenant.id,
  name: "Menu Review",
  email: EMAIL,
  role: "OWNER",
});
if (profileError) throw new Error(`test profile: ${profileError.message}`);
const chrome = spawn("google-chrome", [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--window-size=1440,1000", "about:blank",
], { stdio: "ignore" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let ws: WebSocket | null = null;
let id = 0;
const pending = new Map<number, (v: any) => void>();
const send = (method: string, params: any = {}, sid?: string) =>
  new Promise<any>((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws!.send(JSON.stringify({ id: i, method, params, ...(sid ? { sessionId: sid } : {}) }));
  });

try {
  let version: any = null;
  for (let i = 0; i < 40; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; }
    catch { await sleep(250); }
  }
  ws = new WebSocket(version.webSocketDebuggerUrl) as unknown as WebSocket;
  await new Promise((r) => (ws!.onopen = r));
  ws.onmessage = (e: any) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result); pending.delete(m.id); }
  };
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  const ev = async (expr: string) => {
    for (let i = 0; i < 8; i++) {
      const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
      if (r?.result?.value !== undefined) return r.result.value;
      await sleep(300);
    }
    return undefined;
  };
  const shot = async (name: string) => {
    const img = await send("Page.captureScreenshot", { format: "png" }, sessionId);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`/root/downloads/${name}.png`, Buffer.from(img.data, "base64"));
    console.log(`  shot  ${name}.png`);
  };

  // Sign in through the real login form. A magic-link hash is not an
  // option: MagicLinkForwarder routes every `type=magiclink` fragment to the
  // admin panel, by design — password sign-in is the owner path.
  await send("Page.navigate", { url: `${SITE}/?view=login` }, sessionId);
  await sleep(6000);
  const loggedIn = await ev(`(() => {
    const set = (el, v) => {
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      s.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const email = document.querySelector('input[type="email"]');
    const pass = document.querySelector('input[type="password"]');
    if (!email || !pass) return 'no form';
    set(email, ${JSON.stringify(EMAIL)});
    set(pass, ${JSON.stringify(PASSWORD)});
    // The submit button — the "Sign In" tab matches the label too and must
    // not be clicked instead.
    const btn = document.querySelector('button[type="submit"]')
      || Array.from(document.querySelectorAll('button')).reverse().find((b) => /sign\\s*in/i.test(b.textContent || ''));
    if (!btn) return 'no button';
    btn.click();
    return 'submitted';
  })()`);
  if (loggedIn !== 'submitted') throw new Error(`login form: ${loggedIn}`);
  await sleep(9000);
  // The app routes an account with unfinished setup to the wizard on its
  // own. If it has not, take it there.
  const hrefNow = String(await ev("location.href") ?? "");
  if (!hrefNow.includes("view=onboarding")) {
    await send("Page.navigate", { url: `${SITE}/?view=onboarding` }, sessionId);
    await sleep(9000);
  }
  const menu = {
    categories: [
      {
        id: "cat-1", name: "Starters", icon: "🍢",
        items: [
          {
            id: "i1", name: "Chicken Tikka", description: null, price: 250, priceUnreadable: false,
            veg: false, confidence: "high",
            variants: [
              { name: "8 pcs", price: 250 },
              { name: "12 pcs", price: 420 },
            ],
            addOns: [], tags: [],
          },
          {
            id: "i2", name: "Tandoori Chicken", description: null, price: 320, priceUnreadable: false,
            veg: false, confidence: "high",
            variants: [
              { name: "Half", price: 320 },
              { name: "Full", price: 560 },
            ],
            addOns: [], tags: [],
          },
          {
            id: "i3", name: "Chicken Wings", description: null, price: 220, priceUnreadable: false,
            veg: false, confidence: "high",
            variants: [{ name: "8 pcs", price: 220 }],
            addOns: [], tags: [],
          },
          {
            id: "i4", name: "Mystery Curry", description: null, price: null, priceUnreadable: true,
            veg: null, confidence: "low", variants: [], addOns: [], tags: [],
          },
        ],
      },
      {
        id: "cat-2", name: "Mains", icon: "🍛",
        items: [
          { id: "i5", name: "Masala Dosa", description: null, price: 140, priceUnreadable: false, veg: true, confidence: "high", variants: [], addOns: [], tags: [] },
        ],
      },
    ],
  };
  const seeded = await ev(`(() => {
    const raw = localStorage.getItem('the-salad-onboarding');
    if (!raw) return 'no draft';
    try {
      const d = JSON.parse(raw);
      d.step = 2;
      d.menu = ${JSON.stringify(menu)};
      d.customize = { ...(d.customize || {}), theme: d.customize?.theme || 'light', currency: 'INR', currencySymbol: '₹' };
      localStorage.setItem('the-salad-onboarding', JSON.stringify(d));
      return 'seeded';
    } catch { return 'unreadable'; }
  })()`);
  if (seeded !== 'seeded') throw new Error(`could not seed draft: ${seeded}`);
  await send("Page.reload", {}, sessionId);
  await sleep(11000);

  const text = String(await ev(`document.body.innerText`) ?? "");
  check("review step is up", text.includes("categories") && text.includes("items"));
  // The exact string "₹0.00" — "250.00" ends in "0.00" too, and is fine.
  check("no ₹0.00 anywhere", !text.includes("₹0.00"), text.split("\n").filter((l) => l.includes("₹0.00")).join(" | "));
  check("Chicken Tikka shows the lowest portion price", text.includes("₹250.00"));
  check("Chicken Tikka portion chips priced", text.includes("8 pcs") && text.includes("₹420.00"));
  check("Tandoori Chicken derived from variants", text.includes("₹320.00"));
  // Exactly one dish is flagged for a missing price — Mystery Curry. The
  // dishes with readable portion prices are not flagged at all.
  check("only the truly-unreadable dish is flagged", (text.match(/price not read/g) ?? []).length === 1);
  check("Mystery Curry flagged for entry", /Mystery Curry[\s\S]{0,200}price not read/.test(text));
  check("Mystery Curry shows no price, not zero", /Mystery Curry[\s\S]{0,200}₹—/.test(text));
  check("plain dish untouched", text.includes("Masala Dosa") && text.includes("₹140.00"));
  check("one item needs verify", text.includes("1 need verify"));

  await shot("menu-review-desktop");

  // Phone width — the chips must wrap, not spill.
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sessionId);
  await sleep(600);
  const spill = await ev(`(() => {
    const de = document.documentElement;
    return de.scrollWidth > de.clientWidth + 1;
  })()`);
  check("no sideways spill on a phone", spill === false);
  await shot("menu-review-phone");
} finally {
  chrome.kill();
  // Leave nothing behind: the account and its tenant were made for this run.
  try {
    await admin.auth.admin.deleteUser(created.user.id);
    await admin.from("tenants").delete().eq("id", tenant.id);
  } catch { /* best effort */ }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
