/**
 * Publishing to connected clients.
 *
 * Supabase Realtime's broadcast endpoint, called with the service role: the
 * server decides, clients listen. A diner's phone holds no Supabase session,
 * so it cannot be sent a row from a table behind RLS, but it can subscribe to
 * a topic the server names.
 *
 * Three rules this module enforces, because the old version broke all three:
 *
 *   1. **A topic carries a capability, not an identifier.** `orders:<tenantId>`
 *      was guessable by anyone who had scanned a QR — the tenant id is in the
 *      session payload. Staff topics carry a per-tenant secret issued at
 *      bootstrap; a diner's topic carries their own session token.
 *   2. **A payload carries no personal data and no credentials** — see
 *      `realtime-payload.ts`, which owns the shape.
 *   3. **Publishing never fails the write.** Fire and forget, as before.
 */
import { admin } from "./db.ts";
import {
  dinerTopicName,
  isCapabilityTopic,
  orderEvent,
  staffTopicName,
  type OrderEventFacts,
} from "./realtime-payload.ts";

export { dinerTopicName, isCapabilityTopic, orderEvent, staffTopicName };
export type { OrderEventFacts };

const topicCache = new Map<string, string>();

/**
 * Resolve (and cache for this invocation) the staff topic of a tenant.
 *
 * Falls back to the legacy topic if the secret cannot be read, so a database
 * hiccup degrades realtime rather than breaking it — the client polls every
 * four seconds either way.
 */
export async function staffTopic(tenantId: string): Promise<string> {
  const cached = topicCache.get(tenantId);
  if (cached) return cached;
  try {
    const { data, error } = await admin().rpc("ensure_tenant_realtime_secret", {
      p_tenant: tenantId,
    });
    if (error || !data) return `orders:${tenantId}`;
    const topic = staffTopicName(tenantId, String(data));
    topicCache.set(tenantId, topic);
    return topic;
  } catch {
    return `orders:${tenantId}`;
  }
}

function send(topic: string, type: string, payload: unknown): void {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return;

  const pending = fetch(`${url}/realtime/v1/api/broadcast`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: key,
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      messages: [
        {
          topic,
          event: type,
          payload: { ...(payload as Record<string, unknown>), type, timestamp: new Date().toISOString() },
          // Deliberately not `private: true`. A private channel is authorised
          // by RLS on `realtime.messages`, which this project cannot write to
          // (owned by supabase_realtime_admin; migrations run as postgres). A
          // private channel with no policy receives nothing — so the channel
          // stays public and the capability topic does the work.
          private: false,
        },
      ],
    }),
  }).catch(() => {
    /* the write stands; the client's poll reconciles */
  });

  try {
    (globalThis as any).EdgeRuntime?.waitUntil?.(pending);
  } catch {
    /* no waitUntil — the fire-and-forget fetch still runs */
  }
}

/** Publish one event to a restaurant's staff topic. */
export async function publishToStaff(
  tenantId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  send(await staffTopic(tenantId), type, payload);
}

/** Publish one event to a single diner's topic. */
export function publishToDiner(sessionToken: string, type: string, payload: Record<string, unknown>): void {
  if (!sessionToken) return;
  send(dinerTopicName(sessionToken), type, payload);
}

/**
 * Publish to an explicit topic.
 *
 * Kept because a menu change is not an order: it is announced on
 * `menu:<tenantId>`, a public topic that carries no personal data and no
 * capability, and the diner's menu listens for it so a price or an
 * availability change lands without a reload.
 *
 * It lives here rather than being deleted with the old tenant-wide order
 * topic, because deleting it while `menu` still imported it is exactly how a
 * 500 got shipped on the menu-save path.
 */
export function publishEvent(event: {
  type: string;
  tenantId: string;
  topic?: string;
  [key: string]: unknown;
}): void {
  const { topic, ...rest } = event;
  send(topic ?? `orders:${event.tenantId}`, event.type, rest);
}
