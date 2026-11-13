/** What is configured, and what is still missing. */
import { createClient } from "@supabase/supabase-js";

const SB = "https://ygibmdkrslquamwflshb.supabase.co";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpcJMiOiJzdXBhYmFzZSIsInJlZiI6InlnaWJtZGtyc2xxdWFtd2Zsc2hiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA5MTg0NTUsImV4cCI6MjEwNjQ5NDQ1NX0.6zGsI3raxhRsi2cwt0eaEae1Vmh_C6qmVM2PVZs4uQw";

const admin = createClient(SB, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: "phrnx@icloud.com" });
const c = createClient(SB, ANON, { auth: { persistSession: false } });
const { data } = await c.auth.verifyOtp({ token_hash: link!.properties.hashed_token, type: "magiclink" });
const t = data!.session!.access_token;

const call = async (path: string, method = "GET") => {
  const res = await fetch(`${SB}/functions/v1/${path}`, {
    method,
    headers: { apikey: ANON, authorization: `Bearer ${t}`, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

console.log("\n── Gemini ──");
{
  const r = await call("super-admin/ai-provider/test", "POST");
  console.log("  test:", r.status, JSON.stringify(r.body).slice(0, 320));
  const g = await call("super-admin/ai-provider");
  console.log("  models:", JSON.stringify({ text: g.body?.textModel, image: g.body?.imageModel, configured: g.body?.configured }));
}

console.log("\n── Razorpay ──");
{
  const r = await call("super-admin/payments");
  console.log("  plans:", r.status, JSON.stringify(r.body).slice(0, 400));
}

console.log("\n── what the plans say ──");
{
  const { data: plans } = await admin.from("subscription_plans").select("id, name, price_monthly, razorpay_plan_id, is_active, trial_days");
  for (const p of plans ?? []) {
    console.log(`  ${p.id}: ₹${p.price_monthly} active=${p.is_active} trial=${p.trial_days}d razorpay_plan_id=${p.razorpay_plan_id ?? "(not set)"}`);
  }
}

console.log("\n── the AI call log ──");
{
  const { data: logs } = await admin.from("ai_request_logs").select("provider, model, action, status, error_message, created_at").order("created_at", { ascending: false }).limit(5);
  console.log("  ", JSON.stringify(logs ?? []).slice(0, 500));
}
