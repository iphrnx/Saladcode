// deno-lint-ignore-file no-explicit-any
/**
 * The OpenAI-compatible fallback for the AI onboarding calls, separated from
 * the plumbing that carries it.
 *
 * Everything here is pure: no database, no network, no environment. It
 * decides *when* a failure is worth falling back on, and converts between
 * the Gemini shapes the primary path uses and the OpenAI shapes the fallback
 * endpoint expects. The fetch itself lives in `ai-fallback-client.ts`.
 *
 * The fallback exists for one situation: Gemini is down, overloaded, or rate
 * limiting, and the restaurant is standing in onboarding waiting for its
 * menu. It is never an answer to a request Gemini *rejected* — a 400 or 401
 * fails the same way everywhere and must surface as-is.
 *
 * Environment variables (every one optional):
 *
 *   FALLBACK_LLM_BASE_URL    default https://api.deepseek.com/v1
 *   FALLBACK_LLM_API_KEY     no default — without it the text fallback is off
 *   FALLBACK_LLM_MODEL       default deepseek-flash
 *
 * Dish images are Gemini-only (Nov 3): DeepSeek has no images endpoint, so
 * the image fallback could never succeed against the only configured
 * provider. The FALLBACK_IMAGE_* variables are gone with it.
 */

export type FallbackReason = "rate-limit (429)" | "server error (5xx)" | "timeout";

/**
 * Whether a Gemini failure is worth routing to the fallback.
 *
 * The phrases come from `describeGeminiError` and the timeout branch in
 * `_shared/gemini.ts` — that wording is the contract this classifier reads.
 * Gemini's own fetch already retried 429/5xx once before this error reaches
 * us, so a match here means the retries are exhausted. If `gemini.ts` ever
 * rewords its errors, update these patterns with it.
 */
export function fallbackReason(message: string): FallbackReason | null {
  if (/did not respond within/i.test(message)) return "timeout";
  if (/rate limiting/i.test(message)) return "rate-limit (429)";
  if (/server error \(5\d{2}\)/i.test(message)) return "server error (5xx)";
  return null;
}

export type ProviderRoute =
  | "primary-then-fallback"
  | "fallback-only"
  | "unconfigured";

/**
 * Which provider path an extraction should take, decided from the two keys
 * alone and nothing else.
 *
 * A configured Gemini stays the primary (the fallback remains a courtesy for
 * when it fails); a missing or blank Gemini key routes straight to the
 * fallback without calling Gemini or waiting on anything; with neither key
 * there is no reader at all and the caller must answer with the
 * configuration error below. Keys are normalised here so an empty string
 * counts as absent even if a caller forgot to trim.
 */
export function selectProviderRoute(
  geminiApiKey: string | null,
  fallbackApiKey: string | null,
): ProviderRoute {
  const gemini = (geminiApiKey ?? "").trim();
  const fallback = (fallbackApiKey ?? "").trim();
  if (gemini !== "") return "primary-then-fallback";
  if (fallback !== "") return "fallback-only";
  return "unconfigured";
}

/**
 * The error for a deployment with no reader configured at all. It names the
 * two edge function secrets — names only, never values — so the operator
 * knows exactly what to set and the browser never sees a credential.
 */
export const UNCONFIGURED_EXTRACTION_MESSAGE =
  "AI extraction is not configured. The Super Admin has to set the GEMINI_API_KEY edge function secret (the primary provider) or the FALLBACK_LLM_API_KEY edge function secret (the fallback provider).";

export type FallbackLlmConfig = {
  provider: "openai-compatible";
  baseUrl: string;
  apiKey: string | null;
  model: string;
};

function trimToNull(value: string | undefined | null): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function fallbackLlmConfig(get: (key: string) => string | undefined): FallbackLlmConfig {
  return {
    provider: "openai-compatible",
    baseUrl: stripTrailingSlash(
      trimToNull(get("FALLBACK_LLM_BASE_URL")) ?? "https://api.deepseek.com/v1",
    ),
    apiKey: trimToNull(get("FALLBACK_LLM_API_KEY")),
    // deepseek-flash is DeepSeek's current name (V4.1-Flash, image-capable);
    // the old deepseek-chat alias was retired in July 2026.
    model: trimToNull(get("FALLBACK_LLM_MODEL")) ?? "deepseek-flash",
  };
}

/**
 * Strict OpenAI-compatible endpoints refuse `response_format: json_object`
 * unless the prompt literally says "JSON". The extraction prompt does — it
 * asks for "a structured JSON format" and "ONLY valid JSON" — and this check
 * keeps that coupling honest if the prompt is ever reworded.
 */
export function promptMentionsJson(prompt: string): boolean {
  return /json/i.test(prompt);
}

/**
 * Gemini content parts → an OpenAI vision `content` array.
 *
 * `{ text }` becomes a text part and `{ inline_data: { mime_type, data } }`
 * becomes an `image_url` part carrying the same bytes as a data URL. A part
 * of any other shape is dropped rather than sent somewhere it would fail.
 */
