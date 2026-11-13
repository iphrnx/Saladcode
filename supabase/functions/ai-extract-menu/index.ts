// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { guard } from "../_shared/auth.ts";
import { body, json, preflight } from "../_shared/http.ts";
import {
  getGeminiConfig,
  geminiGenerateText,
  parseDataUrl,
} from "../_shared/gemini.ts";
import { withAiLog } from "../_shared/ai-log.ts";
import { aiLimitsFromEnv, checkAiUsage } from "../_shared/ai-guard.ts";
import { normalizeExtractedCategories } from "../_shared/menu-normalize.ts";
import {
  fallbackLlmConfig,
  fallbackReason,
  fallbackUnsupportedMessage,
  sanitizeFallbackDetail,
  selectProviderRoute,
  summarizeFallbackPayload,
  UNCONFIGURED_EXTRACTION_MESSAGE,
  type FallbackLlmConfig,
} from "../_shared/ai-fallback.ts";
import { fallbackChatCompletion } from "../_shared/ai-fallback-client.ts";

/**
 * POST /functions/v1/ai-extract-menu  (menu.manage)
 *
 * Accepts menu images (base64 data URLs) and uses Google Gemini to extract
 * structured menu data, falling back to the OpenAI-compatible endpoint when
 * Gemini fails in a way worth routing — and going to it *directly* when no
 * GEMINI_API_KEY is configured, so a fallback-only deployment still reads
 * menus instead of answering "not configured".
 *
 * This used to call Z AI's `chat/completions/vision`. The prompt, the
 * normalisation and the response shape are unchanged, so the onboarding
 * upload → preview → edit → approve → import workflow works exactly as it
 * did; only the provider behind it changed.
 *
 * The API keys are read on the server, from the edge function secrets
 * (`GEMINI_API_KEY`, `FALLBACK_LLM_API_KEY`) and nowhere else — the table
 * holds model names, which are configuration, not credentials. They are
 * never sent to the browser and never appear in a response or a log.
 */

const PROMPT = `You are an expert at reading restaurant menus from photos/scans. Analyze the menu image(s) and extract ALL menu items into a structured JSON format.

IMPORTANT INSTRUCTIONS:
- Handle blurry, rotated, multi-page, and differently formatted menus.
- For each item, extract: category, name, description (if present), price, veg/non-veg indicator (if visible), variants/sizes (if present), and add-ons (if present).
- If a field is unclear or you're uncertain, set its "confidence" to "low". Otherwise "high".
- An item is "low" confidence if ANY of its fields is uncertain or unreadable, not just one.
- NEVER invent a price. If a price cannot be read, set "price" to null and mark the item "low" confidence. The same applies to the name, the description, the variants and the add-ons: if you cannot read them, leave them out or set them to null rather than guessing.
- Prices should be numbers (without currency symbols).
- If a dish is sold in multiple sizes or portions with their own prices (\"Half ₹180 / Full ₹320\", \"8 pcs ₹250 / 12 pcs ₹420\"), emit ONE item with every size in \"variants\" — never split it into separate items, and never put the portion or size inside the item \"name\".
- Never emit the same dish twice, and never invent a portion price: a size whose price cannot be read gets \"price\": null.
- If the menu is in a non-English language, still extract in the original language but provide an English translation of the name if possible.
- Group items by their category as shown on the menu. If no category is visible, use "Main Menu".
- If several images are given they are pages of the same menu. Merge the pages, keep the categories from each page, and never invent an item that is not on any page.
- Return ONLY valid JSON, no markdown, no explanation.

Return this exact JSON structure:
{
  "categories": [
    {
      "name": "Category Name",
      "icon": "🍽️",
      "items": [
        {
          "name": "Item Name",
          "description": "Item description if available",
          "price": 12.99,
          "veg": true,
          "confidence": "high",
          "variants": [
            { "name": "Half", "price": 8.99 },
            { "name": "Full", "price": 14.99 }
          ],
          "addOns": [
            { "name": "Extra Cheese", "price": 2.00 }
          ],
          "tags": ["spicy", "bestseller"]
        }
      ]
    }
  ]
}

For the category icon, choose an appropriate emoji:
🍛 for main dishes, 🍜 for noodles/soup, 🍢 for grilled/skewers, 🥗 for salads/appetizers, 🍰 for desserts, 🍹 for beverages/drinks, 🍕 for pizza, 🍔 for burgers, 🍣 for sushi, 🥘 for curries, 🍝 for pasta, 🌮 for mexican, 🥟 for dumplings, 🍚 for rice dishes, 🧊 for cold items, 🍞 for bread/bakery.

For tags, use only these values where applicable: veg, non-veg, vegan, spicy, jain, bestseller, new, gluten-free. Never use any other value.
Set "veg" to true if the item appears to be vegetarian, false if non-vegetarian, null if unclear.`;

