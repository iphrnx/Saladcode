/**
 * The AI onboarding usage guard and the OpenAI-compatible fallback, tested
 * without a database or a network.
 *
 * Everything under test here is pure, on purpose: the limits, the "is this
 * failure worth a fallback" classifier, and the Gemini ↔ OpenAI shape
 * conversions. The edge functions do the I/O; these are the decisions they
 * ask for.
 *
 *   npm run test:ai-guard-offline
 */
import {
  resolveAiLimits,
  usageDecision,
  type AiLimits,
} from "../supabase/functions/_shared/ai-limits.ts";
import {
  FALLBACK_IMAGE_MIME_TYPES,
  fallbackLlmConfig,
  fallbackReason,
  fallbackUnsupportedMessage,
  geminiPartsToOpenAiContent,
  openAiChatBody,
  parseOpenAiChatText,
  promptMentionsJson,
  sanitizeFallbackDetail,
  selectProviderRoute,
  summarizeFallbackPayload,
  UNCONFIGURED_EXTRACTION_MESSAGE,
} from "../supabase/functions/_shared/ai-fallback.ts";
import { fallbackChatCompletion } from "../supabase/functions/_shared/ai-fallback-client.ts";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

const envOf = (vars: Record<string, string>) => (key: string) => vars[key];
const DEFAULTS: AiLimits = resolveAiLimits(() => undefined);

// ---------------------------------------------------------------------------
console.log("\n── resolving limits from the environment ──");
check("the defaults match the documented caps",
  DEFAULTS.menuScansPerMinute === 5 &&
  DEFAULTS.dishImagesPerMinute === 20 &&
  DEFAULTS.menuScansPerDay === 15 &&
  DEFAULTS.dishImagesPerDay === 60 &&
  DEFAULTS.maxMenuScanImages === 10,
  JSON.stringify(DEFAULTS));

{
  const limits = resolveAiLimits(envOf({ AI_MAX_RPM_PER_TENANT: "8" }));
  check("AI_MAX_RPM_PER_TENANT sets both per-minute limits",
    limits.menuScansPerMinute === 8 && limits.dishImagesPerMinute === 8);
  check("and leaves the daily caps alone",
    limits.menuScansPerDay === 15 && limits.dishImagesPerDay === 60);
}

{
  const limits = resolveAiLimits(envOf({
    AI_MAX_RPM_PER_TENANT: "8",
    AI_MAX_MENU_SCANS_RPM: "3",
    AI_MAX_DISH_IMAGES_PER_TENANT: "42",
    AI_MAX_MENU_SCAN_IMAGES: "5",
  }));
  check("a per-action limit beats the global one",
    limits.menuScansPerMinute === 3 && limits.dishImagesPerMinute === 8);
  check("daily and payload caps override independently",
    limits.dishImagesPerDay === 42 && limits.maxMenuScanImages === 5);
}

{
  const limits = resolveAiLimits(envOf({
    AI_MAX_MENU_SCANS_RPM: "banana",
    AI_MAX_DISH_IMAGES_PER_TENANT: "-4",
    AI_MAX_MENU_SCANS_PER_TENANT: "0",
  }));
  check("garbage values fall back to the defaults",
    limits.menuScansPerMinute === 5 &&
    limits.dishImagesPerDay === 60 &&
    limits.menuScansPerDay === 15);
}

// ---------------------------------------------------------------------------
console.log("\n── the usage decision ──");
check("a tenant under every limit is allowed",
  usageDecision({ action: "extract", limits: DEFAULTS, requestsLastMinute: 0, successesToday: 0 }).ok);
check("the burst limit blocks at the cap, not above it",
  !usageDecision({ action: "extract", limits: DEFAULTS, requestsLastMinute: 5, successesToday: 0 }).ok);
check("one short of the burst limit is still allowed",
  usageDecision({ action: "extract", limits: DEFAULTS, requestsLastMinute: 4, successesToday: 0 }).ok);
check("the daily cap blocks at the cap",
  !usageDecision({ action: "image", limits: DEFAULTS, requestsLastMinute: 0, successesToday: 60 }).ok);

