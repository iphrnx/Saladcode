import { spawn } from "node:child_process";
const PORT = 9951;
const SITE = "https://www.thesalad.in";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn("google-chrome", ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/chrome-ph-${Date.now()}`, "--no-sandbox", "--disable-gpu", "--window-size=1400,900", "about:blank"], { stdio: "ignore" });
let ws: WebSocket; let id = 0; const pend = new Map<number, any>();
const send = (m: string, p: any = {}, s2?: string) => new Promise<any>((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p, ...(s2 ? { sessionId: s2 } : {}) })); });
const evalv = async (sid: string, e: string) => { try { return (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }, sid)).result?.value; } catch { return null; } };
try {
  let v: any = null;
  for (let i = 0; i < 40; i++) { try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(250); } }
  ws = new WebSocket(v.webSocketDebuggerUrl) as any; await new Promise((r) => (ws.onopen = r));
  const buckets: { login: number[]; bootstrap: number[]; visible: number[] } = { login: [], bootstrap: [], visible: [] };

  for (let run = 0; run < 3; run++) {
    const marks: Record<string, number> = {};
    const onMsg = (e: any) => {
      const m = JSON.parse(e.data);
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); return; }
      if (m.method === "Network.responseReceived") {
        const u = m.params.response.url;
        if (u.includes("/auth/login")) marks.login = Date.now();
        if (u.includes("/bootstrap")) marks.bootstrap = Date.now();
      }
    };
    ws.addEventListener("message", onMsg);
    const { targetId } = await send("Target.createTarget", { url: `${SITE}/?view=login` });
    const { sessionId: sid } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Runtime.enable", {}, sid); await send("Network.enable", {}, sid);
    await sleep(6500);
    const t0 = Date.now();
    await evalv(sid, `(() => { const set=(el,v)=>{const s=Object.getOwnPropertyDescriptor(el.constructor.prototype,'value').set;s.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))}; set(document.getElementById('email'),'zhut@demo.com'); set(document.getElementById('password'),'123456'); [...document.querySelectorAll('button[type=submit]')].find(b=>/^sign in$/i.test(b.textContent.trim())).click(); return 1 })()`);
    let visible = 0;
    for (let i = 0; i < 120; i++) {
      await sleep(200);
      const s = await evalv(sid, `(() => { const t = document.body.innerText; return !t.includes('Loading your restaurant') && /ACTIVE SESSIONS|Point of Sale|Tables|Today/.test(t) })()`);
      if (s) { visible = Date.now(); break; }
    }
    ws.removeEventListener("message", onMsg);
    if (marks.login) buckets.login.push(marks.login - t0);
    if (marks.bootstrap) buckets.bootstrap.push(marks.bootstrap - t0);
    if (visible) buckets.visible.push(visible - t0);
    console.log(`run ${run + 1}: login ${marks.login ? marks.login - t0 : "-"}ms · bootstrap ${marks.bootstrap ? marks.bootstrap - t0 : "-"}ms · visible ${visible ? visible - t0 : "never"}ms`);
    await send("Target.closeTarget", { targetId });
  }
  const med = (a: number[]) => a.length ? a.sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN;
  console.log(`\nmedian: login response ${med(buckets.login)}ms · bootstrap response ${med(buckets.bootstrap)}ms · dashboard visible ${med(buckets.visible)}ms`);
} finally { chrome.kill(); }
