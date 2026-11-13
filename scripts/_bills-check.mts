/** The "Awaiting payment" strip: money owed must stay visible. */
import fs from "node:fs"; import { spawn } from "node:child_process";
const SITE = process.env.SITE_URL ?? "http://127.0.0.1:3100";
const FIXTURE = process.env.FIXTURE_URL ?? "http://127.0.0.1:8791";
const PORT = Number(process.env.CDP_PORT ?? 9290);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (l: string, ok: boolean, d?: string) => { if (ok) pass++; else fail++; console.log(`  ${ok ? "ok  " : "FAIL"}  ${l}${d && !ok ? `\n        ${d}` : ""}`); };

const profile = `/tmp/chrome-bills-${PORT}`; fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn("google-chrome", ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--window-size=1400,1000", "about:blank"], { stdio: "ignore" });
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
  await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
  const ev = async (x: string) => (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }, sessionId)).result?.value;

  await fetch(`${FIXTURE}/__fixture/state?name=pos-bills&fail=`);
  await ev(`location.href = ${JSON.stringify(`${SITE}/?view=dashboard`)}`);
  let ready = false;
  for (let i = 0; i < 60; i++) { ready = (await ev(`document.querySelectorAll('[data-pending-bill]').length`)) >= 2; if (ready) break; await sleep(300); }

  check("bills with money due are listed", ready, String(await ev(`document.querySelectorAll('[data-pending-bill]').length`)));
  const body = await ev(`document.body.innerText.replace(/\\s+/g, ' ')`);
  check("a closed, unsettled sitting still appears", /Table 1/.test(body) && /480/.test(body), body.slice(0, 200));
  check("a partially paid sitting shows what is left", /Table 4/.test(body) && /200/.test(body));
  check("it says how much was paid", /of/.test(body) && /300/.test(body));
  check("the strip is labelled", /Awaiting payment/i.test(body));

  const opened = await ev(`(async () => {
    document.querySelector('[data-pending-bill]').click();
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 200));
      if (document.querySelector('[role="dialog"]')) return 'open';
    }
    return 'missing dialogs=' + document.querySelectorAll('[role="dialog"]').length + ' body=' + document.body.innerText.replace(/\s+/g,' ').slice(0,120);
  })()`);
  check("tapping one opens its bill", opened === "open", String(opened));

  if (process.env.SHOT_DIR) {
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
    fs.writeFileSync(`${process.env.SHOT_DIR}/pending-bills.png`, Buffer.from(shot.data, "base64"));
  }
} catch (e) { console.log("failed:", (e as Error).message); fail++; } finally { chrome.kill(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
