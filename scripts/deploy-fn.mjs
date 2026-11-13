#!/usr/bin/env node
/**
 * Deploy one Supabase edge function, bundling the shared modules it imports.
 *
 *   node scripts/deploy-fn.mjs menu
 *
 * The bundle keeps the same relative layout as the repo —
 *   <name>/index.ts  and  _shared/*.ts
 * — so `import ... from "../_shared/auth.ts"` resolves identically locally and
 * when deployed. verify_jwt is false because staff-session and diner routes
 * carry no Supabase JWT; every function authenticates itself via guard().
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PROJECT_ID = process.env.SUPABASE_PROJECT_ID ?? "ygibmdkrslquamwflshb";
const ROOT = "supabase/functions";

const name = process.argv[2];
if (!name) {
  console.error("usage: node scripts/deploy-fn.mjs <function-name>");
  process.exit(1);
}

const files = [];

for (const file of readdirSync(join(ROOT, "_shared"))) {
  if (!file.endsWith(".ts")) continue;
  files.push({
    name: `_shared/${file}`,
    content: readFileSync(join(ROOT, "_shared", file), "utf8"),
  });
}

const entrypoint = `${name}/index.ts`;
files.push({ name: entrypoint, content: readFileSync(join(ROOT, entrypoint), "utf8") });
// SKIP_DENO_JSON works around an MCP redeploy bug where an existing function's
// absolute import-map path is reused and mis-joined; Deno resolves `jsr:`
// specifiers natively, so the import map is optional.
if (!process.env.SKIP_DENO_JSON) {
  files.push({ name: "deno.json", content: readFileSync(join(ROOT, "deno.json"), "utf8") });
}

const argsPath = `/tmp/fn-args-${name}-${process.pid}.json`;

writeFileSync(
  argsPath,
  JSON.stringify({
    project_id: PROJECT_ID,
    name,
    entrypoint_path: entrypoint,
    verify_jwt: false,
    // The MCP server persists an absolute import-map path on create and then
    // mis-joins it on the next deploy; supplying it relative keeps redeploys
    // working.
    import_map_path: process.env.SKIP_DENO_JSON ? undefined : "deno.json",
    files,
  }),
);

console.log(`deploying "${name}" (${files.length} files, entrypoint ${entrypoint})`);
// MCP_AGENT lets a subagent (which may not itself hold the supaletta server)
// delegate the MCP call to the agent that does. Unset in normal use.
const agentArgs = process.env.MCP_AGENT ? ["--agent", process.env.MCP_AGENT] : [];
const out = execFileSync(
  "letta",
  ["mcp", "call", "mcp__supaletta__deploy_edge_function", "--args-file", argsPath, ...agentArgs],
  { encoding: "utf8" },
);

const start = out.indexOf("{");
const parsed = JSON.parse(out.slice(start));
const text = parsed.content?.[0]?.text ?? "";
const slug = /"slug"\s*:\s*"([^"]+)"/.exec(text)?.[1];
const ok = parsed.isError !== true && (slug === undefined || slug === name);
console.log(ok ? "ok" : "FAILED", `deployed slug=${slug ?? "?"}`, text.slice(0, 200));
