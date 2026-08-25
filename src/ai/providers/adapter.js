// PROVIDER ADAPTER — the only place that knows how a specific vendor's HTTP API
// is shaped.
//
// Everything above this file (orchestrator, context, validation) is
// provider-agnostic and deals in `{provider, prompt} -> {ok, text}`. Everything
// vendor-specific — base URLs, auth headers, request bodies, response shapes,
// per-model quirks — is below it.
//
// The transports themselves are reused from services/aiAnalysisClient.js rather
// than rewritten: they are working, exercised by the existing suite, and
// rewriting them would risk a regression for no architectural gain. What this
// module adds is the BOUNDARY — one interface, an enforced timeout, and a
// normalised failure shape — so a new provider is a change here and nowhere
// else.

const legacy = require("../../services/aiAnalysisClient");
const { policyFor, DEFAULT_TIMEOUT_MS } = require("./router");

/**
 * Run a completion.
 *
 * @param {object} args
 *   provider  {string} already validated by the router
 *   apiKey    {string} resolved by the router; never taken from a request body
 *   prompt    {string}
 *   temperature, maxTokens, assistant
 *   policy    {object} { timeoutMs, maxTokens } from the router
 * @returns {object} { ok, text, provider, model } | { ok:false, reason, detail }
 */
async function complete({
  provider, apiKey, prompt, temperature = 0.3, maxTokens, assistant = null, policy = null
} = {}) {
  if (!apiKey) {
    // Should be unreachable: the router refuses before this point. Kept as a
    // hard stop so a future caller cannot bypass routing by calling directly.
    return normalizeFailure({ reason: "missing_api_key" }, provider);
  }

  const effective = policy || policyFor(provider);
  const cap = effective.maxTokens
    ? Math.min(maxTokens || effective.maxTokens, effective.maxTokens)
    : maxTokens;

  // A HARD DEADLINE, always. The previous implementation returned a timeout of 0
  // — meaning none — whenever AI_API_TIMEOUT_MS was unset, which was the
  // default, so a wedged provider connection hung the user's HTTP request
  // indefinitely and the per-provider overrides were dead code.
  const timeoutMs = effective.timeoutMs || DEFAULT_TIMEOUT_MS;

  try {
    const completion = await withDeadline(
      legacy.callProvider({ apiKey, provider, prompt, temperature, maxTokens: cap, assistant }),
      timeoutMs,
      provider
    );
    if (!completion || !completion.ok) return normalizeFailure(completion, provider);
    const text = String(completion.text || "").trim();
    if (!text) return normalizeFailure({ reason: "empty_response" }, provider, completion.model);
    return Object.freeze({
      ok: true, text, provider: completion.provider || provider, model: completion.model || null
    });
  } catch (err) {
    return normalizeFailure(
      { reason: err.code === "provider_timeout" ? "timeout" : "request_failed", detail: err.message },
      provider);
  }
}

/**
 * Enforce a deadline even if the underlying transport does not.
 *
 * The losing promise is not cancellable here, so the request may continue in the
 * background — but the USER's request is released, which is the property that
 * matters. The transport's own AbortController handles the socket when the
 * global timeout is configured.
 */
function withDeadline(promise, timeoutMs, provider) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${provider} did not respond within ${timeoutMs}ms`);
      err.code = "provider_timeout";
      reject(err);
    }, timeoutMs);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** One failure shape, whatever the vendor returned. */
function normalizeFailure(completion, provider, model = null) {
  const reason = (completion && completion.reason) || "ai_request_failed";
  return Object.freeze({
    ok: false,
    reason,
    detail: (completion && completion.detail) || null,
    provider: (completion && completion.provider) || provider || null,
    model: (completion && completion.model) || model,
    // Whether retrying could plausibly help — for the caller's messaging, not
    // for an automatic retry, which the transport already does at the socket level.
    retryable: ["timeout", "request_failed", "provider_unavailable", "rate_limited"].includes(reason)
  });
}

module.exports = { complete, withDeadline, normalizeFailure };
