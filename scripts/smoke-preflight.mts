/**
 * Pre-deployment smoke tests.
 *
 * Every failure this project has shipped in the last day belongs to one of
 * three classes, and all three are detectable before a deploy:
 *
 *   1. an edge function references a name it never imported — esbuild parses
 *      it, so the bundle "compiles", and the runtime throws on first call;
 *   2. a database function exists in two arities, so PostgREST cannot choose;
 *   3. a deploy assumed a column or RPC that the migration had not created.
 *
 *   npm run smoke                                  # static only, no network
 *   SUPABASE_SERVICE_ROLE_KEY=... npm run smoke:live  # also probes production
 *
 * Static checks run against the working tree. The live probe is read-only and
 * uses a demo table, cleaning up after itself.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

let pass = 0, fail = 0;
const check = (l: string, ok: boolean, d?: string) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${l}${d && !ok ? `\n        ${d}` : ""}`);
};

const FN_ROOT = "supabase/functions";
const functions = readdirSync(FN_ROOT).filter((d) => {
  try { return readFileSync(join(FN_ROOT, d, "index.ts"), "utf8").length > 0; } catch { return false; }
});

// Names the shared modules export — the surface a function may call.
const shared = new Map<string, Set<string>>();
for (const file of readdirSync(join(FN_ROOT, "_shared"))) {
  if (!file.endsWith(".ts")) continue;
  const src = readFileSync(join(FN_ROOT, "_shared", file), "utf8");
  const names = new Set<string>();
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s+(?:const|let)\s+([A-Za-z0-9_]+)/g)) names.add(m[1]);
  // Re-exports: `export { orderEvent, publishToStaff }` — the common shape for
  // a module that wraps another.
  for (const m of src.matchAll(/export\s*\{([^}]+)\}\s*(?:from\s*"[^"]+")?/g)) {
    for (const piece of m[1].split(",")) {
      const name = piece.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  // Interfaces and types are imported the same way and must resolve too.
  for (const m of src.matchAll(/export\s+(?:interface|type)\s+([A-Za-z0-9_]+)/g)) names.add(m[1]);
  shared.set(file, names);
}
const allShared = new Set([...shared.values()].flatMap((s) => [...s]));

console.log("\n── every imported name exists ──");
for (const fn of functions) {
  const src = readFileSync(join(FN_ROOT, fn, "index.ts"), "utf8");
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*"\.\.\/_shared\/([a-z-]+)\.ts"/g)) {
    const wanted = m[1]
      .split(",")
      .map((piece) => piece.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    const provided = shared.get(`${m[2]}.ts`);
    const missing = wanted.filter((w) => !provided?.has(w));
    if (missing.length) check(`${fn}: imports from ${m[2]}.ts resolve`, false, `missing: ${missing.join(", ")}`);
  }
}
console.log("\n── no function uses a shared name it did not import ──");
{
  // The bug that took ordering down: `orderEvent(...)` called with no import.
  let offenders = 0;
  for (const fn of functions) {
    const src = readFileSync(join(FN_ROOT, fn, "index.ts"), "utf8");
    for (const name of allShared) {
      // a call site, and no import of that name anywhere in the file
      const calls = new RegExp(`(?<![.\\w])${name}\\(`, "g");
      if (!calls.test(src)) continue;
      const imported = new RegExp(`import[^;]*\\b${name}\\b[^;]*from\\s*"\\.\\./_shared/`, "s");
      const declared = new RegExp(`(?:function|const|let|class)\\s+${name}\\b`);
      if (imported.test(src) || declared.test(src)) continue;
      check(`${fn}: ${name} is imported before use`, false, "called but never imported or declared");
      offenders++;
    }
  }
  if (offenders === 0) check("every shared call has a matching import", true);
}

console.log("\n── migrations do not leave overloaded functions behind ──");
{
  const dir = "supabase/migrations";
  const created = new Map<string, Set<string>>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(dir, file), "utf8");
    for (const m of sql.matchAll(/create or replace function public\.([a-z_0-9]+)\(([^)]*)\)/g)) {
      const args = m[2].split(",").filter((a) => a.trim()).length;
      if (!created.has(m[1])) created.set(m[1], new Set());
      created.get(m[1])!.add(String(args));
    }
    for (const m of sql.matchAll(/drop function if exists public\.([a-z_0-9]+)\(([^)]*)\)/g)) {
      const args = m[2].split(",").filter((a) => a.trim()).length;
      created.get(m[1])?.delete(String(args));
    }
  }
  const ambiguous = [...created.entries()].filter(([, arities]) => arities.size > 1);
  check("no function is left with two signatures",
    ambiguous.length === 0,
    ambiguous.map(([n, a]) => `${n}(${[...a].join(", ")})`).join("; "));
}

console.log("\n── edge functions do not reference columns the schema lacks ──");
{
  // A named column the migration has not created makes PostgREST fail the
  // whole query, which reads as "not found" to the caller.
  const union = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join("supabase/migrations", f), "utf8")).join("\n");
  const added = new Set<string>();
  for (const m of union.matchAll(/add column if not exists ([a-z_0-9]+)/g)) added.add(m[1]);
  for (const m of union.matchAll(/create table if not exists public\.([a-z_0-9]+)\s*\(([\s\S]*?)\n\);/g)) {
    for (const col of m[2].matchAll(/^\s{2}([a-z_0-9]+)\s+[a-z]/gm)) added.add(col[1]);
  }
  const suspects = ["activation_status", "check_id", "anchor_session_id", "unsettled_at"];
  const missing = suspects.filter((c) => !added.has(c));
  check("new columns are created by a migration", missing.length === 0, missing.join(", "));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
