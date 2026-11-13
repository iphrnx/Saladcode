/**
 * The contract between the Super Admin pages and the function behind them.
 *
 * Each page declares the shape it expects — `superAdminFetch<Overview>('overview')`
 * — and the function returns something. If a page reads a field the function
 * does not return, the page shows "undefined" or an empty box, and nobody
 * notices because a dashboard that renders is a dashboard that looks right.
 *
 * This compares each page's declared type against the real response.
 */
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const PANEL = path.join(process.cwd(), "src/app/superadmin/(panel)");

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail = "") {
  checks++;
  if (ok) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });
const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: "phrnx@icloud.com" });
const c = createClient(SB, ANON, { auth: { persistSession: false } });
const { data } = await c.auth.verifyOtp({ token_hash: link!.properties.hashed_token, type: "magiclink" });
const token = data!.session!.access_token;

async function call(path: string) {
  const res = await fetch(`${SB}/functions/v1/super-admin/${path}`, {
    headers: { apikey: ANON, authorization: `Bearer ${token}` },
  });
  return res.json();
}

/**
 * The top-level fields of a declared type, and the fields of the object
 * types it names. Good enough to catch a field that nothing returns.
 */
function typeFields(source: string, typeName: string): { top: string[]; nested: Record<string, string[]> } {
  const top: string[] = [];
  const nested: Record<string, string[]> = {};

  const block = new RegExp(`(?:type|interface)\\s+${typeName}\\s*=\\s*\\{([\\s\\S]*?)\\n\\}`, "m").exec(source);
  if (!block) return { top, nested };

  let depth = 0;
  let current = "";
  const parts: string[] = [];
  for (const ch of block[1]) {
    if (ch === "{") { depth++; current += ch; continue; }
    if (ch === "}") { depth--; current += ch; if (depth === 0) { parts.push(current); current = ""; } continue; }
    current += ch;
    if (ch === "\n" && depth === 0) { parts.push(current); current = ""; }
  }
  if (current.trim()) parts.push(current);

  for (const part of parts) {
    const m = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\??\s*:/.exec(part);
    if (!m) continue;
    const name = m[1];
    top.push(name);
    const inner = /\{([\s\S]*)\}\s*;?\s*$/.exec(part);
    if (inner) {
      const fields: string[] = [];
      for (const line of inner[1].split("\n")) {
        const im = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\??\s*:/.exec(line);
        if (im) fields.push(im[1]);
      }
      if (fields.length) nested[name] = fields;
    }
  }
  return { top, nested };
}

const PAGES: { label: string; file: string; type: string; endpoint: string; isArray?: boolean }[] = [
  { label: "Overview", file: "page.tsx", type: "Overview", endpoint: "overview" },
  { label: "CRM directory", file: "crm/page.tsx", type: "Restaurant", endpoint: "crm", isArray: true },
  { label: "CRM detail", file: "crm/[id]/page.tsx", type: "Detail", endpoint: "crm" },
  { label: "Conversion", file: "conversion/page.tsx", type: "Conversion", endpoint: "conversion" },
  { label: "Retention", file: "retention/page.tsx", type: "Retention", endpoint: "retention" },
  { label: "Payments", file: "payments/page.tsx", type: "Payments", endpoint: "payments" },
  { label: "Usage", file: "usage/page.tsx", type: "Usage", endpoint: "usage" },
  { label: "Reports", file: "reports/page.tsx", type: "Report", endpoint: "reports?from=2026-01-01&to=2026-12-31" },
];

for (const page of PAGES) {
  console.log(`\n── ${page.label} ──`);
  const file = path.join(PANEL, page.file);
  const source = fs.readFileSync(file, "utf-8");
  const { top, nested } = typeFields(source, page.type);

  let body = await call(page.endpoint);
  if (page.label === "CRM detail") {
    const { data: one } = await admin.from("tenants").select("id").limit(1);
    body = await call(`crm/${one![0].id}`);
  }

  const sample = page.isArray ? (body?.[0] ?? {}) : (body ?? {});
  if (page.isArray) {
    check(`${page.label} returns rows`, Array.isArray(body) && body.length > 0, `got ${JSON.stringify(body).slice(0, 80)}`);
  } else {
    check(`${page.label} returns an object`, body && !Array.isArray(body) && typeof body === "object", JSON.stringify(body).slice(0, 80));
  }

  for (const field of top) {
    const present = field in sample || (sample[field] !== undefined);
    check(`${page.label}.${field} is returned`, present, Object.keys(sample).join(", "));
  }
  for (const [name, fields] of Object.entries(nested)) {
    const raw = sample[name];
    if (!raw || typeof raw !== "object") {
      check(`${page.label}.${name} is present`, false, `got ${JSON.stringify(raw).slice(0, 60)}`);
      continue;
    }
    // A list of objects: the shape to check is the first row's.
    const obj = Array.isArray(raw) ? (raw[0] ?? {}) : raw;
    if (Array.isArray(raw) && raw.length === 0) {
      console.log(`        (${page.label}.${name} is empty — nothing to check)`);
      continue;
    }
    for (const field of fields) {
      check(`${page.label}.${name}.${field} is returned`, field in obj, Object.keys(obj).join(", "));
    }
  }
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
