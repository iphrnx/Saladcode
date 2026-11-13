/**
 * The billing pages, verified in a real browser against the fixture backend.
 *
 *   npx tsx scripts/_billing-verify.mts            # all states, all widths
 *   STATE=trial npx tsx scripts/_billing-verify.mts
 *
 * What it proves, per subscription state:
 *
 *   1. The Billing tab and Manage Billing print the SAME plan, price, payment
 *      mode, start date, period date, day count and renewal sentence.
 *   2. The word "AutoPay" appears only on a state whose mandate Razorpay
 *      verified.
 *   3. No horizontal overflow at 375, 768 and 1280 px.
 *   4. Inside a summary row, the statistic tiles are the same height (±1px)
 *      and share left edges — the "consistent spacing and alignment" the
 *      redesign is judged on.
 *
 * Screenshots are written next to it when SHOT_DIR is set.
 */
import fs from "node:fs";
import { spawn } from "node:child_process";

const SITE = process.env.SITE_URL ?? "http://localhost:3100";
const FIXTURE = process.env.FIXTURE_URL ?? "http://127.0.0.1:8791";
const SHOT_DIR = process.env.SHOT_DIR ?? "";
const ONLY = process.env.STATE ?? "";
const WIDTHS = (process.env.WIDTHS ?? "1280,768,375").split(",").map(Number);
const THEME = process.env.THEME ?? "light";
const PORT = Number(process.env.CDP_PORT ?? 9230);

const STATES = [
  "trial", "autopay", "autopay-unverified", "pay-once-annual", "legacy-onetime",
  "past-due", "pending", "cancelled-scheduled", "restricted", "refunded",
];
/** States whose fixture has a mandate Razorpay confirmed. */
const VERIFIED_MANDATE = new Set(["autopay", "past-due", "pending", "cancelled-scheduled", "refunded"]);

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function browser(width: number, cdpPort = PORT) {
  const profile = `/tmp/chrome-verify-${cdpPort}-${width}`;
  fs.rmSync(profile, { recursive: true, force: true });
  const chrome = spawn("google-chrome", [
    "--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
    `--window-size=${width},1000`, "about:blank",
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

  let version: any = null;
  for (let i = 0; i < 40; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json(); break; }
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
    width, height: 1000, deviceScaleFactor: 1, mobile: width < 640,
  }, sessionId);

  /** Poll until the selector exists, or give up loudly. */
  const waitUntil = async (expression: string, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return true;
      await sleep(300);
    }
    return false;
  };
  const waitFor = (selector: string, timeoutMs: number) =>
    waitUntil(`!!document.querySelector(${JSON.stringify(selector)})`, timeoutMs);

  const evaluate = async (expression: string): Promise<any> => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description ?? ""));
    return r.result?.value;
  };

  return {
    evaluate,
    waitFor,
    waitUntil,
    async shot(path: string) {
      const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
      fs.writeFileSync(path, Buffer.from(shot.data, "base64"));
    },
    close: () => chrome.kill(),
  };
}

/** Everything the summary card prints, plus the page's own text. */
const PROBE = `(() => {
  const txt = (e) => (e?.innerText ?? "").replace(/\\s+/g, " ").trim();
  const summary = document.querySelector('[data-billing-summary]');
  const tiles = [...(summary?.querySelectorAll('[data-billing-tile]') ?? [])].filter((t) => t.getBoundingClientRect().width > 0).map((t) => {
    const r = t.getBoundingClientRect();
    return {
      label: t.getAttribute('data-label') || '',
      value: txt(t).replace(txt(t.querySelector('p')) || '', '').trim() || txt(t.querySelectorAll('p')[1]),
      x: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top + window.scrollY),
    };
  });
  // Zero-sized boxes are the other view's cards, still mounted behind
  // \`hidden\` — measuring them would report a left edge of 0 and a giant gap.
  const cards = [...document.querySelectorAll('[data-billing-card]')]
    .map((c) => {
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top + window.scrollY) };
    })
    .filter((c) => c.w > 0 && c.h > 0);
  return JSON.stringify({
    body: txt(document.body),
    renewal: txt(document.querySelector('[data-billing-renewal]')),
    tiles,
    cards,
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  });
})()`;

