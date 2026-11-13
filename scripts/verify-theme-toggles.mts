/**
 * The three theme controls, and whether each one means what it says.
 *
 *  - Settings → Appearance → Theme: the owner app's palette. It applies the
 *    instant it is chosen, so it must be saved the instant it is chosen too —
 *    a control that changes immediately but keeps its value somewhere else is
 *    how "it didn't save" happens.
 *  - Onboarding → Customize → Menu Theme: the restaurant's customer-menu theme.
 *    It must open on the theme the restaurant has, not on the flow's default,
 *    or saving that step quietly puts the restaurant back.
 *  - The customer menu itself: it must show the restaurant's theme, and must not
 *    follow the owner's own app theme — a diner in daylight should see the
 *    restaurant's menu, not the owner's dark mode.
 *
 *   npm run test:themes
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SITE = process.env.SITE_URL ?? "https://www.thesalad.in";
const EMAIL = process.env.EMAIL ?? "phrnx@icloud.com";
const PORT = Number(process.env.CDP_PORT ?? 9981);
const PROFILE = `/tmp/chrome-theme-${PORT}`;

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });
const { data: profile } = await admin.from("profiles").select("tenant_id").eq("email", EMAIL).maybeSingle();
const tenantId = profile!.tenant_id as string;
const { data: settingsBefore } = await admin
  .from("settings").select("key, value").eq("tenant_id", tenantId).in("key", ["menu_theme", "pref_theme"]);
const savedMenuTheme = settingsBefore?.find((r) => r.key === "menu_theme")?.value ?? null;
const savedPrefTheme = settingsBefore?.find((r) => r.key === "pref_theme")?.value ?? null;
const { data: table } = await admin.from("tables").select("qr_token").eq("tenant_id", tenantId).limit(1).maybeSingle();
console.log(`  tenant settings before: menu_theme=${savedMenuTheme} pref_theme=${savedPrefTheme}`);

const setSetting = async (key: string, value: string | null) => {
  if (value === null) {
    await admin.from("settings").delete().eq("tenant_id", tenantId).eq("key", key);
    return;
  }
  const { data } = await admin.from("settings").select("key").eq("tenant_id", tenantId).eq("key", key).maybeSingle();
  if (data) await admin.from("settings").update({ value }).eq("tenant_id", tenantId).eq("key", key);
  else await admin.from("settings").insert({ tenant_id: tenantId, key, value });
};
const readSetting = async (key: string) =>
  (await admin.from("settings").select("value").eq("tenant_id", tenantId).eq("key", key).maybeSingle())?.data?.value ?? null;

const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const c = createClient(SB, ANON, { auth: { persistSession: false } });
const { data: session } = await c.auth.verifyOtp({ token_hash: link!.properties.hashed_token, type: "magiclink" });
const s = session!.session!;
const hash = new URLSearchParams({
  access_token: s.access_token, refresh_token: s.refresh_token, expires_at: String(s.expires_at),
  expires_in: String(s.expires_in), token_type: s.token_type, type: "magiclink",
}).toString();

const chrome = spawn("google-chrome", [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--window-size=1440,1000", "about:blank",
], { stdio: "ignore" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let ws: WebSocket | null = null;
let id = 0;
const pending = new Map<number, (v: any) => void>();
const send = (method: string, params: any = {}, sid?: string) =>
  new Promise<any>((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws!.send(JSON.stringify({ id: i, method, params, ...(sid ? { sessionId: sid } : {}) }));
  });

try {
  let version: any = null;
  for (let i = 0; i < 40; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; }
    catch { await sleep(250); }
  }
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
  const ev = async (expr: string) => {
    for (let i = 0; i < 10; i++) {
      const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
      if (r?.result?.value !== undefined) return r.result.value;
      await sleep(400);
    }
    return undefined;
  };
  // Real input at the element's centre: these are Radix controls and ignore
  // dispatched events.
  const clickElement = async (finder: string) => {
    const box = await ev(`(() => {
      const el = ${finder};
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
    })()`);
    if (!box) return false;
    const { x, y } = JSON.parse(box);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, sessionId);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, sessionId);
    return true;
  };
  const isDark = () => ev(`document.documentElement.classList.contains('dark')`);
  const THEME_SELECT = `(() => {
    for (const b of document.querySelectorAll('[role="combobox"]')) {
      let el = b;
      for (let up = 0; up < 5 && el; up++, el = el.parentElement) {
        const text = (el.innerText || '').trim();
        if (text && text.length < 60 && /(^|\\s)Theme(\\s|$)/.test(text)) return b;
      }
    }
    return null;
  })()`;

  // ---- A. the owner's app theme -----------------------------------------
  console.log("\n── Settings → Appearance → Theme ──");
  await send("Page.navigate", { url: `${SITE}/?view=dashboard#${hash}` }, sessionId);
  await sleep(5000);
  // Start from the opposite value, so "it is saved" cannot pass because it was
  // already light — and do it here, before Settings is opened.
  await setSetting("pref_theme", "dark");
  await ev(`localStorage.setItem('the-salad-theme', 'dark')`);
  await send("Page.navigate", { url: `${SITE}/?view=settings` }, sessionId);
  await sleep(11000);
  // Appearance is on the Preferences tab, and Settings does not open on it.
  let tabbed = false;
  for (let i = 0; i < 8 && !tabbed; i++) {
    tabbed = await clickElement(`[...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === 'Preferences')`);
    if (!tabbed) await sleep(1500);
  }
  check("the Preferences tab was opened", tabbed === true);
  await sleep(3000);
  const onSettings = await ev(`/Appearance/i.test(document.body.innerText)`);
  check("Appearance is on screen", onSettings === true,
    String(await ev(`document.body.innerText.slice(0, 160)`)).replace(/\n/g, " | "));

  const shownTheme = await ev(`${THEME_SELECT}?.textContent?.trim() ?? null`);
  console.log("  the Theme control shows:", JSON.stringify(shownTheme));
  const beforeReload = String(shownTheme).toLowerCase();
  check("the Theme control shows the preference the account has",
    beforeReload.includes("dark"), `control says ${shownTheme}, and the account was just set to dark`);

  // Choose Light, by keyboard: Radix's list does not open for a dispatched mouse
  // gesture in headless Chrome — tried a plain click and a full move/hover/press
  // /pause/release — but focusing the trigger and pressing Enter does open it,
  // and the arrow keys move to the next choice.
  const focused = await ev(`(() => { const el = ${THEME_SELECT}; if (!el) return false; el.focus(); return true })()`);
  check("the theme control can be focused", focused === true);
  for (const key of ["Enter", "ArrowDown", "Enter"]) {
    const code = key === "Enter" ? "Enter" : "ArrowDown";
    const vk = key === "Enter" ? 13 : 40;
    await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk }, sessionId);
    await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk }, sessionId);
    await sleep(900);
  }
  await sleep(2500);
  const shownNow = await ev(`${THEME_SELECT}?.textContent?.trim() ?? null`);
  check("Light was chosen", /light/i.test(String(shownNow)), `the control now says ${shownNow}`);

  check("choosing it applies immediately", (await isDark()) === false, "the document is still dark");
  await sleep(1500);
  const storedPref = await readSetting("pref_theme");
  check("and it is saved as the account's preference", storedPref === "light",
    `settings.pref_theme is ${storedPref} — the control applied the change but kept the old value`);

  // The symptom this is really about: reload and see whether it stuck.
  await send("Page.reload", {}, sessionId);
  await sleep(10000);
  const stillLight = (await isDark()) === false;
  // A reload puts Settings back on its first tab, so the Appearance control has
  // to be brought up again before it can be read.
  for (let i = 0; i < 6; i++) {
    const ok = await clickElement(`[...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === 'Preferences')`);
    if (ok) break;
    await sleep(1500);
  }
  await sleep(2500);
  const controlAfter = await ev(`${THEME_SELECT}?.textContent?.trim() ?? null`);
  check("it is still light after a reload", stillLight && /light/i.test(String(controlAfter)),
    `document dark=${!stillLight}, control says ${controlAfter}`);

  // ---- B. the onboarding step -------------------------------------------
  console.log("\n── Onboarding → Customize → Menu Theme ──");
  const cardPressed = (name: string) => ev(`(() => {
    const card = [...document.querySelectorAll('button')]
      .filter((b) => (b.innerText || '').includes(${JSON.stringify(name)}))
      .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
    return card ? card.getAttribute('aria-pressed') === 'true' : null;
  })()`);

  /**
   * Open the flow and walk to the Customize step — it opens at step 1, and the
   * menu theme lives on step 3. Checking the step without getting there is how
   * this read "the theme cards are missing" when nothing was on screen at all.
   */
  const openOnboarding = async () => {
    await send("Page.navigate", { url: `${SITE}/?view=onboarding` }, sessionId);
    await sleep(11000);
    // Step 1 is a form with required fields and will not let Continue through
    // while any are empty, so the flow is resumed at step 3 through the draft it
    // keeps in this browser. Nothing is saved and the draft is local.
    const moved = await ev(`(() => {
      const raw = localStorage.getItem('the-salad-onboarding');
      if (!raw) return 'no draft';
      try {
        const draft = JSON.parse(raw);
        draft.step = 3;
        localStorage.setItem('the-salad-onboarding', JSON.stringify(draft));
        return 'moved';
      } catch { return 'unreadable draft'; }
    })()`);
    if (moved !== 'moved') return String(moved);
    await send("Page.reload", {}, sessionId);
    await sleep(11000);
    return Boolean(await ev(`/Menu Theme/i.test(document.body.innerText)`));
  };

  await setSetting("menu_theme", "dark");
  const reached = await openOnboarding();
  check("the Customize step is showing", reached === true,
    `openOnboarding said ${reached}; page: ` + String(await ev(`document.body.innerText.slice(0, 140)`)).replace(/\n/g, " | "));
  const darkSelected = await cardPressed("Dark Mode");
  check("with the dark menu saved, the dark card is the selected one", darkSelected === true,
    `aria-pressed=${darkSelected} — the step is showing its own default, not the restaurant's theme`);

  await setSetting("menu_theme", "light");
  // Drop the draft, so the step is seeded again from the account rather than
  // carried over from the check above.
  await ev(`localStorage.removeItem('the-salad-onboarding')`);
  await openOnboarding();
  const lightSelected = await cardPressed("Light Mode");
  check("and with the light menu saved, the light card is", lightSelected === true, `aria-pressed=${lightSelected}`);

  // ---- C. what the diner actually gets ----------------------------------
  console.log("\n── the customer's menu ──");
  for (const wanted of ["dark", "light"] as const) {
    await setSetting("menu_theme", wanted);
    // The owner's own app theme is set to the opposite, to prove the menu does
    // not follow the owner around.
    await ev(`localStorage.setItem('the-salad-theme', ${JSON.stringify(wanted === "dark" ? "light" : "dark")})`);
    await send("Page.navigate", { url: `${SITE}/?table=${(table as any)?.qr_token}` }, sessionId);
    await sleep(9000);
    const menuIsDark = await isDark();
    check(`a ${wanted} menu is shown as ${wanted}`, menuIsDark === (wanted === "dark"),
      `document dark=${menuIsDark} while the restaurant's theme is ${wanted}`);
  }
} catch (e) {
  check("the theme checks ran", false, (e as Error).message);
} finally {
  chrome.kill();
  await sleep(400);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* gone */ }
  await setSetting("menu_theme", savedMenuTheme);
  await setSetting("pref_theme", savedPrefTheme);
  console.log(`\n  settings restored: menu_theme=${savedMenuTheme} pref_theme=${savedPrefTheme}`);
}

console.log(`\n${pass}/${pass + fail} checks passed${fail ? ` — ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
