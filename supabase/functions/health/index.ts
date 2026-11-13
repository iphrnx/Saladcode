// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { admin } from "../_shared/db.ts";
import { json, preflight } from "../_shared/http.ts";

/**
 * /functions/v1/health
 *
 * Liveness/readiness probe for uptime monitors and the platform.
 *
 * Deliberately public and deliberately terse — it reports whether the app can
 * reach its database, and nothing about tenants or configuration. Mirrors
 * src/app/api/health/route.ts.
 */

Deno.serve((req: Request) => {
  const pf = preflight(req);
  if (pf) return pf;

  return handle(req);
});

async function handle(req: Request): Promise<Response> {
  const startedAt = Date.now();

  let database: "ok" | "unreachable" = "unreachable";
  try {
    const { error } = await admin()
      .from("tenants")
      .select("id", { count: "exact", head: true });
    if (!error) database = "ok";
  } catch {
    /* leave as unreachable */
  }

  const healthy = database === "ok";

  return json(
    req,
    {
      status: healthy ? "ok" : "degraded",
      database,
      latencyMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    },
    healthy ? 200 : 503,
  );
}
