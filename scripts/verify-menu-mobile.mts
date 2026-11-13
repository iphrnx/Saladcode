/**
 * The Menu Management page on a phone: compact chrome, nothing clipped, no
 * jumping.
 *
 * The same shape as the Orders check, because the page had the same problems:
 * chrome that animated its own height, a stats block clamped to less than its
 * contents needed, and cards that transitioned their own box. Every claim here
 * is measured.
 *
 *   npm run test:menu-mobile
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SITE = process.env.SITE_URL ?? "https://www.thesalad.in";
const EMAIL = process.env.EMAIL ?? "phrnx@icloud.com";
const PORT = Number(process.env.CDP_PORT ?? 9441);

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
const { data: session } = await c.auth.verifyOtp({
  token_hash: link!.properties.hashtoken ?? link!.properties.hashed_token,
  type: "magiclink",
});
const s = session!.session!;

const profile = `/tmp/chrome-menu-${PORT}`;
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn("google-chrome", [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "about:blank",
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

const MEASURE = `(() => {
  const scroll = document.querySelector('[data-menu-scroll]');
  const stats = document.querySelector('[data-menu-stats]');
  const tabs = document.querySelector('[data-menu-tabs]');
  const list = document.querySelector('[data-menu-list]');
  const cards = [...document.querySelectorAll('[data-menu-card]')];
  const pills = tabs ? [...tabs.querySelectorAll('button')] : [];
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), h: Math.round(r.height) }; };
  const rows = (el) => el ? [...el.children].map(box) : [];
  const card = cards[0];
  let animation = null;
  if (card) { const cs = getComputedStyle(card); animation = cs.animationName + ' ' + cs.animationDuration; }
  const pinned = scroll
    ? [...scroll.querySelectorAll('*')].filter((el) => ['sticky', 'fixed'].includes(getComputedStyle(el).position)).length
    : null;
  return JSON.stringify({
    scrollBox: box(scroll),
    scrollTop: scroll ? Math.round(scroll.scrollTop) : null,
    scrolls: scroll ? scroll.scrollHeight > scroll.clientHeight + 1 : null,
    stats: box(stats),
    statRows: rows(stats ? stats.firstElementChild : null),
    statsClips: stats ? getComputedStyle(stats).overflow === 'hidden' : null,
    tabs: box(tabs),
    pillBoxes: pills.map(box),
    tabsScroll: tabs ? { scrollWidth: tabs.scrollWidth, clientWidth: tabs.clientWidth, scrollLeft: Math.round(tabs.scrollLeft) } : null,
    list: box(list),
    card: box(card),
    cardCount: cards.length,
    pinned,
    pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
    pageScrolls: document.documentElement.scrollHeight - window.innerHeight,
    animation,
    dark: document.documentElement.classList.contains('dark'),
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
    await send("Page.navigate", { url: `${SITE}/?view=menu#${hash}` }, sessionId);
    await sleep(5000);
    await send("Page.navigate", { url: `${SITE}/?view=menu` }, sessionId);
    await sleep(9000);

    const first = JSON.parse(await ev(MEASURE));
    check("the menu page rendered", first.stats !== null && first.tabs !== null && first.list !== null, JSON.stringify(first).slice(0, 200));
    check("the dark theme is on", first.dark === true);
    check("the page does not scroll sideways", first.pageOverflow <= 1, `overflow ${first.pageOverflow}px`);
    check("the page itself does not scroll behind the column", first.pageScrolls <= 1, `page scrolls by ${first.pageScrolls}px`);
    check("nothing in the view is pinned sticky or fixed", first.pinned === 0, `${first.pinned} pinned element(s)`);
    check("the scroll column fills the space it was given", first.scrollBox!.h >= 200, `only ${first.scrollBox!.h}px tall`);

    // The stats were the clipped block: a 10rem clamp over a grid that needs
    // more, with overflow hidden over the top.
    check("the stats block does not clip its own content", first.statsClips === false, `overflow is ${first.statsClips ? 'hidden' : 'visible'}`);
    const statRows = first.statRows.filter(Boolean);
    check(
      "every stat card sits inside the stats block",
      statRows.length > 0 && statRows.every((r: any) => r.bottom <= first.stats!.bottom + 1),
      `rows ${JSON.stringify(statRows)} vs block bottom ${first.stats!.bottom}`,
    );

    // The pills: scrollable sideways, and not cut off vertically.
    const pillBoxes = first.pillBoxes.filter(Boolean);
    check(
      "the category pills are not clipped by their row",
      pillBoxes.length > 0 && pillBoxes.every((r: any) => r.top >= first.tabs!.top - 1 && r.bottom <= first.tabs!.bottom + 1),
      `pills ${JSON.stringify(pillBoxes.slice(0, 2))} vs row ${JSON.stringify(first.tabs)}`,
    );

    if (first.card) {
      check(
        "the first card starts below the category pills",
        first.card.top >= first.tabs!.bottom,
        `card top ${first.card.top} vs pills bottom ${first.tabs!.bottom}`,
      );
      check("the list starts below the pills", first.list!.top >= first.tabs!.bottom, `${first.list!.top} vs ${first.tabs!.bottom}`);
      check("no slide animation is left on the cards", (first.animation || "").startsWith("none"), String(first.animation));
    } else {
      check("there is at least one menu card to measure", false, "no [data-menu-card] found");
    }

    if (viewport.name === "phone") {
      // Where the chrome actually ends, measured: header ~148px (the two action
      // buttons wrap onto their own line at this width), stats ~103px, pills
      // ~38px. Before this work it was ~410px, most of it two stacked filter
      // rows and a clamp that hid the bottom stat cards. A threshold just above
      // today's number is what stops the padding creeping back.
      check(
        "the chrome is compact",
        first.stats!.bottom <= 312,
        `the header, search and stats end at ${first.stats!.bottom}px`,
      );
      check(
        "the category pills scroll sideways",
        first.tabsScroll!.scrollWidth > first.tabsScroll!.clientWidth,
        JSON.stringify(first.tabsScroll),
      );

      await ev(`document.querySelector('[data-menu-tabs]').scrollLeft = 9999`);
      await sleep(700);
      const lastPillVisible = await ev(`(() => {
        const row = document.querySelector('[data-menu-tabs]');
        const last = [...row.querySelectorAll('button')].pop();
        if (!last) return false;
        const r = last.getBoundingClientRect(), rowBox = row.getBoundingClientRect();
        return r.left >= rowBox.left - 1 && r.right <= rowBox.right + 1 && r.bottom <= rowBox.bottom + 1;
      })()`);
      check("the last category pill scrolls fully into view", lastPillVisible === true);
      await ev(`document.querySelector('[data-menu-tabs]').scrollLeft = 0`);
      await sleep(600);

      const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
      fs.writeFileSync("/root/downloads/menu-mobile.png", Buffer.from(shot.data, "base64"));

      // Switching category, and searching, must not move the chrome or the cards.
      const before = { tabs: first.tabs!.bottom, card: first.card?.top, stats: first.stats!.bottom };
      const switched = await ev(`(() => {
        const pills = [...document.querySelectorAll('[data-menu-tabs] button')];
        const target = pills[1] ?? pills[0];
        target?.click();
        return Boolean(target);
      })()`);
      await sleep(1600);
      const afterSwitch = JSON.parse(await ev(MEASURE));
      check("a different category could be selected", switched === true);
      check(
        "switching category does not move the chrome",
        Math.abs(afterSwitch.stats!.bottom - before.stats) <= 1 && Math.abs(afterSwitch.tabs!.bottom - before.tabs) <= 1,
        `stats ${before.stats} → ${afterSwitch.stats!.bottom}, pills ${before.tabs} → ${afterSwitch.tabs!.bottom}`,
      );
      check(
        "switching category does not move the first card",
        !afterSwitch.card || Math.abs(afterSwitch.card.top - before.card!) <= 1,
        `card ${before.card} → ${afterSwitch.card?.top}`,
      );

      await ev(`(() => {
        const input = document.querySelector('input[placeholder^="Search"]');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'zz');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await sleep(1400);
      const afterSearch = JSON.parse(await ev(MEASURE));
      check(
        "typing in the search does not move the chrome either",
        Math.abs(afterSearch.stats!.bottom - before.stats) <= 1 && Math.abs(afterSearch.tabs!.bottom - before.tabs) <= 1,
        `stats ${before.stats} → ${afterSearch.stats!.bottom}, pills ${before.tabs} → ${afterSearch.tabs!.bottom}`,
      );

      await ev(`(() => {
        const input = document.querySelector('input[placeholder^="Search"]');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await sleep(1200);
      const afterClear = JSON.parse(await ev(MEASURE));
      check(
        "clearing the search restores the list without moving anything",
        Math.abs(afterClear.stats!.bottom - before.stats) <= 1 && (!afterClear.card || Math.abs(afterClear.card.top - before.card!) <= 1),
        JSON.stringify({ stats: afterClear.stats!.bottom, card: afterClear.card?.top, was: before }),
      );
    } else {
      // A wide window scrolls the same way: one column, nothing pinned.
      await ev(`document.querySelector('[data-menu-scroll]').scrollTop = 300`);
      await sleep(900);
      const wide = JSON.parse(await ev(MEASURE));
      check("the wide layout scrolls as one column too", wide.scrollTop === 0 || wide.tabs!.top < first.tabs!.top, `pills ${first.tabs!.top} → ${wide.tabs!.top}`);
      check("nothing is pinned at this width either", wide.pinned === 0, `${wide.pinned} pinned`);
      await ev(`document.querySelector('[data-menu-scroll]').scrollTop = 0`);
      await sleep(900);
      const top = JSON.parse(await ev(MEASURE));
      check(
        "and the layout at the top is unchanged",
        top.card !== null && top.card.top >= top.tabs!.bottom - 1,
        JSON.stringify({ card: top.card?.top, tabsBottom: top.tabs?.bottom }),
      );
    }
  }

  console.log(`\n${pass}/${pass + fail} checks passed${fail ? ` — ${fail} FAILED` : ""}`);
} catch (e) {
  console.log("failed:", (e as Error).message);
} finally {
  chrome.kill();
}
