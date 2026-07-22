const config = require("../config");
const { getSkillContextForPage } = require("./skillsManifest");

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

function buildChatPrompt(input) {
  // `context` is this month's already-computed health/cashflow/revenue/anomalies/
  // vendors/customers/actions -- whether computed by the AI (skills-driven) or,
  // when no AI key is configured, by the deterministic fallback engine. Either
  // way it is ground truth for chat: never recompute or contradict it here.
  const context = input.context || {};
  const contextPayload = {
    month: input.month,
    assistant: input.assistant,
    provider: input.provider,
    health: context.health || {},
    cashflow: context.cashflow || {},
    revenue: context.revenue || {},
    anomalies: context.anomalies || {},
    vendors: context.vendors || {},
    customers: context.customers || {},
    actions: context.actions || {}
  };

  const skillContext = getSkillContextForPage("chat");

  return [
    "You are FinGuard AI, the virtual financial controller described in the skill documentation below.",
    "Read it to understand your positioning, tone, and what's expected of you before answering.",
    "=== SKILL DOCUMENTATION ===",
    skillContext,
    "=== END SKILL DOCUMENTATION ===",
    "",
    "Answer as a financial controller for SMEs.",
    "Base your answer on the context JSON below, which is already-computed for this month -- treat it as ground truth, do not recompute or contradict it.",
    "If uncertain, say what additional data is needed.",
    "Be concise, practical, and include 1-3 action points.",
    "Do not expose secrets.",
    "Context JSON:",
    JSON.stringify(contextPayload),
    "User question:",
    input.message
  ].join("\n");
}

function buildInterpretationPrompt(input) {
  const skillOutputs = input.skillOutputs || {};

  const allSkillDocs = [
    "overview",
    "financial_health",
    "cashflow",
    "revenue",
    "risk",
    "vendors",
    "customers",
    "actions",
    "executive_report"
  ]
    .map((page) => getSkillContextForPage(page))
    .filter(Boolean);

  // De-duplicate (several pages share skills like financial-controller-core).
  const skillContext = Array.from(new Set(allSkillDocs.join("\n\n---\n\n").split("\n\n---\n\n"))).join("\n\n---\n\n");

  return [
    "You are FinGuard AI, the virtual financial controller described in the skill documentation below.",
    "Read each skill's Purpose, Responsibilities, tone guidance, and thresholds carefully --",
    "this defines what you are expected to detect, how to talk about it, and to whom.",
    "",
    "=== SKILL DOCUMENTATION ===",
    skillContext,
    "=== END SKILL DOCUMENTATION ===",
    "",
    `Business: ${input.businessName || "this business"}, period: ${input.period || "current month"}.`,
    "",
    "Below is this month's data, already computed by the deterministic skill engine described above.",
    "Treat every number here as ground truth -- never recompute, contradict, or invent figures not present in it.",
    "Your job is ONLY to narrate and explain it, per the executive-report-generator tone guidelines",
    "(plain English, lead with impact, be specific with names/amounts, honest but constructive, calibrated urgency).",
    "",
    "Skill output data:",
    JSON.stringify(skillOutputs),
    "",
    "Return STRICT JSON only, matching this schema exactly:",
    "{",
    '  "overall_summary": "2-3 sentence founder-friendly summary",',
    '  "overall_risk_level": "low|medium|high",',
    '  "pages": {',
    '    "financial_health": { "narrative": "...", "key_findings": ["..."] },',
    '    "cashflow": { "narrative": "...", "key_findings": ["..."], "recommended_actions": ["..."] },',
    '    "revenue": { "narrative": "...", "key_findings": ["..."] },',
    '    "risk": { "narrative": "...", "key_findings": ["..."] },',
    '    "vendors": { "narrative": "...", "key_findings": ["..."] },',
    '    "customers": { "narrative": "...", "key_findings": ["..."] },',
    '    "actions": { "recommended_actions": ["..."] }',
    "  },",
    '  "executive_report": {',
    '    "executive_summary": "...",',
    '    "key_insights": ["..."],',
    '    "what_is_working": ["..."],',
    '    "what_needs_attention": ["..."],',
    '    "priority_actions": [{ "rank": 1, "action": "...", "why": "..." }]',
    "  }",
    "}",
    "Rules:",
    "- Never claim confirmed fraud; use indicator language only (per fraud-and-errors-detector positioning).",
    "- Name specific customers/vendors/amounts when present in the data above.",
    "- Keep every array to a maximum of 6 items.",
    "- Keep each narrative to 2-3 sentences.",
    "- If a section's underlying data is empty/absent, say so briefly rather than inventing content."
  ].join("\n");
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

async function callOpenAiCompatible({ apiKey, provider, prompt, temperature, baseUrlOverride, modelOverride, timeoutMsOverride, maxTokens }) {
  const model = modelOverride || config.aiApiModel || "gpt-5-mini";
  const endpoint = buildEndpoint(baseUrlOverride || config.aiApiBaseUrl);
  const controller = new AbortController();
  const timeoutMs = timeoutMsOverride || clamp(toNumber(config.aiApiTimeoutMs, 15000), 3000, 60000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(endpoint, {
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
      signal: controller.signal
    });

    if (!res.ok) {
      const errorText = await res.text();
      return { ok: false, reason: classifyProviderError(res.status, errorText), detail: errorText, provider: provider || "openai", model };
    }

    const data = await res.json();
    return { ok: true, text: extractTextFromCompletion(data), provider: provider || "openai", model };
  } catch (error) {
    return {
      ok: false,
      reason: error.name === "AbortError" ? "timeout" : "request_failed",
      detail: error.message,
      provider: provider || "openai",
      model
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function callAnthropic({ apiKey, prompt, temperature, maxTokens }) {
  const model = ANTHROPIC_DEFAULT_MODEL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), clamp(toNumber(config.aiApiTimeoutMs, 15000), 3000, 60000));

  try {
    const res = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
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
      signal: controller.signal
    });

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
    clearTimeout(timeout);
  }
}

