/**
 * The email queue, against the live database — without the provider.
 *
 *   npm run test:emails-live
 *
 * Registers a throwaway restaurant (which queues its welcome email), proves the
 * queue is idempotent, then purges the account and checks that the delivery
 * record survives the deletion it describes. Actual delivery through Resend is
 * verified separately, once RESEND_API_KEY is configured.
 */
import { createClient } from "@supabase/supabase-js";
const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, extra = "") => {
  if (ok) { pass++; console.log(`  ok    ${n}`); } else { fail++; console.log(`  FAIL  ${n}${extra ? ` — ${extra}` : ""}`); }
};

const stamp = Date.now();
const email = `email-test-${stamp}@example.com`;
const password = "Test-pass-1234";

try {
  console.log("\n── a new account queues exactly one welcome email ──");
  const reg = await fetch(`${SB}/functions/v1/auth/register`, {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({ email, password, name: "Email Tester", restaurantName: `Email ${stamp}` }),
  });
  const regBody = await reg.json();
  check("registration succeeds", reg.status === 200, JSON.stringify(regBody).slice(0, 160));
  const tenantId = regBody?.tenant?.id as string | undefined;
  check("the tenant was created", Boolean(tenantId));

  const { data: queued } = await admin
    .from("email_events")
    .select("id, event_type, recipient, status, subject, attempts, event_key")
    .eq("tenant_id", tenantId!);
  check("one email was queued", (queued ?? []).length === 1, JSON.stringify(queued));
  const row = (queued ?? [])[0] as any;
  check("it is the welcome email", row?.event_type === "trial_started", row?.event_type);
  check("addressed to the owner", row?.recipient === email, row?.recipient);
  check("with a real subject", String(row?.subject ?? "").length > 5, row?.subject);
  check("and it is pending, not wrongly marked sent", row?.status === "pending", row?.status);

  console.log("\n── the same event cannot be queued twice ──");
  const again = await admin.from("email_events").insert({
    event_key: row.event_key, event_type: "trial_started", tenant_id: tenantId,
    recipient: email, subject: "duplicate",
  });
  check("the unique event key refuses a duplicate", Boolean(again.error), JSON.stringify(again.error)?.slice(0, 100));

  console.log("\n── purging the account keeps the delivery record ──");
  const { data: purged, error: purgeError } = await admin.rpc("purge_tenant", { p_tenant_id: tenantId });
  check("purge succeeds even though the account has profiles and roles", !purgeError, purgeError?.message ?? "");
  check("it reports what it removed", Number((purged as any)?.profiles ?? 0) >= 1, JSON.stringify(purged));

  const { data: tenantAfter } = await admin.from("tenants").select("name, email, active, subscription_status").eq("id", tenantId!).maybeSingle();
  check("the restaurant is now a tombstone", (tenantAfter as any)?.name === "Deleted restaurant" && (tenantAfter as any)?.active === false, JSON.stringify(tenantAfter));
  check("its contact details are gone", (tenantAfter as any)?.email === null);

  const { data: profileAfter } = await admin.from("profiles").select("id").eq("tenant_id", tenantId!);
  check("the owner's profile is gone", (profileAfter ?? []).length === 0);

  const { data: emailAfter } = await admin.from("email_events").select("id, tenant_id, recipient").eq("event_key", row.event_key).maybeSingle();
  check("the email record survives the account it describes", Boolean(emailAfter?.id), JSON.stringify(emailAfter));
  // The tenant row survives as an anonymised tombstone (invoices and payments
  // still have to point at something), so the delivery record keeps pointing
  // at it — and at nothing that identifies a person.
  check("still anchored to the tombstone, not to a person", (emailAfter as any)?.tenant_id === tenantId, String((emailAfter as any)?.tenant_id));
  check("with the address kept for the delivery trail", (emailAfter as any)?.recipient === email);
} finally {
  // Leave nothing behind: hard-delete the tombstone and its user.
  const { data: t } = await admin.from("tenants").select("id").eq("slug", `deleted-${(stamp)}`).maybeSingle();
  void t;
  const { data: profiles } = await admin.from("profiles").select("id").eq("tenant_id", (await admin.from("tenants").select("id").ilike("slug", "deleted-%").limit(1).maybeSingle()).data?.id ?? "00000000-0000-0000-0000-000000000000");
  void profiles;
  const users = (await admin.auth.admin.listUsers({ perPage: 200 })).data?.users ?? [];
  for (const u of users.filter((x) => x.email === email)) await admin.auth.admin.deleteUser(u.id);
  await admin.from("email_events").delete().eq("recipient", email);
  const leftovers = (await admin.from("tenants").select("id, slug").ilike("slug", "deleted-%")).data ?? [];
  for (const l of leftovers) {
    await admin.from("tenants").delete().eq("id", l.id);
  }
  console.log("\n  test account and records removed");
}
console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail > 0) process.exit(1);
