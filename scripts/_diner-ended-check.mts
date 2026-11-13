/**
 * The diner's "session ended" screen, checked in a real browser.
 *
 *   npx tsx scripts/_diner-ended-check.mts
 *
 * Seeds a diner session into sessionStorage (the way a real ended session
 * looks), points the app at the fixture backend, and checks what the diner is
 * left with: the thank-you card, the note about the bill, and a working
 * "View Bill" next to it. Measures the layout at desktop and phone width.
 */
import fs from "node:fs";
import { spawn } from "node:child_process";

const SITE = process.env.SITE_URL ?? "http://127.0.0.1:3100";
const FIXTURE = process.env.FIXTURE_URL ?? "http://127.0.0.1:8791";
const SHOT_DIR = process.env.SHOT_DIR ?? "";
const PORT = Number(process.env.CDP_PORT ?? 9240);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

for (const width of [1280, 375]) {
  const profile = `/tmp/chrome-diner-${PORT}-${width}`;
  fs.rmSync(profile, { recursive: true, force: true });
  const chrome = spawn("google-chrome", [
    "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    "--no-sandbox", "--disable-gpu", "--hide-scrollbars", `--window-size=${width},900`, "about:blank",
  ], { stdio: "ignore" });

  let ws: any = null;
  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  const send = (method: string, params: any = {}, sessionId?: string): Promise<any> =>
    new Promise((resolve) => {
      const msgId = ++id;
      pending.set(msgId, resolve);
      ws.send(JSON.stringify({ id: msgId, method, params, ...(sessionId ? { sessionId } : {}) }));
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
    await send("Emulation.setDeviceMetricsOverride", {
      width, height: 900, deviceScaleFactor: 1, mobile: width < 640,
    }, sessionId);
    const evaluate = async (expression: string): Promise<any> => {
      const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
      return r.result?.value;
    };

    await fetch(`${FIXTURE}/__fixture/state?name=diner-ended&fail=`);
    await evaluate(`location.href = ${JSON.stringify(SITE)}`);
    await sleep(1500);
    // A session the diner already holds — exactly what survives a refresh.
    await evaluate(`sessionStorage.setItem('the-salad-diner-session', JSON.stringify({
      token: 'fixture-session-token', tenantId: 'tenant_fixture', tableId: 'table_fixture'
    }))`);
    await evaluate(`location.href = ${JSON.stringify(`${SITE}/?view=public-menu`)}`);

    let ready = false;
    for (let i = 0; i < 60; i++) {
      ready = await evaluate(`document.body.innerText.includes('Thanks for dining with us')`);
      if (ready) break;
      await sleep(300);
    }

    console.log(`\n══ ${width}px ══`);
    check("the ended screen rendered", ready);
    const body = await evaluate(`document.body.innerText.replace(/\\s+/g, ' ')`);
    check("the thank-you line is shown", body.includes("Thanks for dining with us! ❤️"));
    check("the bill note is shown",
      body.includes("Please download your bill for your records, as it may not be available after your session ends."));
    check("the bill action is still there", /View Bill/.test(body));
    check("the review form is still there", body.includes("Submit Review") || body.includes("Rate your experience"));

    const geo = await evaluate(`(() => {
      const card = [...document.querySelectorAll('div')].find((d) => d.textContent.startsWith('Thanks for dining with us!'));
      const box = card?.getBoundingClientRect();
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'View Bill');
      const bb = btn?.getBoundingClientRect();
      return JSON.stringify({
        card: box ? { w: Math.round(box.width), h: Math.round(box.height) } : null,
        bill: bb ? { w: Math.round(bb.width), h: Math.round(bb.height) } : null,
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        order: card && btn ? (card.compareDocumentPosition(btn) & 4) !== 0 : null,
      });
    })()`);
    const g = JSON.parse(geo);
    check("the card is compact", g.card !== null && g.card.h < 120, JSON.stringify(g.card));
    check("it sits above the bill action", g.order === true);
    check("no horizontal overflow", g.overflowX <= 0, `${g.overflowX}px`);

    // After the review is submitted the card swaps for a thank-you panel.
    // The reminder has to survive that swap — it is still the last moment the
    // bill can be downloaded.
    await sleep(800); // let React hydrate before a programmatic click
    const clicked = await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Submit Review');
      if (!b) return false; b.click(); return true;
    })()`);
    check("the review submits", clicked === true);
    let submitted = false;
    for (let i = 0; i < 30; i++) {
      submitted = await evaluate(`document.body.innerText.includes('Review Submitted')`);
      if (submitted) break;
      await sleep(200);
    }
    check("the submitted panel appears", submitted,
      submitted ? undefined : await evaluate(`document.body.innerText.replace(/\s+/g, ' ').slice(0, 300)`));
    const after = await evaluate(`document.body.innerText.replace(/\\s+/g, ' ')`);
    check("the reminder survives the submitted panel",
      after.includes("Thanks for dining with us!") && after.includes("Please download your bill"));
    check("the bill action is still reachable after submitting", /View Bill/.test(after));

    // A full refresh must land back on the same locked screen: the bill and
    // the review stay reachable, and ordering stays closed.
    await evaluate("location.reload()");
    await sleep(3500);
    const afterRefresh = await evaluate(`document.body.innerText.replace(/\\s+/g, ' ')`);
    check("a refresh keeps the diner on the ended screen",
      afterRefresh.includes("Your table session has ended"));
    check("…with the bill still reachable", /View Bill/.test(afterRefresh));
    check("…and the reminder still shown", afterRefresh.includes("Please download your bill"));
    check("…and no way back into ordering",
      !/Add to cart|Place order|View Menu|Browse Menu/i.test(afterRefresh));

    // The bill button must show the consolidated check, not one order.
    await evaluate("location.reload()");
    await sleep(2500);
    const billOpened = await evaluate(`(async () => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'View Bill');
      if (!b) return 'no-button';
      b.click();
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 250));
        if (document.body.innerText.includes('INV-0000007')) return 'open';
      }
      return 'missing';
    })()`);
    check("View Bill opens the consolidated check", billOpened === 'open', String(billOpened));
    const billText = await evaluate(`document.body.innerText.replace(/\\s+/g, ' ')`);
    check("…with both orders on it", /Paneer Tikka/.test(billText) && /Masala Dosa/.test(billText));
    check("…the GST split", /CGST/.test(billText) && /SGST/.test(billText));
    check("…what was paid and what is due", /Paid/.test(billText) && /810/.test(billText));

    if (SHOT_DIR) {
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
      fs.writeFileSync(`${SHOT_DIR}/diner-ended-${width}.png`, Buffer.from(shot.data, "base64"));
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