async function callGemini({ apiKey, prompt, temperature, maxTokens }) {
  const model = GEMINI_DEFAULT_MODEL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), clamp(toNumber(config.aiApiTimeoutMs, 15000), 3000, 60000));

  try {
    const res = await fetch(`${GEMINI_BASE_URL}/models/${model}:generateContent`, {
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
      signal: controller.signal
    });

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
    clearTimeout(timeout);
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
    // provider (~15 tokens/sec observed), so it gets a longer timeout and a
    // tighter max_tokens cap than other providers to keep latency reasonable.
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

async function generateAiChatResponse({ apiKey, provider, assistant, month, context, message }) {
  const prompt = buildChatPrompt({ provider, assistant, month, context, message });
  const completion = await callChatCompletions({ apiKey, provider, prompt, temperature: 0.35, assistant });

  if (!completion.ok) return completion;

  return {
    ok: true,
    provider: completion.provider,
    model: completion.model,
    text: completion.text.trim()
  };
}

function clip(arr, n) {
  return Array.isArray(arr) ? arr.slice(0, n) : [];
}

function normalizePageNarrative(page) {
  return {
    narrative: String((page && page.narrative) || "").trim(),
    key_findings: clip(page && page.key_findings, 6),
    recommended_actions: clip(page && page.recommended_actions, 6)
  };
}

/**
 * The deterministic skill engine (riskEngine.js + api.js) has already computed
 * every number for this month. The AI's only job here is to read those numbers
 * plus the skill docs and produce founder-facing narrative, key findings, and
 * an executive report -- never to recompute or contradict the figures.
 */
async function generateAiInterpretation({ apiKey, provider, assistant, businessName, period, skillOutputs }) {
  const prompt = buildInterpretationPrompt({ businessName, period, skillOutputs });
  const completion = await callChatCompletions({ apiKey, provider, prompt, temperature: 0.15, maxTokens: 3072, assistant });

  if (!completion.ok) return completion;

  const parsed = parseJsonMaybe(completion.text);
  if (!parsed) {
    return { ok: false, reason: "unparseable_response", detail: completion.text, provider: completion.provider, model: completion.model };
  }

  const pages = parsed.pages || {};

  return {
    ok: true,
    provider: completion.provider,
    model: completion.model,
    output: {
      overall_summary: String(parsed.overall_summary || "").trim(),
      overall_risk_level: String(parsed.overall_risk_level || "medium").toLowerCase(),
      pages: {
        financial_health: normalizePageNarrative(pages.financial_health),
        cashflow: normalizePageNarrative(pages.cashflow),
        revenue: normalizePageNarrative(pages.revenue),
        risk: normalizePageNarrative(pages.risk),
        vendors: normalizePageNarrative(pages.vendors),
        customers: normalizePageNarrative(pages.customers),
        actions: normalizePageNarrative(pages.actions)
      },
      executive_report: {
        executive_summary: String((parsed.executive_report && parsed.executive_report.executive_summary) || "").trim(),
        key_insights: clip(parsed.executive_report && parsed.executive_report.key_insights, 6),
        what_is_working: clip(parsed.executive_report && parsed.executive_report.what_is_working, 6),
        what_needs_attention: clip(parsed.executive_report && parsed.executive_report.what_needs_attention, 6),
        priority_actions: clip(parsed.executive_report && parsed.executive_report.priority_actions, 6)
      }
    }
  };
}

module.exports = {
  generateAiChatResponse,
  generateAiInterpretation
};
