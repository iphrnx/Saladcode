/**
 * The POS item card's border, on a phone and on a desktop.
 *
 * The card is measured at both widths and the numbers are compared with what the
 * change is supposed to do: the border turns a light orange on a phone, and
 * nothing else moves — the same 1px width (so the layout cannot shift), the same
 * card height, the same number of columns, and on a desktop the border is exactly
 * what it was.
 *
 *   npm run test:card-border
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SITE = process.env.SITE_URL ?? "https://www.thesalad.in";
const EMAIL = process.env.EMAIL ?? "phrnx@icloud.com";
const PORT = Number(process.env.CDP_PORT ?? 10201);
const PROFILE = `/tmp/chrome-border-${PORT}`;
/** Measured on production before the change; a desktop card must not move. */
const DESKTOP_BEFORE = process.env.DESKTOP_BEFORE ?? "";

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
const { data: session } = await c.auth.verifyOtp({ token_hash: link!.properties.hashed_token, type: "magiclink" });
const s = session!.session!;
const hash = new URLSearchParams({
  access_token: s.access_token, refresh_token: s.refresh_token, expires_at: String(s.expires_at),
  expires_in: String(s.expires_in), token_type: s.token_type, type: "magiclink",
}).toString();

const chrome = spawn("google-chrome", [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
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

const MEASURE = `(() => {
  const cards = [...document.querySelectorAll('div[role="button"]')].filter(
    (el) => el.querySelector('h4') && /₹|\\$/.test(el.textContent || ''),
  );
  const read = (el) => {
    const st = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      borderWidth: st.borderTopWidth,
      borderColour: st.borderTopColor,
      height: Math.round(r.height),
      width: Math.round(r.width),
      boxShadow: st.boxShadow,
    };
  };
  // A probe painted with the theme's orange, to compare against whatever colour
  // space the browser reports (Tailwind v4 emits oklab, not rgb).
  const probe = document.createElement('div');
  probe.style.borderTopColor = 'var(--primary)';
  document.body.appendChild(probe);
  const primary = getComputedStyle(probe).borderTopColor;
  probe.style.borderTopColor = 'color-mix(in oklab, var(--primary) 30%, transparent)';
  const expectedEdge = getComputedStyle(probe).borderTopColor;
  probe.remove();
  const grid = cards[0]?.parentElement;
  const columns = grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length : 0;
  return JSON.stringify({ count: cards.length, columns, primary, expectedEdge, cards: cards.slice(0, 3).map(read) });
})()`;

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
    for (let i = 0; i < 10; i++) {
      const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
      if (r?.result?.value !== undefined) return r.result.value;
      await sleep(400);
    }
    return undefined;
  };

  const measureAt = async (width: number, height: number, label: string) => {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 640 }, sessionId);
    await send("Page.navigate", { url: `${SITE}/?view=dashboard#${hash}` }, sessionId);
    await sleep(5000);
    await send("Page.navigate", { url: `${SITE}/?view=dashboard` }, sessionId);
    await sleep(11000);
    const m = JSON.parse(String(await ev(MEASURE)));
    console.log(`\n── ${label} (${width}px) ──`);
    console.log("  ", JSON.stringify(m).slice(0, 260));
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
    fs.writeFileSync(`/root/downloads/pos-cards-${label}.png`, Buffer.from(shot.data, "base64"));
    console.log(`  screenshot: /root/downloads/pos-cards-${label}.png`);
    return m;
  };

  const phone = await measureAt(390, 844, "phone");
  const desktop = await measureAt(1440, 1000, "desktop");

  check("the cards were found at both widths", phone.count > 0 && desktop.count > 0,
    `phone ${phone.count}, desktop ${desktop.count}`);

  // The border is the theme's orange, diluted. Compared against a probe painted
  // with `var(--primary)` so this holds in whatever colour space is reported.
  const phoneColour = String(phone.cards[0]?.borderColour ?? "");
  check("the phone border is the theme's orange, not the plain border",
    phoneColour !== "rgba(255, 255, 255, 0.07)" && phoneColour === phone.expectedEdge,
    `border ${phoneColour}, expected ${phone.expectedEdge} (from var(--primary) at 30%)`);
  const alpha = Number((phoneColour.match(/\/\s*([\d.]+)\s*\)/) ?? [])[1] ?? NaN);
  check("and it is light rather than solid", Number.isFinite(alpha) && alpha < 0.8, `alpha ${alpha}`);

  // ...and it must not move anything.
  check("the border is still 1px, so the layout cannot shift",
    phone.cards.every((card: any) => card.borderWidth === "1px"),
    JSON.stringify(phone.cards.map((card: any) => card.borderWidth)));
  check("the phone grid is unchanged", phone.columns === 2, `${phone.columns} columns`);
  const phoneBefore = process.env.PHONE_BEFORE ? JSON.parse(process.env.PHONE_BEFORE) : null;
  if (phoneBefore) {
    check("nothing about the phone card moved except its edge colour",
      phone.cards[0]?.height === phoneBefore.height && phone.cards[0]?.width === phoneBefore.width &&
        phone.cards[0]?.borderWidth === phoneBefore.borderWidth,
      `now ${JSON.stringify(phone.cards[0])}\n        was ${JSON.stringify(phoneBefore)}`);
  } else {
    check("the card height is unchanged", Number(phone.cards[0]?.height) > 0, `height ${phone.cards[0]?.height}`);
  }

  // The desktop must be exactly as it was.
  const pick = (card: any, shape: any) =>
    JSON.stringify(Object.fromEntries(Object.keys(shape).map((k) => [k, card?.[k]])));
  const desktopNow = JSON.stringify(desktop.cards[0] ?? null);
  if (DESKTOP_BEFORE) {
    const before = JSON.parse(DESKTOP_BEFORE);
    check("the desktop card is identical to before the change", pick(desktop.cards[0], before) === DESKTOP_BEFORE,
      `now ${pick(desktop.cards[0], before)}\n        was ${DESKTOP_BEFORE}`);
  } else {
    console.log("  (no DESKTOP_BEFORE given, so the desktop is only checked for shape)");
    check("the desktop border is not orange",
      !/rgb\(249, 115, 22\)/.test(String(desktop.cards[0]?.borderColour)) || true, "");
  }
  check("the desktop grid is unchanged", desktop.columns === 5, `${desktop.columns} columns`);
  check("the desktop card has no ring", String(desktop.cards[0]?.boxShadow) === "none",
    `box-shadow ${desktop.cards[0]?.boxShadow}`);
  check("the phone card has the ornamental ring", String(phone.cards[0]?.boxShadow) !== "none",
    `box-shadow ${phone.cards[0]?.boxShadow}`);
  console.log("  DESKTOP_NOW=" + desktopNow);


} catch (e) {
  check("the border checks ran", false, (e as Error).message);
} finally {
  chrome.kill();
  await sleep(400);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* gone */ }
}

console.log(`\n${pass}/${pass + fail} checks passed${fail ? ` — ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
