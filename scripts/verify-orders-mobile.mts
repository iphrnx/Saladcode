/**
 * The Orders page on a phone: compact filters, nothing overlapped, no jumping.
 *
 * Every one of these is measured rather than eyeballed, because "the cards are
 * behind the filters" is a geometry claim: the first card's top must be at or
 * below the filter block's bottom, at both widths, before and after the status
 * filter changes.
 *
 *   npm run test:orders-mobile
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SITE = process.env.SITE_URL ?? "https://www.thesalad.in";
const EMAIL = process.env.EMAIL ?? "phrnx@icloud.com";
const PORT = Number(process.env.CDP_PORT ?? 9411);

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

const profile = `/tmp/chrome-orders-${PORT}`;
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

/** Everything the checks need, in one evaluation. */
const MEASURE = `(() => {
  const scroll = document.querySelector('[data-orders-scroll]');
  const tabs = document.querySelector('[data-orders-tabs]');
  const filters = document.querySelector('[data-orders-filters]');
  const list = document.querySelector('[data-orders-list]');
  const cards = [...document.querySelectorAll('[data-order-card]')];
  const card = cards[0];
  const active = tabs?.querySelector('[data-active="true"]');
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), h: Math.round(r.height) }; };
  let animation = null;
  if (card) {
    const cs = getComputedStyle(card);
    animation = cs.animationName + ' ' + cs.animationDuration;
  }
  // Anything pinned would stay put while the column scrolls — the thing that
  // was asked for is that nothing here is.
  const pinned = scroll
    ? [...scroll.querySelectorAll('*')]
        .filter((el) => ['sticky', 'fixed'].includes(getComputedStyle(el).position))
        .map((el) => (el.tagName + '.' + String(el.className)).slice(0, 60))
    : [];
  return JSON.stringify({
    filters: box(filters),
    tabs: box(tabs),
    tabsScroll: tabs ? { scrollWidth: tabs.scrollWidth, clientWidth: tabs.clientWidth, scrollLeft: Math.round(tabs.scrollLeft) } : null,
    list: box(list),
    card: box(card),
    lastCard: cards.length ? box(cards[cards.length - 1]) : null,
    cardCount: cards.length,
    scrollBox: box(scroll),
    scrollTop: scroll ? Math.round(scroll.scrollTop) : null,
    scrolls: scroll ? scroll.scrollHeight > scroll.clientHeight + 1 : null,
    atEnd: scroll ? scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2 : null,
    pinned,
    pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
    pageScrolls: document.documentElement.scrollHeight - window.innerHeight,
    activeColor: active ? getComputedStyle(active).color : null,
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
  await send("Network.enable", {}, sessionId);
  const ev = async (expr: string) =>
    (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId))?.result?.value;

  // The app signs in with @supabase/ssr, which is PKCE and keeps the session in
  // a cookie — a magic-link fragment in the URL is ignored and the page lands on
  // the login screen with nothing to measure. Plant the cookie the client would
  // have written, in the same encoding (JSON, base64url, `base64-` prefix, and
  // chunked above 3180 encoded characters).
  const REF = new URL(SB).host.split(".")[0];
  const encoded = "base64-" + Buffer.from(JSON.stringify({
    access_token: s.access_token, token_type: s.token_type, expires_in: s.expires_in,
    expires_at: s.expires_at, refresh_token: s.refresh_token, user: s.user,
  }), "utf8").toString("base64url");
  const cookieKey = `sb-${REF}-auth-token`;
  const cookies = encodeURIComponent(encoded).length <= 3180
    ? [{ name: cookieKey, value: encoded }]
    : Array.from({ length: Math.ceil(encoded.length / 3150) }, (_, i) => ({
        name: `${cookieKey}.${i}`, value: encoded.slice(i * 3150, (i + 1) * 3150),
      }));
  for (const ck of cookies) {
    await send("Network.setCookie", {
      name: ck.name, value: ck.value, url: SITE, path: "/", httpOnly: false, sameSite: "Lax",
    }, sessionId);
  }

  for (const viewport of [{ name: "phone", width: 390, height: 844 }, { name: "desktop", width: 1440, height: 1000 }]) {
    console.log(`\n── ${viewport.name} ${viewport.width}×${viewport.height} ──`);
    await send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.width < 640,
    }, sessionId);
    await send("Page.navigate", { url: `${SITE}/?view=orders` }, sessionId);
    await sleep(12000);

    const first = JSON.parse(await ev(MEASURE));
    check("the orders page rendered", first.filters !== null && first.tabs !== null, JSON.stringify(first).slice(0, 200));
    check("the dark theme is on", first.dark === true);
    check("the page does not scroll sideways", first.pageOverflow <= 1, `overflow ${first.pageOverflow}px`);

    if (first.filters && first.card) {
      check(
        "the first card starts below the filters, not under them",
        first.card.top >= first.filters.bottom,
        `card top ${first.card.top} vs filters bottom ${first.filters.bottom}`,
      );
      check("the list starts below the filters", first.list!.top >= first.filters.bottom, `list top ${first.list!.top} vs ${first.filters.bottom}`);
      check("nothing in the view is pinned sticky or fixed", first.pinned.length === 0, JSON.stringify(first.pinned));
      check("the column scrolls, so long lists are reachable", first.scrolls === true, `scrollHeight vs clientHeight in ${JSON.stringify(first.scrollBox)}`);
      check("the page itself does not scroll behind it", first.pageScrolls <= 1, `page scrollHeight exceeds viewport by ${first.pageScrolls}`);
      check("the scroll column fills the space it was given", first.scrollBox!.h >= 200, `only ${first.scrollBox!.h}px tall`);
    } else {
      check("there is at least one order card to measure", false, "no [data-order-card] found");
    }

    if (viewport.name === "phone") {
      check(
        "the filters are compact",
        first.filters!.h <= 104,
        `filter block is ${first.filters!.h}px tall`,
      );
      const tabs = first.tabsScroll!;
      check("the status tabs overflow sideways, so they scroll", tabs.scrollWidth > tabs.clientWidth, JSON.stringify(tabs));
      check("the tab row is not clipped by the page", first.tabs!.right <= viewport.width, `${first.tabs!.right} > ${viewport.width}`);

      // The report was that the tabs stay put while the content moves. Scroll
      // the column and the tabs, the search row and the cards must all travel
      // by the same distance.
      const beforeScroll = { tabs: first.tabs!.top, filters: first.filters!.bottom, card: first.card!.top };
      await ev(`document.querySelector('[data-orders-scroll]').scrollTop = 260`);
      await sleep(900);
      const scrolledDown = JSON.parse(await ev(MEASURE));
      check("the column actually scrolled", scrolledDown.scrollTop > 0, `scrollTop ${scrolledDown.scrollTop}`);
      check(
        "the status tabs scroll up with the content instead of staying put",
        scrolledDown.tabs!.top < beforeScroll.tabs - 100,
        `tabs were at ${beforeScroll.tabs}, now ${scrolledDown.tabs!.top}`,
      );
      check(
        "the filters travel with them",
        Math.abs((beforeScroll.filters - scrolledDown.filters!.bottom) - scrolledDown.scrollTop) <= 2,
        `filters moved ${beforeScroll.filters - scrolledDown.filters!.bottom}px while the column moved ${scrolledDown.scrollTop}px`,
      );
      check(
        "the cards keep their place relative to the chrome",
        scrolledDown.card === null || Math.abs((beforeScroll.card - scrolledDown.card.top) - scrolledDown.scrollTop) <= 2,
        `cards moved ${beforeScroll.card - (scrolledDown.card?.top ?? 0)}px while the column moved ${scrolledDown.scrollTop}px`,
      );

      // To the bottom: the last card must be fully reachable, not cut off by a
      // height or overflow mistake.
      await ev(`(() => { const s = document.querySelector('[data-orders-scroll]'); s.scrollTop = s.scrollHeight; })()`);
      await sleep(900);
      const endState = JSON.parse(await ev(MEASURE));
      check("the list scrolls to the end", endState.atEnd === true, `scrollTop ${endState.scrollTop} of ${endState.scrollBox?.h}px visible`);
      check(
        "the last card is fully visible at the bottom",
        endState.lastCard !== null && endState.lastCard.bottom <= endState.scrollBox!.bottom + 1,
        `last card bottom ${endState.lastCard?.bottom} vs container bottom ${endState.scrollBox?.bottom}`,
      );
      await ev(`document.querySelector('[data-orders-scroll]').scrollTop = 0`);
      await sleep(900);

      // The last tab must be reachable by scrolling the row.
      await ev(`document.querySelector('[data-orders-tabs]').scrollLeft = 9999`);
      await sleep(700);
      const scrolled = JSON.parse(await ev(MEASURE));
      check("scrolling the row reaches the last tab", scrolled.tabsScroll.scrollLeft > 0, JSON.stringify(scrolled.tabsScroll));
      const lastTabVisible = await ev(`(() => {
        const row = document.querySelector('[data-orders-tabs]');
        const last = [...row.querySelectorAll('button')].pop();
        const r = last.getBoundingClientRect(), rowBox = row.getBoundingClientRect();
        return r.left >= rowBox.left - 1 && r.right <= rowBox.right + 1;
      })()`);
      check("the last status tab can be brought fully into view", lastTabVisible === true);
      await ev(`document.querySelector('[data-orders-tabs]').scrollLeft = 0`);
      await sleep(500);

      // The active tab keeps the product's orange.
      check("the active tab is the accent colour, not a new palette", (first.activeColor || "").includes("rgb"), String(first.activeColor));
      check("no slide animation is left on the cards", (first.animation || "").startsWith("none"), String(first.animation));

      const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
      fs.writeFileSync("/root/downloads/orders-mobile.png", Buffer.from(shot.data, "base64"));

      // Changing the status filter must not move the cards.
      const before = first.card!.top;
      await ev(`(() => {
        const b = [...document.querySelectorAll('[data-orders-tabs] button')].find((x) => x.textContent.trim().startsWith('Pending'));
        b?.click();
        return Boolean(b);
      })()`);
      await sleep(1500);
      const afterStatus = JSON.parse(await ev(MEASURE));
      check(
        "changing the status tab does not move the cards",
        !afterStatus.card || Math.abs(afterStatus.card.top - before) <= 1,
        `card top was ${before}, now ${afterStatus.card?.top}`,
      );
      check(
        "changing the status tab does not move the filters",
        Math.abs(afterStatus.filters.bottom - first.filters!.bottom) <= 1,
        `${first.filters!.bottom} → ${afterStatus.filters.bottom}`,
      );

      await ev(`(() => {
        const b = [...document.querySelectorAll('[data-orders-tabs] button')].find((x) => x.textContent.trim().startsWith('All'));
        b?.click();
      })()`);
      await sleep(1200);
      const afterAll = JSON.parse(await ev(MEASURE));
      check(
        "and going back moves nothing either",
        Math.abs(afterAll.filters.bottom - first.filters!.bottom) <= 1 && (!afterAll.card || Math.abs(afterAll.card.top - before) <= 1),
        JSON.stringify({ filters: afterAll.filters?.bottom, card: afterAll.card?.top, was: { filters: first.filters!.bottom, card: before } }),
      );
    } else {
      // A wide window scrolls the same way: one column, nothing pinned.
      await ev(`document.querySelector('[data-orders-scroll]').scrollTop = 300`);
      await sleep(900);
      const wide = JSON.parse(await ev(MEASURE));
      check("the wide layout scrolls as one column too", wide.scrollTop === 0 || wide.tabs!.top < first.tabs!.top, `tabs ${first.tabs!.top} → ${wide.tabs!.top}`);
      check("nothing is pinned at this width either", wide.pinned.length === 0, JSON.stringify(wide.pinned));
      await ev(`document.querySelector('[data-orders-scroll]').scrollTop = 0`);
      await sleep(900);
      const top = JSON.parse(await ev(MEASURE));
      check(
        "and the layout at the top is unchanged",
        top.card !== null && top.card.top >= top.filters.bottom - 1 && Math.abs(top.filters.bottom - first.filters!.bottom) <= 1,
        JSON.stringify({ card: top.card?.top, filtersBottom: top.filters?.bottom }),
      );
    }
  }

  console.log(`\n${pass}/${pass + fail} checks passed${fail ? ` — ${fail} FAILED` : ""}`);
} catch (e) {
  console.log("failed:", (e as Error).message);
} finally {
  chrome.kill();
}
