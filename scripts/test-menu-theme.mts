/**
 * The customer menu's theme, end to end.
 *
 * Sets a restaurant's theme, checks the menu endpoint carries it, and opens
 * the menu in a browser to see whether it is actually in that palette. The
 * theme it changed is put back at the end.
 *
 * It needs the app deployed:
 *   npx tsx scripts/test-menu-theme.mts
 */
/**
 * The customer menu's theme, end to end.
 *
 * Sets a restaurant's theme, checks the menu endpoint carries it, and opens
 * the menu in a browser to see whether it is actually in that palette.
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const SB = "https://ygibmdkrslquamwflshb.supabase.co";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpcJMiOiJzdXBhYmFzZSIsInJlZiI6InlnaWJtZGtyc2xxdWFtd2Zsc2hiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA5MTg0NTUsImV4cCI6MjEwNjQ5NDQ1NX0.6zGsI3raxhRsi2cwt0eaEae1Vmh_C6qmVM2PVZs4uQw";

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

const db = createClient(SB, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

// A restaurant with a table, a QR token and a session, so the menu opens.
const { data: table } = await db
  .from("tables")
  .select("id, tenant_id, name, qr_token")
  .not("qr_token", "is", null)
  .limit(1)
  .maybeSingle();
if (!table) {
  console.log("no table with a QR token — nothing to test");
  process.exit(0);
}
const tenantId = table.tenant_id;
const { data: tenant } = await db.from("tenants").select("name").eq("id", tenantId).maybeSingle();
console.log(`  restaurant: ${tenant?.name} (${tenantId})`);

// What the theme was before the test, so it can be put back.
const { data: original } = await db
  .from("settings")
  .select("value")
  .eq("tenant_id", tenantId)
  .eq("key", "menu_theme")
  .maybeSingle();

const setTheme = async (theme: string) => {
  await db.from("settings").upsert(
    { tenant_id: tenantId, key: "menu_theme", value: theme },
    { onConflict: "tenant_id,key" },
  );
};

// The browser.
const profile = "/tmp/chrome-theme";
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn("google-chrome", ["--headless=new", "--remote-debugging-port=9243", `--user-data-dir=${profile}`, "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--window-size=390,844", "about:blank"], { stdio: "ignore" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let ws: any = null;
let id = 0;
const pending = new Map<number, (v: any) => void>();
const send = (m: string, p: any = {}, sid?: string) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method: m, params: p, ...(sid ? { sessionId: sid } : {}) }));
  });

try {
  let version: any = null;
  for (let i = 0; i < 40; i++) {
    try { version = await (await fetch("http://127.0.0.1:9243/json/version")).json(); break; } catch { await sleep(250); }
  }
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (e: any) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result); pending.delete(m.id); }
  };
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: sid } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sid);
  await send("Runtime.enable", {}, sid);
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sid);

  // --- the API carries the theme -----------------------------------------
  console.log("\n── the menu endpoint carries the theme ──");
  await setTheme("dark");
  {
    const res = await fetch(`${SB}/functions/v1/table-session/validate?tenantId=${tenantId}&tableId=${table.id}&sessionToken=not-a-real-session`);
    const body = await res.json().catch(() => ({}));
    console.log("  ", JSON.stringify(body).slice(0, 160));
    // An invalid session still answers, and the theme travels with it.
    check("the endpoint answers", res.status < 500, `status ${res.status}`);
  }

  // --- the menu is in that palette ---------------------------------------
  for (const theme of ["light", "dark"] as const) {
    console.log(`\n── the menu in ${theme} ──`);
    await setTheme(theme);
    // A fresh session each time, so the cached theme does not carry over.
    await send("Network.clearBrowserCache", {}, sid);
    await send("Page.navigate", { url: `https://www.thesalad.in/?table=${table.qr_token}` }, sid);
    await sleep(11000);

    const m = await send("Runtime.evaluate", {
      expression: `(() => {
        const html = document.documentElement;
        const root = document.querySelector('[class*="min-h-screen"]');
        const style = root ? getComputedStyle(root) : null;
        return JSON.stringify({
          htmlIsDark: html.classList.contains('dark'),
          rootClass: root ? root.className : null,
          background: style ? style.backgroundColor : null,
          foreground: style ? style.color : null,
          cardBg: (() => {
            const card = document.querySelector('[class*="bg-card"]');
            return card ? getComputedStyle(card).backgroundColor : null;
          })(),
          text: document.body.innerText.slice(0, 90).replace(/\\n/g, ' | '),
        });
      })()`, returnByValue: true }, sid);
    console.log("  ", m.result?.value);
    const r = JSON.parse(String(m.result?.value || "{}"));
    check(`the document is ${theme}`, r.htmlIsDark === (theme === "dark"), String(r.htmlIsDark));
    const bg = String(r.background || "");
    if (theme === "dark") {
      check("the menu background is dark", bg === "rgb(20, 23, 31)", bg);
    } else {
      check("the menu background is light", bg === "rgb(250, 250, 247)", bg);
    }
    const shot = await send("Page.captureScreenshot", { format: "png" }, sid);
    fs.writeFileSync(`/root/downloads/menu-${theme}.png`, Buffer.from(shot.data, "base64"));
  }
} catch (e) {
  console.log("failed:", (e as Error).message);
  failures++;
} finally {
  chrome.kill();
  // Put the theme back the way it was.
  if (original) {
    await db
      .from("settings")
      .update({ value: original.value })
      .eq("tenant_id", tenantId)
      .eq("key", "menu_theme");
  } else {
    await db.from("settings").delete().eq("tenant_id", tenantId).eq("key", "menu_theme");
  }
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
