/**
 * The multi-diner accept flow, driven through the real POS UI.
 *
 *   npx tsx scripts/_pos-approve-e2e.mts
 *
 * Two diners scan the same table, each gets their own private session, and
 * both orders are held. One card represents the table; pressing Accept clears
 * both sessions in one call, and the card becomes Active without a reload.
 */
import fs from "node:fs";
import { spawn } from "node:child_process";

const SITE = process.env.SITE_URL ?? "http://127.0.0.1:3100";
const FIXTURE = process.env.FIXTURE_URL ?? "http://127.0.0.1:8791";
const PORT = Number(process.env.CDP_PORT ?? 9260);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

const profile = `/tmp/chrome-e2e-${PORT}`;
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn("google-chrome", [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--window-size=1400,1000", "about:blank",
], { stdio: "ignore" });

let ws: any = null, id = 0;
const pending = new Map<number, (v: any) => void>();
const send = (method: string, params: any = {}, sid?: string): Promise<any> =>
  new Promise((resolve) => {
    const msgId = ++id;
    pending.set(msgId, resolve);
    ws.send(JSON.stringify({ id: msgId, method, params, ...(sid ? { sessionId: sid } : {}) }));
  });

try {
  let version: any = null;
  for (let i = 0; i < 40; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; }
    catch { await sleep(250); }
  }
  if (!version) throw new Error("Chrome did not start");
  ws = new WebSocket(version.webSocketDebuggerUrl) as unknown as WebSocket;
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (e: any) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)!(msg.result); pending.delete(msg.id); }
  };
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
  const evaluate = async (expression: string): Promise<any> =>
    (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId)).result?.value;

  await fetch(`${FIXTURE}/__fixture/state?name=pos-approve&fail=`);
  await evaluate(`location.href = ${JSON.stringify(SITE)}`);
  await sleep(1200);
  // The consent banner is fixed to the bottom of the viewport and would eat
  // the click on the card underneath it.
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Accept All');
    b?.click();
  })()`);
  await evaluate(`location.href = ${JSON.stringify(`${SITE}/?view=dashboard`)}`);
  for (let i = 0; i < 60; i++) {
    if ((await evaluate(`document.querySelectorAll('[data-session-state]').length`)) > 0) break;
    await sleep(300);
  }

  const before = JSON.parse(await evaluate(`(() => {
    const c = document.querySelector('[data-session-state]');
    return JSON.stringify({
      state: c?.getAttribute('data-session-state'),
      buttons: [...(c?.querySelectorAll('button') ?? [])].map((b) => b.textContent.trim()),
      text: c?.innerText.replace(/\\s+/g, ' '),
    });
  })()`));

  check("a table with two waiting diners is one card", before.state === "waiting", before.state);
  check("it offers Accept and Reject", before.buttons.includes("Accept") && before.buttons.includes("Reject"), before.buttons.join("|"));
  check("it says the order is held, not counted as kitchen work", /held/i.test(before.text), before.text);

  // A table with an open balance must not close silently.
  const closeRefused = await evaluate(`(async () => {
    const card = document.querySelector('[data-session-state]');
    const b = [...card.querySelectorAll('button')].find((x) => x.textContent.trim() === 'End session');
    if (!b) return 'no-button';
    b.click();
    await new Promise((r) => setTimeout(r, 900));
    return document.body.innerText.includes('Settle them first') ? 'refused' : 'closed';
  })()`);
  check("End Session is refused while orders are open and unpaid", closeRefused === "refused", String(closeRefused));

  const accepted = await evaluate(`(async () => {
    // Scoped to the card: the cookie banner also has an "Accept All" button,
    // and a page-wide search finds that one first.
    const card = document.querySelector('[data-session-state]');
    const b = [...card.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Accept');
    if (!b) return 'no-button';
    b.click();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const c = [...document.querySelectorAll('[data-session-state]')].find((x) => x.textContent.includes('Table 3'));
      if (c?.getAttribute('data-session-state') === 'active') return 'active';
    }
    return 'still-pending';
  })()`);
  check("Accept clears the whole table, without a reload", accepted === "active", String(accepted));

  const after = await evaluate(`document.querySelector('[data-session-state]')?.innerText.replace(/\\s+/g, ' ')`);
  check("…and the card now reads Active", /Active/.test(after), String(after));
  check("…with no Accept offered any more", !/Accept/.test(String(after)), String(after));
} catch (e) {
  console.log("failed:", (e as Error).message);
  fail++;
} finally {
  chrome.kill();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
