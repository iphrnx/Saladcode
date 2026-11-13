/**
 * The Orders filter bar, watched while the list scrolls and updates.
 *
 * On mobile the status tabs + search/type box are sticky under the shell
 * header. This drives a real browser and refuses to pass unless:
 *   - the bar stays pinned at the header's bottom edge through the full
 *     scroll range, with no card ever painting over it,
 *   - the tabs' own horizontal scroll still works while pinned,
 *   - pinning/unpinning never shifts the cards (no layout jump),
 *   - a REAL status update (Pending -> Preparing through the card's own
 *     action button) preserves the expanded card and the scroll position,
 *     and is restored afterwards (Preparing -> Pending via the API),
 *   - on desktop nothing changed: the bar scrolls away with the stats.
 *
 *   npm run test:orders-sticky                     (localhost:3000)
 *   BASE=https://www.thesalad.in npm run test:orders-sticky  (live)
 *   MOBILE=0 desktop only, MOBILE=1 mobile only.
 *   LOGIN_EMAIL=... — needs an account with orders (phrnxs@gmail.com).
 */
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!; const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!; const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BASE = process.env.BASE ?? "http://localhost:3000";
const PORT = Number(process.env.CDP_PORT ?? 9580);
const WHICH = process.env.MOBILE ?? "both";
const LOGIN = process.env.LOGIN_EMAIL ?? "phrnxs@gmail.com";

let pass = 0, fail = 0;
const check = (l: string, ok: boolean, d?: string) => { if (ok) pass++; else fail++; console.log(`  ${ok ? "ok  " : "FAIL"}  ${l}${d && !ok ? ` [${d}]` : ""}`); };

const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });
const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: LOGIN });
const cc = createClient(SB, ANON, { auth: { persistSession: false } });
const { data: session } = await cc.auth.verifyOtp({ token_hash: (link!.properties as any).hashtoken ?? (link!.properties as any).hashed_token, type: "magiclink" });
const s = session!.session!;
const ref = new URL(SB).hostname.split(".")[0]; const KEY = `sb-${ref}-auth-token`;
const so = { access_token: s.access_token, refresh_token: s.refresh_token, token_type: s.token_type, expires_in: s.expires_in, expires_at: s.expires_at, user: s.user };
const val = "base64-" + Buffer.from(JSON.stringify(so), "utf8").toString("base64url");

