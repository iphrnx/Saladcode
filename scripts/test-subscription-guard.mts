/**
 * The one-billable-plan rules, tested without a database or a network.
 *
 * These are the decisions that keep "one restaurant = one billable plan =
 * one recurring charge" true under repeated clicks, concurrent requests,
 * superseded purchases, and duplicate or out-of-order webhooks. A wrong
 * answer here is how a restaurant gets charged twice — so the rules are
 * pure and every path is exercised.
 *
 *   npm run test:subscription-guard
 */
import {
  canCancelWithoutPaymentImpact,
  decideChargeLink,
  decideCheckoutAction,
  decideScheduledCancel,
  decideSwitchAction,
  isAuthorisableStatus,
  isBillableStatus,
  isDeadStatus,
  mandateSupersededByPeriod,
  mandateVerdict,
  sameScheduledStart,
  type LiveSubscription,
  type PendingMandateCheckout,
} from "../supabase/functions/_shared/subscription-guard.ts";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

const live = (status: string, paidCount = 0): LiveSubscription => ({ status, paidCount });

const pending = (over: Partial<PendingMandateCheckout> = {}): PendingMandateCheckout => ({
  id: "co_1",
  planId: "starter",
  interval: "monthly",
  scheduledStartAt: "2027-11-30T00:00:00.000Z",
  razorpaySubscriptionId: "sub_X",
  ...over,
});

const START = "2027-11-30T00:00:00.000Z";

console.log("\nstatus classification");
check("billable: authenticated, active, paused", ["authenticated", "active", "paused"].every(isBillableStatus));
check("not billable: created, cancelled, completed, expired, halted",
  !["created", "cancelled", "completed", "expired", "halted"].some(isBillableStatus));
check("authorisable: created only", isAuthorisableStatus("created") &&
  !["authenticated", "active", "cancelled"].some(isAuthorisableStatus));
check("dead: cancelled, completed, expired, halted", ["cancelled", "completed", "expired", "halted"].every(isDeadStatus));
check("not dead: created, authenticated, active, paused",
  !["created", "authenticated", "active", "paused"].some(isDeadStatus));
check("case-insensitive statuses", isBillableStatus("Active") && isDeadStatus("CANCELLED"));

console.log("\ncanCancelWithoutPaymentImpact");
check("created, never charged → cancellable", canCancelWithoutPaymentImpact(live("created", 0)));
check("authenticated, never charged → cancellable", canCancelWithoutPaymentImpact(live("authenticated", 0)));
check("active, never charged → cancellable", canCancelWithoutPaymentImpact(live("active", 0)));
check("created but charged → NOT cancellable", !canCancelWithoutPaymentImpact(live("created", 1)));
check("active and charged → NOT cancellable", !canCancelWithoutPaymentImpact(live("active", 3)));
check("cancelled → nothing to cancel", !canCancelWithoutPaymentImpact(live("cancelled", 0)));

console.log("\ndecideCheckoutAction — the reuse/replace/expire rule");
const req = { requestPlanId: "starter", requestInterval: "monthly" as const, requestScheduledStart: START };
check("no pending mandate → create", decideCheckoutAction({ existing: null, live: null, ...req }).kind === "create");
check("same plan+interval+start, never authorised → reuse",
  decideCheckoutAction({ existing: pending(), live: live("created"), ...req }).kind === "reuse");
check("same intent, already authorised → reuse (no second mandate)",
  decideCheckoutAction({ existing: pending(), live: live("authenticated"), ...req }).kind === "reuse");
check("same intent, active but uncharged → reuse",
  decideCheckoutAction({ existing: pending(), live: live("active", 0), ...req }).kind === "reuse");
check("different plan, uncharged → replace",
  decideCheckoutAction({ existing: pending(), live: live("created"), requestPlanId: "pro", requestInterval: "monthly", requestScheduledStart: START }).kind === "replace");
check("different interval, uncharged → replace",
  decideCheckoutAction({ existing: pending(), live: live("created"), requestPlanId: "starter", requestInterval: "annual", requestScheduledStart: START }).kind === "replace");
check("scheduled start moved (paid time extended), uncharged → replace",
  decideCheckoutAction({ existing: pending(), live: live("created"), requestPlanId: "starter", requestInterval: "monthly", requestScheduledStart: "2028-11-30T00:00:00.000Z" }).kind === "replace");
check("legacy row without interval → replace (self-heals old data)",
  decideCheckoutAction({ existing: pending({ interval: null }), live: live("created"), ...req }).kind === "replace");
check("mandate cancelled at Razorpay → expire row, no cancel call",
  decideCheckoutAction({ existing: pending(), live: live("cancelled"), ...req }).kind === "expire");
