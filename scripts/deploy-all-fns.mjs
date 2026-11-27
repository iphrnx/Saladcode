#!/usr/bin/env node
/**
 * Deploy every edge function in one pass.
 *
 *   node scripts/deploy-all-fns.mjs
 *
 * Skips `_shared` (it is bundled into each function) and any directory without
 * an index.ts. Continues past a failure and summarises at the end, so one bad
 * function does not block the rest.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = "supabase/functions";
const RETIRED_FUNCTIONS = ["reservations", "test-shared"];
const PROJECT_ID =
  process.env.SUPABASE_PROJECT_ID ??
  (process.env.NEXT_PUBLIC_SUPABASE_URL
    ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0]
    : "jeuixphibaasbxgaexfg");
const yesFlag = process.argv.includes("--yes") ? ["--yes"] : [];

const names = readdirSync(ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
  .map((e) => e.name)
  .filter((name) => existsSync(join(ROOT, name, "index.ts")));

const failed = [];
for (const name of names) {
  try {
    execFileSync("node", ["scripts/deploy-fn.mjs", name, ...yesFlag], { stdio: "pipe", encoding: "utf8" });
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failed.push(name);
    console.log(`  ✗ ${name}  ${String(err.stdout ?? err.message).slice(-200)}`);
  }
}

for (const retired of RETIRED_FUNCTIONS) {
  try {
    execFileSync(
      "npx",
      ["supabase", "functions", "delete", retired, `--remote=${PROJECT_ID}`, ...yesFlag],
      { stdio: "pipe", encoding: "utf8" },
    );
    console.log(`  ✔ ${retired} (retired & removed)`);
  } catch (err) {
    const out = `${err.stdout ?? ""}\n${err.stderr ?? ""}\n${err.message ?? ""}`;
    if (/not found|does not exist|404/i.test(out)) {
      console.log(`  ✔ ${retired} (already absent)`);
    } else {
      failed.push(retired);
      console.log(`  ✗ ${retired} (cleanup)  ${out.slice(-200)}`);
    }
  }
}

console.log(`\n${names.length - failed.length}/${names.length} deployed`);
if (failed.length) {
  console.log("failed:", failed.join(", "));
  process.exit(1);
}
