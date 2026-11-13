/**
 * Does the Role Access page scroll smoothly?
 *
 * Scrolls it the way a finger does and watches for the two things that make a
 * page feel like it is fighting back: the scroll position going *backwards*
 * while the reader scrolls forwards, and the chrome above the content changing
 * height mid-scroll (which moves the content under the reader's eye).
 *
 *   npm run test:scroll-jitter
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SITE = process.env.SITE_URL ?? "https://www.thesalad.in";
const EMAIL = process.env.EMAIL ?? "phrnx@icloud.com";
const PORT = Number(process.env.CDP_PORT ?? 9831);
const PROFILE = `/tmp/chrome-jitter-${PORT}`;

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

const chrome = spawn("google-chrome", [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--window-size=390,844", "about:blank",
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
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, sessionId);
  const ev = async (expr: string) =>
    (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId))?.result?.value;
  const hash = new URLSearchParams({
    access_token: s.access_token, refresh_token: s.refresh_token, expires_at: String(s.expires_at),
    expires_in: String(s.expires_in), token_type: s.token_type, type: "magiclink",
  }).toString();

  await send("Page.navigate", { url: `${SITE}/?view=dashboard#${hash}` }, sessionId);
  await sleep(5000);
  await send("Page.navigate", { url: `${SITE}/?view=dashboard` }, sessionId);
  await sleep(11000);
  await send("Page.navigate", { url: `${SITE}/?view=roles` }, sessionId);
  await sleep(9000);
  check("the Role Access page is up", Boolean(await ev(`/Role Access/i.test(document.body.innerText)`)));

  // The scroller the page uses, whichever element it is.
  const scrollerInfo = JSON.parse(String(await ev(`(() => {
    const all = [...document.querySelectorAll('*')];
    const scrollers = all.filter((el) => {
      const st = getComputedStyle(el);
      return /(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 20 && el.clientHeight > 200;
    });
    const main = scrollers[0] ?? null;
    return JSON.stringify({
      count: scrollers.length,
      tag: main ? main.tagName + '.' + String(main.className).slice(0, 40) : null,
      scrollHeight: main?.scrollHeight ?? 0,
      clientHeight: main?.clientHeight ?? 0,
      // Which element's height changes when the collapse happens.
      docScroller: document.scrollingElement === document.documentElement,
    });
  })()`)));
  console.log("  scroller:", JSON.stringify(scrollerInfo));

  // Scroll like a finger: many small steps, sampling what the reader would see.
  const trace = JSON.parse(String(await ev(`(async () => {
    const all = [...document.querySelectorAll('*')];
    const candidates = all.filter((el) => {
      const st = getComputedStyle(el);
      return /(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 20 && el.clientHeight > 200;
    });
    // The one with the most to scroll is the page the reader is moving.
    const scroller = candidates.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0]
      ?? document.scrollingElement;

    // The chrome the collapse shrinks: the element carrying the transition the
    // hook drives. Measuring it proves the effect still runs, so a pass here
    // cannot come from having quietly disabled it.
    const chrome = () => {
      const el = document.querySelector('[class*="transition-all"][class*="ease-out"]');
      return el ? Math.round(el.getBoundingClientRect().height) : 0;
    };
    // A piece of content to watch. The invariant is measured per frame, not
    // against its starting position: between two frames, the content must move
    // on screen by exactly as much as the page scrolled. Anything else is the
    // layout shifting under the reader — which is the jump this is about — and
    // it holds whatever else is on the page, including nested panes.
    const anchor = () => {
      // Only a *visible* match: the views render a mobile and a desktop copy and
      // hide one, and the hidden one has no box — finding it first made every
      // frame look like the content never moved.
      const el = [...document.querySelectorAll('*')].find((e) => {
        if (e.children.length !== 0) return false
        if (!/Runs the floor|Handles billing|Sees and advances/i.test(e.textContent || '')) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      })
      return el ? el.getBoundingClientRect().top : null
    };

    const samples = [];
    let last = scroller.scrollTop;
    let lastAnchor = anchor();
    for (let step = 0; step < 60; step++) {
      scroller.scrollTop = scroller.scrollTop + 24;   // a steady downward scroll
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const now = scroller.scrollTop;
      const a = anchor();
      const shifted = a !== null && lastAnchor !== null
        ? Math.round(Math.abs((a - lastAnchor) + (now - last)))
        : 0;
      lastAnchor = a;
      samples.push({
        top: Math.round(now),
        delta: Math.round(now - last),
        header: chrome(),
        shifted,
      });
      last = now;
    }
    const heights = [...new Set(samples.map((x) => x.header))];
    const backwards = samples.filter((x) => x.delta < -1);
    return JSON.stringify({
      samples: samples.length,
      headerHeights: heights,
      headerChangedTimes: heights.length,
      backwardsFrames: backwards.length,
      worstBackwards: backwards.length ? Math.min(...backwards.map((x) => x.delta)) : 0,
      finalTop: samples[samples.length - 1].top,
      worstLayoutShift: Math.max(...samples.map((x) => x.shifted)),
      nonZeroShifts: samples.map((x, i) => (x.shifted > 1 ? { i, shifted: x.shifted, top: x.top, header: x.header } : null)).filter(Boolean),
      // A collapse animates: its height passes through intermediate values, so
      // what matters is that it only ever shrinks while scrolling down.
      headerWentBackUp: samples.some((x, i) => i > 0 && x.header > samples[i - 1].header + 1),
      firstTen: samples.slice(0, 10),
    });
  })()`)));
  console.log("  header heights seen:", JSON.stringify(trace.headerHeights));
  console.log("  first steps:", JSON.stringify(trace.firstTen));
  console.log(`  backwards frames while scrolling down: ${trace.backwardsFrames} (worst ${trace.worstBackwards}px)`);
  console.log(`  worst layout shift in a frame: ${trace.worstLayoutShift}px | header sprang back: ${trace.headerWentBackUp}`);
  console.log(`  frames with a shift: ${JSON.stringify(trace.nonZeroShifts)}`);

  check("the page actually scrolled", trace.finalTop > 200, `ended at ${trace.finalTop}`);
  check("scrolling forward never moves the page backwards", trace.backwardsFrames === 0,
    `${trace.backwardsFrames} frames went backwards, worst ${trace.worstBackwards}px — the reader's scroll is being overridden`);
  check("the header still shrinks as you scroll", trace.headerChangedTimes >= 2,
    `heights seen: ${JSON.stringify(trace.headerHeights)} — a single height means the effect no longer runs at all`);
  check("the header only ever shrinks on the way down, never springs back",
    trace.headerWentBackUp === false, JSON.stringify(trace.headerHeights));
  check("the content moves exactly with the scroll, with no layout jump",
    trace.worstLayoutShift <= 3, `worst frame shifted the content ${trace.worstLayoutShift}px beyond the scroll`);

  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
  fs.writeFileSync("/root/downloads/roles-scroll.png", Buffer.from(shot.data, "base64"));
} catch (e) {
  check("the scroll checks ran", false, (e as Error).message);
} finally {
  chrome.kill();
  await sleep(400);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* gone */ }
}

console.log(`\n${pass}/${pass + fail} checks passed${fail ? ` — ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