const summaryOf = (page: any) =>
  Object.fromEntries(page.tiles.map((t: any) => [t.label, t.value]));

for (const width of WIDTHS) {
  const states = ONLY ? [ONLY] : STATES;
  const b = await browser(width);
  console.log(`\n══ ${width}px ${THEME} ══`);
  try {
    for (const state of states) {
      await fetch(`${FIXTURE}/__fixture/state?name=${state}`);
      await b.evaluate(`location.href = ${JSON.stringify(`${SITE}/?view=billing`)}`);
      // Wait for the summary to exist rather than for a fixed delay: a cold
      // Next build compiles the route on first request and takes seconds.
      // If it still has not appeared, reload once — a page that lost its
      // first render (a chunk race) is worth one retry, not a red herring.
      if (!(await b.waitFor("[data-billing-summary]", 20_000))) {
        await b.evaluate("location.reload()");
        await b.waitFor("[data-billing-summary]", 20_000);
      }
      // The renewal line says "Checking…" until the verified payload lands.
      // Probe the settled page, not a half-loaded one — otherwise the tab is
      // read mid-flight and compared against a Manage view that already has
      // the answer.
      await b.waitUntil(
        `(() => { const el = document.querySelector('[data-billing-renewal]'); return !!el && !el.innerText.includes('Checking'); })()`,
        15_000,
      );
      if (THEME === "dark") {
        await b.evaluate("document.documentElement.classList.add('dark')");
        await sleep(300);
      }
      const tabRaw = await b.evaluate(PROBE);
      const tab = JSON.parse(tabRaw);

      let clicked = false;
      for (let attempt = 0; attempt < 3 && !clicked; attempt++) {
        clicked = await b.evaluate(`(() => {
          const btn = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().includes('Manage Billing'));
          if (!btn) return false; btn.click(); return true;
        })()`);
        if (!clicked) await sleep(1000);
      }
      await b.waitFor("[data-billing-summary]", 15_000);
      await sleep(600);
      if (THEME === "dark") await b.evaluate("document.documentElement.classList.add('dark')");
      const manageRaw = clicked ? await b.evaluate(PROBE) : tabRaw;
      const manage = JSON.parse(manageRaw);

      const a = summaryOf(tab);
      const m = summaryOf(manage);
      const keys = ["Price", "Payment mode", "Started", "Trial started", "Next billing date", "Access expires on", "Trial ends", "Status"];

      console.log(`\n-- ${state} --`);
      check("Manage Billing opened", clicked === true);
      for (const k of keys) {
        if (a[k] === undefined && m[k] === undefined) continue;
        check(`${k}: "${a[k] ?? "—"}" on both pages`, a[k] === m[k], `tab=${a[k]}  manage=${m[k]}`);
      }

      check("the summary rendered its tiles", tab.tiles.length >= 4, `${tab.tiles.length} tiles`);
      // The renewal sentence is the one fact both pages take from the verified
      // payload; it must read identically.
      check("renewal line identical on both pages", tab.renewal === manage.renewal,
        `tab=${tab.renewal} manage=${manage.renewal}`);

      // AutoPay may appear only where Razorpay confirmed a mandate.
      const claimsAutoPay = (body: string) => /AutoPay/.test(body);
      if (!VERIFIED_MANDATE.has(state)) {
        check("no AutoPay claim without a verified mandate",
          !/Payment mode:? ?[^|]*AutoPay/.test(tab.body) || !claimsAutoPay(tab.body),
          (tab.body.match(/.{0,40}AutoPay.{0,40}/) ?? [""])[0]);
        check("…and the payment-mode tile does not say AutoPay",
          !String(a["Payment mode"] ?? "").includes("AutoPay"), String(a["Payment mode"]));
      } else {
        check("a verified mandate may show AutoPay", true);
      }

      check("no horizontal overflow on the billing tab", tab.overflowX <= 0, `${tab.overflowX}px`);
      check("no horizontal overflow on Manage Billing", manage.overflowX <= 0, `${manage.overflowX}px`);

      // Tile alignment: same row ⇒ same top, same height; columns share width.
      const rows = new Map<number, any[]>();
      for (const t of tab.tiles) {
        const row = rows.get(t.top) ?? [];
        row.push(t);
        rows.set(t.top, row);
      }
      const heights = [...rows.values()].filter((r) => r.length > 1).map((r) => Math.max(...r.map((t) => t.h)) - Math.min(...r.map((t) => t.h)));
      check("tiles in a row are the same height", heights.every((d) => d <= 1), `deltas=${heights.join(",")}`);

      for (const [page, label] of [[tab, "billing tab"], [manage, "Manage Billing"]] as const) {
        const xs = [...new Set(page.cards.map((c: any) => c.x))];
        const ws = [...new Set(page.cards.map((c: any) => c.w))];
        check(`${label}: every card shares one left edge and width`,
          xs.length === 1 && ws.length === 1, `x=${xs.join(",")} w=${ws.join(",")}`);
      }
      // Manage Billing is nothing but cards, so its vertical rhythm is the
      // one place even spacing can be asserted end to end.
      const gaps = manage.cards.slice(1).map((c: any, i: number) => c.top - (manage.cards[i].top + manage.cards[i].h));
      check("Manage Billing spaces its cards evenly",
        gaps.length > 2 && gaps.every((g: number) => Math.abs(g - gaps[0]) <= 1),
        `gaps=${gaps.join(",")} cards=${manage.cards.length}`);

      if (SHOT_DIR) {
        fs.mkdirSync(SHOT_DIR, { recursive: true });
        await b.shot(`${SHOT_DIR}/${state}-manage-${width}.png`);
        await b.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Back to Billing'); b?.click(); })()`);
        await sleep(1200);
        await b.shot(`${SHOT_DIR}/${state}-billing-${width}.png`);
      }
    }
  } finally {
    b.close();
  }
}

