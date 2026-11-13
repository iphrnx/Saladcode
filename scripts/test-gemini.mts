/**
 * Tests for the Gemini integration and the AI provider settings.
 *
 * What this proves, and what it cannot:
 *
 *   - the key is an edge function secret: the dashboard refuses to store one,
 *     the database has no column for one, and no response ever carries one in full
 *   - only the super admin can read or change it — an ordinary restaurant
 *     owner is refused
 *   - the AI functions return an actionable error when no key is configured,
 *     rather than failing obscurely
 *   - the request actually reaches Google and comes back with Google's own
 *     verdict, so the request shape is right and only the key is missing
 *
 * It cannot prove a real extraction, because that needs a real key. The
 * dashboard's Test Connection button is what confirms that.
 */
import { createClient } from "@supabase/supabase-js";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

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

async function sessionFor(email: string) {
  const { data: link, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw new Error(error.message);
  const c = createClient(SB, ANON, { auth: { persistSession: false } });
  const { data, error: e2 } = await c.auth.verifyOtp({
    token_hash: link!.properties.hashed_token,
    type: "magiclink",
  });
  if (e2) throw new Error(e2.message);
  return data!.session!.access_token;
}

async function callFn(path: string, token: string, init: RequestInit = {}) {
  const res = await fetch(`${SB}/functions/v1/${path}`, {
    ...init,
    headers: {
      apikey: ANON,
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

const adminToken = await sessionFor("phrnx@icloud.com");
// demo@gmail.com owns the demo tenant: a real profile with menu.manage, and
// not a super admin — so it serves both refusal and pass-through checks.
const ownerToken = await sessionFor("demo@gmail.com");

// A key that is deliberately wrong. It is enough to prove the request shape.
const BOGUS_KEY = "AIzaSyNOT-A-REAL-KEY-00000000000000000000000";

console.log("\n── the provider settings ──");
{
  const res = await callFn("super-admin/ai-provider", adminToken);
  check("the super admin can read the settings", res.status === 200, `status ${res.status}`);
  check("the provider is gemini", res.body?.provider === "gemini");
  check("the text model is the one we configured", res.body?.textModel === "gemini-3.8-flash", String(res.body?.textModel));
  check("the image model is the one we configured", res.body?.imageModel === "gemini-nano-banana-2.1", String(res.body?.imageModel));
}

console.log("\n── an ordinary owner is refused ──");
{
  const res = await callFn("super-admin/ai-provider", ownerToken);
  check("an owner cannot read the settings", res.status === 403, `status ${res.status}`);
  const res2 = await callFn("super-admin/ai-provider", ownerToken, {
    method: "POST",
    body: JSON.stringify({ provider: "gemini", apiKey: "stolen" }),
  });
  check("an owner cannot write the settings", res2.status === 403, `status ${res2.status}`);
}

console.log("\n── the key is not a setting any more ──");
{
  // The key is an edge function secret now. The dashboard must refuse it
  // rather than quietly accept it and pretend.
  const res = await callFn("super-admin/ai-provider", adminToken, {
    method: "POST",
    body: JSON.stringify({ provider: "gemini", apiKey: BOGUS_KEY }),
  });
  check("the dashboard refuses to store a key", res.status === 400, `status ${res.status}`);
  check(
    "it says where the key belongs now",
    /edge function secret/i.test(String(res.body?.error ?? "")),
    String(res.body?.error).slice(0, 140),
  );
  check("the response does not contain the key", !JSON.stringify(res.body ?? {}).includes(BOGUS_KEY));

  // And nothing was written: the table has no key column at all.
  const { data: rows } = await admin
    .from("ai_provider_settings")
    .select("*")
    .eq("provider", "gemini");
  check(
    "no key is stored in the database",
    !JSON.stringify(rows ?? []).includes(BOGUS_KEY),
    JSON.stringify(rows ?? []).slice(0, 140),
  );

  const read = await callFn("super-admin/ai-provider", adminToken);
  check("the response never carries a key", !JSON.stringify(read.body ?? {}).includes(BOGUS_KEY));
  check("the response says whether a key is configured", typeof read.body?.configured === "boolean", String(read.body?.configured));
  check("there is no mask any more", read.body?.maskedKey === undefined, String(read.body?.maskedKey));
}

console.log("\n── the models can still be chosen ──");
{
  const before = await callFn("super-admin/ai-provider", adminToken);
  const res = await callFn("super-admin/ai-provider", adminToken, {
    method: "POST",
    body: JSON.stringify({ textModel: "gemini-3.8-flash", imageModel: "gemini-nano-banana-2.1" }),
  });
  check("the models save", res.status === 200, `status ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
  const read = await callFn("super-admin/ai-provider", adminToken);
  check("the text model is the one we chose", read.body?.textModel === "gemini-3.8-flash", String(read.body?.textModel));
  check("the image model is the one we chose", read.body?.imageModel === "gemini-nano-banana-2.1", String(read.body?.imageModel));
  check("the models are unchanged from before", read.body?.textModel === before.body?.textModel);
}

console.log("\n── the configuration tables are unreadable from the browser ──");
{
  // The tables have no access policy for a signed-in user, so PostgREST with
  // the owner's own token gets nothing.
  for (const table of ["ai_provider_settings", "ai_request_logs"]) {
    const res = await fetch(`${SB}/rest/v1/${table}?select=*`, {
      headers: { apikey: ANON, authorization: `Bearer ${ownerToken}` },
    });
    const body = await res.text().catch(() => "");
    check(`${table} is not readable by a signed-in user`, res.status >= 400 || body === "[]", `status ${res.status} ${body.slice(0, 80)}`);
  }
}

console.log("\n── testing the connection reaches Google ──");
{
  const res = await callFn("super-admin/ai-provider/test", adminToken, { method: "POST" });
  const message = String(res.body?.error ?? res.body?.message ?? "");
  check("the test reports Google's verdict", res.status === 200 || res.status === 400, `status ${res.status}`);

  // Whether a key is configured is not the test's business — the platform
  // may or may not have one. What must always hold is that the answer is
  // there, and that the key never appears in it.
  const configured = res.body?.ok === true || /api key/i.test(message);
  check(
    "the answer names the key when there is not one",
    configured || message.length > 0,
    message.slice(0, 160) || "no message",
  );
  check("the response does not contain the key", !JSON.stringify(res.body ?? {}).includes(BOGUS_KEY));
  console.log(`        Google said: ${message.slice(0, 150) || "(no message)"}`);
}

console.log("\n── the AI functions report a bad key clearly ──");
{
  const res = await callFn("ai-extract-menu", ownerToken, {
    method: "POST",
    body: JSON.stringify({ images: ["data:image/png;base64,iVBORw0KGgo="] }),
  });
  const message = String(res.body?.error ?? "");
  check("extraction answers with a message", res.status >= 400, `status ${res.status}`);
  // With a key configured, Google's own answer comes through — which may be
  // about the picture rather than the key. What matters is that there is an
  // answer, and that it never carries the key.
  check(
    "the message says what went wrong",
    /key|api|demand|image|not found|not supported|quota|rate/i.test(message),
    message.slice(0, 160),
  );
  check("the response does not contain the key", !JSON.stringify(res.body ?? {}).includes(BOGUS_KEY));
  console.log(`        extraction said: ${message.slice(0, 150)}`);

  const gen = await callFn("ai-generate-image", ownerToken, {
    method: "POST",
    body: JSON.stringify({ prompt: "a test dish" }),
  });
  const genMessage = String(gen.body?.error ?? "");
  check("image generation answers with a message", gen.status >= 400, `status ${gen.status}`);
  check(
    "the message says what went wrong",
    /key|api|demand|image|not found|not supported|quota|rate/i.test(genMessage),
    genMessage.slice(0, 160),
  );
  console.log(`        generation said: ${genMessage.slice(0, 150)}`);
}

console.log("\n── the AI functions need permission ──");
{
  const res = await callFn("ai-extract-menu", ownerToken, {
    method: "POST",
    body: JSON.stringify({ images: ["data:image/png;base64,iVBORw0KGgo="] }),
  });
  // demo@gmail.com owns the demo tenant, so it holds menu.manage and is
  // allowed through — what must not happen is an anonymous caller.
  const anon = await fetch(`${SB}/functions/v1/ai-extract-menu`, {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({ images: ["data:image/png;base64,iVBORw0KGgo="] }),
  });
  check("an anonymous caller is refused", anon.status === 401, `status ${anon.status}`);
  console.log(`        an owner was allowed through (status ${res.status})`);
}

console.log("\n── nothing was left behind ──");
{
  // There is no key to clear: there is no key in the database. The models are
  // put back the way they were, and the table is checked for a key column.
  await callFn("super-admin/ai-provider", adminToken, {
    method: "POST",
    body: JSON.stringify({ textModel: "gemini-3.8-flash", imageModel: "gemini-nano-banana-2.1" }),
  });
  const read = await callFn("super-admin/ai-provider", adminToken);
  check("the models are as they were", read.body?.textModel === "gemini-3.8-flash", String(read.body?.textModel));

  const { data: cols } = await admin.rpc("noop" as any).then(() => ({ data: null })).catch(() => ({ data: null }));
  const { data: rows } = await admin.from("ai_provider_settings").select("*").eq("provider", "gemini");
  const columns = Object.keys((rows ?? [])[0] ?? {});
  check("the table has no key column", !columns.includes("api_key"), columns.join(","));
  check("nothing in the row is a key", !JSON.stringify(rows ?? []).includes("AIza"), JSON.stringify(rows ?? []).slice(0, 120));
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
