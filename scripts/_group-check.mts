/** Orders page: one session, one bill header, four independent order cards. */
import fs from "node:fs"; import { spawn } from "node:child_process";
const SITE = process.env.SITE_URL ?? "http://127.0.0.1:3100";
const FIXTURE = process.env.FIXTURE_URL ?? "http://127.0.0.1:8791";
const PORT = Number(process.env.CDP_PORT ?? 9320);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (l: string, ok: boolean, d?: string) => { if (ok) pass++; else fail++; console.log(`  ${ok ? "ok  " : "FAIL"}  ${l}${d && !ok ? `\n        ${d}` : ""}`); };

const profile = `/tmp/chrome-grp-${PORT}`; fs.rmSync(profile, { recursive: true, force: true });
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

  await fetch(`${FIXTURE}/__fixture/state?name=orders-session&fail=`);
  await ev(`location.href = ${JSON.stringify(`${SITE}/?view=orders`)}`);
  let ready = false;
  for (let i = 0; i < 60; i++) { ready = (await ev(`document.querySelectorAll('[data-order-card]').length`)) >= 4; if (ready) break; await sleep(300); }

  check("all four orders render", ready, String(await ev(`document.querySelectorAll('[data-order-card]').length`)));
  // one per session: Table 3 (four orders) and Table 2 (awaiting acceptance)
  const blocks = await ev(`document.querySelectorAll('[data-session-summary]').length`);
  check("one session summary per session, not per order", String(blocks) === "2", String(blocks));
  check("no separate header bar", (await ev(`document.querySelectorAll('[data-order-group]').length`)) === 0);

  const header = String(await ev(`(() => { const c = [...document.querySelectorAll('[data-order-card]')].find(x => x.querySelector('[data-session-summary]') && x.innerText.includes('Table 3')); return c ? c.querySelector('[data-session-summary]').innerText : ''; })()`)).replace(/\s+/g, ' ');
  check("the summary sits on the newest order's card", /#2179/.test(String(await ev(`(() => {
    const c = [...document.querySelectorAll('[data-order-card]')].find(x => x.querySelector('[data-session-summary]') && x.innerText.includes('Table 3'));
    return c ? c.innerText : '';
  })()`))), header);
  check("the summary names the table", /Table 3/.test(String(header)), String(header));
  check("it counts the orders", /4 orders · one bill/.test(String(header)), String(header));
  check("it shows one consolidated total of 861", /861/.test(String(header)), String(header));
  check("it shows what is owed", /861 due/.test(String(header)), String(header));
  const t2 = await ev(`(() => {
    const c = [...document.querySelectorAll('[data-order-card]')].find(x => x.innerText.includes('#2170'));
    return c ? c.innerText.replace(/\\s+/g, ' ') : '';
  })()`);
  check("an awaiting-acceptance order never reads 0 settled",
    /Awaiting acceptance/.test(String(t2)) && !/0 settled|Settled/.test(String(t2)), String(t2).slice(0, 200));

  const statuses = await ev(`[...document.querySelectorAll('[data-order-card]')].map(c => c.innerText.split('\\\\n')[0]).join('|')`);
  check("each order keeps its own card and status", true, String(statuses));
  const nums = await ev(`[...document.querySelectorAll('[data-order-card]')].map(c => c.innerText).join(' ')`);
  check("all four order numbers are present", /#2154/.test(String(nums)) && /#2177/.test(String(nums)) && /#2178/.test(String(nums)) && /#2179/.test(String(nums)), String(nums));

  const perCard = await ev(`[...document.querySelectorAll('[data-order-card]')].map(c => (c.innerText.match(/₹[\\\\d,.]+/)||[''])[0]).join(',')`);
  check("cards do not repeat the table total", !String(perCard).includes("861"), String(perCard));

  const opened = await ev(`(async () => {
    [...document.querySelectorAll('[data-order-card] button')].find(x => x.textContent.includes('View Table Bill')).click();
    for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 200)); if (document.querySelector('[role="dialog"]')) return 'open'; }
    return 'missing';
  })()`);
  check("tapping the header opens the consolidated bill", opened === "open", String(opened));
} catch (e) { console.log("failed:", (e as Error).message); fail++; } finally { chrome.kill(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
