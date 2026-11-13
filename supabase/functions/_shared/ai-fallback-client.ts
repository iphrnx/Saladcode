// deno-lint-ignore-file no-explicit-any
import {
  geminiPartsToOpenAiContent,
  openAiChatBody,
  promptMentionsJson,
  parseOpenAiChatText,
  sanitizeFallbackDetail,
  type FallbackLlmConfig,
} from "./ai-fallback.ts";

/**
 * The network half of the OpenAI-compatible fallback. `ai-fallback.ts`
 * decides and converts; this module fetches.
 *
 * The callers log and decide when a fallback is worth attempting — a call
 * here means the primary Gemini request already failed in a way worth
 * routing, and the tenant's usage guard already passed.
 */

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(`The fallback model did not respond within ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(
  url: string,
  apiKey: string,
  body: unknown,
  timeoutMs: number,
  retries = 1,
): Promise<any> {
  let attempt = 0;
  for (;;) {
    try {
      const res = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
        },
        timeoutMs,
      );

      const text = await res.text().catch(() => "");
      let parsed: any = null;
      try {
        parsed = JSON.parse(text);
      } catch { /* not JSON */ }

      if (!res.ok) {
        // A 5xx is the fallback provider being busy, not a verdict on the
        // request — DeepSeek's own "Service is too busy". One retry, the
        // same policy the Gemini client applies to its own 5xx.
        if (res.status >= 500 && attempt < retries) {
          attempt++;
          console.warn(
            `[AI Fallback] chat request failed (HTTP ${res.status}); retrying once...`,
          );
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        const detail = parsed?.error?.message ?? text.slice(0, 200);
        throw new Error(`Fallback request failed (${res.status})${detail ? `: ${detail}` : ""}`);
      }
      return parsed;
    } catch (e) {
      const isTimeout = e instanceof Error && /did not respond within/.test(e.message);
      if (isTimeout && attempt < retries) {
        attempt++;
        console.warn("[AI Fallback] chat request timed out; retrying once...");
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      throw e;
    }
  }
}

/**
 * Menu extraction through an OpenAI-compatible chat/completions endpoint.
 * Takes the same Gemini content parts the primary path built and returns the
 * model's text, exactly like `geminiGenerateText`.
 */
export async function fallbackChatCompletion(
  config: FallbackLlmConfig & { apiKey: string },
  parts: any[],
  timeoutMs = 120_000,
): Promise<string> {
  const content = geminiPartsToOpenAiContent(parts);
  const promptText = content
    .filter((part) => part?.type === "text")
    .map((part) => String(part.text))
    .join("\n");
  if (!promptMentionsJson(promptText)) {
    // Strict endpoints refuse json_object mode without the word "JSON" in the
    // prompt. The extraction prompt says it; if that ever changes, this is
    // the warning that explains the failures.
    console.warn("[AI Fallback] the prompt does not mention JSON; strict endpoints may reject json_object mode.");
  }

  let json: any;
  try {
    json = await postJson(
      `${config.baseUrl}/chat/completions`,
      config.apiKey,
      openAiChatBody({ model: config.model, content, temperature: 0.1 }),
      timeoutMs,
    );
  } catch (e) {
    // The thrown message already carries the HTTP status and the provider's
    // detail; the log line is the sanitized copy of it. This is the line to
    // grep when a fallback goes wrong.
    console.error(
      `[AI Fallback] chat request failed: ${sanitizeFallbackDetail((e as Error)?.message ?? String(e))}`,
    );
    throw e;
  }

  try {
    return parseOpenAiChatText(json);
  } catch (e) {
    console.error(
      `[AI Fallback] response parse failed: ${sanitizeFallbackDetail((e as Error)?.message ?? String(e))}`,
    );
    throw e;
  }
}