const chrome = spawn("google-chrome", ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/chrome-ostk-${PORT}-${Date.now()}`, "--no-sandbox", "--disable-gpu", "about:blank"], { stdio: "ignore" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let ws: WebSocket | null = null; let id = 0; const pending = new Map<number, (v: any) => void>();
const consoleErrors: string[] = [];
const send = (m: string, p: any = {}, sid?: string) => new Promise<any>((res) => { const i = ++id; pending.set(i, res); ws!.send(JSON.stringify({ id: i, method: m, params: p, ...(sid ? { sessionId: sid } : {}) })); });

let version: any = null; for (let i = 0; i < 40; i++) { try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(250); } }
ws = new WebSocket(version.webSocketDebuggerUrl) as unknown as WebSocket; await new Promise((r) => (ws!.onopen = r));
ws.onmessage = (e: any) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result); pending.delete(m.id); }
  else if (m.method === "Runtime.exceptionThrown") consoleErrors.push(m.params.exceptionDetails?.exception?.description?.split("\n")[0] || "exception");
  else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") consoleErrors.push(String(m.params.args?.[0]?.value || "console.error").slice(0, 120));
};

async function tap(sid: string, x: number, y: number, mobile: boolean) {
  if (mobile) {
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] }, sid);
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, sid);
  } else {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, sid);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, sid);
  }
}

async function run(label: string, width: number, mobile: boolean) {
  console.log(`\n=== ${label} ${width} ===`);
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: sid } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sid); await send("Runtime.enable", {}, sid);
  const ev = async (x: string) => (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }, sid))?.result?.value;
  await send("Emulation.setDeviceMetricsOverride", { width, height: mobile ? 844 : 900, deviceScaleFactor: mobile ? 2 : 1, mobile }, sid);
  if (val.length <= 3180) await send("Network.setCookie", { name: KEY, value: val, url: BASE, path: "/", sameSite: "Lax" }, sid);
  else for (let i = 0, o = 0; o < val.length; i++, o += 3180) await send("Network.setCookie", { name: `${KEY}.${i}`, value: val.slice(o, o + 3180), url: BASE, path: "/", sameSite: "Lax" }, sid);
  await send("Page.navigate", { url: `${BASE}/?view=orders` }, sid);
  await sleep(9000);
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>/^Accept All$/.test((b.textContent||'').trim()));if(b)b.click();return 1})()`); await sleep(600);

  const filters = `document.querySelector('[data-orders-filters]')`;
  const scroller = `document.querySelector('[data-orders-scroll]')`;
  const top = async () => ev(`(()=>Math.round(${filters}.getBoundingClientRect().top))()`);

  const loaded = await ev(`(()=>!!document.querySelector('[data-orders-filters]') && document.querySelectorAll('[data-order-card]').length)()`);
  check("orders loaded with filter bar", Number(loaded) > 0, `cards=${loaded}`);

  if (!mobile) {
    const t0 = await top();
    await ev(`(()=>{${scroller}.scrollTop = ${scroller}.scrollHeight;return 1})()`); await sleep(400);
    const t = await top();
    const sc = await ev(`document.querySelector('[data-orders-scroll]').scrollTop`);
    // Non-sticky signature: the bar moves by exactly the scroll amount.
    check("desktop: filter bar scrolls away (not sticky)", Number(sc) > 0 && Math.abs((Number(t0) - Number(t)) - Number(sc)) <= 2, `before=${t0} after=${t} scrollTop=${sc}`);
    return;
  }

  const before = await top();
  check("filter bar starts below header", Number(before) > 56, `top=${before}`);

  // The first card's flow position must be identical before and after pinning.
  const cardPos = `(()=>{const c=document.querySelector('[data-order-card]');const sc=${scroller};return c?Math.round(c.getBoundingClientRect().top + sc.scrollTop):-1})()`;
  const pos0 = await ev(cardPos);

  await ev(`(()=>{${scroller}.scrollTop = 400;return 1})()`); await sleep(300);
  const mid = await top();
  await ev(`(()=>{${scroller}.scrollTop = 1500;return 1})()`); await sleep(300);
  const deep = await top();
  await ev(`(()=>{${scroller}.scrollTop = ${scroller}.scrollHeight;return 1})()`); await sleep(400);
  const bottom = await top();
  const hdrBottom = await ev(`(()=>{const h=document.querySelector('header');return h?Math.round(h.getBoundingClientRect().bottom):56})()`);
  check("bar pinned at header bottom through full scroll", mid === deep && deep === bottom && Math.abs(Number(bottom) - Number(hdrBottom)) <= 1, `mid=${mid} deep=${deep} bottom=${bottom} hdr=${hdrBottom}`);

  const peek = await ev(`(()=>{
    const p = ${filters}.getBoundingClientRect();
    for (let x = p.left + 8; x < p.right - 8; x += 24) {
      const el = document.elementFromPoint(x, p.top + 4);
      if (el && el.closest && el.closest('[data-order-card]')) return 'card@'+Math.round(x);
    }
    return 'clean';
  })()`);
  check("no card paints over the pinned bar", peek === "clean", String(peek));

  const hscroll = await ev(`(()=>{const t=document.querySelector('[data-orders-tabs]');if(t.scrollWidth<=t.clientWidth)return 'fits';t.scrollLeft = 400;return Math.round(t.scrollLeft)})()`);
  if (hscroll === 'fits') console.log("  skip  tabs fit without overflow");
  else check("tabs still scroll horizontally while pinned", Number(hscroll) > 0, `scrollLeft=${hscroll}`);
  await ev(`(()=>{document.querySelector('[data-orders-tabs]').scrollLeft = 0;return 1})()`);

  // ── state preservation across a REAL status update ──
  // Expand the first Pending card, flip it to Preparing with its own action
  // button, and require the card to stay expanded with the scroll unmoved.
  await ev(`(()=>{${scroller}.scrollTop = 0;return 1})()`); await sleep(500);
  const target = await ev(`(()=>{
    const cards=[...document.querySelectorAll('[data-order-card]')];
    const i=cards.findIndex(c=>/Pending/.test(c.innerText));
    if(i<0)return null;
    const num=(cards[i].innerText.match(/#(\\d+)/)||[])[1];
    const hdr=cards[i].querySelector('button');
    const r=hdr.getBoundingClientRect();
    return {i,num,x:r.x+r.width/2,y:r.y+r.height/2};
  })()`);
  if (!target) {
    check("status update preserves expansion + scroll", false, "no Pending card found");
  } else {
    await tap(sid, target.x, target.y, true); await sleep(700); // expand
    const expandedBefore = await ev(`(()=>{const c=document.querySelectorAll('[data-order-card]')[${target.i}];return !!c.querySelector('svg.lucide-chevron-down')})()`);
    const scrollBefore = await ev(`document.querySelector('[data-orders-scroll]').scrollTop`);
    const actionBtn = await ev(`(()=>{
      const c=document.querySelectorAll('[data-order-card]')[${target.i}];
      const b=[...c.querySelectorAll('button')].find(b=>b.className.includes('flex-1'));
      if(!b)return null;const r=b.getBoundingClientRect();
      return {x:r.x+r.width/2,y:r.y+r.height/2,label:(b.textContent||'').trim()};
    })()`);
    if (!actionBtn) check("status update preserves expansion + scroll", false, "no action button");
    else {
      await tap(sid, actionBtn.x, actionBtn.y, true);
      // wait for the badge to read Preparing (edge call + refresh)
      let badge = "";
      for (let i = 0; i < 24; i++) {
        await sleep(500);
        badge = await ev(`(()=>{const c=[...document.querySelectorAll('[data-order-card]')].find(c=>c.innerText.includes('#${target.num}'));return c?(c.innerText.match(/Pending|Preparing|Ready|Completed|Cancelled/)||[''])[0]:''})()`);
        if (badge === "Preparing") break;
      }
      const after = await ev(`(()=>{
        const c=[...document.querySelectorAll('[data-order-card]')].find(c=>c.innerText.includes('#${target.num}'));
        return {exp: c ? !!c.querySelector('svg.lucide-chevron-down') : null, sc: document.querySelector('[data-orders-scroll]').scrollTop};
      })()`);
      check("status flipped Pending -> Preparing", badge === "Preparing", `badge=${badge} via "${actionBtn.label}"`);
      check("card still expanded after status update", expandedBefore === true && after.exp === true, `before=${expandedBefore} after=${after.exp}`);
      check("scroll position preserved during status update", Math.abs(Number(after.sc) - Number(scrollBefore)) <= 4, `before=${scrollBefore} after=${after.sc}`);

      // restore: Preparing -> Pending via the REST API (service key)
      const restore = await fetch(`${SB}/rest/v1/orders?tenant_id=eq.00d6c78f-554c-4b1a-8e66-96d5f344e73c&order_number=eq.${encodeURIComponent(target.num)}`, {
        method: "PATCH",
        headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ status: "PENDING" }),
      });
      let back = "";
      for (let i = 0; i < 24; i++) {
        await sleep(500);
        back = await ev(`(()=>{const c=[...document.querySelectorAll('[data-order-card]')].find(c=>c.innerText.includes('#${target.num}'));return c?(c.innerText.match(/Pending|Preparing|Ready|Completed|Cancelled/)||[''])[0]:''})()`);
        if (back === "Pending") break;
      }
      check("order restored to Pending", restore.ok && back === "Pending", `http=${restore.status} badge=${back}`);
      // collapse the card again to leave the UI as found
      await ev(`(()=>{const c=[...document.querySelectorAll('[data-order-card]')].find(c=>c.innerText.includes('#${target.num}'));if(c&&c.querySelector('svg.lucide-chevron-down'))c.querySelector('button').click();return 1})()`);
    }
  }

  // Pinning must not shift the cards: flow position identical to the start.
  await ev(`(()=>{${scroller}.scrollTop = 0;return 1})()`); await sleep(500);
  const pos1 = await ev(cardPos);
  check("no layout shift from pinning", pos0 === pos1, `before=${pos0} after=${pos1}`);
  const backTop = await top();
  check("bar unpins when scrolled back to top", Number(backTop) > 56, `top=${backTop}`);
}

if (WHICH === "1" || WHICH === "both") await run("MOBILE", 390, true);
if (WHICH === "0" || WHICH === "both") await run("DESKTOP", 1440, false);
check("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));
console.log(`\n  ${pass} passed, ${fail} failed\n`);
chrome.kill(); process.exit(fail ? 1 : 0);
