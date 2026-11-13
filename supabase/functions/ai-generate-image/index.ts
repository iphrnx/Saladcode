// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { guard } from "../_shared/auth.ts";
import { admin } from "../_shared/db.ts";
import { body, json, preflight } from "../_shared/http.ts";
import {
  getGeminiConfig,
  geminiGenerateImage,
  parseDataUrl,
} from "../_shared/gemini.ts";
import { withAiLog } from "../_shared/ai-log.ts";
import { checkAiUsage } from "../_shared/ai-guard.ts";

/**
 * POST /functions/v1/ai-generate-image  (menu.manage)
 *
 * Generates a dish photograph with Gemini, stores it in the `menu-images`
 * Storage bucket, and points the menu item at it.
 *
 * The item is looked up with the caller's tenant, so a restaurant can only
 * ever generate and attach an image to its own menu. The generated file is
 * written to `{tenant_id}/{uuid}.{ext}` in the existing public bucket and
 * the public URL is saved on `menu_items.image`.
 *
 * This is the image model only. Menu OCR lives in `ai-extract-menu` and uses
 * the text model — the two are never mixed.
 */

const BUCKET = "menu-images";

const DEFAULT_PROMPT =
  "A professional food photograph of {name}. {description} Appetising, freshly " +
  "plated, shot on a clean neutral surface with soft natural light, shallow depth " +
  "of field, high detail, restaurant menu photography.";

Deno.serve(async (req: Request) => {
  const pf = preflight(req);
  if (pf) return pf;

  const g = await guard(req, { permission: "menu.manage" });
  if (!g.ok) return g.response;

  if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);

  try {
    return await generate(req, g.session.tenantId);
  } catch (e: any) {
    console.error("AI image generation error:", e);
    return json(req, { error: e?.message || "Image generation failed" }, 500);
  }
});

async function generate(req: Request, tenantId: string): Promise<Response> {
  const b = await body(req);
  const itemId = b.itemId ? String(b.itemId) : null;
  const promptOverride = b.prompt ? String(b.prompt).trim() : "";

  if (!itemId && !promptOverride) {
    return json(req, { error: "itemId or prompt is required" }, 400);
  }

  const db = admin();

  // The item is fetched with the caller's tenant, so the image can only ever
  // be attached to a menu item this restaurant owns.
  let item: any = null;
  if (itemId) {
    const { data, error } = await db
      .from("menu_items")
      .select("id, name, description, image")
      .eq("id", itemId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (error) return json(req, { error: error.message }, 500);
    if (!data) {
      return json(req, { error: "Menu item not found" }, 404);
    }
    item = data;
  }

  const config = await getGeminiConfig("gemini");
  if (!config.apiKey) {
    return json(
      req,
      {
        error:
          "Image generation is not configured. The Super Admin has to set the GEMINI_API_KEY edge function secret.",
      },
      503,
    );
  }

  const name = String(item?.name ?? "a dish");
  const description = item?.description ? String(item.description) : "";
  const prompt = promptOverride || DEFAULT_PROMPT
    .replace("{name}", name)
    .replace("{description}", description ? `${description}. ` : "");

  // Pre-flight usage guard: the burst and daily caps are checked before the
  // provider is called, and a tenant over its limit gets a clean 429 rather
  // than a provider error.
  const usage = await checkAiUsage(tenantId, "image");
  if (!usage.ok) return json(req, { error: usage.message }, 429);

  // Dish images are Gemini-only: the one configured fallback provider
  // (DeepSeek) has no images endpoint, so a fallback could never succeed —
  // removed Nov 3 rather than fail noisily on every Gemini outage.
  const image = await withAiLog(
    { provider: "gemini", model: config.imageModel, action: "image", tenantId },
    () =>
      geminiGenerateImage({
        model: config.imageModel,
        apiKey: config.apiKey!,
        prompt,
        timeoutMs: 120_000,
        retries: 1,
      }),
  );

  // Store the file in the existing public bucket, under the restaurant's own
  // folder, so the path says whose image it is.
  const parsed = parseDataUrl(`data:${image.mimeType};base64,${image.data}`);
  const mimeType = parsed?.mimeType ?? image.mimeType;
  const ext = mimeType.includes("png") ? "png" : mimeType.includes("webp") ? "webp" : "jpg";
  const path = `${tenantId}/${crypto.randomUUID()}.${ext}`;

  const bytes = Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0));

  const { error: uploadError } = await db.storage
    .from(BUCKET)
    .upload(path, bytes, { contentType: mimeType, upsert: false });
  if (uploadError) {
    console.error("storage upload failed:", uploadError);
    return json(req, { error: `Could not save the generated image: ${uploadError.message}` }, 500);
  }

  const { data: urlData } = db.storage.from(BUCKET).getPublicUrl(path);
  const publicUrl = urlData?.publicUrl ?? null;
  if (!publicUrl) {
    return json(req, { error: "Could not build the image URL" }, 500);
  }

  // Associate it with the item it was generated for.
  if (item) {
    const { error: updateError } = await db
      .from("menu_items")
      .update({ image: publicUrl })
      .eq("id", item.id)
      .eq("tenant_id", tenantId);
    if (updateError) {
      console.error("could not attach the image to the item:", updateError);
      return json(
        req,
        { error: `The image was generated but could not be attached: ${updateError.message}`, url: publicUrl },
        500,
      );
    }
  }

  return json(req, { url: publicUrl, path, mimeType, itemId: item?.id ?? null });
}
