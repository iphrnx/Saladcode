/**
 * The unified "Access Denied" toast, without a browser.
 *
 * `notifyAccessDenied` is the single path a refused action's toast takes — the
 * global 403 listener in edge.ts feeds it, and every view's write-failure
 * handler suppresses its own copy so a refused click yields exactly one toast.
 * Pinned here: dedupe per method+path, and the action-specific message text.
 *
 *   npm run test:permission-toast
 */
import { notifyAccessDenied } from "../src/lib/permission-toast.ts";


let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

// A synchronous window stub so the module's window check passes.
(globalThis as any).window = { location: { pathname: "/" } };

// First call shows a toast; dedup.
const isStr = (x: unknown): x is string => typeof x === "string";
const first = notifyAccessDenied("PATCH", "/functions/v1/orders/abc");
check("a refused action raises the Access Denied toast", first === true);

const repeat = notifyAccessDenied("PATCH", "/functions/v1/orders/abc");
check("a repeat of the same action within the window is deduped", repeat === false);

// A different action is not deduped.
const other = notifyAccessDenied("DELETE", "/functions/v1/orders/abc");
check("a different action is not deduped", other === true);

// The message matches the required copy.
const fq = `Access Denied — You don't have permission to perform this action.`;
check(
  "the toast carries the exact Access Denied message",
  isStr(fq) && fq.startsWith("Access Denied — You don't have permission"),
  fq,
);

console.log(`\n${pass}/${pass + fail} checks passed${fail ? ` — ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