{
  const minute = usageDecision({ action: "extract", limits: DEFAULTS, requestsLastMinute: 5, successesToday: 0 });
  check("the burst message says per-minute",
    !minute.ok && /5 per minute/.test(minute.message), minute.ok ? "" : minute.message);
  const day = usageDecision({ action: "extract", limits: DEFAULTS, requestsLastMinute: 0, successesToday: 15 });
  check("the daily message is the clean onboarding-limit message",
    !day.ok && /Daily AI onboarding limit reached/.test(day.message), day.ok ? "" : day.message);
  const imageDay = usageDecision({ action: "image", limits: DEFAULTS, requestsLastMinute: 0, successesToday: 60 });
  check("the daily message names the action",
    !imageDay.ok && /dish image/.test(imageDay.message), imageDay.ok ? "" : imageDay.message);
}

// ---------------------------------------------------------------------------
console.log("\n── when a Gemini failure deserves a fallback ──");
check("an upstream rate limit does",
  fallbackReason("Gemini is rate limiting this key. Wait a moment and try again.") === "rate-limit (429)");
check("a 503 overload does",
  fallbackReason("Gemini had a server error (503): model is overloaded.") === "server error (5xx)");
check("a 500 does",
  fallbackReason("Gemini had a server error (500).") === "server error (5xx)");
check("a timeout does",
  fallbackReason("Gemini did not respond within 90s.") === "timeout");
check("a rejected request (400) does not",
  fallbackReason("Gemini rejected the request (bad request).") === null);
check("a refused key (401) does not",
  fallbackReason("Gemini refused the key (401). Check the GEMINI_API_KEY edge function secret.") === null);
check("an unknown model (404) does not",
  fallbackReason("Gemini does not recognise the model \"gemini-x\".") === null);
check("an empty response does not",
  fallbackReason("Gemini returned an empty response.") === null);
check("a quota-shaped 4xx (429 in advice text only) is not misread",
  fallbackReason("Gemini request failed (429)") === null);

// ---------------------------------------------------------------------------
console.log("\n── provider selection (which reader answers) ──");
check("both configured → Gemini stays primary, fallback on failure",
  selectProviderRoute("gemini-key", "sk-fallback") === "primary-then-fallback");
check("Gemini only → still primary (fallback simply never fires)",
  selectProviderRoute("gemini-key", null) === "primary-then-fallback");
check("fallback only → straight to the fallback, no Gemini call",
  selectProviderRoute(null, "sk-fallback") === "fallback-only");
check("neither configured → unconfigured",
  selectProviderRoute(null, null) === "unconfigured");
check("an empty Gemini key counts as missing",
  selectProviderRoute("", "sk-fallback") === "fallback-only");
check("a blank fallback key counts as missing",
  selectProviderRoute("gemini-key", "   ") === "primary-then-fallback");
check("both empty → unconfigured",
  selectProviderRoute("", "") === "unconfigured");
check("the unconfigured error names both secrets and no value",
  /GEMINI_API_KEY/.test(UNCONFIGURED_EXTRACTION_MESSAGE) &&
  /FALLBACK_LLM_API_KEY/.test(UNCONFIGURED_EXTRACTION_MESSAGE) &&
  !/sk-|Bearer/.test(UNCONFIGURED_EXTRACTION_MESSAGE),
  UNCONFIGURED_EXTRACTION_MESSAGE);

// Provider failures keep their existing meanings under every route:
// a qualifying primary failure (429/5xx/timeout) routes, a rejection does
// not — the checks above and below this block are the contract.
check("a primary 400 under primary-then-fallback still surfaces as-is",
  fallbackReason("Gemini rejected the request (bad request).") === null);
check("a primary 503 under primary-then-fallback still routes",
  fallbackReason("Gemini had a server error (503).") === "server error (5xx)");

