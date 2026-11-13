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

const names = readdirSync(ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
  .map((e) => e.name)
  .filter((name) => existsSync(join(ROOT, name, "index.ts")));

const failed = [];
for (const name of names) {
  try {
    execFileSync("node", ["scripts/deploy-fn.mjs", name], { stdio: "pipe", encoding: "utf8" });
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failed.push(name);
    console.log(`  ✗ ${name}  ${String(err.stdout ?? err.message).slice(-200)}`);
  }
}

console.log(`\n${names.length - failed.length}/${names.length} deployed`);
if (failed.length) {
  console.log("failed:", failed.join(", "));
  process.exit(1);
}
