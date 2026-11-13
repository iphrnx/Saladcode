/**
 * Check the public legal pages the way a visitor meets them.
 *
 * Four pages, at a phone width and a desktop width: the route renders, the
 * footer links to it from the landing page, nothing overflows sideways, and the
 * page is not a wall of text with no way back. Screenshots are written to
 * /root/downloads for each page at phone width, and one of the landing footer.
 *
 *   SITE_URL=http://localhost:3100 npm run test:legal-pages
 */
import fs from "node:fs";
import { spawn } from "node:child_process";

const SITE = process.env.SITE_URL ?? "http://localhost:3100";
const PORT = Number(process.env.CDP_PORT ?? 9271);
const PAGES = [
  { path: "/privacy", heading: "Privacy Policy", must: ["Digital Personal Data Protection Act", "Grievance officer"] },
  { path: "/terms", heading: "Terms & Conditions", must: ["Governing law and jurisdiction", "Free trial, subscriptions and payment"] },
  { path: "/cookies", heading: "Cookie Policy", must: ["the-salad-staff-session", "sb-…-auth-token"] },
  { path: "/contact", heading: "Contact us", must: ["Grievance officer", "Product support"] },
];

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

const profile = `/tmp/chrome-legal-${PORT}`;
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn("google-chrome", [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "about:blank",
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

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 1000 },
];

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
  const ev = async (expr: string) =>
    (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId))?.result?.value;

  // The landing page's footer is the way in. Its links must exist and be real.
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send("Page.navigate", { url: `${SITE}/` }, sessionId);
  await sleep(4000);
  const footerLinks = await ev(`
    JSON.stringify([...document.querySelectorAll('footer nav[aria-label="Legal"] a')].map((a) => [a.textContent.trim(), a.getAttribute('href')]))
  `);
  const links = JSON.parse(footerLinks || "[]");
  console.log("footer legal links:", footerLinks);
  check("the landing footer links to all four pages", links.length === 4, footerLinks);
  for (const [label, href] of links) {
    check(`"${label}" points at ${href}`, typeof href === "string" && href.startsWith("/"), String(href));
  }
  // The footer is the thing being checked, so bring it into view before
  // capturing — a screenshot of the hero proves nothing about it.
  await ev(`document.querySelector('footer')?.scrollIntoView({ block: 'end' })`);
  await sleep(1200);
  const landingShot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
  fs.writeFileSync("/root/downloads/legal-footer-desktop.png", Buffer.from(landingShot.data, "base64"));
  // Returned raw and tidied here: a regex inside the template literal that
  // carries the expression to the page would have its backslash interpreted by
  // the template literal itself, and the page would receive broken JavaScript.
  const rawFooter = await ev(`document.querySelector('footer') ? document.querySelector('footer').innerText : ''`);
  const footerText = String(rawFooter ?? '').replace(/\s+/g, ' ');
  console.log("footer says:", JSON.stringify(footerText).slice(0, 220));
  check("the footer names the policies", /Privacy Policy/.test(footerText) && /Terms/.test(footerText) && /Cookie Policy/.test(footerText) && /Contact/.test(footerText), footerText);

  for (const viewport of VIEWPORTS) {
    console.log(`\n── ${viewport.name} ${viewport.width}×${viewport.height} ──`);
    await send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.width < 640,
    }, sessionId);

    for (const page of PAGES) {
      await send("Page.navigate", { url: `${SITE}${page.path}` }, sessionId);
      await sleep(2500);
      const info = await ev(`JSON.stringify({
        title: document.title,
        h1: (document.querySelector('h1')?.textContent || '').trim(),
        text: document.body.innerText,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        backLink: Boolean(document.querySelector('a[href="/"]')),
        links: [...document.querySelectorAll('a')].filter((a) => a.getAttribute('href')?.startsWith('/')).map((a) => a.getAttribute('href')),
      })`);
      const p = JSON.parse(info);
      check(`${page.path} renders`, p.h1 === page.heading, `h1 was "${p.h1}"`);
      check(`${page.path} has no sideways overflow`, p.overflow <= 1, `overflow ${p.overflow}px`);
      check(`${page.path} has a way back to the site`, p.backLink === true, "no link to /");
      check(`${page.path} title is set`, p.title.includes(page.heading) || p.title.includes("The Salad"), p.title);
      for (const phrase of page.must) {
        // Case-insensitive: some labels are uppercased by CSS, and innerText
        // returns what is rendered, so a case-sensitive match reports a missing
        // section that is right there on the page.
        const found = p.text.toLowerCase().includes(phrase.toLowerCase());
        check(`${page.path} covers "${phrase.slice(0, 34)}"`, found, "not found in the page text");
      }
      const bad = p.links.filter((h: string) => !["/", "/privacy", "/terms", "/cookies", "/contact"].includes(h));
      check(`${page.path} has no link to a route that does not exist`, bad.length === 0, JSON.stringify(bad));

      if (viewport.name === "phone") {
        const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId);
        const file = `/root/downloads/legal${page.path.replace("/", "-")}-phone.png`;
        fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
      }
    }
  }

  console.log(`\n${pass}/${pass + fail} checks passed${fail ? ` — ${fail} FAILED` : ""}`);
} catch (e) {
  console.log("failed:", (e as Error).message);
} finally {
  chrome.kill();
}