Deno.serve(async (req: Request) => {
  const pf = preflight(req);
  if (pf) return pf;

  // Authenticate before the method check so an anonymous caller never sees a
  // 405 — every request to this function requires menu.manage.
  const g = await guard(req, { permission: "menu.manage" });
  if (!g.ok) return g.response;

  if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);

  try {
    return await extract(req, g.session.tenantId);
  } catch (e: any) {
    console.error("AI menu extraction error:", e);
    return json(req, { error: e?.message || "AI extraction failed" }, 500);
  }
});

async function extract(req: Request, tenantId: string): Promise<Response> {
  const b = await body(req);
  const images = b.images as string[] | undefined;

  if (!images || !Array.isArray(images) || images.length === 0) {
    return json(req, { error: "No images provided" }, 400);
  }

  // The payload cap is env-tunable; the default keeps the contract the
  // onboarding UI was built against.
  const maxImages = aiLimitsFromEnv().maxMenuScanImages;
  if (images.length > maxImages) {
    return json(req, { error: `Maximum ${maxImages} images allowed` }, 400);
  }

  // Provider selection, decided once up front from the two keys: a
  // configured Gemini stays primary; a missing one routes straight to the
  // fallback; neither is a configuration error. `selectProviderRoute` is the
  // pure decision and is tested offline.
  const config = await getGeminiConfig("gemini");
  const fallbackConfig = fallbackLlmConfig((key) => Deno.env.get(key));
  const route = selectProviderRoute(config.apiKey, fallbackConfig.apiKey);
  if (route === "unconfigured") {
    return json(
      req,
      { error: UNCONFIGURED_EXTRACTION_MESSAGE },
      503,
    );
  }

  // Build the Gemini content parts: the prompt, then one inline image per
  // page. A data URL that will not parse is rejected here rather than sent to
  // Gemini, so the caller gets a clear error rather than a confusing one.
  const parts: any[] = [{ text: PROMPT }];
  for (const img of images) {
    const parsed = parseDataUrl(img);
    if (!parsed || !parsed.data) {
      return json(req, { error: "One of the images could not be read" }, 400);
    }
    parts.push({ inline_data: { mime_type: parsed.mimeType, data: parsed.data } });
  }

  // Pre-flight usage guard: the burst and daily caps are checked before any
  // provider is called, and a tenant over its limit gets a clean 429 rather
  // than a provider error. The fallback below never sees a blocked request.
  const usage = await checkAiUsage(tenantId, "extract");
  if (!usage.ok) return json(req, { error: usage.message }, 429);

  let rawContent: string;
  if (route === "fallback-only") {
    rawContent = await extractWithFallbackOnly(parts, fallbackConfig, tenantId);
  } else {
    try {
      rawContent = await withAiLog(
        { provider: "gemini", model: config.textModel, action: "extract", tenantId },
        () =>
          geminiGenerateText({
            model: config.textModel,
            apiKey: config.apiKey!,
            parts,
            responseMimeType: "application/json",
            temperature: 0.1,
            timeoutMs: 120_000,
            retries: 1,
          }),
      );
    } catch (primaryError) {
      rawContent = await extractWithFallback(parts, primaryError, fallbackConfig, tenantId);
    }
  }

  // Parse the JSON response (handle markdown-wrapped JSON)
  let cleaned = rawContent.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        return json(req, { error: "AI returned unparseable response", raw: rawContent.substring(0, 500) }, 500);
      }
    } else {
      return json(req, { error: "AI returned unparseable response", raw: rawContent.substring(0, 500) }, 500);
    }
  }

  if (!parsed.categories || !Array.isArray(parsed.categories)) {
    return json(req, { error: "AI response missing categories array", raw: rawContent.substring(0, 500) }, 500);
  }

  // Normalisation — portions out of names, duplicates merged into variants,
  // unreadable prices kept null and flagged — lives in _shared/menu-normalize.ts
  // so the edge function and the offline tests share one implementation.
  const normalized = { categories: normalizeExtractedCategories(parsed.categories) };

  return json(req, normalized);
}

