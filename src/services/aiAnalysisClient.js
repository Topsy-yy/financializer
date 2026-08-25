const config = require("../config");
const { logger } = require("./logger");
const log = logger.child({ component: "ai-transport" });

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-5";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
// "-latest" is a Google-maintained alias that always points at the current
// release for this tier -- avoids hard-coding a dated model ID that Google
// later retires out from under us (the exact bug that hit the OpenAI default).
const GEMINI_DEFAULT_MODEL = "gemini-flash-latest";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-flash";

const MISTRAL_BASE_URL = "https://api.mistral.ai/v1";
const MISTRAL_DEFAULT_MODEL = "mistral-large-latest";
const XAI_BASE_URL = "https://api.x.ai/v1";
const XAI_DEFAULT_MODEL = "grok-4.5";
const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
// The app's built-in default LLMs (no user-provided key needed). One NVIDIA
// build.nvidia.com key covers all of these -- each assistant persona is
// routed to whichever model fits it best. Users who bring their own AI
// provider/key in Settings bypass this entirely.
const NVIDIA_MODEL_BY_ASSISTANT = {
  "controller-core": "meta/llama-3.1-70b-instruct",
  "risk-analyst": "nvidia/llama-3.3-nemotron-super-49b-v1",
  // mixtral-8x22b-instruct-v0.1 reached end-of-life on NVIDIA's catalog
  // (2026-05-21, HTTP 410) -- llama-3.2-3b-instruct is small/fast, a good
  // fit for the interactive cashflow-guardian chat persona.
  "cashflow-guardian": "meta/llama-3.2-3b-instruct",
  // deepseek-r1-distill-qwen-32b 404s on this catalog (retired/gated) --
  // mixtral-8x7b-instruct-v0.1 verified live as of 2026-07-22.
  "executive-brief": "mistralai/mixtral-8x7b-instruct-v0.1"
};
const NVIDIA_FALLBACK_MODEL = "qwen/qwen3-next-80b-a3b-instruct";

function resolveNvidiaModel(assistant) {
  return NVIDIA_MODEL_BY_ASSISTANT[assistant] || NVIDIA_FALLBACK_MODEL;
}
const SYSTEM_PROMPT =
  "You are FinGuard AI, the interpretation and narration layer for an SME financial controller app. " +
  "All figures you are given (scores, findings, amounts, percentages) are already computed by a " +
  "deterministic rule engine described in the skill specifications you are given -- treat them as ground " +
  "truth. Your job is to explain, contextualize, and prioritize them for a founder, never to recompute them.";

function normalizeBaseUrl(input) {
  const value = String(input || "").trim();
  if (!value) return "https://api.openai.com/v1";
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function buildEndpoint(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (normalized.endsWith("/chat/completions")) return normalized;
  return `${normalized}/chat/completions`;
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Upper bound on line items placed in the chat prompt. Keeps token cost (and
// latency on slow providers) predictable no matter how large a month is.
const CHAT_MAX_TRANSACTIONS = 120;
const CHAT_MAX_LEDGER_ROWS = 40;

function compactAmount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}
function compactText(value, max) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max || 80);
}

/**
 * Ask a cheap/free model (NVIDIA by default) to turn a vague line-item question
 * into a structured filter, which the deterministic retrieval layer then
 * executes. This runs ONLY when code-based parsing found no concrete filter, so
 * the common cases stay instant and this never adds latency to them.
 *
 * The output is a tiny JSON object, so the call is short in both directions.
 */
async function extractTransactionFilter({ apiKey, provider, message, parties, period }) {
  if (!apiKey) return null;
  const prompt = [
    "Convert the user's question about financial records into a JSON filter.",
    "Respond with ONLY a JSON object, no prose, using any of these optional keys:",
    '{"day":<1-31>,"date":"YYYY-MM-DD","parties":["exact name from the list"],"text":"keyword",',
    ' "minAmount":<number>,"rank":"desc"|"asc","limit":<1-20>,"wantReceivables":true,"wantPayables":true}',
    "Omit keys that do not apply. Use {} if the question is not about specific records.",
    "Only use party names from this list: " + JSON.stringify((parties || []).slice(0, 60)),
    "The period being discussed is " + (period || "the current month") + ".",
    "Question: " + message
  ].join("\n");

  const completion = await callChatCompletions({
    apiKey,
    provider: provider || "nvidia",
    prompt,
    temperature: 0,
    maxTokens: 200
  });
  if (!completion.ok || !completion.text) return null;
  const parsed = parseJsonMaybe(completion.text);
  return parsed && typeof parsed === "object" ? parsed : null;
}

