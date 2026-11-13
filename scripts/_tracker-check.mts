/** The diner's order tracker, in a real browser. */
import fs from "node:fs"; import { spawn } from "node:child_process";
const SITE = process.env.SITE_URL ?? "http://127.0.0.1:3100";
const FIXTURE = process.env.FIXTURE_URL ?? "http://127.0.0.1:8791";
const PORT = Number(process.env.CDP_PORT ?? 9280);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (l: string, ok: boolean, d?: string) => { if (ok) pass++; else fail++; console.log(`  ${ok ? "ok  " : "FAIL"}  ${l}${d && !ok ? `\n        ${d}` : ""}`); };

for (const width of [390, 1280]) {
  const profile = `/tmp/chrome-trk-${PORT}-${width}`;
  fs.rmSync(profile, { recursive: true, force: true });
  const chrome = spawn("google-chrome", ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-sandbox", "--disable-gpu", "--hide-scrollbars", `--window-size=${width},900`, "about:blank"], { stdio: "ignore" });
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
    await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 640 }, sessionId);
    const ev = async (x: string) => (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }, sessionId)).result?.value;

    await fetch(`${FIXTURE}/__fixture/state?name=diner-active&fail=`);
    await ev(`location.href = ${JSON.stringify(SITE)}`); await sleep(1200);
    await ev(`sessionStorage.setItem('the-salad-diner-session', JSON.stringify({ token: 'fixture-session-token', tenantId: 'tenant_fixture', tableId: 'table_fixture' }))`);
    await ev(`location.href = ${JSON.stringify(`${SITE}/?view=public-menu`)}`);
    let ready = false;
    for (let i = 0; i < 60; i++) { ready = await ev(`!!document.querySelector('[data-order-tracker]')`); if (ready) break; await sleep(300); }

    console.log(`\n══ ${width}px ══`);
    check("the tracker sits in the menu header", ready);
    const badge = await ev(`document.querySelector('[data-order-tracker]')?.innerText.trim()`);
    check("it shows a live count", badge === "2", String(badge));

    const opened = await ev(`(async () => {
      document.querySelector('[data-order-tracker]').click();
      for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 150)); if (document.querySelector('[data-order-tracker-panel]')) return 'open'; }
      return 'missing';
    })()`);
    check("tapping opens the panel", opened === "open", String(opened));

    const panel = await ev(`document.querySelector('[data-order-tracker-panel]')?.innerText.replace(/\\s+/g, ' ')`);
    check("both orders are listed", /#2149/.test(panel) && /#2150/.test(panel), String(panel).slice(0, 120));
    check("each carries its own status", /Preparing/.test(panel) && /Ready/.test(panel));
    check("the amounts are shown", /₹640/.test(panel) && /₹670/.test(panel));

    const glass = await ev(`(() => {
      const p = document.querySelector('[data-order-tracker-panel]');
      const s = getComputedStyle(p);
      return JSON.stringify({ blur: s.backdropFilter || s.webkitBackdropFilter, bg: s.backgroundColor, radius: s.borderRadius });
    })()`);
    check("it is a frosted panel", /blur\((?!0px)/.test(glass), glass);
    check("…rounded", (() => { const r = Number((glass.match(/(\d+)px/) ?? [])[1]); return r >= 12 && r <= 32; })(), glass);

    const overflow = await ev(`(() => {
      const p = document.querySelector('[data-order-tracker-panel]').getBoundingClientRect();
      return JSON.stringify({ left: Math.round(p.left), right: Math.round(p.right), vw: window.innerWidth });
    })()`);
    const g = JSON.parse(overflow);
    check("it stays on screen", g.left >= 0 && g.right <= g.vw + 1, overflow);

    const dismissed = await ev(`(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      return !document.querySelector('[data-order-tracker-panel]');
    })()`);
    check("tapping outside dismisses it", dismissed === true);

    if (process.env.SHOT_DIR) {
      await ev(`document.querySelector('[data-order-tracker]').click()`);
      await sleep(400);
      const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
      fs.writeFileSync(`${process.env.SHOT_DIR}/order-tracker-${width}.png`, Buffer.from(shot.data, "base64"));
    }
  } catch (e) { console.log("failed:", (e as Error).message); fail++; } finally { chrome.kill(); }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
