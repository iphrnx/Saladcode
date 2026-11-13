/**
 * Prove the Settings Save button cannot get stuck on "Saving…".
 *
 * The reported bug: press Save, the button reads "Saving…" for ever and stays
 * disabled. This drives the real page, makes the form dirty (a preference
 * switch), presses Save, and watches the button until it is back to "Save
 * Changes". It then flips the switch back and saves again, so the account is
 * left exactly as it was found.
 *
 *   NEXT_PUBLIC_SUPABASE_URL=… NEXT_PUBLIC_SUPABASE_ANON_KEY=… \
 *   SUPABASE_SERVICE_ROLE_KEY=… npx tsx scripts/verify-settings-save.mts
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SITE = process.env.SITE_URL ?? "https://www.thesalad.in";
const EMAIL = process.env.EMAIL ?? "phrnx@icloud.com";
const PORT = Number(process.env.CDP_PORT ?? 9231);

const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });
const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const c = createClient(SB, ANON, { auth: { persistSession: false } });
const { data: session } = await c.auth.verifyOtp({
  token_hash: link!.properties.hashed_token,
  type: "magiclink",
});
const s = session!.session!;

const profile = `/tmp/chrome-verify-settings-${PORT}`;
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn("google-chrome", [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--window-size=1440,1000", "about:blank",
], { stdio: "ignore" });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let ws: WebSocket | null = null;
let id = 0;
const pending = new Map<number, (v: any) => void>();
function send(method: string, params: any = {}, sessionId?: string): Promise<any> {
  return new Promise((resolve) => {
    const msgId = ++id;
    pending.set(msgId, resolve);
    ws!.send(JSON.stringify({ id: msgId, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

/** The Save button, by its own text. */
const SAVE_BUTTON_STATE = `(() => {
  const btn = [...document.querySelectorAll('button')]
    .find((b) => /Save Changes|Saving…/.test(b.textContent || ''));
  if (!btn) return JSON.stringify({ found: false });
  return JSON.stringify({
    found: true,
    label: (btn.textContent || '').trim(),
    disabled: btn.disabled,
    spinner: Boolean(btn.querySelector('svg.animate-spin, .animate-spin')),
  });
})()`;

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
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)!(msg.result); pending.delete(msg.id); }
  };
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 2, mobile: false }, sessionId);

  const hash = new URLSearchParams({
    access_token: s.access_token,
    refresh_token: s.refresh_token,
    expires_at: String(s.expires_at),
    expires_in: String(s.expires_in),
    token_type: s.token_type,
    type: "magiclink",
  }).toString();

  const evalJs = async (expression: string) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    return r?.result?.value;
  };

  await send("Page.navigate", { url: `${SITE}/?view=settings#${hash}` }, sessionId);
  await sleep(4000);
  await send("Page.navigate", { url: `${SITE}/?view=settings` }, sessionId);
  await sleep(9000);

  console.log("page:", JSON.stringify(await evalJs("document.body.innerText.slice(0, 90)")));
  console.log("save button on load:", await evalJs(SAVE_BUTTON_STATE));

  /**
   * Flip one preference switch, save, and watch the button.
   *
   * The dirty check is part of the test: if pressing Save does nothing, the
   * button never enters the saving state and a "the button came back" result
   * would be meaningless. So the flip has to enable the button first.
   */
  const saveRound = async (round: number, switchIndex: number) => {
    // Radix activates a tab on pointer events, not on a bare click.
    const tabClicked = await evalJs(`(() => {
      const tab = [...document.querySelectorAll('[role=tab]')]
        .find((b) => (b.textContent || '').trim() === 'Preferences');
      if (!tab) return false;
      const fire = (type) => tab.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(
        type, { bubbles: true, cancelable: true, view: window, pointerId: 1, isPrimary: true, button: 0 },
      ));
      fire('pointerdown'); fire('mousedown'); fire('pointerup'); fire('mouseup'); fire('click');
      return true;
    })()`);
    await sleep(1500);

    const switches = await evalJs(`
      [...document.querySelectorAll('[role=switch]')].filter((s) => s.offsetParent !== null).length
    `);
    console.log(`round ${round}: Preferences tab clicked = ${tabClicked}, switches visible = ${switches}`);

    const flipped = await evalJs(`(() => {
      const list = [...document.querySelectorAll('[role=switch]')].filter((s) => s.offsetParent !== null);
      const sw = list[${switchIndex}];
      if (!sw) return false;
      sw.click();
      return true;
    })()`);
    await sleep(800);

    const before = JSON.parse(await evalJs(SAVE_BUTTON_STATE));
    console.log(`round ${round}: flipped switch =`, flipped, "| button now", JSON.stringify(before));
    if (!flipped || before.disabled) {
      console.log(`round ${round}: INCONCLUSIVE — the form never became dirty, so Save was never exercised`);
      return null;
    }

    await evalJs(`(() => {
      const btn = [...document.querySelectorAll('button')]
        .find((b) => /Save Changes/.test(b.textContent || '') && !b.disabled);
      btn?.click();
      return Boolean(btn);
    })()`);

    // Watch for up to 25s. The settings PUT is slow while the old edge function
    // is still deployed — exactly the case this has to survive.
    let sawSaving = false;
    let finalState: any = null;
    for (let i = 0; i < 50; i++) {
      await sleep(500);
      const state = JSON.parse(await evalJs(SAVE_BUTTON_STATE));
      if (/Saving/.test(state.label)) sawSaving = true;
      if (i === 1) console.log(`round ${round}: 1s in`, JSON.stringify(state));
      finalState = state;
      if (sawSaving && !/Saving/.test(state.label)) break;
    }
    const toasts = await evalJs(`[...document.querySelectorAll('[data-sonner-toast], li[role=status]')].map((t) => (t.textContent || '').trim()).join(' | ')`);
    const stuck = /Saving/.test(finalState?.label ?? "");
    console.log(`round ${round}: settled as`, JSON.stringify(finalState));
    console.log(`round ${round}: saw the saving state = ${sawSaving}; toasts = ${JSON.stringify(toasts).slice(0, 200)}`);
    console.log(`round ${round}: RESULT`, stuck ? "FAIL — still stuck on Saving…" : !sawSaving ? "INCONCLUSIVE — never entered the saving state" : "PASS — the button came back");
    return stuck ? false : sawSaving;
  };

  const one = await saveRound(1, 1);
  const two = await saveRound(2, 1); // the same switch, flipped back

  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId);
  const out = "/root/downloads/settings-save-verified.png";
  fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log("screenshot:", out);
  if (one === null || two === null) console.log("INCONCLUSIVE — the test never got the button disabled-then-saving");
  else console.log(one && two ? "ALL ROUNDS PASSED" : "SOMETHING IS STILL WRONG");
} catch (e) {
  console.log("failed:", (e as Error).message);
} finally {
  chrome.kill();
}
