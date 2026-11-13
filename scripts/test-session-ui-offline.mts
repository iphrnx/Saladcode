/**
 * The Security page's session-row rules, without a browser.
 *
 * The badges and the Revoke button must mirror what `security/index.ts`'s
 * DELETE route actually enforces, or the page offers an action the server
 * refuses (or hides one it allows). These pins are the UI half of that
 * contract:
 *
 *   - the session being used is never revocable from the page,
 *   - an owner session ends only by the owner, and only on another device,
 *   - a staff session ends by anyone who can manage security,
 *   - the "Active Sessions" total counts every genuine live session (the sum
 *     of the per-row counts), not the number of grouped rows.
 *
 *   npm run test:session-ui
 */
import { activeSessionTotal, sessionRight, viewerIsOwner } from "../src/lib/session-ui.ts";
import type { Session } from "../src/components/app/data-context.tsx";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

const sess = (part: Partial<Session> & { id: string }): Session => ({
  id: part.id,
  userId: "u-1",
  token: undefined,
  device: null,
  browser: null,
  os: null,
  ip: null,
  location: null,
  kind: "owner",
  role: null,
  current: false,
  lastActive: "2026-11-07T00:00:00Z",
  createdAt: "2026-11-07T00:00:00Z",
  count: 1,
  ids: [part.id],
  firstSeen: "2026-11-07T00:00:00Z",
  user: { id: "u-1", name: "A", email: "a@x.com" },
  ...part,
});

console.log("\nviewerIsOwner");
check("no currentStaff → owner viewer", viewerIsOwner(null) === true);
check("absent currentStaff → owner viewer", viewerIsOwner(undefined) === true);
check("a staff viewer is not the owner", viewerIsOwner({ id: "s1" }) === false);

console.log("\nsessionRight — current sessions");
const currentOwner = sess({ id: "o1", kind: "owner", current: true });
const currentStaff = sess({ id: "s1", kind: "staff", role: "Cashier", current: true });
check("the current owner session reads 'current'", sessionRight(true, true, currentOwner) === "current");
check("the current staff session reads 'current' too (no self-revoke)", sessionRight(true, false, currentStaff) === "current");
check("even without manage rights it is 'current', not a revoke", sessionRight(false, true, currentOwner) === "current");

console.log("\nsessionRight — owner sessions on other devices");
const otherOwner = sess({ id: "o2", kind: "owner" });
check("an owner may revoke another owner's session", sessionRight(true, true, otherOwner) === "revoke");
check("a staff viewer sees an owner session as protected", sessionRight(true, false, otherOwner) === "protected");
check("without manage rights there is no action", sessionRight(false, true, otherOwner) === "protected");

console.log("\nsessionRight — staff sessions");
const otherStaff = sess({ id: "s2", kind: "staff", role: "Waiter" });
check("a security manager revokes a staff session", sessionRight(true, false, otherStaff) === "revoke");
check("the owner revokes a staff session", sessionRight(true, true, otherStaff) === "revoke");
check("a viewer without manage rights sees nothing", sessionRight(false, true, otherStaff) === null);

console.log("\nactiveSessionTotal");
check(
  "the total sums every genuine session behind the rows",
  activeSessionTotal([
    sess({ id: "a", count: 9 }),
    sess({ id: "b", kind: "staff", count: 1 }),
    sess({ id: "c", kind: "staff", count: 3 }),
  ]) === 13,
);
check("absent list is zero", activeSessionTotal(undefined) === 0);
check("rows without a count count as one", activeSessionTotal([sess({ id: "x" })]) === 1);

console.log(`\n${pass}/${pass + fail} checks passed${fail ? ` — ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
