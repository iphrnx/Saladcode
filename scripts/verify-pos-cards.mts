/**
 * The POS product cards: nothing about a dish may be cut off.
 *
 * Measures every card at a phone width and a desktop width — the card's height,
 * and whether the name, the description or the price is clipped — and refuses to
 * pass if it found no cards to measure (a green check on an empty list is not a
 * check).
 *
 *   npm run test:pos-cards
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SITE = process.env.SITE_URL ?? "https://www.thesalad.in";
const EMAIL = process.env.EMAIL ?? "phrnx@icloud.com";
const PORT = Number(process.env.CDP_PORT ?? 9521);

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });
const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const c = createClient(SB, ANON, { auth: { persistSession: false } });
const { data: session } = await c.auth.verifyOtp({ token_hash: link!.properties.hashtoken ?? link!.properties.hashed_token, type: "magiclink" });
const s = session!.session!;

const chrome = spawn("google-chrome", [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/chrome-pos-${PORT}`,
  "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "about:blank",
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

/** Every card, with the parts that must be readable. */
const MEASURE = `(() => {
  const cards = [...document.querySelectorAll('div[role="button"]')].filter((el) =>
    el.querySelector('h4') && /₹|\\$/.test(el.textContent || ''));
  const clipped = (el) => el ? el.scrollWidth > el.clientWidth + 1 : false;
  const rows = cards.map((el) => {
    const name = el.querySelector('h4');
    const desc = [...el.querySelectorAll('p')].find((p) => p.className.includes('text-[11px]') || p.className.includes('line-clamp'));
    const price = [...el.querySelectorAll('span')].find((sp) => /text-gradient-primary/.test(sp.className));
    const rect = el.getBoundingClientRect();
    return {
      name: (name?.textContent || '').slice(0, 26),
      h: Math.round(rect.height),
      nameClipped: clipped(name),
      nameLines: name ? Math.round(name.getBoundingClientRect().height / parseFloat(getComputedStyle(name).lineHeight || '18')) : 0,
      descClipped: clipped(desc),
      descText: (desc?.textContent || '').slice(0, 26),
      priceClipped: clipped(price),
      priceText: price?.textContent || '',
    };
  });
  const heights = rows.map((r) => r.h).sort((a, b) => a - b);
  return JSON.stringify({
    count: rows.length,
    heights,
    medianH: heights.length ? heights[Math.floor(heights.length / 2)] : 0,
    clippedNames: rows.filter((r) => r.nameClipped).map((r) => r.name),
    clippedDescs: rows.filter((r) => r.descClipped).map((r) => r.descText),
    clippedPrices: rows.filter((r) => r.priceClipped).map((r) => r.priceText),
    sample: rows.slice(0, 4),
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
  });
})()`;

try {
  let version: any = null;
  for (let i = 0; i < 40; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; }
    catch { await sleep(250); }
  }
  if (!version) throw new Error("Chrome did not start");
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
  const ev = async (expr: string) =>
    (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId))?.result?.value;

  const hash = new URLSearchParams({
    access_token: s.access_token, refresh_token: s.refresh_token, expires_at: String(s.expires_at),
    expires_in: String(s.expires_in), token_type: s.token_type, type: "magiclink",
  }).toString();

  for (const viewport of [{ name: "phone", width: 390, height: 844 }, { name: "desktop", width: 1440, height: 1000 }]) {
    console.log(`\n── ${viewport.name} ${viewport.width}×${viewport.height} ──`);
    await send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.width < 640,
    }, sessionId);
    await send("Page.navigate", { url: `${SITE}/?view=dashboard#${hash}` }, sessionId);
    await sleep(5000);
    await send("Page.navigate", { url: `${SITE}/?view=dashboard` }, sessionId);
    await sleep(10000);

    const m = JSON.parse(String(await ev(MEASURE)));
    console.log("  cards:", m.count, "| heights:", JSON.stringify(m.heights), "| median:", m.medianH);
    console.log("  sample:", JSON.stringify(m.sample?.[0] ?? {}));
    check("the product cards were found", m.count > 0, JSON.stringify(m).slice(0, 200));
    check("no dish name is cut off", m.clippedNames.length === 0, JSON.stringify(m.clippedNames));
    check("no description is cut off", m.clippedDescs.length === 0, JSON.stringify(m.clippedDescs));
    check("no price is cut off", m.clippedPrices.length === 0, JSON.stringify(m.clippedPrices));
    check("the page does not scroll sideways", m.overflowX <= 1, `overflow ${m.overflowX}px`);

    if (viewport.name === "phone") {
      const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
      fs.writeFileSync("/root/downloads/pos-cards-phone.png", Buffer.from(shot.data, "base64"));
      console.log("  screenshot: /root/downloads/pos-cards-phone.png");
    }
  }
} catch (e) {
  check("the card checks ran", false, (e as Error).message);
} finally {
  chrome.kill();
}

console.log(`\n${pass}/${pass + fail} checks passed${fail ? ` — ${fail} FAILED` : ""}`);
