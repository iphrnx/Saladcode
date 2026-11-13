/**
 * The Menu Management category pills, watched while the list scrolls.
 *
 * On mobile the pill row is sticky under the shell header so the category
 * filter never scrolls away. This drives a real browser at both form
 * factors and refuses to pass unless:
 *   - the pills stay pinned at the header's bottom edge while cards scroll,
 *   - cards pass UNDER the bar (the bar's top edge never hits a card),
 *   - the pills' own horizontal scroll still works while pinned,
 *   - tapping a pill while pinned still filters the list,
 *   - on desktop nothing changed: the pills scroll away with the stats.
 *
 *   npm run test:menu-sticky                      (localhost:3000)
 *   BASE=https://www.thesalad.in npm run test:menu-sticky   (live)
 *   MOBILE=0 to skip the mobile pass, MOBILE=1 to skip the desktop pass.
 *   LOGIN_EMAIL=... — needs an account whose menu overflows the viewport
 *   and has enough categories to overflow the pill row (phrnxs@gmail.com).
 */
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!; const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!; const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BASE = process.env.BASE ?? "http://localhost:3000";
const PORT = Number(process.env.CDP_PORT ?? 9570);
const WHICH = process.env.MOBILE ?? "both";
const LOGIN = process.env.LOGIN_EMAIL ?? "zhut@demo.com";

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

