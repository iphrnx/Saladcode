import { spawn } from "node:child_process";
const PORT = 9921;
const SITE = process.env.SITE ?? "https://www.thesalad.in";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn("google-chrome", ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/chrome-fl-${Date.now()}`, "--no-sandbox", "--disable-gpu", "--window-size=1400,900", "about:blank"], { stdio: "ignore" });
let ws: WebSocket; let id = 0; const pend = new Map<number, any>();
const send = (m: string, p: any = {}, s2?: string) => new Promise<any>((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p, ...(s2 ? { sessionId: s2 } : {}) })); });
const evalv = async (sid: string, e: string) => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }, sid)).result?.value;
const now = () => Date.now();
try {
  let v: any = null;
  for (let i = 0; i < 40; i++) { try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(250); } }
  ws = new WebSocket(v.webSocketDebuggerUrl) as any; await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (e: any) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
  const { targetId } = await send("Target.createTarget", { url: `${SITE}/?view=login` });
  const { sessionId: sid } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, sid); await send("Network.enable", {}, sid); await send("Page.enable", {}, sid);
  await sleep(7000);

  const type = async (sel: string, val: string) => {
    const box = await evalv(sid, `(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.focus(); el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2}) })()`);
    const { x, y } = JSON.parse(String(box));
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, sid);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, sid);
    await evalv(sid, `(() => { const el = document.querySelector(${JSON.stringify(sel)}); const s = Object.getOwnPropertyDescriptor(el.constructor.prototype,'value').set; s.call(el, ${JSON.stringify(val)}); el.dispatchEvent(new Event('input',{bubbles:true})); return 1 })()`);
  };
  const clickSignIn = async () => {
    const box = await evalv(sid, `(() => { const b = [...document.querySelectorAll('button[type=submit]')].find(b => /^sign in$/i.test(b.textContent.trim())); const r = b.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2}) })()`);
    const { x, y } = JSON.parse(String(box));
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, sid);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, sid);
  };

  await type("#email", "zhut@demo.com");
  await type("#password", "123456");
  const t0 = now();
  await clickSignIn();

  const seen: string[] = [];
  let dashboardAt: number | null = null, urlAt: number | null = null;
  for (let i = 0; i < 150; i++) {
    // A client-side route change swaps the execution context; a read taken
    // mid-swap comes back undefined, which simply means "not yet".
    let p: any = null;
    try {
      const s = await evalv(sid, `JSON.stringify({ url: location.href, body: document.body.innerText.slice(0, 4000) })`);
      if (s) p = JSON.parse(String(s));
    } catch { p = null; }
    if (!p) { await sleep(150); continue; }
    if (urlAt === null && p.url.includes("view=dashboard")) urlAt = now();
    const ready = !p.body.includes("Loading your restaurant") && /ACTIVE SESSIONS|Point of Sale|Tables|Today/.test(p.body);
    if (ready) { dashboardAt = now(); seen.push(`+${now() - t0}ms dashboard`); break; }
    if (p.body.includes("Sign In") && /invalid|incorrect|error/i.test(p.body) && i > 12) { seen.push("login error: " + p.body.slice(0, 200)); break; }
    await sleep(200);
  }
  console.log("url changed to dashboard at:", urlAt ? `+${urlAt - t0}ms` : "never");
  console.log("dashboard visible at:      ", dashboardAt ? `+${dashboardAt - t0}ms` : "never");
  console.log(seen.join(" | "));
  console.log("final url:", await evalv(sid, "location.href"));
} finally { chrome.kill(); }