check("mandate expired at Razorpay → expire", decideCheckoutAction({ existing: pending(), live: live("expired"), ...req }).kind === "expire");
check("mandate completed → expire", decideCheckoutAction({ existing: pending(), live: live("completed"), ...req }).kind === "expire");
check("mandate halted → expire", decideCheckoutAction({ existing: pending(), live: live("halted"), ...req }).kind === "expire");
check("mandate cancelled AFTER charging → expire (history, not a live bill)",
  decideCheckoutAction({ existing: pending(), live: live("cancelled", 3), ...req }).kind === "expire");
check("mandate completed after charging → expire",
  decideCheckoutAction({ existing: pending(), live: live("completed", 12), ...req }).kind === "expire");
check("Razorpay unreachable, same intent → reuse (authorising twice is a no-op)",
  decideCheckoutAction({ existing: pending(), live: null, ...req }).kind === "reuse");
check("Razorpay unreachable, different intent → unavailable (never guess)",
  decideCheckoutAction({ existing: pending(), live: null, requestPlanId: "pro", requestInterval: "monthly", requestScheduledStart: START }).kind === "unavailable");
const blocked = decideCheckoutAction({ existing: pending(), live: live("active", 2), ...req });
check("pending row but mandate already charging → blocked", blocked.kind === "blocked" && (blocked as any).reason.length > 0);
check("authenticated and charging → blocked",
  decideCheckoutAction({ existing: pending(), live: live("authenticated", 1), ...req }).kind === "blocked");

console.log("\nsameScheduledStart");
check("identical → same", sameScheduledStart(START, START));
check("both null → same", sameScheduledStart(null, null));
check("30 seconds apart → same (clock tolerance)", sameScheduledStart(START, "2027-11-30T00:00:30.000Z"));
check("10 minutes apart → different", !sameScheduledStart(START, "2027-11-30T00:10:00.000Z"));
check("one null → different", !sameScheduledStart(START, null) && !sameScheduledStart(null, START));
check("unparseable → different", !sameScheduledStart("not-a-date", START));

console.log("\ndecideSwitchAction — the link-switch rule");
const sw = { newSubscriptionId: "sub_NEW" };
check("no previous link → leave", decideSwitchAction({ previousSubscriptionId: null, ...sw, previousLive: null }).kind === "leave");
check("same mandate (renewal) → leave", decideSwitchAction({ previousSubscriptionId: "sub_NEW", ...sw, previousLive: null }).kind === "leave");
check("previous active → cancel it", decideSwitchAction({ previousSubscriptionId: "sub_OLD", ...sw, previousLive: live("active") }).kind === "cancel-previous");
check("previous authenticated → cancel it", decideSwitchAction({ previousSubscriptionId: "sub_OLD", ...sw, previousLive: live("authenticated") }).kind === "cancel-previous");
check("previous paused → cancel it", decideSwitchAction({ previousSubscriptionId: "sub_OLD", ...sw, previousLive: live("paused") }).kind === "cancel-previous");
check("previous already cancelled → leave", decideSwitchAction({ previousSubscriptionId: "sub_OLD", ...sw, previousLive: live("cancelled") }).kind === "leave");
check("previous completed → leave", decideSwitchAction({ previousSubscriptionId: "sub_OLD", ...sw, previousLive: live("completed") }).kind === "leave");
check("previous status unknown → unknown (audited, not assumed)", decideSwitchAction({ previousSubscriptionId: "sub_OLD", ...sw, previousLive: null }).kind === "unknown");

console.log("\nmandateSupersededByPeriod — paid time moved past a scheduled start");
check("start before the new paid boundary → superseded", mandateSupersededByPeriod("2026-11-29T00:00:00.000Z", "2027-11-30T00:00:00.000Z"));
check("start exactly at the new boundary → still the arranged future", !mandateSupersededByPeriod("2027-11-30T00:00:00.000Z", "2027-11-30T00:00:00.000Z"));
check("start after the new boundary → keep", !mandateSupersededByPeriod("2028-01-01T00:00:00.000Z", "2027-11-30T00:00:00.000Z"));
check("immediate-start mandate still pending → superseded", mandateSupersededByPeriod(null, "2027-11-30T00:00:00.000Z"));
check("unparseable start → keep (never cancel on a guess)", !mandateSupersededByPeriod("garbage", "2027-11-30T00:00:00.000Z"));

console.log("\ndecideChargeLink — the anti-flap rule for webhooks");
const cl = { incomingId: "sub_IN" };
check("renewal on the linked mandate → apply", decideChargeLink({ linkedId: "sub_IN", ...cl, linkedLive: null, incomingLive: live("active", 3) }).kind === "apply");
check("no link yet → apply", decideChargeLink({ linkedId: null, ...cl, linkedLive: null, incomingLive: live("active", 1) }).kind === "apply");
check("charging mandate is dead (cancelled after charge) → reject, link stays put",
  decideChargeLink({ linkedId: "sub_LINKED", ...cl, linkedLive: live("active", 2), incomingLive: live("cancelled", 1) }).kind === "reject-dead-incoming");