function extractTextFromCompletion(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => item?.text || "")
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Turns a raw HTTP status + error body into a small set of stable reasons the
 * rest of the app (and the UI) can branch on, instead of an opaque "http_429"
 * the user has no way to interpret.
 */
function classifyProviderError(status, bodyText) {
  const lower = String(bodyText || "").toLowerCase();

  if (
    status === 429 ||
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("quota") ||
    lower.includes("resource_exhausted") ||
    lower.includes("resource has been exhausted")
  ) {
    return "rate_limited";
  }

  // Some providers (xAI included) return 402/403 "permission-denied" for a
  // billing/credits problem on an otherwise-valid key -- check for that
  // BEFORE the generic 401/403 "bad key" bucket below, or a real key gets
  // wrongly reported as "rejected" when the actual issue is no credits.
  if (
    status === 402 ||
    lower.includes("insufficient balance") ||
    lower.includes("insufficient_balance") ||
    lower.includes("no credits") ||
    lower.includes("doesn't have any credits") ||
    lower.includes("does not have any credits") ||
    lower.includes("licenses yet") ||
    lower.includes("purchase") ||
    lower.includes("billing")
  ) {
    return "insufficient_balance";
  }

  if (
    status === 401 ||
    status === 403 ||
    lower.includes("invalid api key") ||
    lower.includes("invalid_api_key") ||
    lower.includes("incorrect api key") ||
    lower.includes("permission_denied") ||
    lower.includes("permission-denied") ||
    lower.includes("api key not valid")
  ) {
    return "invalid_api_key";
  }

  if (
    status === 404 ||
    lower.includes("model_not_found") ||
    lower.includes("does not exist") ||
    lower.includes("not found for api version") ||
    lower.includes("is not a valid model")
  ) {
    return "model_not_found";
  }

  if (status >= 500) return "provider_unavailable";

  return `http_${status}`;
}

function parseJsonMaybe(text) {
  try {
    return JSON.parse(text);
  } catch {
    const block = String(text).match(/\{[\s\S]*\}/);
    if (!block) return null;
    try {
      return JSON.parse(block[0]);
    } catch {
      return null;
    }
  }
}

// Resolve the effective abort timeout. When config.aiApiTimeoutMs is 0 (the
// default) the timeout is disabled entirely — even a per-call override is
// ignored — so the AI controller never aborts a slow-but-valid response and
// falls back to the rule-based report. Set AI_API_TIMEOUT_MS > 0 to re-enable.
function resolveTimeoutMs(override) {
  const base = toNumber(config.aiApiTimeoutMs, 0);
  if (base <= 0) return 0; // disabled globally -> no timeout at all
  return override && override > 0 ? override : base;
}

// Create an abort signal that fires after `timeoutMs`, or no signal at all when
// the timeout is disabled (timeoutMs = 0). `clear()` is always safe to call.
function makeAbort(timeoutMs) {
  if (!timeoutMs) return { signal: undefined, clear: function () {} };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, clear: function () { clearTimeout(timer); } };
}

// Transient network faults that are worth retrying. These are connection-level
// failures (the request never reached the provider), not provider rejections —
// retrying an auth/quota error would be pointless, so those are excluded.
const RETRYABLE_NETWORK_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",  // TCP connect timed out (flaky route / IPv6 stall)
  "UND_ERR_SOCKET",           // socket closed mid-flight
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",                // transient DNS failure
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE"
]);

function networkErrorCode(error) {
  const cause = error && error.cause;
  return (cause && (cause.code || cause.name)) || error.code || "";
}
function isRetryableNetworkError(error) {
  if (!error || error.name === "AbortError") return false; // a real timeout, not transient
  return RETRYABLE_NETWORK_CODES.has(networkErrorCode(error));
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * fetch() that transparently retries transient connection failures.
 *
 * Intermittent UND_ERR_CONNECT_TIMEOUT is the common failure mode on networks
 * with a flaky IPv6 route: the same request succeeds moments later. Rather than
 * surfacing that to the user as "couldn't reach the AI", retry a few times with
 * exponential backoff so a working connection is almost always found.
 *
 * Attempts are controlled by AI_NETWORK_RETRIES (default 3 total attempts).
 */
async function fetchWithRetry(endpoint, options, label) {
  const attempts = Math.max(1, toNumber(config.aiNetworkRetries, 3));
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fetch(endpoint, options);
    } catch (error) {
      lastError = error;
      if (!isRetryableNetworkError(error) || attempt === attempts) break;
      const backoffMs = 400 * Math.pow(2, attempt - 1); // 400ms, 800ms, 1600ms…
      log.warn(
        `[AI] ${label} connection failed (${networkErrorCode(error)}) — retrying ${attempt}/${attempts - 1} in ${backoffMs}ms`
      );
      await sleep(backoffMs);
    }
  }
  throw lastError;
}