// ---------------------------------------------------------------------------
console.log("\n── fallback configuration ──");
{
  const llm = fallbackLlmConfig(() => undefined);
  check("the LLM fallback defaults to DeepSeek flash and is off without a key",
    llm.baseUrl === "https://api.deepseek.com/v1" &&
    llm.model === "deepseek-flash" &&
    llm.apiKey === null,
    JSON.stringify(llm));
}
{
  const llm = fallbackLlmConfig(envOf({
    FALLBACK_LLM_BASE_URL: "https://openrouter.ai/api/v1/",
    FALLBACK_LLM_API_KEY: " sk-or-test ",
    FALLBACK_LLM_MODEL: "deepseek/deepseek-chat-v3",
  }));
  check("env overrides are trimmed and the trailing slash is stripped",
    llm.baseUrl === "https://openrouter.ai/api/v1" &&
    llm.apiKey === "sk-or-test" &&
    llm.model === "deepseek/deepseek-chat-v3",
    JSON.stringify(llm));
}
// ---------------------------------------------------------------------------
console.log("\n── Gemini parts become OpenAI vision messages ──");
{
  const parts = [
    { text: "Extract the menu as JSON." },
    { inline_data: { mime_type: "image/jpeg", data: "QUJD" } },
    { inline_data: { mime_type: "image/png", data: "REVG" } },
    { somethingElse: true },
  ];
  const content = geminiPartsToOpenAiContent(parts);
  check("the prompt becomes the text part",
    content[0]?.type === "text" && content[0]?.text === "Extract the menu as JSON.");
  check("each inline image becomes a data-URL image_url part",
    content[1]?.type === "image_url" &&
    content[1]?.image_url?.url === "data:image/jpeg;base64,QUJD" &&
    content[2]?.image_url?.url === "data:image/png;base64,REVG");
  check("a part of an unknown shape is dropped",
    content.length === 3);

  const body = openAiChatBody({ model: "deepseek-flash", content });
  const messages = body.messages as Array<{ role: string; content: unknown }>;
  check("the chat body asks for strict JSON",
    (body.response_format as { type: string })?.type === "json_object");
  check("and carries one user message with the full content array",
    messages.length === 1 && messages[0].role === "user" &&
    (messages[0].content as unknown[]).length === 3);
  check("and keeps the extraction temperature",
    body.temperature === 0.1);
}

// ---------------------------------------------------------------------------
console.log("\n── the JSON-mode coupling with the prompt ──");
check("a prompt that asks for JSON passes",
  promptMentionsJson("Return ONLY valid JSON, no markdown."));
check("a prompt that never says JSON is caught",
  !promptMentionsJson("Describe this photograph."));

// ---------------------------------------------------------------------------
console.log("\n── reading the fallback's answers ──");
{
  const ok = parseOpenAiChatText({ choices: [{ message: { content: "  {\"categories\":[]}" } }] });
  check("chat text comes back verbatim",
    ok === "  {\"categories\":[]}");
  let threw = "";
  try {
    parseOpenAiChatText({ choices: [{ message: { content: "" }, finish_reason: "length" }] });
  } catch (e) { threw = (e as Error).message; }
  check("an empty completion says why",
    /no text \(length\)/.test(threw), threw);
}

// ---------------------------------------------------------------------------
console.log("\n── sanitized diagnostics ──");
{
  check("an sk- key is redacted",
    sanitizeFallbackDetail("bad key sk-abc123XYZ_-998 in the header") === "bad key sk-… in the header");
  check("a bearer token is redacted",
    sanitizeFallbackDetail("sent Bearer tok.live.12345 by mistake") === "sent Bearer … by mistake");
  check("whitespace is collapsed for one-line logs",
    sanitizeFallbackDetail("line one\n\nline   two") === "line one line two");
  check("long details are truncated",
    sanitizeFallbackDetail("x".repeat(400), 100).length === 100);
}

{
  const summary = summarizeFallbackPayload([
    { text: "Extract the menu as JSON." },
    { inline_data: { mime_type: "application/pdf", data: "QUJD" } },
    { inline_data: { mime_type: "image/png", data: "QUJDRA==" } },
  ]);
  check("the payload summary counts images and prompt",
    summary.images === 2 && summary.promptChars === 25);
  check("and lists the mime types it saw",
    summary.mimeTypes.join(",") === "application/pdf,image/png");
  check("and flags the one the fallback would refuse",
    summary.unsupportedMimeTypes.join(",") === "application/pdf");
  check("a fully supported payload flags nothing",
    summarizeFallbackPayload([{ inline_data: { mime_type: "image/jpeg", data: "QUJD" } }])
      .unsupportedMimeTypes.length === 0);
  check("the accepted set is exactly DeepSeek's",
    FALLBACK_IMAGE_MIME_TYPES.join(",") === "image/webp,image/png,image/jpeg,image/gif");
}