check("charging mandate expired → reject-dead-incoming",
  decideChargeLink({ linkedId: "sub_LINKED", ...cl, linkedLive: live("active", 2), incomingLive: live("expired", 1) }).kind === "reject-dead-incoming");
check("another billable mandate holds the link → reject the duplicate",
  decideChargeLink({ linkedId: "sub_LINKED", ...cl, linkedLive: live("active", 2), incomingLive: live("active", 1) }).kind === "reject-linked-billable");
check("linked mandate paused (still billable) → reject the duplicate",
  decideChargeLink({ linkedId: "sub_LINKED", ...cl, linkedLive: live("paused", 1), incomingLive: live("active", 1) }).kind === "reject-linked-billable");
check("linked mandate dead → the incoming charge takes over",
  decideChargeLink({ linkedId: "sub_LINKED", ...cl, linkedLive: live("cancelled", 5), incomingLive: live("active", 1) }).kind === "apply");
check("linked mandate status unknown → the money follows (apply, sweep audits)",
  decideChargeLink({ linkedId: "sub_LINKED", ...cl, linkedLive: null, incomingLive: live("active", 1) }).kind === "apply");
check("incoming status unknown + billable link → reject (never move a link on a guess)",
  decideChargeLink({ linkedId: "sub_LINKED", ...cl, linkedLive: live("active", 2), incomingLive: null }).kind === "reject-linked-billable");
check("no flap: first-linked billable mandate always wins, deterministically", (() => {
  const a = decideChargeLink({ linkedId: "sub_A", ...cl, linkedLive: live("active", 2), incomingLive: live("active", 1) });
  return a.kind === "reject-linked-billable";
})());

console.log("\nmandateVerdict — the audit label");
check("active → billable", mandateVerdict(live("active", 1)) === "billable");
check("created → authorisable", mandateVerdict(live("created")) === "authorisable");
check("cancelled → dead", mandateVerdict(live("cancelled")) === "dead");
check("halted → dead", mandateVerdict(live("halted")) === "dead");
check("no answer → unknown", mandateVerdict(null) === "unknown");

console.log("\ndecideScheduledCancel — may this mandate be cancelled, and why");
const FUTURE = "2027-11-30T00:00:00.000Z";
const PAST = "2026-01-01T00:00:00.000Z";
{
  const sc = (scheduledStartAt: string | null, status: string, paidCount = 0) =>
    decideScheduledCancel({ scheduledStartAt, live: { status, paidCount } }).kind;
  check("cancelled at Razorpay → already dead", sc(FUTURE, "cancelled") === "already-dead");
  check("expired at Razorpay → already dead", sc(FUTURE, "expired") === "already-dead");
  check("completed → already dead", sc(FUTURE, "completed", 12) === "already-dead");
  check("halted → already dead", sc(FUTURE, "halted") === "already-dead");
  check("charged, whatever else → refuse (money needs a human)",
    sc(FUTURE, "active", 1) === "refuse-charged" && sc(FUTURE, "created", 1) === "refuse-charged");
  check("never authorised ('created'), uncharged → cancel and kill the link",
    sc(FUTURE, "created") === "cancel-never-authorised");
  check("never authorised, immediate start → still safe to cancel",
    sc(null, "created") === "cancel-never-authorised");
  check("never authorised, past start → still safe (nothing ever collected)",
    sc(PAST, "created") === "cancel-never-authorised");
  check("authorised, future start, uncharged → cancel-scheduled",
    sc(FUTURE, "authenticated") === "cancel-scheduled");
  check("active, future start, uncharged → cancel-scheduled",
    sc(FUTURE, "active") === "cancel-scheduled");
  check("paused, future start, uncharged → cancel-scheduled",
    sc(FUTURE, "paused") === "cancel-scheduled");
  check("authorised, immediate (no start) → refuse: it is live now",
    sc(null, "authenticated") === "refuse-started");
  check("authorised, start already passed → refuse",
    sc(PAST, "authenticated") === "refuse-started");
  check("unrecognised status → refuse", sc(FUTURE, "some-new-razorpay-state") === "refuse-unknown");
  check("dead is checked BEFORE charged (a cancelled mandate with history is just done)",
    decideScheduledCancel({ scheduledStartAt: FUTURE, live: { status: "cancelled", paidCount: 3 } }).kind === "already-dead");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("\nONE-BILLABLE-PLAN RULES FAILED");
  process.exit(1);
}