async function callOpenAiCompatible({ apiKey, provider, prompt, temperature, baseUrlOverride, modelOverride, timeoutMsOverride, maxTokens }) {
  const model = modelOverride || config.aiApiModel || "gpt-5-mini";
  const endpoint = buildEndpoint(baseUrlOverride || config.aiApiBaseUrl);
  const { signal, clear } = makeAbort(resolveTimeoutMs(timeoutMsOverride));

  try {
    const res = await fetchWithRetry(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: maxTokens || 1024,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt }
        ]
      }),
      signal: signal
    }, provider || "openai");

    if (!res.ok) {
      const errorText = await res.text();
      return { ok: false, reason: classifyProviderError(res.status, errorText), detail: errorText, provider: provider || "openai", model };
    }

    const data = await res.json();
    return { ok: true, text: extractTextFromCompletion(data), provider: provider || "openai", model };
  } catch (error) {
    // Surface the real network cause (proxy, DNS, TLS, reset) — this is what the
    // "Could not reach the AI provider" fallback hides from the UI.
    log.error(
      `[AI] ${provider || "openai"} request to ${endpoint} failed:`,
      error.name, "-", error.message,
      error.cause ? "| cause: " + (error.cause.code || error.cause.message || error.cause) : ""
    );
    return {
      ok: false,
      reason: error.name === "AbortError" ? "timeout" : "request_failed",
      detail: error.message,
      provider: provider || "openai",
      model
    };
  } finally {
    clear();
  }
}

async function callAnthropic({ apiKey, prompt, temperature, maxTokens }) {
  const model = ANTHROPIC_DEFAULT_MODEL;
  const { signal, clear } = makeAbort(resolveTimeoutMs());

  try {
    const res = await fetchWithRetry(`${ANTHROPIC_BASE_URL}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens || 1024,
        temperature,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }]
      }),
      signal: signal
    }, "anthropic");

    if (!res.ok) {
      const errorText = await res.text();
      return { ok: false, reason: classifyProviderError(res.status, errorText), detail: errorText, provider: "anthropic", model };
    }

    const data = await res.json();
    const text = (data.content || []).map((block) => block.text || "").filter(Boolean).join("\n");
    return { ok: true, text, provider: "anthropic", model };
  } catch (error) {
    return {
      ok: false,
      reason: error.name === "AbortError" ? "timeout" : "request_failed",
      detail: error.message,
      provider: "anthropic",
      model
    };
  } finally {
    clear();
  }
}

async function callGemini({ apiKey, prompt, temperature, maxTokens }) {
  const model = GEMINI_DEFAULT_MODEL;
  const { signal, clear } = makeAbort(resolveTimeoutMs());

  try {
    const res = await fetchWithRetry(`${GEMINI_BASE_URL}/models/${model}:generateContent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature, maxOutputTokens: maxTokens || 1024 }
      }),
      signal: signal
    }, "google");

    if (!res.ok) {
      const errorText = await res.text();
      return { ok: false, reason: classifyProviderError(res.status, errorText), detail: errorText, provider: "google", model };
    }

    const data = await res.json();
    const candidate = (data.candidates || [])[0];
    const parts = (candidate && candidate.content && candidate.content.parts) || [];
    const text = parts.map((part) => part.text || "").filter(Boolean).join("\n");
    return { ok: true, text, provider: "google", model };
  } catch (error) {
    return {
      ok: false,
      reason: error.name === "AbortError" ? "timeout" : "request_failed",
      detail: error.message,
      provider: "google",
      model
    };
  } finally {
    clear();
  }
}

