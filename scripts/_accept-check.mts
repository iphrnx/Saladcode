/** A held order card: Awaiting Acceptance, Accept/Reject, then Start Preparing. */
import fs from "node:fs"; import { spawn } from "node:child_process";
const SITE = process.env.SITE_URL ?? "http://127.0.0.1:3100";
const FIXTURE = process.env.FIXTURE_URL ?? "http://127.0.0.1:8791";
const PORT = Number(process.env.CDP_PORT ?? 9310);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (l: string, ok: boolean, d?: string) => { if (ok) pass++; else fail++; console.log(`  ${ok ? "ok  " : "FAIL"}  ${l}${d && !ok ? `\n        ${d}` : ""}`); };

const profile = `/tmp/chrome-acc-${PORT}`; fs.rmSync(profile, { recursive: true, force: true });
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

  await fetch(`${FIXTURE}/__fixture/state?name=orders-held&fail=`);
  await ev(`location.href = ${JSON.stringify(`${SITE}/?view=orders`)}`);
  let ready = false;
  for (let i = 0; i < 60; i++) { ready = (await ev(`document.querySelectorAll('[data-order-card]').length`)) > 0; if (ready) break; await sleep(300); }

  console.log("\n── a held order says what it is ──");
  check("the card rendered", ready);
  const body = await ev(`document.body.innerText.replace(/\\s+/g, ' ')`);
  check("it reads Awaiting Acceptance", /Awaiting Acceptance/.test(body), body.slice(0, 180));
  check("it no longer says Waiting for table", !/Waiting for table/.test(body));
  check("Start Preparing is not offered", !/Start Preparing/.test(body));

  const buttons = await ev(`[...document.querySelectorAll('[data-order-card] button')].map(b => b.textContent.trim()).join('|')`);
  check("Accept and Reject are offered", /Accept/.test(buttons) && /Reject/.test(buttons), buttons);

  console.log("\n── accepting moves it to Pending, not Preparing ──");
  const accepted = await ev(`(async () => {
    const b = [...document.querySelectorAll('[data-order-card] button')].find(x => x.textContent.trim() === 'Accept');
    if (!b) return 'no-button';
    b.click();
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 250));
      const t = document.body.innerText;
      if (/Start Preparing/.test(t) && !/Awaiting Acceptance/.test(t)) return 'pending';
    }
    return 'still-held';
  })()`);
  check("accepting swaps to Start Preparing", accepted === "pending", String(accepted));
  const card = await ev(`document.querySelector('[data-order-card]')?.innerText.replace(/\\s+/g, ' ') ?? ''`);
  check("the card's badge reads Pending", /Pending/.test(card) && !/Awaiting Acceptance/.test(card), card.slice(0, 160));
  check("…and Start Preparing is now the action", /Start Preparing/.test(card), card.slice(0, 160));
} catch (e) { console.log("failed:", (e as Error).message); fail++; } finally { chrome.kill(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
