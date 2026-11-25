#!/usr/bin/env node
/**
 * Deploy one Supabase edge function using the supported Supabase CLI workflow.
 *
 *   node scripts/deploy-fn.mjs menu
 *
 * --no-verify-jwt is passed because staff-session and diner routes carry no
 * Supabase JWT; every function authenticates itself via guard() / superGuard().
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const PROJECT_ID =
  process.env.SUPABASE_PROJECT_ID ??
  (process.env.NEXT_PUBLIC_SUPABASE_URL
    ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0]
    : "jeuixphibaasbxgaexfg");

const name = process.argv[2];
if (!name || name === "--help" || name === "-h") {
  console.error("usage: node scripts/deploy-fn.mjs <function-name>");
  process.exit(name ? 0 : 1);
}

const entrypoint = join("supabase", "functions", name, "index.ts");
if (!existsSync(entrypoint)) {
  console.error(`Edge function entrypoint not found: ${entrypoint}`);
  process.exit(1);
}

console.log(`Deploying "${name}" to project ${PROJECT_ID} via Supabase CLI...`);
execFileSync(
  "npx",
  ["supabase", "functions", "deploy", name, "--no-verify-jwt", "--project-ref", PROJECT_ID],
  { stdio: "inherit" },
);
