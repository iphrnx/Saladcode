// deno-lint-ignore-file no-explicit-any
import { admin } from "./db.ts";

/**
 * What the AI features have been asked to do, and what came back.
 *
 * It holds the shape of a call — which provider, which model, which action,
 * how long it took, and the error when there was one. It deliberately holds
 * **no prompt text and no response text**: a menu scan carries a restaurant's
 * menu, and that does not belong in a log anybody can read.
 *
 * The table has no access policy, so only the service role can write to it
 * and only the `super-admin` edge function can read it.
 */
export type AiAction = "extract" | "image" | "test";

export async function logAiRequest(opts: {
  provider: string;
  model: string | null;
  action: AiAction;
  tenantId?: string | null;
  status: "ok" | "error";
  durationMs?: number | null;
  errorMessage?: string | null;
}): Promise<void> {
  try {
    await admin().from("ai_request_logs").insert({
      provider: opts.provider,
      model: opts.model,
      action: opts.action,
      tenant_id: opts.tenantId ?? null,
      status: opts.status,
      duration_ms: opts.durationMs ?? null,
      // The message is truncated: it is for a person to read, not a place to
      // put a whole response.
      error_message: opts.errorMessage ? String(opts.errorMessage).slice(0, 400) : null,
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    // A logging failure must never be the reason a call fails.
    console.error("ai-log: could not write the log", (e as Error).message);
  }
}

/** Time a call and log it, whatever happens. */
export async function withAiLog<T>(
  opts: {
    provider: string;
    model: string | null;
    action: AiAction;
    tenantId?: string | null;
  },
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    await logAiRequest({
      ...opts,
      status: "ok",
      durationMs: Date.now() - started,
    });
    return result;
  } catch (e) {
    await logAiRequest({
      ...opts,
      status: "error",
      durationMs: Date.now() - started,
      errorMessage: (e as Error).message,
    });
    throw e;
  }
}