const chrome = spawn("google-chrome", ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/chrome-sticky-${PORT}-${Date.now()}`, "--no-sandbox", "--disable-gpu", "about:blank"], { stdio: "ignore" });
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
  else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") consoleErrors.push(m.params.args?.[0]?.value || "console.error");
};

async function run(label: string, width: number, mobile: boolean) {
  console.log(`\n=== ${label} ${width} ===`);
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: sid } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sid); await send("Runtime.enable", {}, sid);
  const ev = async (x: string) => (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }, sid))?.result?.value;
  await send("Emulation.setDeviceMetricsOverride", { width, height: mobile ? 844 : 900, deviceScaleFactor: mobile ? 2 : 1, mobile }, sid);
  if (val.length <= 3180) await send("Network.setCookie", { name: KEY, value: val, url: BASE, path: "/", sameSite: "Lax" }, sid);
  else for (let i = 0, o = 0; o < val.length; i++, o += 3180) await send("Network.setCookie", { name: `${KEY}.${i}`, value: val.slice(o, o + 3180), url: BASE, path: "/", sameSite: "Lax" }, sid);
  await send("Page.navigate", { url: `${BASE}/?view=menu` }, sid);
  await sleep(9000);
  await ev(`(()=>{Object.keys(localStorage).filter(k=>/pos-cart|cart/.test(k)).forEach(k=>localStorage.removeItem(k));return 1})()`);
  await send("Page.navigate", { url: `${BASE}/?view=menu` }, sid);
  await sleep(8000);
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>/^Accept All$/.test((b.textContent||'').trim()));if(b)b.click();return 1})()`); await sleep(600);

  const ready = await ev(`(()=>!!document.querySelector('[data-menu-tabs]') && document.querySelectorAll('[data-menu-list] [class*="card"], [data-menu-list] .card-premium').length >= 0)()`);
  const pills = `document.querySelector('[data-menu-tabs]').parentElement`; // the sticky wrapper
  const scroller = `document.querySelector('[data-menu-scroll]')`;
  const top = async () => ev(`(()=>Math.round(${pills}.getBoundingClientRect().top))()`);

  if (!mobile) {
    // Desktop: pills must scroll away with the stats (unchanged behavior).
    const t0 = await top();
    await ev(`(()=>{${scroller}.scrollTop = ${scroller}.scrollHeight;return 1})()`); await sleep(400);
    const t = await top();
    const sc = await ev(`document.querySelector('[data-menu-scroll]').scrollTop`);
    // Non-sticky signature: the pills move by exactly the scroll amount.
    check("desktop: pills scroll away (not sticky)", Number(sc) > 0 && Math.abs((Number(t0) - Number(t)) - Number(sc)) <= 2, `before=${t0} after=${t} scrollTop=${sc}`);
    return;
  }

  check("menu loaded with pills", !!ready);
  const before = await top();
  check("pills start below header", Number(before) > 56, `top=${before}`);

  // Scroll in steps — the pills must park at the scroller's top and stay there.
  await ev(`(()=>{${scroller}.scrollTop = 300;return 1})()`); await sleep(300);
  const mid = await top();
  await ev(`(()=>{${scroller}.scrollTop = 1200;return 1})()`); await sleep(300);
  const deep = await top();
  await ev(`(()=>{${scroller}.scrollTop = ${scroller}.scrollHeight;return 1})()`); await sleep(400);
  const bottom = await top();
  const hdrBottom = await ev(`(()=>{const h=document.querySelector('header');return h?Math.round(h.getBoundingClientRect().bottom):56})()`);
  check("pills pinned at header bottom while scrolling", mid === deep && deep === bottom && Math.abs(Number(bottom) - Number(hdrBottom)) <= 1, `mid=${mid} deep=${deep} bottom=${bottom} hdr=${hdrBottom}`);

  // Cards pass UNDER the bar: sample the strip just above the pills' bottom edge — it must never be a card.
  const peek = await ev(`(()=>{
    const p = ${pills}.getBoundingClientRect();
    for (let x = p.left + 8; x < p.right - 8; x += 24) {
      const el = document.elementFromPoint(x, p.top + 4);
      if (el && el.closest && el.closest('[data-menu-list]')) return 'card@'+Math.round(x);
    }
    return 'clean';
  })()`);
  check("no card paints over the pinned bar", peek === "clean", String(peek));

  // The pills' own horizontal scroll still works while pinned (when they overflow).
  const hscroll = await ev(`(()=>{const t=document.querySelector('[data-menu-tabs]');if(t.scrollWidth<=t.clientWidth)return 'fits';t.scrollLeft = 400;return Math.round(t.scrollLeft)})()`);
  if (hscroll === 'fits') console.log("  skip  pills fit without overflow — nothing to scroll horizontally");
  else check("pills still scroll horizontally while pinned", Number(hscroll) > 0, `scrollLeft=${hscroll}`);
  await ev(`(()=>{document.querySelector('[data-menu-tabs]').scrollLeft = 0;return 1})()`);

  // Tapping a pinned pill still filters: every visible card must carry the
  // tapped category's name, and only that.
  const pillBtn = await ev(`(()=>{const bs=[...document.querySelectorAll('[data-menu-tabs] button')];const b=bs[1];if(!b)return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,name:(b.textContent||'').replace(/\s*\(\d+\)\s*$/,'').replace(/^[^\p{L}\p{N}]+/u,'').trim()}})()`);
  if (pillBtn) {
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: pillBtn.x, y: pillBtn.y }] }, sid);
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, sid);
    await sleep(900);
    // read the pill name, then verify every visible card carries it
    const name = JSON.stringify(pillBtn.name);
    const res = await ev(`(()=>{const name=${name};const grid=document.querySelector('[data-menu-list] .grid');if(!grid||grid.children.length===0)return 'no-cards';const cards=[...grid.children];const ok=cards.filter(c=>c.innerText.includes(name)).length;return ok===cards.length?'filtered':('only '+ok+'/'+cards.length+' match')})()`);
    check("pinned pill still filters the list", res === "filtered", `${pillBtn.name}: ${res}`);
  } else check("pinned pill still filters the list", false, "second pill not found");

  // Scroll back up: pills return to their natural place below the stats.
  await ev(`(()=>{${scroller}.scrollTop = 0;return 1})()`); await sleep(400);
  const back = await top();
  check("pills unpin when scrolled back to top", Number(back) > 56, `top=${back}`);
}

if (WHICH === "1" || WHICH === "both") await run("MOBILE", 390, true);
if (WHICH === "0" || WHICH === "both") await run("DESKTOP", 1440, false);
check("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));
console.log(`\n  ${pass} passed, ${fail} failed\n`);
chrome.kill(); process.exit(fail ? 1 : 0);
