/**
 * Check the cookie banner the way a visitor meets it.
 *
 * Fresh browser profile each time, so "first visit" is genuinely a first visit:
 * the banner appears, both buttons record what they say, the choice survives a
 * reload, and nothing on the page is blocked while the banner is up.
 *
 *   SITE_URL=http://localhost:3100 npm run test:cookie-banner
 */
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { spawn } from "node:child_process";

const SITE = process.env.SITE_URL ?? "http://localhost:3100";
const EMAIL = process.env.EMAIL ?? "phrnx@icloud.com";
const PORT = Number(process.env.CDP_PORT ?? 9311);

// The diner-menu check below needs a table to scan; `profile` is already taken
// by the browser's profile directory.
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});
const { data: ownerProfile } = await admin.from("profiles").select("tenant_id").eq("email", EMAIL).maybeSingle();
const tenantId = ownerProfile!.tenant_id as string;
const CONSENT_KEY = "the-salad-cookie-consent";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

const profile = `/tmp/chrome-consent-${PORT}`;
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn("google-chrome", [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--window-size=390,844", "about:blank",
], { stdio: "ignore" });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let ws: WebSocket | null = null;
let id = 0;
const pending = new Map<number, (v: any) => void>();
const send = (method: string, params: any = {}, sessionId?: string) =>
  new Promise<any>((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws!.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

try {
  let version: any = null;
  for (let i = 0; i < 40; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; }
    catch { await sleep(250); }
  }
  if (!version) throw new Error("Chrome did not start");
  ws = new WebSocket(version.webSocketDebuggerUrl) as unknown as WebSocket;
  await new Promise((r) => (ws!.onopen = r));
  ws.onmessage = (e: any) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result); pending.delete(m.id); }
  };
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, sessionId);
  const ev = async (expr: string) =>
    (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId))?.result?.value;

  const bannerState = `
    JSON.stringify({
      up: Boolean(document.querySelector('[role=region][aria-label="Cookie choices"]')),
      stored: localStorage.getItem(${JSON.stringify(CONSENT_KEY)}),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      accept: Boolean([...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Accept All')),
      reject: Boolean([...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Reject All')),
    })
  `;
  const press = (label: string) => ev(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
    if (!b) return false;
    b.click();
    return true;
  })()`);

  /**
   * Read the banner state, retrying until the page answers.
   *
   * A single read can land while the page is still navigating — production is
   * slower than a local build — and an evaluate against a page that is not there
   * yet returns nothing at all, which then fails as "undefined is not valid JSON"
   * rather than as anything to do with the banner.
   */
  const readBanner = async (attempts = 12) => {
    for (let i = 0; i < attempts; i++) {
      const raw = await ev(bannerState);
      if (typeof raw === "string" && raw.trim().startsWith("{")) {
        try { return JSON.parse(raw) as { up: boolean; stored: string | null; overflow: number; accept: boolean; reject: boolean } } catch { /* retry */ }
      }
      await sleep(500);
    }
    return null;
  };

  const load = async (path = "/") => {
    await send("Page.navigate", { url: `${SITE}${path}` }, sessionId);
    await sleep(4000);
  };

  // The diner's menu is the one page the banner stands down on: someone who
  // scanned the code at their table is ordering food, and the banner lands over
  // the dishes they are tapping. This is the check that says so — and the one
  // above it is its pair, so suppressing the banner everywhere by mistake
  // fails here rather than passing quietly.
  console.log("\n── the diner's menu ──");
  {
    // A session left behind by an earlier run keeps this table's menu from
    // opening a new one, and the menu then never loads — so clear them first.
    await admin.from("table_sessions").delete().eq("tenant_id", tenantId).eq("status", "ACTIVE");
    const { data: table } = await admin
      .from("tables")
      .select("qr_token")
      .eq("tenant_id", tenantId)
      .limit(1)
      .maybeSingle();
    // A dish name is the honest marker that the menu has rendered: the search
    // box's "Search dishes…" is a placeholder, and a placeholder is not text on
    // the page, so waiting for it can never succeed.
    const { data: anyDish } = await admin
      .from("menu_items")
      .select("name")
      .eq("tenant_id", tenantId)
      .eq("available", true)
      .limit(1)
      .maybeSingle();
    const menuMarker = String(anyDish?.name ?? "Table");
    if (!table?.qr_token) {
      check("a table to scan was found", false, "no table on the test restaurant");
    } else {
      // No consent on record, so on any other page the banner would appear.
      await send("Runtime.evaluate", { expression: `localStorage.clear()` }, sessionId);
      await load(`/?table=${table.qr_token}`);
      // The menu has to have finished loading before "no banner" means
      // anything: on a half-loaded page every check passes for the wrong
      // reason. It starts a session and reads the dishes first.
      let menuLoaded = false;
      for (let i = 0; i < 40 && !menuLoaded; i++) {
        menuLoaded = Boolean(await ev(`document.body.innerText.includes(${JSON.stringify(menuMarker)})`));
        if (!menuLoaded) await sleep(500);
      }
      const onMenu = await readBanner();
      check("no banner over the diner's menu", onMenu?.up === false, JSON.stringify(onMenu));
      check("and the menu had loaded, rather than the check looking at an empty page",
        menuLoaded === true,
        String(await ev(`document.body.innerText.slice(0, 120)`)));
      check("nothing was recorded behind the diner's back", onMenu?.stored === null, String(onMenu?.stored));

      // The same storage state on a page that is not the menu still shows it.
      await load("/");
      const elsewhere = await readBanner();
      check("elsewhere the banner still appears", elsewhere?.up === true, JSON.stringify(elsewhere));
    }
  }

  await send("Runtime.evaluate", { expression: `localStorage.clear()` }, sessionId);
  console.log("\n── first visit ──");
  await load("/");
  const first = await readBanner();
  check("the banner appears on a first visit", first?.up === true, JSON.stringify(first));
  check("it offers Accept All", first?.accept === true);
  check("it offers Reject All", first?.reject === true);
  check("nothing is stored before a choice is made", first?.stored === null, String(first?.stored));
  check("the banner does not push the page sideways", first?.overflow <= 1, `overflow ${first?.overflow}px`);

  // "Without affecting existing functionality": with the banner up, the site's
  // own controls must still be the thing under the pointer.
  const heroClickable = await ev(`(() => {
    const cta = [...document.querySelectorAll('button, a')].find((e) => /Create your restaurant|Get started/i.test(e.textContent || ''));
    if (!cta) return 'no cta found';
    const r = cta.getBoundingClientRect();
    if (r.width === 0) return 'cta not visible';
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return cta.contains(top) || top === cta ? true : 'covered by ' + (top?.tagName || '?') + '.' + (top?.className || '').toString().slice(0, 60);
  })()`);
  check("the page's own controls still receive clicks", heroClickable === true, String(heroClickable));

  const shot1 = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
  fs.writeFileSync("/root/downloads/cookie-banner-phone.png", Buffer.from(shot1.data, "base64"));

  console.log("\n── Accept All ──");
  check("the button was pressed", (await press("Accept All")) === true);
  await sleep(600);
  const afterAccept = await readBanner();
  check("the banner closes", afterAccept?.up === false);
  check("the choice is recorded as accepted", /"choice":"all"/.test(String(afterAccept?.stored)), String(afterAccept?.stored));

  await load("/");
  const revisit = await readBanner();
  check("it does not come back on a later visit", revisit?.up === false, JSON.stringify(revisit));
  check("the choice is still there", /"choice":"all"/.test(String(revisit?.stored)), String(revisit?.stored));

  console.log("\n── Cookie settings, then Reject All ──");
  const reopened = await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Cookie settings');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  const reopenedState = await readBanner();
  check("Cookie settings brings the banner back", reopened === true && reopenedState?.up === true,
    JSON.stringify({ pressed: reopened, banner: reopenedState }));

  check("the reject button was pressed", (await press("Reject All")) === true);
  await sleep(600);
  const afterReject = await readBanner();
  check("the banner closes again", afterReject?.up === false);
  check(
    "the choice is recorded as essential-only",
    /"choice":"essential"/.test(String(afterReject?.stored)),
    String(afterReject?.stored),
  );

  await load("/");
  const final = await readBanner();
  check("rejecting is remembered too", final?.up === false && /"choice":"essential"/.test(String(final?.stored)), JSON.stringify(final));

  console.log("\n── a cleared browser asks again ──");
  await ev(`localStorage.removeItem(${JSON.stringify(CONSENT_KEY)})`);
  await load("/");
  const cleared = await readBanner();
  check("with storage cleared the banner returns", cleared?.up === true, JSON.stringify(cleared));

  console.log(`\n${pass}/${pass + fail} checks passed${fail ? ` — ${fail} FAILED` : ""}`);
} catch (e) {
  console.log("failed:", (e as Error).message);
} finally {
  chrome.kill();
}
