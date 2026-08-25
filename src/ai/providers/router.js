// PROVIDER ROUTER — decides WHICH provider serves a request, and under whose key.
//
// Separated from orchestration so that "who pays for this call and with which
// credentials" is one auditable decision, made in one place, rather than being
// re-derived at each of the five AI call sites.
//
// MONETIZATION IS NOT REDESIGNED HERE. The plan → provider mapping and the
// credit costs remain entitlements.js's, and this module calls into it. What is
// added is the part that was missing: validation of the resulting selection,
// and a rule about whose key may be spent.
//
// THE BUG THIS FIXES. `extractTransactionFilter` was called with
// `config.nvidiaApiKey` hardcoded, for every tenant, on every line-item chat
// question — bypassing plan routing, bypassing the credit check, and spending
// the server's managed key on behalf of BYOK customers who bring their own.
// Provider selection now goes through `route()` for EVERY call, including
// internal ones, and an internal call declares itself so it can be metered or
// refused rather than silently absorbed.

const entitlements = require("../../services/entitlements");

/** Providers the transport layer actually implements. */
const SUPPORTED = Object.freeze([
  "openai", "azure-openai", "anthropic", "claude", "google", "gemini",
  "deepseek", "mistral", "grok", "xai", "nvidia", "nim"
]);

/** Why a request cannot be served. Each maps to honest user-facing copy. */
const DENIED = Object.freeze({
  NO_KEY_BYOK: "missing_ai_api_key",
  NO_KEY_MANAGED: "managed_key_unavailable",
  INSUFFICIENT_CREDITS: "insufficient_credits",
  NOT_ENTITLED: "not_entitled",
  DISABLED: "ai_analysis_disabled",
  UNSUPPORTED_PROVIDER: "unsupported_provider"
});

/**
 * Per-provider request policy.
 *
 * TIMEOUTS. `config.aiApiTimeoutMs` defaults to 0, and the old
 * `resolveTimeoutMs` returned 0 — meaning NO timeout at all — whenever the
 * global was unset, which also made every per-provider override dead code. A
 * wedged connection therefore hung the HTTP request indefinitely. Each provider
 * now carries a real ceiling that applies whether or not the global is set.
 */
const POLICY = Object.freeze({
  nvidia: { timeoutMs: 90000, maxTokens: 1536 },
  nim: { timeoutMs: 90000, maxTokens: 1536 },
  mistral: { timeoutMs: 60000 },
  anthropic: { timeoutMs: 60000 },
  claude: { timeoutMs: 60000 },
  google: { timeoutMs: 45000 },
  gemini: { timeoutMs: 45000 },
  deepseek: { timeoutMs: 60000 },
  grok: { timeoutMs: 60000 },
  xai: { timeoutMs: 60000 },
  openai: { timeoutMs: 45000 },
  "azure-openai": { timeoutMs: 45000 }
});

const DEFAULT_TIMEOUT_MS = 45000;

function policyFor(provider) {
  return POLICY[String(provider || "").toLowerCase()] || { timeoutMs: DEFAULT_TIMEOUT_MS };
}

/**
 * Route a request to a provider.
 *
 * @param {object} args
 *   profile   {object}  the tenant's profile (plan, BYOK key, provider choice)
 *   config    {object}  server config (managed keys)
 *   operation {string}  the metered operation name, e.g. "chat", "monthly-review"
 *   capability{string}  an entitlement capability that must be present, if any
 *   internal  {boolean} a support call the user did not ask for directly
 * @returns {object} { allowed, provider, apiKey, managed, plan, reason, policy }
 */
function route({ profile, config, operation, capability = null, internal = false } = {}) {
  if (config && config.enableAiAnalysis === false) {
    return denied(DENIED.DISABLED, { operation });
  }
  if (capability && !entitlements.can(profile, capability)) {
    return denied(DENIED.NOT_ENTITLED, { operation, capability });
  }

  const routing = entitlements.resolveAiRouting(profile, config);
  const provider = normalizeProvider(routing.provider);

  if (!provider) {
    // An unrecognised provider string used to fall through to the generic
    // OpenAI transport — so a user selecting "azure-openai" had their Azure key
    // sent to api.openai.com. Refusing is the only safe response.
    return denied(DENIED.UNSUPPORTED_PROVIDER, {
      operation, requested: routing.provider
    });
  }
  if (!routing.apiKey) {
    return denied(routing.mode === "byok" ? DENIED.NO_KEY_BYOK : DENIED.NO_KEY_MANAGED,
      { operation, provider, managed: routing.managed, plan: routing.plan });
  }

  // CREDITS. An internal support call is charged to the SAME budget as the
  // user-facing operation it serves, so it can never be a free side-channel on
  // the server's key.
  if (routing.managed && operation && !entitlements.canAfford(profile, operation)) {
    return denied(DENIED.INSUFFICIENT_CREDITS, {
      operation, provider,
      plan: routing.plan,
      cost: entitlements.creditCost(operation)
    });
  }

  return Object.freeze({
    allowed: true,
    provider,
    apiKey: routing.apiKey,
    managed: routing.managed,
    mode: routing.mode,
    plan: routing.plan,
    operation: operation || null,
    internal: Boolean(internal),
    policy: policyFor(provider),
    // Never log or return the key itself; this is what is safe to record.
    describe: () => `${routing.mode}:${provider}`
  });
}

function normalizeProvider(value) {
  const p = String(value || "").trim().toLowerCase();
  return SUPPORTED.includes(p) ? p : null;
}

function denied(reason, detail = {}) {
  return Object.freeze(Object.assign({
    allowed: false,
    reason,
    provider: detail.provider || null,
    apiKey: null,
    managed: detail.managed != null ? detail.managed : null,
    policy: policyFor(detail.provider)
  }, detail));
}

// NOTE: charging lives in src/ai/billing.js, not here. This module decides WHO
// serves a request; billing decides what it costs and spends it atomically. The
// non-atomic charge() that used to live here was removed in JOB 9 so there is
// no second, racy path for a future caller to reach for.
module.exports = { route, normalizeProvider, policyFor, SUPPORTED, DENIED, DEFAULT_TIMEOUT_MS };
