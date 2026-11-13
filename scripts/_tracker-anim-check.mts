/** The order tracker animates on a real status change — and only then. */
import fs from "node:fs"; import { spawn } from "node:child_process";
const SITE = process.env.SITE_URL ?? "http://127.0.0.1:3100";
const FIXTURE = process.env.FIXTURE_URL ?? "http://127.0.0.1:8791";
const PORT = Number(process.env.CDP_PORT ?? 9300);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (l: string, ok: boolean, d?: string) => { if (ok) pass++; else fail++; console.log(`  ${ok ? "ok  " : "FAIL"}  ${l}${d && !ok ? `\n        ${d}` : ""}`); };

const profile = `/tmp/chrome-anim-${PORT}`; fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn("google-chrome", ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--window-size=390,900", "about:blank"], { stdio: "ignore" });
let ws: any = null, id = 0; const pending = new Map<number, (v: any) => void>();
const send = (m: string, p: any = {}, s?: string) => new Promise<any>(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p, ...(s ? { sessionId: s } : {}) })); });
try {
  let v: any = null;
  for (let i = 0; i < 40; i++) { try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(250); } }
  ws = new WebSocket(v.webSocketDebuggerUrl) as any; await new Promise(r => (ws.onopen = r));
  ws.onmessage = (e: any) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result); pending.delete(m.id); } };
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId); await send("Runtime.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 900, deviceScaleFactor: 1, mobile: true }, sessionId);
  const ev = async (x: string) => (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }, sessionId)).result?.value;

  await fetch(`${FIXTURE}/__fixture/state?name=diner-active&fail=`);
  await ev(`location.href = ${JSON.stringify(SITE)}`); await sleep(1200);
  await ev(`sessionStorage.setItem('the-salad-diner-session', JSON.stringify({ token: 'fixture-session-token', tenantId: 'tenant_fixture', tableId: 'table_fixture' }))`);
  await ev(`location.href = ${JSON.stringify(`${SITE}/?view=public-menu`)}`);
  let ready = false;
  for (let i = 0; i < 60; i++) { ready = await ev(`!!document.querySelector('[data-order-tracker]')`); if (ready) break; await sleep(300); }

  console.log("\n── the first load is not a status change ──");
  check("the tracker rendered", ready);
  await sleep(1500);
  check("no toast on first load", (await ev(`document.querySelectorAll('[data-order-toast]').length`)) === 0);
  check("no pop on first load", (await ev(`!!document.querySelector('.order-pop')`)) === false);

  console.log("\n── a real change animates ──");
  await fetch(`${FIXTURE}/__fixture/advance`);   // PREPARING → READY
  let sawToast = false, sawPop = false;
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    if (!sawToast) sawToast = (await ev(`document.querySelectorAll('[data-order-toast]').length`)) > 0;
    if (!sawPop) sawPop = (await ev(`!!document.querySelector('.order-pop')`)) === true;
    if (sawToast && sawPop) break;
  }
  check("the button pops", sawPop);
  check("a toast appears", sawToast);
  const toast = await ev(`document.querySelector('[data-order-toast]')?.innerText ?? ''`);
  check("it names the new status", /Ready/.test(String(toast)), String(toast));
  check("it is announced politely", (await ev(`document.querySelector('[data-order-toast]')?.getAttribute('aria-live') ?? ''`)) === "polite");

  console.log("\n── and it leaves on its own ──");
  let gone = false;
  for (let i = 0; i < 24; i++) { await sleep(400); if ((await ev(`document.querySelectorAll('[data-order-toast]').length`)) === 0) { gone = true; break; } }
  check("the toast clears within ~1.5s", gone);

  console.log("\n── the button does not move ──");
  const geom = await ev(`(() => {
    const b = document.querySelector('[data-order-tracker]').getBoundingClientRect();
    return JSON.stringify({ t: Math.round(b.top), l: Math.round(b.left), w: Math.round(b.width), h: Math.round(b.height) });
  })()`);
  const g = JSON.parse(geom);
  check("it keeps its size and place", g.w === 36 && g.h === 36, geom);
  check("the page does not scroll sideways", (await ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`)) <= 0);
} catch (e) { console.log("failed:", (e as Error).message); fail++; } finally { chrome.kill(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
