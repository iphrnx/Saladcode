/**
 * The Roles page scroll contract, verified with real touch gestures.
 *
 * Mobile: the whole page scrolls as one — title, tab toggle, Create Role,
 * stats, pills, permission sections — and ONLY the role pills dock under
 * the shell header once they reach it. No inner scroll container in the
 * detail card. Desktop keeps the bounded layout with its own scrollers
 * and the scroll-collapse header.
 *
 * Refuses to pass unless, on a real browser:
 *   - a TOUCH SWIPE on the permission area scrolls the page (not script),
 *   - the header/title/stats scroll away and the pills dock at the header's
 *     bottom edge and stay there across the whole scroll range,
 *   - the detail card has NO inner scroller on mobile (overflow visible),
 *   - a horizontal swipe on the pills scrolls the pills, not the page,
 *   - no permission card paints over the docked pill band,
 *   - switching roles from the docked pills works,
 *   - desktop: detail keeps its inner scroller, collapse still fires.
 *
 *   npm run test:roles-sticky                     (localhost:3000)
 *   BASE=https://www.thesalad.in npm run test:roles-sticky  (live)
 *   MOBILE=0 desktop only, MOBILE=1 mobile only.
 */
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!; const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!; const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BASE = process.env.BASE ?? "http://localhost:3000";
const PORT = Number(process.env.CDP_PORT ?? 9591);
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