async function callChatCompletions({ apiKey, provider, prompt, temperature = 0.2, maxTokens, assistant }) {
  if (!config.enableAiAnalysis) {
    return { ok: false, reason: "ai_analysis_disabled" };
  }

  if (!apiKey) {
    return { ok: false, reason: "missing_api_key" };
  }

  const normalizedProvider = String(provider || "openai").toLowerCase();

  if (normalizedProvider === "anthropic" || normalizedProvider === "claude") {
    return callAnthropic({ apiKey, prompt, temperature, maxTokens });
  }
  if (normalizedProvider === "google" || normalizedProvider === "gemini") {
    return callGemini({ apiKey, prompt, temperature, maxTokens });
  }
  if (normalizedProvider === "deepseek") {
    return callOpenAiCompatible({
      apiKey,
      provider,
      prompt,
      temperature,
      maxTokens,
      baseUrlOverride: DEEPSEEK_BASE_URL,
      modelOverride: DEEPSEEK_DEFAULT_MODEL
    });
  }
  if (normalizedProvider === "mistral") {
    // Mistral's API is OpenAI-compatible (Bearer auth, /chat/completions shape),
    // so it reuses the same client with a base URL + model override.
    // (timeoutMsOverride only applies if AI_API_TIMEOUT_MS is re-enabled; by
    // default the timeout is off so slow responses aren't aborted.)
    return callOpenAiCompatible({
      apiKey,
      provider,
      prompt,
      temperature,
      maxTokens,
      baseUrlOverride: MISTRAL_BASE_URL,
      modelOverride: MISTRAL_DEFAULT_MODEL,
      timeoutMsOverride: 60000
    });
  }
  if (normalizedProvider === "grok" || normalizedProvider === "xai") {
    // Grok's API is OpenAI-compatible (Bearer auth, /chat/completions shape),
    // so this reuses the same client as DeepSeek/OpenAI with an override.
    return callOpenAiCompatible({
      apiKey,
      provider,
      prompt,
      temperature,
      maxTokens,
      baseUrlOverride: XAI_BASE_URL,
      modelOverride: XAI_DEFAULT_MODEL
    });
  }
  if (normalizedProvider === "nvidia" || normalizedProvider === "nim") {
    // NVIDIA NIM (build.nvidia.com) is also OpenAI-compatible, and offers a
    // free-credits tier that doesn't require billing to be set up first.
    // Its shared free-tier infra is measurably slower than a dedicated
    // provider (~15 tokens/sec observed), so it keeps a tighter max_tokens cap.
    // The timeout is disabled by default (see resolveTimeoutMs) so a slow NVIDIA
    // response completes instead of aborting to the rule-based report.
    return callOpenAiCompatible({
      apiKey,
      provider,
      prompt,
      temperature,
      maxTokens: Math.min(maxTokens || 1024, 1536),
      baseUrlOverride: NVIDIA_BASE_URL,
      modelOverride: resolveNvidiaModel(assistant),
      timeoutMsOverride: 90000
    });
  }

  return callOpenAiCompatible({ apiKey, provider, prompt, temperature, maxTokens });
}

/**
 * TEST-ONLY provider stub.
 *
 * Lets the HTTP suite exercise the real request path — route, orchestrator,
 * context builder, validator — without a network call, which is the only way to
 * prove that a fabricated answer is blocked AT THE ROUTE rather than merely in
 * a unit test.
 *
 * Doubly gated: it does nothing unless BOTH NODE_ENV === "test" and the
 * AI_TEST_PROVIDER flag are set, so it cannot be reached in a deployed
 * environment even if the flag were set by accident.
 */
let testStub = null;
function isTestStubEnabled() {
  return process.env.NODE_ENV === "test" && process.env.AI_TEST_PROVIDER === "1";
}
function setTestStub(next) {
  if (!isTestStubEnabled()) return false;
  testStub = next;
  return true;
}

module.exports = {
  extractTransactionFilter,
  // JOB 8: the transport, exposed so src/ai/providers/adapter.js can own the
  // boundary while the provider-specific HTTP code stays here. Everything above
  // the adapter is provider-agnostic; this is the seam between the two.
  callProvider: async function callProviderWithStub(args) {
    if (isTestStubEnabled() && testStub) {
      if (testStub.fail) return { ok: false, reason: testStub.fail, provider: args.provider };
      return { ok: true, text: testStub.text || "", provider: args.provider, model: "test-stub" };
    }
    return callChatCompletions(args);
  },
  setTestStub,
  isTestStubEnabled,
  classifyProviderError
};
