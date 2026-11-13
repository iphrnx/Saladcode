/**
 * Regression test suite verifying Demo Mode is completely removed:
 *   - Verifies demo-mode.ts, demo-data.ts, demo-router.ts, demo-banner.tsx do NOT exist
 *   - Verifies zero demo bypasses in client fetchers (src/lib/edge.ts)
 *   - Verifies zero demo bypasses in sign-out flow (src/lib/sign-out.ts)
 *   - Verifies zero demo credentials or bypasses in login & staff-login pages
 *   - Verifies zero demo banners rendered in app shell and staff dashboard
 *   - Verifies zero demo storage keys in src/
 *   - Verifies zero demo references in server-side API routes (src/app/api/**)
 */
import fs from "node:fs";
import path from "node:path";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

console.log("Demo Mode Removal & Zero-Bypass Regression Suite:\n");

// 1. Verify demo files are permanently deleted
check(
  "src/lib/demo-mode.ts is deleted",
  !fs.existsSync(path.join(process.cwd(), "src/lib/demo-mode.ts")),
);
check(
  "src/lib/demo-data.ts is deleted",
  !fs.existsSync(path.join(process.cwd(), "src/lib/demo-data.ts")),
);
check(
  "src/lib/demo-router.ts is deleted",
  !fs.existsSync(path.join(process.cwd(), "src/lib/demo-router.ts")),
);
check(
  "src/components/demo directory is deleted",
  !fs.existsSync(path.join(process.cwd(), "src/components/demo")),
);

// 2. Client fetchers have no demo interception
const edgeSrc = read("src/lib/edge.ts");
check(
  "src/lib/edge.ts has no demo-mode import",
  !edgeSrc.includes("demo-mode"),
);
check(
  "src/lib/edge.ts has no demo-router import",
  !edgeSrc.includes("demo-router"),
);
check(
  "edgeFetch routes unconditionally to real Supabase edge functions",
  !edgeSrc.includes("handleDemoFetch"),
);

// 3. Sign-out flow has no demo bypass
const signOutSrc = read("src/lib/sign-out.ts");
check(
  "src/lib/sign-out.ts has no demo imports or bypasses",
  !signOutSrc.includes("demo-mode") && !signOutSrc.includes("disableDemoMode"),
);

// 4. Login page has no demo credentials or buttons
const loginSrc = read("src/components/auth/login-page.tsx");
check(
  "src/components/auth/login-page.tsx has no demo imports",
  !loginSrc.includes("demo-mode") && !loginSrc.includes("demo-data"),
);
check(
  "src/components/auth/login-page.tsx has no hardcoded demo credentials",
  !loginSrc.includes("DEMO_EMAIL") && !loginSrc.includes("DEMO_PASSWORD"),
);
check(
  "src/components/auth/login-page.tsx has no local demo preview cards",
  !loginSrc.includes("Local Demo Preview") && !loginSrc.includes("QuickLoginBtn"),
);

// 5. Staff login page has no demo role switching
const staffLoginSrc = read("src/components/staff/staff-login.tsx");
check(
  "src/components/staff/staff-login.tsx has no demo imports or quick login cards",
  !staffLoginSrc.includes("demo-mode") && !staffLoginSrc.includes("Demo Staff Quick Login"),
);

// 6. App Shell & Staff Dashboard have no demo banners
const appShellSrc = read("src/components/app/app-shell.tsx");
check(
  "src/components/app/app-shell.tsx has no DemoBanner import or tag",
  !appShellSrc.includes("DemoBanner"),
);
const staffDashSrc = read("src/components/staff/staff-dashboard.tsx");
check(
  "src/components/staff/staff-dashboard.tsx has no DemoBanner import or tag",
  !staffDashSrc.includes("DemoBanner"),
);

// 7. Data context does not skip Realtime for demo
const dataContextSrc = read("src/components/app/data-context.tsx");
check(
  "src/components/app/data-context.tsx does not bypass Supabase Realtime for demo",
  !dataContextSrc.includes("the_salad_demo_role"),
);

// 8. Server-side API routes contain zero demo references
function findFiles(dir: string, ext: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...findFiles(full, ext));
    else if (e.name.endsWith(ext)) files.push(full);
  }
  return files;
}

const apiFiles = findFiles("src/app/api", ".ts");
const anyApiDemoRef = apiFiles.some((f) =>
  /demo-mode|demo-router|the_salad_demo_role/i.test(fs.readFileSync(f, "utf8")),
);
check("Server-side src/app/api/** routes contain zero demo bypasses", !anyApiDemoRef);

// 9. Storage keys in src/ have zero demo keys
const allSrcFiles = findFiles("src", ".ts").concat(findFiles("src", ".tsx"));
const anyStorageDemoRef = allSrcFiles.some((f) =>
  fs.readFileSync(f, "utf8").includes("the_salad_demo_role"),
);
check("Zero references to 'the_salad_demo_role' storage key across all src/ files", !anyStorageDemoRef);

console.log(`\n======================================================================`);
console.log(`  REGRESSION COMPLETE: ${pass} passed, ${fail} failed`);
console.log(`======================================================================\n`);

if (fail > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
