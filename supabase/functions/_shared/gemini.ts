// deno-lint-ignore-file no-explicit-any
import { admin } from "./db.ts";

/**
 * Google Gemini client, shared by the AI edge functions.
 *
 * The API key lives in the `GEMINI_API_KEY` **edge function secret** and
 * nowhere else — not in a database table, not in a response, not in the
 * browser. The Super Admin can see whether a key is configured and can change
 * which model is used, but it cannot read the key, write the key, or see any
 * part of it.
 *
 * The model names are the other way round: they are configuration, not
 * credentials, so they live in `public.ai_provider_settings` and the Super
 * Admin can change them.
 */

export const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** Defaults, matching the model's names the dashboard writes into the table. */
export const DEFAULT_TEXT_MODEL = "gemini-3.8-flash";
export const DEFAULT_IMAGE_MODEL = "gemini-nano-banana-2.1";

export type GeminiSource = "edge-function-secret" | "none";

export type GeminiConfig = {
  provider: string;
  apiKey: string | null;
  textModel: string;
  imageModel: string;
  source: GeminiSource;
  updatedAt: string | null;
};

/**
 * Resolve the Gemini configuration, preferring the value the Super Admin
 * saved and falling back to the function's own secret.
 */
export async function getGeminiConfig(provider = "gemini"): Promise<GeminiConfig> {
  // The key comes from the edge function's own environment and from nowhere
  // else. The table holds the model names, which are configuration.
  const { data } = await admin()
    .from("ai_provider_settings")
    .select("provider, text_model, image_model, updated_at")
    .eq("provider", provider)
    .maybeSingle();

  const row = data as any;
  const fromEnv = (Deno.env.get("GEMINI_API_KEY") ?? "").trim() || null;

  return {
    provider,
    apiKey: fromEnv,
    textModel: row?.text_model || DEFAULT_TEXT_MODEL,
    imageModel: row?.image_model || DEFAULT_IMAGE_MODEL,
    source: fromEnv ? "edge-function-secret" : "none",
    updatedAt: row?.updated_at ?? null,
  };
}

/**
 * There is nothing to mask any more.
 *
 * The key was never returned to a browser — it was stored in a table and
 * masked on the way out, which meant a mask of it travelled through the
 * database and through every response. It now lives in the function's
 * environment, and the dashboard is told only whether one is configured.
 */
export function maskKey(_key: string | null | undefined): string {
  return "";
}

/** Split a `data:<mime>;base64,<payload>` URL into its parts. */
export function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  return {
    mimeType: match[1] || "image/jpeg",
    data: match[3] || "",
  };
}

type GeminiErrorBody = {
  error?: { code?: number; message?: string; status?: string };
};

function describeGeminiError(status: number, body: GeminiErrorBody, model: string): string {
  const message = body?.error?.message?.trim();
  // The key is an edge function secret now, so the advice says where it
  // lives. It used to say "save it in Super Admin -> AI Provider", and that
  // page is gone.
  const keyAdvice = "Check the GEMINI_API_KEY edge function secret.";
  const modelAdvice =
    "Change the model name in the plan catalogue (ai_provider_settings) and redeploy.";
  if (status === 400) {
    if (/api key not valid/i.test(message ?? "")) {
      return `The Gemini API key was rejected. ${keyAdvice}`;
    }
    if (/model/i.test(message ?? "") && /not found|not supported/i.test(message ?? "")) {
      return `Gemini does not recognise the model "${model}". ${modelAdvice}`;
    }
    return `Gemini rejected the request (${message ?? "bad request"}).`;
  }
  if (status === 401 || status === 403) {
    // A 403 is also what an API that is not enabled in the key's project
    // looks like, so both are worth saying.
    return `Gemini refused the key (${status}). ${keyAdvice} The Generative Language API must also be enabled in that project.`;
  }
  if (status === 404) {
    return `Gemini does not recognise the model "${model}". ${modelAdvice}`;
  }
  if (status === 429) {
    return "Gemini is rate limiting this key. Wait a moment and try again.";
  }
  if (status >= 500) {
    // Google's own words are kept, because a 503 from a model that does not
    // exist says so, and a generic "try again" would hide that.
    return `Gemini had a server error (${status})${message ? `: ${message}` : ""}.`;
  }
  return `Gemini request failed (${status})${message ? `: ${message}` : ""}.`;
}

