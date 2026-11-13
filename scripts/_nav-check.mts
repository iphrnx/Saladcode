import { spawn } from "node:child_process";
const PORT = 9941;
const SITE = "https://www.thesalad.in";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn("google-chrome", ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/chrome-nv-${Date.now()}`, "--no-sandbox", "--disable-gpu", "--window-size=1400,900", "about:blank"], { stdio: "ignore" });
let ws: WebSocket; let id = 0; const pend = new Map<number, any>();
const send = (m: string, p: any = {}, s2?: string) => new Promise<any>((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p, ...(s2 ? { sessionId: s2 } : {}) })); });
const evalv = async (sid: string, e: string) => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }, sid)).result?.value;
try {
  let v: any = null;
  for (let i = 0; i < 40; i++) { try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(250); } }
  ws = new WebSocket(v.webSocketDebuggerUrl) as any; await new Promise((r) => (ws.onopen = r));
  const events: string[] = [];
  ws.onmessage = (e: any) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); return; }
    if (m.method === "Page.frameNavigated" && !m.params.frame.parentId) events.push("document " + m.params.frame.url.replace(SITE, ""));
    if (m.method === "Network.requestWillBeSent" && /_next\/static\/chunks/.test(m.params.request.url)) events.push("js " + m.params.request.url.split("/").pop());
  };
  const { targetId } = await send("Target.createTarget", { url: `${SITE}/?view=login` });
  const { sessionId: sid } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, sid); await send("Page.enable", {}, sid); await send("Network.enable", {}, sid);
  await sleep(7000);
  events.length = 0;
  await evalv(sid, `(() => { const set=(el,v)=>{const s=Object.getOwnPropertyDescriptor(el.constructor.prototype,'value').set;s.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))}; set(document.getElementById('email'),'zhut@demo.com'); set(document.getElementById('password'),'123456'); [...document.querySelectorAll('button[type=submit]')].find(b=>/^sign in$/i.test(b.textContent.trim())).click(); return 1 })()`);
  await sleep(9000);
  const docs = events.filter((e) => e.startsWith("document"));
  console.log("document navigations after submit:", docs.length, docs);
  console.log("js chunks re-downloaded:", events.filter((e) => e.startsWith("js")).length);
  console.log("url:", await evalv(sid, "location.href"));
} finally { chrome.kill(); }