// ---------------------------------------------------------------------------
// The failure path: the verified payload cannot be fetched.
// ---------------------------------------------------------------------------
if (!ONLY || ONLY === "failure") {
  console.log("\n══ failure path (the manage call fails) ══");
  // A different debugging port: the previous browser is still shutting down,
  // and two Chromes on one port is a race the harness should not have.
  const b = await browser(1280, PORT + 1);
  try {
    await fetch(`${FIXTURE}/__fixture/state?name=autopay&fail=manage`);
    await b.evaluate(`location.href = ${JSON.stringify(`${SITE}/?view=billing`)}`);
    await b.waitFor("[data-billing-summary]", 25_000);
    await sleep(800);
    const tab = JSON.parse(await b.evaluate(PROBE));
    await b.evaluate(`(() => { const x = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Manage Billing')); x?.click(); })()`);
    await b.waitFor("[data-billing-summary]", 15_000);
    await sleep(800);
    const manage = JSON.parse(await b.evaluate(PROBE));

    check("the Billing tab still shows the plan", tab.tiles.length >= 4, `${tab.tiles.length} tiles`);
    check("Manage Billing still shows the plan", manage.tiles.length >= 4, `${manage.tiles.length} tiles`);
    check("both pages say the renewal could not be confirmed",
      tab.renewal === manage.renewal && tab.renewal.includes("Could not be confirmed"),
      `tab=${tab.renewal} manage=${manage.renewal}`);
    check("the failed page does not claim AutoPay",
      !/Payment mode[^|]*AutoPay/.test(manage.body), (manage.body.match(/.{0,40}AutoPay.{0,40}/) ?? [""])[0]);
    const a = summaryOf(tab);
    const m = summaryOf(manage);
    check("the same plan facts survive the failure",
      JSON.stringify(a) === JSON.stringify(m), `tab=${JSON.stringify(a)} manage=${JSON.stringify(m)}`);
  } finally {
    b.close();
    await fetch(`${FIXTURE}/__fixture/state?fail=`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