async function geminiFetch(
  url: string,
  apiKey: string,
  body: unknown,
  timeoutMs: number,
  retries: number,
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) return res;

      const text = await res.text().catch(() => "");
      let parsed: GeminiErrorBody = {};
      try { parsed = JSON.parse(text); } catch { /* not JSON */ }

      // Retry only what is worth retrying: a rate limit or a server fault.
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < retries) {
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
        continue;
      }
      throw new Error(describeGeminiError(res.status, parsed, String((body as any)?.model ?? "")));
    } catch (e) {
      clearTimeout(timer);
      lastError = e as Error;
      if (e instanceof Error && e.name === "AbortError") {
        throw new Error(`Gemini did not respond within ${Math.round(timeoutMs / 1000)}s.`);
      }
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
  throw lastError ?? new Error("Gemini request failed.");
}

/**
 * Call Gemini's generateContent and return the text it produced.
 *
 * `parts` is the Gemini content shape: `{ text }` for text and
 * `{ inline_data: { mime_type, data } }` for an image.
 */
export async function geminiGenerateText(opts: {
  model: string;
  apiKey: string;
  parts: any[];
  responseMimeType?: string;
  temperature?: number;
  timeoutMs?: number;
  retries?: number;
}): Promise<string> {
  const body: any = {
    contents: [{ role: "user", parts: opts.parts }],
    generationConfig: {
      temperature: opts.temperature ?? 0.2,
      // camelCase, which is what the REST API expects — Google rejects
      // `response_mime_type` with "Unknown name".
      ...(opts.responseMimeType ? { responseMimeType: opts.responseMimeType } : {}),
    },
  };

  const res = await geminiFetch(
    `${GEMINI_BASE}/models/${encodeURIComponent(opts.model)}:generateContent`,
    opts.apiKey,
    body,
    opts.timeoutMs ?? 90_000,
    opts.retries ?? 1,
  );

  const json: any = await res.json().catch(() => null);
  const text: string | undefined = json?.candidates?.[0]?.content?.parts
    ?.map((p: any) => (typeof p?.text === "string" ? p.text : ""))
    .join("");

  if (!text) {
    const block = json?.candidates?.[0]?.content?.parts?.[0];
    if (block?.text) return String(block.text);
    const reason = json?.promptFeedback?.blockReason ?? json?.candidates?.[0]?.finishReason;
    throw new Error(
      reason
        ? `Gemini returned no text (${reason}).`
        : "Gemini returned an empty response.",
    );
  }
  return text;
}

/**
 * Call Gemini's image model and return the base64 image it produced.
 */
export async function geminiGenerateImage(opts: {
  model: string;
  apiKey: string;
  prompt: string;
  timeoutMs?: number;
  retries?: number;
}): Promise<{ data: string; mimeType: string }> {
  const body: any = {
    contents: [{ role: "user", parts: [{ text: opts.prompt }] }],
    generationConfig: { responseModalities: ["IMAGE"] },
  };

  const res = await geminiFetch(
    `${GEMINI_BASE}/models/${encodeURIComponent(opts.model)}:generateContent`,
    opts.apiKey,
    body,
    opts.timeoutMs ?? 120_000,
    opts.retries ?? 1,
  );

  const json: any = await res.json().catch(() => null);
  const parts: any[] = json?.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    const inline = part?.inlineData ?? part?.inline_data;
    if (inline?.data) {
      return { data: String(inline.data), mimeType: String(inline.mimeType ?? inline.mime_type ?? "image/png") };
    }
  }
  const reason = json?.promptFeedback?.blockReason ?? json?.candidates?.[0]?.finishReason;
  throw new Error(
    reason
      ? `Gemini did not return an image (${reason}).`
      : "Gemini returned no image.",
  );
}

/**
 * A cheap call that proves the key works, used by the dashboard's Test
 * Connection button.
 */
export async function testGeminiConnection(opts: {
  model: string;
  apiKey: string;
  timeoutMs?: number;
}): Promise<{ ok: true; model: string; reply: string }> {
  const text = await geminiGenerateText({
    model: opts.model,
    apiKey: opts.apiKey,
    parts: [{ text: "Reply with the single word: ok" }],
    temperature: 0,
    timeoutMs: opts.timeoutMs ?? 30_000,
    retries: 0,
  });
  return { ok: true, model: opts.model, reply: text.trim().slice(0, 40) };
}
