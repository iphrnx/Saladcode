import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SITE = "https://www.thesalad.in";
const PORT = 9711;
const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: "zhut@demo.com" });
const otp = await admin.auth.verifyOtp({ token_hash: (link as any).properties.hashed_token, type: "magiclink" });
const sess = otp.data.session!;
const chrome = spawn("google-chrome", ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/chrome-ui-${Date.now()}`, "--no-sandbox", "--disable-gpu", "--window-size=1400,1100", "about:blank"], { stdio: "ignore" });
let ws: WebSocket; let id = 0; const pend = new Map<number, any>();
const send = (m: string, p: any = {}, s2?: string) => new Promise<any>((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p, ...(s2 ? { sessionId: s2 } : {}) })); });
const evalv = async (sid: string, e: string) => (await send("Runtime.evaluate", { expression: e, returnByValue: true }, sid)).result?.value;
const clickText = async (sid: string, sel: string, text: string) => {
  const box = await evalv(sid, `(() => { const el=[...document.querySelectorAll(${JSON.stringify(sel)})].find(b=>b.textContent.trim()===${JSON.stringify(text)}); if(!el) return null; el.scrollIntoView({block:'center'}); const r=el.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2}); })()`);
  if (!box) return false; const { x, y } = JSON.parse(box);
  for (const t of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type: t, x, y, button: "left", clickCount: 1 }, sid);
  return true;
};
try {
  let v: any = null;
  for (let i = 0; i < 40; i++) { try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(250); } }
  ws = new WebSocket(v.webSocketDebuggerUrl) as any; await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (e: any) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
  const { targetId } = await send("Target.createTarget", { url: `${SITE}/?view=login` });
  const { sessionId: sid } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, sid); await send("Page.enable", {}, sid); await sleep(3000);
  await send("Runtime.evaluate", { expression: `(() => { const key="sb-ygibmdkrslquamwflshb-auth-token"; const s=${JSON.stringify({ access_token: sess.access_token, refresh_token: sess.refresh_token, token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now()/1000)+3600, user: sess.user })}; document.cookie = key+"="+encodeURIComponent("base64-"+btoa(JSON.stringify(s)).replace(/=+$/,""))+"; path=/; SameSite=Lax"; return 1; })()`, returnByValue: true }, sid);
  await send("Page.navigate", { url: `${SITE}/?view=settings` }, sid); await sleep(14000);
  await clickText(sid, "[role=tab]", "Billing"); await sleep(4000);
  await clickText(sid, "[role=tab]", "Annually"); await sleep(2500);
  const body = String(await evalv(sid, "document.body.innerText"));
  console.log("Pay once option:", /Pay once/.test(body), "| Enable AutoPay option:", /Enable AutoPay/.test(body));
  console.log("explains no-mandate:", /No mandate, no auto-debit/.test(body), "| explains 12-month cap:", /12 months/.test(body));
  const r = await send("Page.captureScreenshot", { format: "png" }, sid);
  (await import("node:fs")).writeFileSync("/tmp/annual-modes.png", Buffer.from(r.data, "base64"));
} finally { chrome.kill(); }
