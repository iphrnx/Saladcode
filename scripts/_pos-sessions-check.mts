/**
 * The POS floor cards, in all three states, in a real browser.
 *
 *   npx tsx scripts/_pos-sessions-check.mts
 *
 * Checks the things the redesign is judged on: three compact cards, one per
 * table, with the same height and the same anatomy; no idle timer anywhere;
 * Approve/Reject only on the card that is waiting; and End Session disabled on
 * a table that is already closed.
 */
import fs from "node:fs";
import { spawn } from "node:child_process";

const SITE = process.env.SITE_URL ?? "http://127.0.0.1:3100";
const FIXTURE = process.env.FIXTURE_URL ?? "http://127.0.0.1:8791";
const SHOT_DIR = process.env.SHOT_DIR ?? "";
const PORT = Number(process.env.CDP_PORT ?? 9250);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

for (const width of [1440, 390]) {
  const profile = `/tmp/chrome-pos-${PORT}-${width}`;
  fs.rmSync(profile, { recursive: true, force: true });
  const chrome = spawn("google-chrome", [
    "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    "--no-sandbox", "--disable-gpu", "--hide-scrollbars", `--window-size=${width},1000`, "about:blank",
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
    await send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width < 640 }, sessionId);
    const evaluate = async (expression: string): Promise<any> =>
      (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId)).result?.value;

    await fetch(`${FIXTURE}/__fixture/state?name=pos-sessions&fail=`);
    await evaluate(`location.href = ${JSON.stringify(`${SITE}/?view=dashboard`)}`);
    let ready = false;
    for (let i = 0; i < 60; i++) {
      ready = (await evaluate(`document.querySelectorAll('[data-session-state]').length`)) >= 3;
      if (ready) break;
      await sleep(300);
    }

    console.log(`\n══ ${width}px ══`);
    check("three table cards rendered", ready, String(await evaluate(`document.querySelectorAll('[data-session-state]').length`)));

    const geo = JSON.parse(await evaluate(`(() => {
      const cards = [...document.querySelectorAll('[data-session-state]')];
      return JSON.stringify({
        states: cards.map((c) => c.getAttribute('data-session-state')),
        heights: cards.map((c) => Math.round(c.getBoundingClientRect().height)),
        widths: cards.map((c) => Math.round(c.getBoundingClientRect().width)),
        body: document.body.innerText.replace(/\\s+/g, ' '),
        pendingButtons: cards.filter((c) => c.getAttribute('data-session-state') === 'waiting')
          .flatMap((c) => [...c.querySelectorAll('button')].map((b) => b.textContent.trim())),
        closedButtons: cards.filter((c) => c.getAttribute('data-session-state') === 'closed')
          .flatMap((c) => [...c.querySelectorAll('button')].map((b) => ({ t: b.textContent.trim(), d: b.disabled }))),
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      });
    })()`));

    const set = [...new Set(geo.states as string[])].sort().join(",");
    // This fixture sets up active / waiting / closed / idle. Payment Due comes
    // from a check with a balance and is exercised in the bills scenario.
    check("the floor shows active, waiting, closed and idle tables",
      set === "active,closed,idle,waiting", set);
    check("the running bill is on the card", /860/.test(geo.body), geo.body.slice(0, 240));
    check("no idle *timer* on the card (Idle is a state now)", !/idle \d+ min/i.test(geo.body), (geo.body.match(/.{0,30}idle.{0,30}/i) ?? [""])[0]);
    check("the duration and the order count are still shown",
      /18 min/.test(geo.body) && /3 orders/.test(geo.body), geo.body.slice(0, 200));
    check("a held order reads as held, not as kitchen work", /1 held/.test(geo.body));
    check("only the waiting card offers Accept and Reject",
      geo.pendingButtons.join("|") === "Accept|Reject|End session", geo.pendingButtons.join("|"));
    check("a waiting table is not offered a bill it does not have",
      !geo.pendingButtons.includes("Table bill"), geo.pendingButtons.join("|"));
    check("a closed card cannot be ended again",
      geo.closedButtons.find((b: any) => b.t === "End session")?.d === true, JSON.stringify(geo.closedButtons));
    check("cards share one width", new Set(geo.widths).size === 1, JSON.stringify(geo.widths));
    check("cards share one height", new Set(geo.heights).size === 1, JSON.stringify(geo.heights));
    check("no horizontal overflow", geo.overflowX <= 0, `${geo.overflowX}px`);

    if (SHOT_DIR) {
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
      fs.writeFileSync(`${SHOT_DIR}/pos-sessions-${width}.png`, Buffer.from(shot.data, "base64"));
    }
  } catch (e) {
    console.log("failed:", (e as Error).message);
    fail++;
  } finally {
    chrome.kill();
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
