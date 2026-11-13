/**
 * A rename must not log anyone out or lose what they had.
 *
 * The browser keys were renamed with the product. This checks the part that
 * makes that safe: an old name is still read, its value is moved to the new
 * name, and the old entry is cleared — for every key, including the ones only
 * reachable behind a sign-in.
 *
 * Two halves, because two different pieces of code do the work:
 *
 *   1. the module every call site goes through, exercised against a fake
 *      browser storage for all eight keys;
 *   2. the inline script in the root layout that applies the theme before the
 *      app mounts — separate code, and the one place a missed migration would
 *      show as a flash of the wrong theme.
 *
 *   npm run test:storage-migration
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

// ── 1. The module, against a fake browser ───────────────────────────────────

class FakeStorage {
  map = new Map<string, string>();
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) { this.map.set(k, String(v)); }
  removeItem(k: string) { this.map.delete(k); }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
}

const local = new FakeStorage();
const session = new FakeStorage();
(globalThis as any).window = { localStorage: local, sessionStorage: session };

const { KEYS, readStored, writeStored, removeStored, keyName, legacyKeyName } = await import(
  "../src/lib/storage-keys.ts"
);

console.log("\n── every key carries its value across ──");
for (const name of Object.keys(KEYS) as (keyof typeof KEYS)[]) {
  const suffix = name === "cart" ? "sess-123" : "";
  const legacy = legacyKeyName(name, suffix);
  const current = keyName(name, suffix);
  const store = KEYS[name].area === "session" ? session : local;
  store.clear();

  store.setItem(legacy, `value-for-${name}`);

  const read = readStored(name, suffix);
  check(`${name}: the old value is still read`, read === `value-for-${name}`, String(read));
  check(`${name}: it is now under the new name`, store.getItem(current) === `value-for-${name}`);
  check(`${name}: the old entry is gone`, store.getItem(legacy) === null, String(store.getItem(legacy)));

  // A value written now is written under the new name only.
  writeStored(name, "fresh", suffix);
  check(`${name}: writing uses the new name`, store.getItem(current) === "fresh" && store.getItem(legacy) === null);

  // Removing clears both, so a stale old value cannot resurrect it.
  store.setItem(legacy, "stale");
  removeStored(name, suffix);
  check(`${name}: removing clears both names`, store.getItem(current) === null && store.getItem(legacy) === null);
}

console.log("\n── the new name wins when both exist ──");
local.clear();
local.setItem("the-salad-theme", "dark");
local.setItem("toastly-theme", "light");
check("the current value is used", readStored("theme") === "dark", String(readStored("theme")));
check("the old entry is left alone rather than overwritten", local.getItem("toastly-theme") === "light");

// ── 2. The pre-paint theme script ───────────────────────────────────────────

const SITE = process.env.SITE_URL;
if (!SITE) {
  console.log("\n(no SITE_URL set, so the pre-paint theme script was not exercised)");
} else {
  console.log("\n── the theme script, before the app mounts ──");
  const PORT = Number(process.env.CDP_PORT ?? 9371);
  const profile = `/tmp/chrome-migrate-${PORT}`;
  fs.rmSync(profile, { recursive: true, force: true });
  const chrome = spawn("google-chrome", [
    "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    "--no-sandbox", "--disable-gpu", "--window-size=1200,900", "about:blank",
  ], { stdio: "ignore" });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let ws: any = null;
  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  const send = (method: string, params: any = {}, sessionId?: string) =>
    new Promise<any>((resolve) => {
      const i = ++id;
      pending.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  try {
    let version: any = null;
    for (let i = 0; i < 40; i++) {
      try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; }
      catch { await sleep(250); }
    }
    ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    ws.onmessage = (e: any) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result); pending.delete(m.id); }
    };
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Page.enable", {}, sessionId);
    await send("Runtime.enable", {}, sessionId);
    const ev = async (expr: string) =>
      (await send("Runtime.evaluate", { expression: expr, returnByValue: true }, sessionId))?.result?.value;

    // A visitor who chose the light theme before the rename.
    await send("Page.navigate", { url: `${SITE}/` }, sessionId);
    await sleep(2500);
    await ev(`localStorage.clear(); localStorage.setItem('tablo-theme', 'light')`);

    await send("Page.navigate", { url: `${SITE}/` }, sessionId);
    await sleep(3500);
    const state = JSON.parse(await ev(`JSON.stringify({
      theme: localStorage.getItem('the-salad-theme'),
      legacy: localStorage.getItem('tablo-theme'),
      dark: document.documentElement.classList.contains('dark'),
    })`));
    check("the old choice is carried to the new key", state.theme === "light", JSON.stringify(state));
    check("the old entry is cleared", state.legacy === null, String(state.legacy));
    check("and it is applied, not ignored", state.dark === false, `documentElement has .dark = ${state.dark}`);

    // The dark choice, to be sure the migration is not simply defaulting.
    await ev(`localStorage.clear(); localStorage.setItem('tablo-theme', 'dark')`);
    await send("Page.navigate", { url: `${SITE}/` }, sessionId);
    await sleep(3500);
    const darkState = JSON.parse(await ev(`JSON.stringify({
      theme: localStorage.getItem('the-salad-theme'),
      dark: document.documentElement.classList.contains('dark'),
    })`));
    check("a dark choice migrates as dark", darkState.theme === "dark" && darkState.dark === true, JSON.stringify(darkState));
  } catch (e) {
    check("the theme script could be exercised", false, (e as Error).message);
  } finally {
    chrome.kill();
  }
}

console.log(`\n${pass}/${pass + fail} checks passed${fail ? ` — ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