const chrome = spawn("google-chrome", ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/chrome-rstk-${PORT}-${Date.now()}`, "--no-sandbox", "--disable-gpu", "about:blank"], { stdio: "ignore" });
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

const pill = (name: string) => `[...document.querySelectorAll('button.rounded-full')].find(b=>b.offsetParent&&b.textContent.trim().startsWith('${name}'))`;
const stripOf = `(()=>{const p=${pill("Owner")};return p?p.parentElement.parentElement:null})()`;
const rootOf = `(()=>{const st=${stripOf};return st?st.closest('.h-full'):null})()`;

/** A real vertical swipe: touchStart, a series of touchMove, touchEnd. */
async function swipeY(sid: string, x: number, y0: number, y1: number, steps = 12) {
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: y0, id: 1 }] }, sid);
  for (let i = 1; i <= steps; i++) {
    const y = y0 + ((y1 - y0) * i) / steps;
    await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y, id: 1 }] }, sid);
    await sleep(16);
  }
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, sid);
}
async function swipeX(sid: string, y: number, x0: number, x1: number, steps = 10) {
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y, id: 1 }] }, sid);
  for (let i = 1; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps;
    await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y, id: 1 }] }, sid);
    await sleep(16);
  }
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, sid);
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
  await send("Page.navigate", { url: `${BASE}/?view=roles` }, sid);
  await sleep(9000);
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>/^Accept All$/.test((b.textContent||'').trim()));if(b)b.click();return 1})()`); await sleep(600);

  if (mobile) {
    const loaded = await ev(`(()=>{const st=${stripOf};const root=${rootOf};return {pills:!!st, scrollable: root?root.scrollHeight-root.clientHeight:-1}})()`);
    check("roles page loaded, page scrolls", !!loaded?.pills && Number(loaded?.scrollable) > 200, JSON.stringify(loaded));
    // Flex-shrink regression: in an overflow-auto flex column a child with
    // its own overflow has a zero auto minimum and gets shrunk to nothing.
    const statsH = await ev(`(()=>{const l=[...document.querySelectorAll('p')].find(p=>p.offsetParent&&p.textContent.trim()==='Total Roles');return l?Math.round(l.closest('.rounded-2xl').parentElement.getBoundingClientRect().height):0})()`);
    check("stats grid renders at full height at page top", Number(statsH) > 100, `h=${statsH}`);
  } else {
    const loaded = await ev(`(()=>{
      const items=[...document.querySelectorAll('button.rounded-xl')].filter(b=>b.offsetParent).length;
      const sc=[...document.querySelectorAll('[class*="overflow-y"]')].filter(e=>e.offsetParent&&getComputedStyle(e).overflowY==='auto'&&e.scrollHeight-e.clientHeight>50);
      return {items, scrollers: sc.length};
    })()`);
    check("roles page loaded (sidebar + bounded scrollers)", Number(loaded?.items) > 0 && Number(loaded?.scrollers) >= 1, JSON.stringify(loaded));
  }

  if (mobile) {
    // ── touch swipe scrolls the page ──
    const st0 = await ev(`(()=>{const r=${rootOf};return Math.round(r.scrollTop)})()`);
    await swipeY(sid, 195, 620, 240);
    await sleep(700);
    const st1 = await ev(`(()=>{const r=${rootOf};return Math.round(r.scrollTop)})()`);
    check("touch swipe on permissions scrolls the page", Number(st1) > Number(st0) + 100, `scrollTop ${st0} -> ${st1}`);
    // momentum: keeps moving after release (informational)
    const m0 = await ev(`(()=>{const r=${rootOf};return r.scrollTop})()`);
    await sleep(600);
    const m1 = await ev(`(()=>{const r=${rootOf};return r.scrollTop})()`);
    console.log(`  info  momentum after release: ${Math.round(Number(m0))} -> ${Math.round(Number(m1))}`);

    // ── everything above the pills scrolls away; pills dock ──
    const hdrBottom = await ev(`(()=>{const h=document.querySelector('header');return h?Math.round(h.getBoundingClientRect().bottom):56})()`);
    let docked = true; let aboveGone = true; let detail = "";
    for (const frac of [0.4, 0.7, 1]) {
      await ev(`(()=>{const r=${rootOf};r.scrollTop=(r.scrollHeight-r.clientHeight)*${frac};return 1})()`); await sleep(400);
      const now = await ev(`(()=>{
        const st=${stripOf}; const r=${rootOf};
        const h2=document.querySelector('h2');
        const stats=document.querySelector('.grid.grid-cols-2');
        return {stripTop: Math.round(st.getBoundingClientRect().top),
          h2Bottom: h2?Math.round(h2.getBoundingClientRect().bottom):null,
          statsBottom: stats?Math.round(stats.getBoundingClientRect().bottom):null};
      })()`);
      if (Math.abs(Number(now.stripTop) - Number(hdrBottom)) > 1) { docked = false; detail = `frac=${frac} stripTop=${now.stripTop} hdr=${hdrBottom}`; }
      if (Number(now.h2Bottom) > Number(hdrBottom) || Number(now.statsBottom) > Number(hdrBottom)) aboveGone = false;
    }
    check("pills dock at header bottom and stay", docked, detail);
    check("title + stats scroll away above the pills", aboveGone);

    // ── no inner scroller inside the detail card ──
    const inner = await ev(`(()=>{
      const st=${stripOf};
      const detail=st.parentElement.nextElementSibling || st.parentElement.parentElement.querySelector('.rounded-2xl');
      const scrollers=[...document.querySelectorAll('.rounded-2xl .overflow-y-auto, .rounded-2xl [class*="overflow-y"]')].filter(e=>e.offsetParent);
      const cs = scrollers.map(e=>getComputedStyle(e).overflowY + ':' + (e.scrollHeight-e.clientHeight));
      return cs;
    })()`);
    check("no inner scroll container in the detail card", (inner as any[]).every((c: string) => c.startsWith("visible")), JSON.stringify(inner));

    // ── no card paints over the docked band ──
    const peek = await ev(`(()=>{
      const st=${stripOf}; const p=st.getBoundingClientRect();
      for (let x=p.left+8; x<p.right-8; x+=24) {
        const el=document.elementFromPoint(x, p.top+4);
        if (el && el.closest && el.closest('.rounded-2xl') && !st.contains(el)) return 'card@'+Math.round(x);
      }
      return 'clean';
    })()`);
    check("no card paints over the docked pill band", peek === "clean", String(peek));

    // ── horizontal swipe on the pills scrolls the pills, not the page ──
    const before0 = await ev(`(()=>{const st=${stripOf};const r=${rootOf};return {sl: st.scrollLeft, st2: r.scrollTop}})()`);
    const band = await ev(`(()=>{const st=${stripOf};const r=st.getBoundingClientRect();return Math.round(r.top+r.height/2)})()`);
    await swipeX(sid, Number(band), 340, 40);
    await sleep(600);
    const after0 = await ev(`(()=>{const st=${stripOf};const r=${rootOf};return {sl: st.scrollLeft, st2: r.scrollTop, fits: st.scrollWidth<=st.clientWidth}})()`);
    if ((after0 as any).fits) console.log("  skip  pills fit without horizontal overflow");
    else check("horizontal swipe scrolls pills, page stays", Number(after0.sl) > 0 && after0.st2 === before0.st2, `scrollLeft ${before0.sl}->${after0.sl} page ${before0.st2}->${after0.st2}`);

    // ── switching roles from the docked pills works ──
    await ev(`(()=>{const st=${stripOf};st.scrollLeft=0;return 1})()`); await sleep(300);
    const mgr = await ev(`(()=>{const p=${pill("Manager")};if(!p)return null;const r=p.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    if (!mgr) check("role switch works from docked pills", false, "Manager pill not found");
    else {
      await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: mgr.x, y: mgr.y }] }, sid);
      await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, sid);
      await sleep(800);
      const after = await ev(`(()=>{
        const h=[...document.querySelectorAll('h3')].find(h=>h.offsetParent&&h.className.includes('leading-tight'));
        const st=${stripOf}; const r=${rootOf};
        return {name: h?h.textContent.trim():null, stripTop: Math.round(st.getBoundingClientRect().top), st2: r.scrollTop};
      })()`);
      check("role switch works from docked pills", after.name === "Manager", `name=${after.name}`);
      check("page scroll undisturbed by role switch", Math.abs(Number(after.st2) - Number(after0.st2)) <= 2, `${after0.st2} -> ${after.st2}`);
      const own = await ev(`(()=>{const p=${pill("Owner")};if(!p)return null;const r=p.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      if (own) { await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: own.x, y: own.y }] }, sid); await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, sid); await sleep(400); }
    }
  } else {
    // ── desktop: bounded layout intact ──
    const desk = await ev(`(()=>{
      const grid=document.querySelector('.lg\\\\:grid');
      const detail=[...document.querySelectorAll('[class*="overflow-y"]')].filter(e=>e.offsetParent&&getComputedStyle(e).overflowY==='auto'&&e.scrollHeight-e.clientHeight>50);
      return {grid: !!grid, scrollers: detail.length};
    })()`);
    check("desktop: sidebar grid + inner scrollers intact", desk.grid === true && Number(desk.scrollers) >= 1, JSON.stringify(desk));
    const h2h0 = await ev(`(()=>Math.round(document.querySelector('h2').getBoundingClientRect().height))()`);
    await ev(`(()=>{const sc=[...document.querySelectorAll('[class*="overflow-y"]')].filter(e=>e.offsetParent&&getComputedStyle(e).overflowY==='auto').sort((a,b)=>(b.scrollHeight-b.clientHeight)-(a.scrollHeight-a.clientHeight))[0];if(sc)sc.scrollTop=300;return 1})()`); await sleep(600);
    const h2h1 = await ev(`(()=>Math.round(document.querySelector('h2').getBoundingClientRect().height))()`);
    const statsH = await ev(`(()=>{const g=document.querySelector('.grid.grid-cols-2');return g?Math.round(g.getBoundingClientRect().height):0})()`);
    check("desktop: header collapse still fires on scroll", Number(statsH) === 0 || Number(h2h1) < Number(h2h0), `h2 ${h2h0}->${h2h1} statsH=${statsH}`);
  }
}

if (WHICH === "1" || WHICH === "both") await run("MOBILE", 390, true);
if (WHICH === "0" || WHICH === "both") await run("DESKTOP", 1440, false);
check("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));
console.log(`\n  ${pass} passed, ${fail} failed\n`);
chrome.kill(); process.exit(fail ? 1 : 0);