export function geminiPartsToOpenAiContent(parts: any[]): any[] {
  const content: any[] = [];
  for (const part of parts ?? []) {
    if (typeof part?.text === "string") {
      content.push({ type: "text", text: part.text });
      continue;
    }
    const inline = part?.inline_data ?? part?.inlineData;
    if (inline?.data) {
      const mimeType = inline.mime_type ?? inline.mimeType ?? "image/jpeg";
      content.push({
        type: "image_url",
        image_url: { url: `data:${mimeType};base64,${inline.data}` },
      });
    }
  }
  return content;
}

/** The chat/completions request body for a menu extraction. */
export function openAiChatBody(opts: {
  model: string;
  content: any[];
  temperature?: number;
}): Record<string, unknown> {
  return {
    model: opts.model,
    messages: [{ role: "user", content: opts.content }],
    temperature: opts.temperature ?? 0.1,
    response_format: { type: "json_object" },
  };
}

/** Pull the text out of a chat/completions response, or say why there is none. */
export function parseOpenAiChatText(json: any): string {
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text === "string" && text.trim() !== "") return text;
  const reason = json?.choices?.[0]?.finish_reason ?? json?.error?.message;
  throw new Error(
    reason
      ? `The fallback model returned no text (${reason}).`
      : "The fallback model returned an empty response.",
  );
}

/**
 * The image formats the fallback endpoint accepts. DeepSeek vision rejects
 * anything else with a 400 ("webp, png, jpeg, and gif") — while Gemini
 * happily reads PDFs and HEIC, so a menu that would scan fine on the
 * primary can be unreadable for the backup. The diagnostics below report
 * against this set.
 */
export const FALLBACK_IMAGE_MIME_TYPES = [
  "image/webp",
  "image/png",
  "image/jpeg",
  "image/gif",
];

/**
 * Redact anything credential-shaped from a provider error before it goes to
 * the logs, and keep the line short. Provider messages have never carried
 * our key — this is the belt-and-braces that keeps the promise if one ever
 * does.
 */
export function sanitizeFallbackDetail(message: string, maxLength = 300): string {
  return String(message ?? "")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-…")
    .replace(/Bearer\s+\S+/gi, "Bearer …")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export type FallbackPayloadSummary = {
  images: number;
  mimeTypes: string[];
  unsupportedMimeTypes: string[];
  promptChars: number;
  approxImageKb: number;
};

/**
 * A one-line description of an extraction payload, safe for the logs: which
 * image types it carries (never the bytes), roughly how big it is, and
 * which of those types the fallback endpoint would refuse outright.
 */
export function summarizeFallbackPayload(parts: any[]): FallbackPayloadSummary {
  let images = 0;
  let approxBytes = 0;
  let promptChars = 0;
  const mimeTypes: string[] = [];
  for (const part of parts ?? []) {
    if (typeof part?.text === "string") {
      promptChars += part.text.length;
      continue;
    }
    const inline = part?.inline_data ?? part?.inlineData;
    if (inline?.data) {
      images++;
      approxBytes += Math.floor((String(inline.data).length * 3) / 4);
      mimeTypes.push(inline.mime_type ?? inline.mimeType ?? "image/jpeg");
    }
  }
  return {
    images,
    mimeTypes,
    unsupportedMimeTypes: [
      ...new Set(mimeTypes.filter((m) => !FALLBACK_IMAGE_MIME_TYPES.includes(m))),
    ],
    promptChars,
    approxImageKb: Math.round(approxBytes / 1024),
  };
}

const UNSUPPORTED_UPLOAD_LABELS: Record<string, string> = {
  "application/pdf": "PDF",
  "image/heic": "HEIC",
  "image/heif": "HEIF",
};

/**
 * Why a payload can't go to the fallback, phrased for the restaurant
 * standing in onboarding — or null when every image is one the fallback
 * reads. Gemini accepts PDFs and HEIC photos; DeepSeek vision accepts only
 * webp/png/jpeg/gif. Sending those would burn a request on a certain 400
 * and then surface the *Gemini* error, which points the user at the wrong
 * fix entirely.
 *
 * `context` picks the honest wording: "after-failure" (the default, and the
 * only behaviour that existed before) is the primary reader failing over —
 * "busy right now" is true there. "only-provider" is the fallback running
 * as *the* reader because no Gemini key is configured, where "busy" would
 * be a lie.
 */
export function fallbackUnsupportedMessage(
  summary: FallbackPayloadSummary,
  context: "after-failure" | "only-provider" = "after-failure",
): string | null {
  if (summary.unsupportedMimeTypes.length === 0) return null;
  const labels = summary.unsupportedMimeTypes.map((m) => UNSUPPORTED_UPLOAD_LABELS[m] ?? m);
  if (context === "only-provider") {
    return (
      "The menu reader can only read JPG, PNG, WebP or GIF images — your upload includes " +
      labels.join(" and ") +
      ". Please upload photos in one of the supported formats."
    );
  }
  return (
    "The AI menu reader is busy right now, and the backup reader can only read " +
    "JPG, PNG, WebP or GIF images — your upload includes " +
    labels.join(" and ") +
    ". Please upload photos in one of the supported formats, or try again in a few minutes."
  );
}
