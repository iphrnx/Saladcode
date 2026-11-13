/**
 * The POS cart controls, clicked like a human clicks.
 *
 * The frozen-cart bug: a portioned line's identity is its portionId
 * ("custom-…"), but the +/-/remove buttons addressed the line by portion NAME
 * only, so sameLine never matched and every control silently no-op'd. This
 * drives the real UI with CDP input events on both form factors and refuses
 * to pass unless every control moves the line it was clicked on.
 *
 *   npm run test:pos-cart-ui                     (localhost:3000)
 *   BASE=https://www.thesalad.in npm run test:pos-cart-ui   (live)
 *   MOBILE=1 ... same, at 390px with touch events
 */
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!; const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!; const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BASE = process.env.BASE ?? "http://localhost:3000";
const PORT = Number(process.env.CDP_PORT ?? 9550);
const MOBILE = process.env.MOBILE === "1";
let pass = 0, fail = 0;
const check = (l: string, ok: boolean, d?: string) => { if (ok) pass++; else fail++; console.log(`  ${ok ? "ok  " : "FAIL"}  ${l}${d && !ok ? ` [${d}]` : ""}`); };
const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });
const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: "zhut@demo.com" });
const cc = createClient(SB, ANON, { auth: { persistSession: false } });
const { data: session } = await cc.auth.verifyOtp({ token_hash: (link!.properties as any).hashtoken ?? (link!.properties as any).hashed_token, type: "magiclink" });
const s = session!.session!;
const ref = new URL(SB).hostname.split(".")[0]; const KEY = `sb-${ref}-auth-token`;
const so = { access_token: s.access_token, refresh_token: s.refresh_token, token_type: s.token_type, expires_in: s.expires_in, expires_at: s.expires_at, user: s.user };
const val = "base64-" + Buffer.from(JSON.stringify(so), "utf8").toString("base64url");
const chrome = spawn("google-chrome", ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/chrome-cart-${PORT}-${Date.now()}`, "--no-sandbox", "--disable-gpu", "about:blank"], { stdio: "ignore" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let ws: WebSocket | null = null; let id = 0; const pending = new Map<number, (v: any) => void>(); const errs: string[] = [];
const send = (m: string, p: any = {}, sid?: string) => new Promise<any>((res) => { const i = ++id; pending.set(i, res); ws!.send(JSON.stringify({ id: i, method: m, params: p, ...(sid ? { sessionId: sid } : {}) })); });
let version: any = null; for (let i = 0; i < 40; i++) { try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(250); } }
ws = new WebSocket(version.webSocketDebuggerUrl) as unknown as WebSocket; await new Promise((r) => (ws!.onopen = r));
ws.onmessage = (e: any) => { const m = JSON.parse(e.data); if (m.method === "Runtime.exceptionThrown") errs.push("EXC: " + ((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || "").split("\n")[0]).slice(0, 200)); if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errs.push("ERR: " + (m.params.args?.map((a: any) => a.value ?? a.description ?? "").join(" ")).slice(0, 200)); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result); pending.delete(m.id); } };
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId: sid } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Page.enable", {}, sid); await send("Runtime.enable", {}, sid);
const ev = async (x: string) => (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }, sid))?.result?.value;
const shot = async (n: string) => fs.writeFileSync(n, Buffer.from((await send("Page.captureScreenshot", { format: "png" }, sid)).data, "base64"));
if (MOBILE) await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sid); else await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sid);
if (val.length <= 3180) await send("Network.setCookie", { name: KEY, value: val, url: BASE, path: "/", sameSite: "Lax" }, sid);
else for (let i = 0, o = 0; o < val.length; i++, o += 3180) await send("Network.setCookie", { name: `${KEY}.${i}`, value: val.slice(o, o + 3180), url: BASE, path: "/", sameSite: "Lax" }, sid);
await send("Page.navigate", { url: `${BASE}/?view=dashboard` }, sid); await sleep(9000);
// clear any persisted POS cart so we start from empty
await ev(`(()=>{Object.keys(localStorage).filter(k=>/pos-cart|cart/.test(k)).forEach(k=>localStorage.removeItem(k));return 1})()`);
await send("Page.navigate", { url: `${BASE}/?view=dashboard` }, sid); await sleep(8000);
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>/^Accept All$/.test((b.textContent||'').trim()));if(b)b.click();return 1})()`); await sleep(600);
console.log(`\n=== ${MOBILE ? "MOBILE 390" : "DESKTOP 1440"} ===`);
async function click(loc: string) { const b = await ev(`(()=>{const el=${loc};if(!el)return null;const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`); if (!b) return false; if (MOBILE) { await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: b.x, y: b.y }] }, sid); await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, sid); } else { await send("Input.dispatchMouseEvent", { type: "mousePressed", x: b.x, y: b.y, button: "left", clickCount: 1 }, sid); await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", clickCount: 1 }, sid); } return true; }
// qty of the single cart line's stepper (exact class, in the cart panel)
const readQty = `(()=>{const q=[...document.querySelectorAll('span')].find(s=>/^\\d+$/.test((s.textContent||'').trim())&&(s.className||'').indexOf('min-w-[1.5rem]')>=0);return q?(q.textContent||'').trim():'?'})()`;
const readSub = `(()=>{const m=document.body.innerText.match(/Sub total\\s*₹?([\\d.]+)/);return m?m[1]:'?'})()`;
const cardLoc = `[...document.querySelectorAll('div[role="button"]')].find(d=>/Classic Maggie/.test(d.innerText||'')&&/₹39/.test(d.innerText||''))`;
const plusLoc = `[...document.querySelectorAll("button")].find(b=>b.offsetWidth>0&&(()=>{const p=b.parentElement;return p&&(p.className||"").indexOf("bg-secondary rounded-lg")>=0&&[...p.querySelectorAll("button")].indexOf(b)===1})())`;
const minusLoc = `[...document.querySelectorAll('button')].find(b=>b.offsetWidth>0&&(()=>{const p=b.parentElement;return p&&(p.className||'').indexOf('bg-secondary rounded-lg')>=0&&[...p.querySelectorAll('button')].indexOf(b)===0})())`;
const trashLoc = `[...document.querySelectorAll('button')].find(b=>b.offsetWidth>0&&(b.className||'').indexOf('text-destructive')>=0&&b.querySelector('svg'))`;
await click(cardLoc); await sleep(700);
if (MOBILE) { await click(`[...document.querySelectorAll('button')].find(b=>/items/.test(b.textContent||'')&&(b.className||'').indexOf('fixed')>=0)`); await sleep(1500); }
const q0 = await ev(readQty), s0 = await ev(readSub);
check(`add -> qty 1, subtotal 39 (qty=${q0} sub=${s0})`, q0 === "1" && s0 === "39.00");
await click(plusLoc); await sleep(600);
const q1 = await ev(readQty), s1 = await ev(readSub);
check(`+ -> qty 2, subtotal 78 (qty=${q1} sub=${s1})`, q1 === "2" && s1 === "78.00");
await click(minusLoc); await sleep(600);
const q2 = await ev(readQty), s2 = await ev(readSub);
check(`- -> qty 1, subtotal 39 (qty=${q2} sub=${s2})`, q2 === "1" && s2 === "39.00");
await click(trashLoc); await sleep(700);
const q3 = await ev(readQty), s3 = await ev(readSub);
check(`remove -> line gone (qty=${q3} sub=${s3})`, q3 === "?" );
// ── the frozen-cart scenario: a PORTIONED line (id differs from name slug) ──
if (MOBILE) { // close the sheet so the dish cards are reachable again
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, sid);
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, sid);
  await sleep(800);
}
// click the Spicy Handi Maggie card body (upper half — clear of the portion selector)
await ev(`(()=>{const el=[...document.querySelectorAll('div[role="button"]')].find(d=>/Spicy Handi Maggie/.test(d.innerText||''));if(el)el.scrollIntoView({block:'center'});return 1})()`); await sleep(500);
const shmBox = await ev(`(()=>{const el=[...document.querySelectorAll('div[role="button"]')].find(d=>/Spicy Handi Maggie/.test(d.innerText||''));if(!el)return null;const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height*0.35}})()`);
if (shmBox) { if (MOBILE) { await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: shmBox.x, y: shmBox.y }] }, sid); await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, sid); } else { await send("Input.dispatchMouseEvent", { type: "mousePressed", x: shmBox.x, y: shmBox.y, button: "left", clickCount: 1 }, sid); await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: shmBox.x, y: shmBox.y, button: "left", clickCount: 1 }, sid); } }
await sleep(700);
if (MOBILE) { await click(`[...document.querySelectorAll('button')].find(b=>/items/.test(b.textContent||'')&&(b.className||'').indexOf('fixed')>=0)`); await sleep(1200); }
const p0 = await ev(readQty), ps0 = await ev(readSub);
check(`portion add -> qty 1, subtotal 89 (qty=${p0} sub=${ps0})`, p0 === "1" && ps0 === "89.00");
await click(plusLoc); await sleep(600);
const p1 = await ev(readQty), ps1 = await ev(readSub);
check(`portion + -> qty 2, subtotal 178 (qty=${p1} sub=${ps1})`, p1 === "2" && ps1 === "178.00");
await click(minusLoc); await sleep(600);
const p2 = await ev(readQty), ps2 = await ev(readSub);
check(`portion − -> qty 1, subtotal 89 (qty=${p2} sub=${ps2})`, p2 === "1" && ps2 === "89.00");
await click(trashLoc); await sleep(700);
const p3 = await ev(readQty), ps3 = await ev(readSub);
check(`portion remove -> gone (qty=${p3} sub=${ps3})`, p3 === "?");
await shot(`/tmp/cart-${MOBILE ? "m" : "d"}-final.png`);
check("no console errors", errs.length === 0, errs.slice(0, 3).join("|"));
console.log(`\n  ${pass} passed, ${fail} failed`);
chrome.kill(); process.exit(fail ? 1 : 0);
