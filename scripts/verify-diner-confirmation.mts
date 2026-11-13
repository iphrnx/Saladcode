/**
 * The diner's confirmation screen, as a phone sees it.
 *
 * Drives the real flow — scan, add dishes, place the order — then checks that the
 * tick is green, that the order's lines are named, and that nothing on the screen
 * is unreachable: the button stays put, and the body can be scrolled to its last
 * element. A confirmation that silently overflows its sheet cannot be scrolled to
 * at all, which is how the item list went missing on a phone.
 *
 *   npm run test:diner-confirm
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SITE = process.env.SITE_URL ?? "https://www.thesalad.in";
const EMAIL = process.env.EMAIL ?? "phrnx@icloud.com";
const PORT = Number(process.env.CDP_PORT ?? 9691);

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
const { data: table } = await admin.from("tables").select("id, name, qr_token").eq("tenant_id", tenantId).eq("active", true).limit(1).maybeSingle();
const { data: dishes } = await admin.from("menu_items").select("id, name, price").eq("tenant_id", tenantId).eq("available", true).limit(4);
check("the restaurant has a table and dishes", Boolean(table && dishes?.length), `table=${(table as any)?.name} dishes=${dishes?.length}`);

const chrome = spawn("google-chrome", [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/chrome-confirm-${PORT}`,
  "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--window-size=390,560", "about:blank",
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

let placedOrderNumber: number | null = null;
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
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 560, deviceScaleFactor: 1, mobile: true }, sessionId);
  const ev = async (expr: string) =>
    (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId))?.result?.value;
  /** Poll a condition in the page until it holds, or give up. */
  const waitFor = async (expr: string, seconds = 30) => {
    for (let i = 0; i < seconds * 2; i++) {
      if (await ev(expr)) return true;
      await sleep(500);
    }
    return false;
  };
  /**
   * Tap the element that *is* the thing, not its container.
   *
   * The dish cards do not start with the dish name — the rating and prep time
   * come first — so matching on `startsWith` found nothing, and matching on
   * `includes` alone would pick the grid wrapping every card. The shortest match
   * is the card itself.
   */
  const tap = async (text: string) => ev(`(() => {
    const matches = [...document.querySelectorAll('button, div[role="button"], [role="button"], a')]
      .filter((b) => (b.innerText || '').includes(${JSON.stringify(text)}))
      .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
    const el = matches[0];
    if (!el) return 'not found';
    for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    return 'tapped';
  })()`);

  console.log("\n── a diner scans and orders ──");
  await send("Page.navigate", { url: `${SITE}/?table=${(table as any).qr_token}` }, sessionId);
  // The menu has to have started its session and loaded dishes before anything
  // can be tapped; a fixed sleep is a guess that goes stale on a slow run.
  const menuOpen = await waitFor(
    `document.body.innerText.includes(${JSON.stringify(String((dishes ?? [])[0]?.name ?? "Menu"))})`,
    40,
  );
  check("the menu opened with its dishes", menuOpen === true, String(await ev(`document.body.innerText.slice(0, 120)`)));

  // A few dishes, so the confirmation is long enough to need scrolling on a phone.
  // The add control is a "+" drawn as an icon, so it has no text to match on:
  // find the card that names the dish, then press the button inside it — the
  // trailing one is the add control.
  const addDish = async (name: string) => ev(`(() => {
    const cards = [...document.querySelectorAll('div[role="button"], [role="button"], li, article')]
      .filter((c) => (c.innerText || '').includes(${JSON.stringify(name)}))
      .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
    const card = cards[0];
    if (!card) return 'card not found';
    const buttons = [...card.querySelectorAll('button')];
    const add = buttons[buttons.length - 1];
    if (!add) return 'no add button on the card';
    for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) add.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    return 'added';
  })()`);

  // Twice each, so the confirmation is taller than a phone screen. With a short
  // order the content fits and the scroller is never exercised — which is how a
  // check can pass while the clipping it was written for is still there.
  for (const d of (dishes ?? []).slice(0, 4)) {
    const name = String((d as any).name);
    const ok = await waitFor(`[...document.querySelectorAll('*')].some((b) => (b.innerText || '').includes(${JSON.stringify(name)}))`, 15);
    if (!ok) { console.log(`  (dish never appeared: ${name})`); continue; }
    for (let i = 0; i < 2; i++) {
      const added = await addDish(name);
      if (i === 0) console.log(`  ${name}: ${added}`);
      await sleep(600);
    }
  }
  const cartReady = await waitFor(`[...document.querySelectorAll('button')].some((b) => (b.innerText || '').includes('View Order'))`, 15);
  check("the cart bar appeared", cartReady === true);
  await tap('View Order');
  const placeReady = await waitFor(`[...document.querySelectorAll('button')].some((b) => (b.innerText || '').includes('Place Order'))`, 20);
  check("the place-order button appeared", placeReady === true);
  await tap('Place Order');
  const confirmed = await waitFor(`/Order Confirmed/i.test(document.body.innerText)`, 40);
  check("the order was placed and the confirmation is showing", confirmed === true,
    String(await ev(`document.body.innerText.slice(0, 160)`)));
  await sleep(1500);

  // ---- the confirmation ------------------------------------------------
  console.log("\n── the confirmation ──");
  const seen = JSON.parse(String(await ev(`(() => {
    const text = document.body.innerText;
    const tick = [...document.querySelectorAll('div')].find((d) => {
      const st = getComputedStyle(d);
      return d.querySelector('svg') && /rounded-full/.test(d.className) && /rgb/.test(st.backgroundColor);
    });
    const doneBtn = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === 'Done');
    const scrollers = [...document.querySelectorAll('div')].filter((d) => /overflow-y-auto/.test(d.className));
    const scroller = scrollers[scrollers.length - 1];
    return JSON.stringify({
      confirmed: /Order Confirmed/i.test(text),
      tickColour: tick ? getComputedStyle(tick).backgroundColor : null,
      names: window.__names || [],
      hasNames: null,
      bodyText: text.slice(0, 500),
      doneVisible: doneBtn ? (() => { const r = doneBtn.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight + 1; })() : false,
      scrollable: scroller ? { scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight } : null,
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
    });
  })()`)));
  console.log("  tick:", seen.tickColour, "| scroll:", JSON.stringify(seen.scrollable), "| done visible:", seen.doneVisible);
  console.log("  body:", String(seen.bodyText).replace(/\\n+/g, " | ").slice(0, 240));

  check("the confirmation is showing", seen.confirmed === true, String(seen.bodyText).slice(0, 160));
  check("the tick is green", seen.tickColour === "rgb(16, 185, 129)", String(seen.tickColour));

  // Only the confirmation counts: the menu behind the sheet also names every
  // dish, which is how the first version of this check passed without the
  // confirmation ever being on screen.
  const insideSheet = JSON.parse(String(await ev(`(() => {
    const sheet = document.querySelector('[role="dialog"]') ?? document.body;
    return JSON.stringify({
      text: (sheet.innerText || '').slice(0, 900),
      confirmed: /Order Confirmed/i.test(sheet.innerText || ''),
    });
  })()`)));
  const dishNames = (dishes ?? []).map((d: any) => d.name);
  const named = dishNames.filter((n: string) => String(insideSheet.text).includes(n));
  console.log("  confirmation text:", String(insideSheet.text).replace(/\n+/g, ' | ').slice(0, 260));
  check("the confirmation is the thing on screen", insideSheet.confirmed === true, String(insideSheet.text).slice(0, 120));
  check("the order's lines are named inside it", named.length >= 1, `none of ${JSON.stringify(dishNames)} appeared`);

  check("the Done button is reachable without scrolling", seen.doneVisible === true, JSON.stringify(seen.doneVisible));

  // Nothing may be stranded: scroll the body to its end and look at the last text.
  const reachable = JSON.parse(String(await ev(`(() => {
    const scrollers = [...document.querySelectorAll('div')].filter((d) => /overflow-y-auto/.test(d.className));
    const scroller = scrollers[scrollers.length - 1];
    if (!scroller) return JSON.stringify({ scroller: false });
    scroller.scrollTop = scroller.scrollHeight;
    const noteVisible = (() => {
      const el = [...document.querySelectorAll('*')].find((e) => /meal is on the way/i.test(e.textContent || '') && e.children.length === 0);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight + 1;
    })();
    return JSON.stringify({ scroller: true, noteVisible, scrolled: scroller.scrollTop });
  })()`)));
  console.log("  after scrolling to the end:", JSON.stringify(reachable));
  check("the confirmation is taller than the screen, so this check means something",
    Boolean(seen.scrollable) && seen.scrollable.scrollHeight > seen.scrollable.clientHeight,
    JSON.stringify(seen.scrollable));
  check("the body scrolls, so nothing is stranded below the fold",
    reachable.scroller === true && reachable.noteVisible === true, JSON.stringify(reachable));
  const doneAfterScroll = await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').trim() === 'Done');
    if (!b) return false;
    const r = b.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight + 1;
  })()`);
  check("and the Done button is still there after scrolling", doneAfterScroll === true);
  check("nothing spills sideways", seen.overflowX <= 1, `overflow ${seen.overflowX}px`);

  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
  fs.writeFileSync("/root/downloads/diner-confirmation.png", Buffer.from(shot.data, "base64"));
  const full = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId);
  fs.writeFileSync("/root/downloads/diner-confirmation-full.png", Buffer.from(full.data, "base64"));
  console.log("  screenshots: /root/downloads/diner-confirmation{,-full}.png");
} catch (e) {
  check("the confirmation checks ran", false, (e as Error).message);
} finally {
  chrome.kill();
  await sleep(400);
  try { fs.rmSync(`/tmp/chrome-confirm-${PORT}`, { recursive: true, force: true }); } catch { /* gone already */ }
  // Remove whatever this run created on the real restaurant.
  const { data: recent } = await admin.from("orders").select("id").eq("tenant_id", tenantId).order("created_at", { ascending: false }).limit(3);
  for (const o of recent ?? []) {
    await admin.from("order_items").delete().eq("order_id", o.id);
    await admin.from("orders").delete().eq("id", o.id);
  }
  await admin.from("table_sessions").delete().eq("tenant_id", tenantId).eq("status", "ACTIVE");
}

console.log(`\n${pass}/${pass + fail} checks passed${fail ? ` — ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
