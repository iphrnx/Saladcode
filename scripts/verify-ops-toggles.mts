/**
 * The Operations toggles, after two were removed.
 *
 * Two things matter beyond "the labels are gone". The other toggles must still
 * work and still save — and a save must not blank the two rows whose controls
 * were taken away, which is the trap in removing a control that shares its state
 * with everything else on the screen.
 *
 *   npm run test:ops-toggles
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SITE = process.env.SITE_URL ?? "https://www.thesalad.in";
const EMAIL = process.env.EMAIL ?? "phrnx@icloud.com";
const PORT = Number(process.env.CDP_PORT ?? 10381);
const PROFILE = `/tmp/chrome-ops-${PORT}`;
const KEYS = ["kitchen_display", "table_qr_ordering", "notification_email", "min_delivery_order"];
/** Removed from the screen; must keep whatever value they hold. */
const REMOVED = ["notification_email", "min_delivery_order"];

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });
const { data: profile } = await admin.from("profiles").select("tenant_id").eq("email", EMAIL).maybeSingle();
const tenantId = profile!.tenant_id as string;
const rowsOf = async () => {
  const { data } = await admin.from("settings").select("key, value").eq("tenant_id", tenantId).in("key", KEYS);
  return Object.fromEntries((data ?? []).map((r: any) => [r.key, r.value]));
};
// Give the two removed keys a value worth protecting, if they have none.
const before = await rowsOf();
for (const key of REMOVED) {
  if (before[key] === undefined) {
    await admin.from("settings").insert({ tenant_id: tenantId, key, value: "true" });
  }
}
const seeded = await rowsOf();
console.log("  settings before:", JSON.stringify(seeded));

const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const c = createClient(SB, ANON, { auth: { persistSession: false } });
const { data: session } = await c.auth.verifyOtp({ token_hash: link!.properties.hashed_token, type: "magiclink" });
const s = session!.session!;
const hash = new URLSearchParams({
  access_token: s.access_token, refresh_token: s.refresh_token, expires_at: String(s.expires_at),
  expires_in: String(s.expires_in), token_type: s.token_type, type: "magiclink",
}).toString();

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
  await send("Runtime.enable", {}, sessionId);
  const ev = async (expr: string) => {
    for (let i = 0; i < 8; i++) {
      const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
      if (r?.result?.value !== undefined) return r.result.value;
      await sleep(300);
    }
    return undefined;
  };
  const boxOf = (finder: string) => ev(`(() => {
    const el = ${finder};
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
  })()`);
  const click = async (box: string | null) => {
    if (!box) return false;
    const { x, y } = JSON.parse(box);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, sessionId);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, sessionId);
    return true;
  };

  await send("Page.navigate", { url: `${SITE}/?view=dashboard#${hash}` }, sessionId);
  await sleep(5000);
  await send("Page.navigate", { url: `${SITE}/?view=settings` }, sessionId);
  await sleep(12000);
  await click(await boxOf(`[...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === 'Operations')`));
  await sleep(3000);

  const text = String(await ev(`document.body.innerText`));
  console.log("\n── the Operations tab ──");
  for (const label of ["Kitchen Display System", "Table QR Ordering"]) {
    check(`${label} is still there`, text.includes(label));
  }
  for (const label of ["Email Notifications", "Min Delivery Order"]) {
    check(`${label} is gone`, !text.includes(label));
  }

  // The kept toggle must still work and still save.
  const switchBox = await boxOf(`[...document.querySelectorAll('[role="switch"]')][0]`);
  check("a toggle can be reached", await click(switchBox), String(switchBox));
  await sleep(1200);
  const saveBox = await boxOf(`[...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === 'Save Changes')`);
  check("Save Changes can be pressed", await click(saveBox), String(saveBox));
  await sleep(6000);

  const after = await rowsOf();
  console.log("  settings after:", JSON.stringify(after));
  check("the kept toggle was saved", after.kitchen_display !== seeded.kitchen_display,
    `kitchen_display ${seeded.kitchen_display} → ${after.kitchen_display}`);
  for (const key of REMOVED) {
    check(`${key} was left alone by the save`, after[key] === seeded[key],
      `${seeded[key]} → ${after[key]}`);
  }

  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
  fs.writeFileSync("/root/downloads/settings-operations.png", Buffer.from(shot.data, "base64"));
} catch (e) {
  check("the toggle checks ran", false, (e as Error).message);
} finally {
  chrome.kill();
  await sleep(400);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* gone */ }
  // Put the settings back exactly as they were found.
  for (const key of KEYS) {
    if (seeded[key] === undefined) continue;
    const { data } = await admin.from("settings").select("key").eq("tenant_id", tenantId).eq("key", key).maybeSingle();
    if (data) await admin.from("settings").update({ value: seeded[key] }).eq("tenant_id", tenantId).eq("key", key);
    else await admin.from("settings").insert({ tenant_id: tenantId, key, value: seeded[key] });
  }
  console.log("\n  (settings restored)");
}

console.log(`\n${pass}/${pass + fail} checks passed${fail ? ` — ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
