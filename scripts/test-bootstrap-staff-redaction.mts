/**
 * Regression check: bootstrap never selects or exposes staff PIN credentials
 * (pin_hash, pin_salt) or session tokens, while preserving directory fields,
 * role display, and audit actor mapping.
 */
import { readFileSync } from "node:fs";
import { actorMaps } from "../supabase/functions/_shared/security-identity.ts";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

const src = readFileSync("supabase/functions/bootstrap/index.ts", "utf8");

console.log("\n── bootstrap staff query allowlist ──");
check(
  "no wildcard .from(\"staff\").select(\"*\") or select(\"*, ...\") in bootstrap",
  !/\.from\("staff"\)[\s\S]{0,80}\.select\(\s*["']\*/.test(src),
);

const dirMatch = src.match(/\.from\("staff"\)[\s\S]{0,300}\.select\(\s*"([^"]+)"\s*,?\s*\)/);
const dirSelect = dirMatch?.[1] ?? "";
check(
  "directory staff query uses explicit allowlist",
  dirSelect.length > 0 && !dirSelect.includes("*"),
  `select=${dirSelect}`,
);

for (const forbidden of ["pin_hash", "pin_salt", "failed_attempts", "token"]) {
  check(`directory select excludes ${forbidden}`, !dirSelect.includes(forbidden));
}

for (const required of [
  "id",
  "tenant_id",
  "location_id",
  "role_id",
  "name",
  "employee_id",
  "avatar",
  "active",
  "locked_until",
  "last_login",
  "created_at",
  "updated_at",
  "role:roles(",
]) {
  check(`directory select includes ${required}`, dirSelect.includes(required));
}

console.log("\n── currentStaff & people-directory gating ──");
check(
  "currentStaff lookup selects only id, employee_id, avatar",
  src.includes('.select("id, employee_id, avatar")'),
);
check(
  "staff directory is gated by canSeePeople",
  src.includes("staff: canSeePeople ? staff : []"),
);

console.log("\n── actorMaps compatibility with allowlisted staff shape ──");
{
  const maps = actorMaps(
    [{ id: "s1", name: "Asha", role: { name: "Cashier" } }],
    [{ id: "u1", name: "Priya", role: "Owner", roleRef: { name: "Owner" } }],
  );
  check("actorMaps resolves staff name and role", maps.staff.get("s1")?.name === "Asha" && maps.staff.get("s1")?.role === "Cashier");
  check("actorMaps resolves profile name and role", maps.profiles.get("u1")?.name === "Priya" && maps.profiles.get("u1")?.role === "Owner");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