/**
 * Route a failed extraction to the OpenAI-compatible fallback — but only when
 * the failure is the kind a fallback can answer (a rate limit, a server
 * error, a timeout) and a fallback key is configured. A rejection (400/401)
 * fails the same way everywhere, so the original error stands.
 */
async function extractWithFallback(
  parts: any[],
  primaryError: unknown,
  config: FallbackLlmConfig,
  tenantId: string,
): Promise<string> {
  const reason = fallbackReason(String((primaryError as Error)?.message ?? ""));
  if (!reason) throw primaryError;

  if (!config.apiKey) throw primaryError;

  console.warn(
    `[AI Fallback] Gemini failed with ${reason}, routing to OpenAI-compatible fallback...`,
  );
  const blocked = fallbackPreflight(parts, "after-failure");
  if (blocked) throw new Error(blocked);

  try {
    return await withAiLog(
      { provider: config.provider, model: config.model, action: "extract", tenantId },
      () => fallbackChatCompletion({ ...config, apiKey: config.apiKey! }, parts),
    );
  } catch (fallbackError) {
    // The primary error is the truthful one to surface: the supported path
    // failed, and the fallback was only ever a courtesy.
    console.error(
      "[AI Fallback] fallback failed:",
      (fallbackError as Error)?.message ?? fallbackError,
    );
    throw primaryError;
  }
}

/**
 * No GEMINI_API_KEY is configured, so the OpenAI-compatible fallback is the
 * only reader. Nothing about Gemini is called or waited on — the request
 * goes straight to the fallback, still behind the usage guard, still logged
 * as the provider that actually answered.
 */
async function extractWithFallbackOnly(
  parts: any[],
  config: FallbackLlmConfig,
  tenantId: string,
): Promise<string> {
  console.warn(
    "[AI Fallback] GEMINI_API_KEY is not configured; routing straight to the OpenAI-compatible fallback.",
  );
  const blocked = fallbackPreflight(parts, "only-provider");
  if (blocked) throw new Error(blocked);

  try {
    return await withAiLog(
      { provider: config.provider, model: config.model, action: "extract", tenantId },
      () => fallbackChatCompletion({ ...config, apiKey: config.apiKey! }, parts),
    );
  } catch (fallbackError) {
    // There is no primary error to fall back on — the fallback IS the
    // provider here, so its own error is the truthful one. It is sanitized
    // because it travels to the browser, not just the logs.
    const message = sanitizeFallbackDetail(
      (fallbackError as Error)?.message ?? String(fallbackError),
    );
    console.error("[AI Fallback] fallback failed:", message);
    throw new Error(message);
  }
}

/**
 * What the fallback is being asked to swallow: image types and rough size,
 * never the bytes. DeepSeek vision refuses anything but webp/png/jpeg/gif,
 * so an UNSUPPORTED flag in the log is the whole diagnosis of a 400 to come.
 * Returns the message that should stop the call when the payload holds a
 * format the fallback cannot read — a payload like that would burn the
 * request on a certain 400 and point the restaurant at the wrong fix.
 */
function fallbackPreflight(
  parts: any[],
  context: "after-failure" | "only-provider",
): string | null {
  const summary = summarizeFallbackPayload(parts);
  console.log(
    `[AI Fallback] payload: ${summary.images} image(s) [${summary.mimeTypes.join(", ")}] ` +
      `~${summary.approxImageKb} KB, prompt ${summary.promptChars} chars` +
      (summary.unsupportedMimeTypes.length > 0
        ? ` — UNSUPPORTED for the fallback: ${summary.unsupportedMimeTypes.join(", ")}`
        : ""),
  );
  const blocked = fallbackUnsupportedMessage(summary, context);
  if (blocked) {
    console.warn(
      `[AI Fallback] not attempted: payload holds ${summary.unsupportedMimeTypes.join(", ")}, ` +
        "which the fallback endpoint cannot read (webp/png/jpeg/gif only).",
    );
  }
  return blocked;
}