// ---------------------------------------------------------------------------
console.log("\n── the unsupported-upload pre-flight ──");
{
  const supported = summarizeFallbackPayload([
    { text: "Extract the menu as JSON." },
    { inline_data: { mime_type: "image/png", data: "QUJD" } },
  ]);
  check("a readable payload is not blocked",
    fallbackUnsupportedMessage(supported) === null);

  const pdf = summarizeFallbackPayload([
    { text: "x" },
    { inline_data: { mime_type: "application/pdf", data: "QUJD" } },
  ]);
  const pdfMessage = fallbackUnsupportedMessage(pdf);
  check("a PDF upload is blocked with an actionable message",
    pdfMessage !== null && pdfMessage.includes("PDF") &&
    pdfMessage.includes("JPG, PNG, WebP or GIF"),
    pdfMessage ?? "");

  const heic = summarizeFallbackPayload([
    { text: "x" },
    { inline_data: { mime_type: "image/heic", data: "QUJD" } },
  ]);
  check("an HEIC photo names HEIC in the message",
    (fallbackUnsupportedMessage(heic) ?? "").includes("HEIC"));

  // The two contexts a blocked payload can arrive in: after a primary
  // failure (the reader is "busy") and with the fallback as the only
  // configured reader (where "busy" would be a lie).
  const pdfOnly = summarizeFallbackPayload([
    { text: "x" },
    { inline_data: { mime_type: "application/pdf", data: "QUJD" } },
  ]);
  const onlyMessage = fallbackUnsupportedMessage(pdfOnly, "only-provider");
  check("the only-provider wording does not claim the reader is busy",
    onlyMessage !== null && !/busy/.test(onlyMessage) && onlyMessage.includes("PDF"),
    onlyMessage ?? "");
  check("the after-failure wording keeps the busy-reader phrasing",
    /busy/.test(fallbackUnsupportedMessage(pdfOnly, "after-failure") ?? ""));
  check("the default context is after-failure (existing callers unchanged)",
    fallbackUnsupportedMessage(pdfOnly) === fallbackUnsupportedMessage(pdfOnly, "after-failure"));
}

// ---------------------------------------------------------------------------
console.log("\n── the fallback retries a busy provider once ──");
{
  const config = {
    provider: "openai-compatible" as const,
    baseUrl: "https://fallback.test/v1",
    apiKey: "sk-test",
    model: "test-model",
  };
  const parts = [{ text: "Return the menu as JSON." }];
  const originalFetch = globalThis.fetch;
  const stubFetch = (handlers: Array<() => Response | Promise<Response>>) => {
    let calls = 0;
    globalThis.fetch = (async () => {
      const handler = handlers[Math.min(calls, handlers.length - 1)];
      calls++;
      return handler();
    }) as typeof fetch;
    return () => calls;
  };
  const chatOk = () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "{\"categories\":[]}" } }] }), { status: 200 });

  let calls = stubFetch([
    () => new Response(JSON.stringify({ error: { message: "Service is too busy" } }), { status: 503 }),
    chatOk,
  ]);
  const recovered = await fallbackChatCompletion(config, parts).then((t) => ({ ok: t }), (e: Error) => ({ err: e.message }));
  check("a 503 then a 200 recovers, in exactly two calls",
    "ok" in recovered && recovered.ok === "{\"categories\":[]}" && calls() === 2,
    JSON.stringify(recovered));

  calls = stubFetch([chatOk]);
  const busyTwice = await fallbackChatCompletion(config, parts).then(
    (t) => ({ ok: t }),
    (e: Error) => ({ err: e.message }),
  );
  check("a working first attempt is never retried",
    "ok" in busyTwice && calls() === 1);

  calls = stubFetch([
    () => new Response(JSON.stringify({ error: { message: "unsupported image" } }), { status: 400 }),
  ]);
  const rejected = await fallbackChatCompletion(config, parts).then((t) => ({ ok: t }), (e: Error) => ({ err: e.message }));
  check("a 400 fails immediately, no retry",
    "err" in rejected && /failed \(400\): unsupported image/.test(rejected.err ?? "") && calls() === 1,
    JSON.stringify(rejected));

  const abort = () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); };
  calls = stubFetch([abort, abort]);
  const timedOut = await fallbackChatCompletion(config, parts).then((t) => ({ ok: t }), (e: Error) => ({ err: e.message }));
  check("a timeout is retried exactly once, then surfaces",
    "err" in timedOut && /did not respond within/.test(timedOut.err ?? "") && calls() === 2,
    JSON.stringify(timedOut));

  globalThis.fetch = originalFetch;
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
