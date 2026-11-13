/**
 * E2E Part B (browser): the confirmation link → session → onboarding resume,
 * duplicate/refresh safety, dashboard guard, login routing — then cleanup of
 * the test tenant Part A created.
 *
 * Requires: `npm run dev` running, and Part A first
 * (SUPABASE_SERVICE_ROLE_KEY=… npx tsx --env-file=.env.local scripts/test-signup-flow.mts),
 * which writes /tmp/signup-e2e-state.json and /tmp/confirm-url.txt.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 9333;
const profileDir = mkdtempSync(join(tmpdir(), "chrome-e2e-"));
const chrome = spawn("/usr/bin/google-chrome", [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`,
  "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--window-size=1280,900", "about:blank",
], { stdio: "ignore" });
await new Promise(r => setTimeout(r, 1500));

const ws = new WebSocket((await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();
const sessionId = { value: "" };
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const send = (method: string, params: any = {}, session?: string) => new Promise<any>((resolve) => {
  const id = ++msgId;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params, sessionId: session ?? (sessionId.value || undefined) }));
});
await new Promise(r => { ws.onopen = r; });

const { result: { targetId } } = await send("Target.createTarget", { url: "about:blank" });
const { result: { sessionId: sid } } = await send("Target.attachToTarget", { targetId, flatten: true });
sessionId.value = sid;
await send("Page.enable");
await send("Runtime.enable");

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function navigate(url: string) {
  await send("Page.navigate", { url });
  await sleep(7000); // dev compile + data fetch
}
async function evaljs(expr: string): Promise<any> {
  const { result } = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  return result?.result?.value;
}
async function bodyText(): Promise<string> {
  const { result } = await send("Runtime.evaluate", { expression: "document.body.innerText", returnByValue: true });
  return result?.result?.value ?? "";
}
async function currentUrl(): Promise<string> {
  const { result } = await send("Runtime.evaluate", { expression: "window.location.href", returnByValue: true });
  return result?.result?.value ?? "";
}
async function shot(name: string) {
  const { result } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync(`/tmp/e2e-${name}.png`, Buffer.from(result.data, "base64"));
}

let pass = 0, fail = 0;
const ok = (name: string, cond: any, detail?: any) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail !== undefined ? " — " + String(detail).slice(0, 200) : ""}`); }
};

const confirmUrl = readFileSync("/tmp/confirm-url.txt", "utf8").trim();
const { EMAIL, PASSWORD, tenantId } = JSON.parse(readFileSync("/tmp/signup-e2e-state.json", "utf8"));

console.log("— B1. Confirmation link opens the confirm view —");
await navigate(confirmUrl);
await shot("b1-confirm");
let text = await bodyText();
ok("confirm view rendered", text.includes("Confirming your email") || text.includes("Create Restaurant") || text.includes("Build Your Menu") || text.includes("Checking session"), text.slice(0, 150));

// It should route through to the wizard (onboardingDone false).
await sleep(6000);
text = await bodyText();
const url1 = await currentUrl();
ok("routed into onboarding", url1.includes("view=onboarding") || text.includes("Create Restaurant"), `${url1} | ${text.slice(0, 120)}`);
ok("fragment stripped from the URL", !url1.includes("access_token"), url1.slice(0, 120));
await shot("b1-onboarding");

console.log("— B2. Wizard prefilled from the account —");
const html = await (async () => {
  const { result } = await send("Runtime.evaluate", { expression: "document.body.innerHTML", returnByValue: true });
  return result?.result?.value ?? "";
})();
ok("restaurant name prefilled", html.includes("Signup Flow Test Cafe"), "");
ok("owner name prefilled", html.includes("E2E Tester"), "");
ok("email prefilled", html.includes(EMAIL), "");

console.log("— B3. Duplicate link click is safe —");
await navigate(confirmUrl);
await sleep(3500);
const url3 = await currentUrl();
text = await bodyText();
ok("duplicate click still reaches the wizard", url3.includes("view=onboarding") || text.includes("Create Restaurant") || text.includes("Build Your Menu"), `${url3} | ${text.slice(0, 120)}`);

console.log("— B4. Refresh at the confirm view (no fragment) —");
await navigate("http://localhost:3000/?view=confirm-email");
await sleep(3500);
const url4 = await currentUrl();
text = await bodyText();
ok("refresh routes by the existing session", url4.includes("view=onboarding") || text.includes("Create Restaurant"), `${url4} | ${text.slice(0, 120)}`);

console.log("— B5. Draft survives a reload (exact step) —");
// Type into the restaurant name field, then move to step 2, then reload.
// Wait for the account prefill to arrive before editing.
let prefilled = false;
for (let i = 0; i < 20 && !prefilled; i++) {
  prefilled = await evaljs(`[...document.querySelectorAll('input')].some(i => (i.value||'').includes('Signup Flow Test Cafe'))`);
  if (!prefilled) await sleep(1000);
}
ok("wizard prefilled from the account", prefilled, "");
await evaljs(`
  (function(){
    const inputs = [...document.querySelectorAll('input')];
    const nameInput = inputs.find(i => (i.value||'').includes('Signup Flow Test Cafe'));
    if (nameInput) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(nameInput, 'Signup Flow Test Cafe Renamed');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return Boolean(nameInput);
  })()`);
await sleep(1500);
// Move to step 2 via the Continue button.
await send("Runtime.evaluate", { expression: `
  (function(){
    const btns = [...document.querySelectorAll('button')];
    const next = btns.find(b => /continue|next/i.test(b.innerText) && !b.disabled);
    if (next) { next.click(); return true; }
    return false;
  })()`, returnByValue: true });
await sleep(1500);
text = await bodyText();
const onStep2 = text.includes("Build Your Menu");
ok("advanced to step 2", onStep2, text.slice(0, 150));
await shot("b5-step2");
await navigate("http://localhost:3000/?view=onboarding");
await sleep(3500);
text = await bodyText();
const html5 = await (async () => {
  const { result } = await send("Runtime.evaluate", { expression: "document.body.innerHTML", returnByValue: true });
  return result?.result?.value ?? "";
})();
ok("reload resumes at step 2", text.includes("Build Your Menu"), text.slice(0, 150));
// Go back to step 1 and read the input VALUE (React-controlled inputs do not
// put the value into innerHTML).
await evaljs(`(function(){ const b = [...document.querySelectorAll('button')].find(b => /back/i.test(b.innerText)); if (b) b.click(); return true; })()`);
await sleep(1500);
const nameValue = await evaljs(`([...document.querySelectorAll('input')].find(i => (i.value||'').includes('Signup Flow Test Cafe')) || {}).value || ''`);
ok("edited name persisted", nameValue.includes("Renamed"), nameValue);

console.log("— B6. Dashboard attempt bounces to the wizard —");
await navigate("http://localhost:3000/?view=dashboard");
await sleep(4500);
const url6 = await currentUrl();
text = await bodyText();
ok("AppShell guard routes incomplete setup to the wizard", url6.includes("view=onboarding") || text.includes("Create Restaurant") || text.includes("Build Your Menu"), `${url6} | ${text.slice(0, 120)}`);

console.log("— B7. Sign out, log in with the confirmed account —");
// Clear the session, then use the real login form.
await send("Runtime.evaluate", { expression: "localStorage.clear(); document.cookie.split(';').forEach(c => document.cookie = c.split('=')[0] + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/'); true", returnByValue: true });
await navigate("http://localhost:3000/?view=login");
await sleep(3000);
text = await bodyText();
ok("login form shown", text.includes("Sign In") || text.includes("Welcome back"), text.slice(0, 120));
// Fill the form.
await send("Runtime.evaluate", { expression: `
  (function(){
    const set = (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const inputs = [...document.querySelectorAll('input')];
    const email = inputs.find(i => i.type === 'email' || /email/i.test(i.placeholder || ''));
    const pw = inputs.find(i => i.type === 'password');
    if (!email || !pw) return 'missing inputs: ' + inputs.map(i => i.type).join(',');
    set(email, ${JSON.stringify(EMAIL)});
    set(pw, ${JSON.stringify(PASSWORD)});
    return 'ok';
  })()`, returnByValue: true });
await sleep(600);
await send("Runtime.evaluate", { expression: `
  (function(){
    const form = document.querySelector('form');
    if (!form) return 'no form';
    const btn = form.querySelector('button[type=submit]') || [...form.querySelectorAll('button')].pop();
    btn.click();
    return 'clicked';
  })()`, returnByValue: true });
await sleep(5000);
const url7 = await currentUrl();
text = await bodyText();
ok("login lands in the wizard (incomplete setup)", url7.includes("view=onboarding") || url7.includes("view=dashboard"), url7);
ok("wizard visible after login", text.includes("Create Restaurant") || text.includes("Build Your Menu"), text.slice(0, 150));
await shot("b7-after-login");

console.log("— B8. Cleanup: the test tenant leaves no trace —");
const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });
const state = JSON.parse(readFileSync("/tmp/signup-e2e-state.json", "utf8"));
if (!state.tenantId || !state.authUserId) {
  console.log("  (skipped — no completed signup in the state file; nothing to clean)");
  console.log(`\nPART B: ${pass} passed, ${fail} failed`);
  chrome.kill();
  process.exit(fail > 0 ? 1 : 0);
}
// Dependency order: audit and children first, the tenant and auth user last.
await admin.from("security_logs").delete().eq("tenant_id", state.tenantId);
await admin.from("email_events").delete().eq("tenant_id", state.tenantId);
await admin.from("roles").delete().eq("tenant_id", state.tenantId);
await admin.from("profiles").delete().eq("tenant_id", state.tenantId);
await admin.from("settings").delete().eq("tenant_id", state.tenantId);
await admin.from("tenants").delete().eq("id", state.tenantId);
await admin.auth.admin.deleteUser(state.authUserId);
const { count: remainingTenants } = await admin.from("tenants").select("id", { count: "exact", head: true }).eq("id", state.tenantId);
const { count: remainingProfiles } = await admin.from("profiles").select("id", { count: "exact", head: true }).eq("id", state.authUserId);
ok("tenant removed", remainingTenants === 0, remainingTenants);
ok("owner profile removed", remainingProfiles === 0, remainingProfiles);

console.log(`\nPART B: ${pass} passed, ${fail} failed`);
chrome.kill();
process.exit(fail > 0 ? 1 : 0);
