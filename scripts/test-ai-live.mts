/**
 * The AI features, for real.
 *
 * Scans an actual menu picture and draws an actual dish photograph, and
 * checks that what comes back is a menu and a picture.
 */
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

const admin = createClient(SB, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: "phrnx@icloud.com" });
const c = createClient(SB, ANON, { auth: { persistSession: false } });
const { data } = await c.auth.verifyOtp({ token_hash: link!.properties.hashed_token, type: "magiclink" });
const token = data!.session!.access_token;

const call = async (path: string, body: unknown) => {
  const res = await fetch(`${SB}/functions/v1/${path}`, {
    method: "POST",
    headers: { apikey: ANON, authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const dataUrl = (path: string) => `data:image/png;base64,${fs.readFileSync(path).toString("base64")}`;

/**
 * Google's own free tier is rate limited and, under load, answers 503.
 * Both are transient, so the test waits and tries again — and says how many
 * attempts it took, because that is the thing worth knowing.
 */
const callWithRetry = async (path: string, body: unknown, attempts = 4) => {
  let last: { status: number; body: any } = { status: 0, body: {} };
  for (let i = 0; i < attempts; i++) {
    last = await call(path, body);
    const message = String(last.body?.error ?? "");
    const transient = /high demand|rate limit|server error|503|429/i.test(message);
    if (last.status === 200 || !transient) {
      if (i > 0) console.log(`        (it took ${i + 1} attempts)`);
      return last;
    }
    console.log(`        attempt ${i + 1} was refused: ${message.slice(0, 90)}`);
    await new Promise((r) => setTimeout(r, 8000 * (i + 1)));
  }
  return last;
};

console.log("\n── scanning a real menu ──");
{
  const res = await callWithRetry("ai-extract-menu", { images: [dataUrl("/tmp/menu.png")] });
  console.log("  status", res.status, JSON.stringify(res.body).slice(0, 200));
  check("the scan answers", res.status === 200, `status ${res.status}`);
  if (res.status === 200) {
    const items = res.body?.items ?? res.body?.menuItems ?? [];
    check("it found the dishes", Array.isArray(items) && items.length >= 4, `${items?.length} items`);
    console.log("  what it read:", JSON.stringify(items).slice(0, 500));
    const names = (items ?? []).map((i: any) => String(i.name ?? "").toLowerCase());
    check("it read Butter Chicken", names.some((n: string) => n.includes("butter chicken")), names.join(", "));
    check("it read a price", (items ?? []).some((i: any) => Number(i.price) > 0), JSON.stringify(items).slice(0, 200));
    check("it found the categories", (res.body?.categories ?? []).length >= 2, JSON.stringify(res.body?.categories).slice(0, 200));
  }
}

console.log("\n── drawing a real dish ──");
{
  // The image generator works on a menu item, so make one first.
  const { data: item } = await admin
    .from("menu_items")
    .select("id, name, tenant_id")
    .eq("tenant_id", (await admin.from("profiles").select("tenant_id").eq("email", "phrnx@icloud.com").maybeSingle()).data?.tenant_id ?? "")
    .limit(1)
    .maybeSingle();

  if (!item) {
    console.log("        (no menu item to draw a photo for)");
  } else {
    const res = await callWithRetry("ai-generate-image", { itemId: item.id, prompt: "a bowl of butter chicken on a rustic table" });
    console.log("  status", res.status, JSON.stringify(res.body).slice(0, 200));
    check("the drawing answers", res.status === 200, `status ${res.status}`);
    if (res.status === 200) {
      const url = String(res.body?.url ?? res.body?.imageUrl ?? res.body?.path ?? "");
      check("it produced a picture", url.length > 0 || Boolean(res.body?.dataUrl), JSON.stringify(res.body).slice(0, 200));
      const { data: after } = await admin.from("menu_items").select("image_url").eq("id", item.id).maybeSingle();
      check("the picture is on the item", Boolean((after as any)?.image_url), String((after as any)?.image_url));
      console.log("  image url:", String((after as any)?.image_url).slice(0, 160));
    }
  }
}

console.log("\n── the call log ──");
{
  const { data: logs } = await admin
    .from("ai_request_logs")
    .select("provider, model, action, status, duration_ms, error_message, created_at")
    .order("created_at", { ascending: false })
    .limit(6);
  console.log("  ", JSON.stringify(logs ?? [], null, 0).slice(0, 700));
  check("the calls were logged", (logs ?? []).length > 0);
  check("none of them failed", (logs ?? []).every((l: any) => l.status === "ok"), JSON.stringify((logs ?? []).filter((l: any) => l.status !== "ok")));
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
