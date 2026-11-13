/** The consolidated bill, opened from the POS card. */
import fs from "node:fs"; import { spawn } from "node:child_process";
const SITE = process.env.SITE_URL ?? "http://127.0.0.1:3100";
const FIXTURE = process.env.FIXTURE_URL ?? "http://127.0.0.1:8791";
const PORT = Number(process.env.CDP_PORT ?? 9270);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (l: string, ok: boolean, d?: string) => { if (ok) pass++; else fail++; console.log(`  ${ok ? "ok  " : "FAIL"}  ${l}${d && !ok ? `\n        ${d}` : ""}`); };
const profile = `/tmp/chrome-chk-${PORT}`; fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn("google-chrome", ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-sandbox", "--disable-gpu", "--window-size=1400,1000", "about:blank"], { stdio: "ignore" });
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

  await fetch(`${FIXTURE}/__fixture/state?name=pos-check&fail=`);
  await ev(`location.href = ${JSON.stringify(`${SITE}/?view=dashboard`)}`);
  for (let i = 0; i < 60; i++) { if (await ev(`document.querySelectorAll('[data-session-state]').length > 0`)) break; await sleep(300); }

  const opened = await ev(`(async () => {
    // The floor now lists every table, so pick the card that has a bill.
    const card = [...document.querySelectorAll('[data-session-state]')]
      .find((c) => [...c.querySelectorAll('button')].some((x) => x.textContent.trim() === 'Table bill'));
    if (!card) return 'no-button';
    const b = [...card.querySelectorAll('button')].find(x => x.textContent.trim() === 'Table bill');
    if (!b) return 'no-button'; b.click();
    for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 250)); if (document.body.innerText.includes('Bill')) return 'open'; }
    return 'missing';
  })()`);
  check("the POS card opens the table bill", opened === "open", String(opened));

  const body = await ev(`document.body.innerText.replace(/\\s+/g, ' ')`);
  check("the bill lists both orders", /#2149/.test(body) && /#2150/.test(body), body.slice(0, 160));
  check("one total for the sitting", /₹1,310/.test(body), body.slice(0, 200));
  check("GST is broken out as CGST and SGST", /CGST/.test(body) && /SGST/.test(body));
  check("outstanding is shown before any payment", /Outstanding/.test(body));

  const paid = await ev(`(async () => {
    const input = document.querySelector('input[inputmode="decimal"]');
    if (!input) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '310');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Cash');
    if (!b) return 'no-button';
    b.click();
    await new Promise(r => setTimeout(r, 1500));
    return document.body.innerText.includes('₹310') ? 'recorded' : 'no-change';
  })()`);
  check("a cash payment is recorded against the check", paid === "recorded", String(paid));

  const afterPay = await ev(`document.body.innerText.replace(/\\s+/g, ' ')`);
  check("…and the outstanding drops by that amount", /Outstanding/.test(afterPay));

  if (process.env.SHOT_DIR) {
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
    fs.writeFileSync(`${process.env.SHOT_DIR}/table-check.png`, Buffer.from(shot.data, "base64"));
  }
} catch (e) { console.log("failed:", (e as Error).message); fail++; } finally { chrome.kill(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
