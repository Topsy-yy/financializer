// THE AI ORCHESTRATOR — the single path every AI request takes.
//
//   context builder  ->  prompt  ->  provider router  ->  adapter
//                                                            |
//                                     output validator  <----+
//                                            |
//                                    answer or safe response
//
// WHY ONE PATH. There were five AI call sites, each assembling its own prompt,
// resolving its own routing and returning the model's text directly to the
// client. Nothing validated the output, and the transaction-filter call skipped
// routing entirely. A single entry point means the guarantees hold everywhere:
// every answer is built from a bounded context, and every answer is checked
// before a user sees it.
//
// THE GUARANTEE. A response reaches the caller only if:
//   * an authoritative analysis run existed to build context from;
//   * the tenant owns that run;
//   * the provider was selected by the router and the tenant could pay;
//   * the answer's financial figures trace back to engine-computed values.
// If any of those fails, the caller gets an honest failure — never a plausible
// answer assembled from nothing.

const { buildAiContext, TenantMismatchError } = require("./context/contextBuilder");
const validator = require("./validation/outputValidator");
const providerRouter = require("./providers/router");
const adapter = require("./providers/adapter");
const billing = require("./billing");

/**
 * Instructions given to the model, replacing the old prompt's reliance on
 * ~15KB of skill documentation to establish role.
 *
 * The rules are stated as constraints on the ANSWER rather than as a persona,
 * because that is what the validator can actually check.
 */
const SYSTEM_RULES = [
  "You are FinGuard AI, the explanation layer of an SME financial controller.",
  "",
  "A deterministic rules engine has already computed every financial figure you are given.",
  "Your job is to explain and prioritise those figures for a business owner.",
  "",
  "HARD RULES:",
  "1. Every number you state must appear in financial_data. Never calculate a new figure,",
  "   a percentage, a total or a projection — if it is not in the data, do not state it.",
  "2. If financial_data does not contain what was asked, say so plainly and name the data",
  "   that would be needed. An honest 'I don't have that' is always correct.",
  "3. Where a figure comes from a finding, refer to that finding by its title or rule.",
  "4. Severity means how much a finding matters if real; confidence means how likely it is",
  "   to be real. Never present a low-confidence finding as established fact.",
  "5. If risk_score.available is false, the engine withheld the score for insufficient",
  "   evidence. Explain that. Do not estimate a score.",
  "6. A finding whose authority is 'tenant' came from a rule THIS BUSINESS wrote, not from",
  "   the engine. Attribute it accordingly and never present it as an engine judgement.",
  "7. The knowledge section is general explanation. It never overrides financial_data,",
  "   and it contains nothing about this business.",
  "",
  "Be concise and practical. Prefer 2-4 short paragraphs and at most 3 action points."
].join("\n");

/**
 * Assemble the prompt from a built context.
 *
 * Kept deliberately simple: the intelligence is in WHAT the context builder
 * selected, not in prompt phrasing.
 */
function buildPrompt({ context, message, history = [], period }) {
  const lines = [SYSTEM_RULES, ""];

  const transcript = formatHistory(history);
  if (transcript) {
    lines.push(
      "=== EARLIER IN THIS CONVERSATION ===",
      transcript,
      "=== END ===",
      "Use the conversation only to resolve what the user is referring to.",
      "Never take a figure from an earlier turn — earlier answers may concern a",
      "different period. Every number must come from financial_data below.",
      ""
    );
  }

  lines.push(
    `The period under discussion is ${period || "the latest analysed period"}.`,
    "",
    "=== AUTHORITATIVE FINANCIAL DATA (the only valid source of figures) ===",
    JSON.stringify(context.payload.financial_data),
    "",
    "=== PRIOR PERIODS (summaries only) ===",
    JSON.stringify(context.payload.history),
    "",
    "=== METHODOLOGY ===",
    JSON.stringify(context.payload.methodology),
    "",
    "=== GENERAL KNOWLEDGE (explanatory; not about this business) ===",
    context.payload.knowledge.map((k) => `[${k.kind}] ${k.title}\n${k.text}`).join("\n\n"),
    "=== END KNOWLEDGE ===",
    "",
    "USER QUESTION:",
    String(message || "")
  );

  return lines.join("\n");
}

function formatHistory(history, maxTurns = 6, maxChars = 600) {
  return (history || [])
    .slice(-maxTurns)
    .map((turn) => {
      const role = turn.role === "assistant" ? "Assistant" : "User";
      const text = String(turn.text || turn.content || "").slice(0, maxChars);
      return text ? `${role}: ${text}` : null;
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Answer a question about a period's authoritative analysis.
 *
 * @param {object} args
 *   run       {object}  the deterministic analysis run — REQUIRED
 *   tenantId  {string}
 *   profile   {object}  for routing and credits
 *   config    {object}
 *   message   {string}
 *   history   {array}
 *   operation {string}  metered operation name (default "chat")
 *   capability{string}  entitlement capability required, if any
 *   monthlyData / retrieval / includeLineItems — line-item retrieval inputs
 * @returns {object} a discriminated result; see the shapes below.
 */
async function ask({
  run,
  tenantId = null,
  profile = null,
  config = null,
  message = "",
  history = [],
  operation = "chat",
  capability = null,
  assistant = null,
  monthlyData = null,
  retrieval = null,
  includeLineItems = false,
  temperature = 0.35,
  /**
   * Additional AUTHORITATIVE values the answer may cite.
   *
   * "Authoritative" means deterministically computed, not "from the engine
   * run". The forecast and what-if simulator are pure functions over the run's
   * own metrics — their projections are as authoritative as a metric, and just
   * as far from being the model's invention. Without this the validator would
   * block a correct answer about a forecast simply because the projection was
   * computed one layer above the run.
   *
   * It must never be used to whitelist a number the model produced.
   */
  extraFacts = null
} = {}) {
  // ── 1. CONTEXT. No authoritative run means no authoritative answer. ──
  let context;
  try {
    context = buildAiContext({
      run, tenantId, message, monthlyData, history, retrieval, includeLineItems
    });
  } catch (err) {
    if (err instanceof TenantMismatchError) {
      // A caller asking for another tenant's analysis is a bug or an attack.
      // Either way it must not be narrated.
      return failure("tenant_mismatch", err.message, { fatal: true });
    }
    return failure(err.code || "context_unavailable", err.message);
  }

  // ── 2. ROUTING. One decision, including for internal support calls. ──
  const routing = providerRouter.route({ profile, config, operation, capability });
  if (!routing.allowed) {
    return failure(routing.reason, describeDenial(routing), { routing, context });
  }

  /* ── 2b. BILLING PREFLIGHT. Checked BEFORE the provider, so a billing
     outage costs no provider tokens. In production an unavailable ledger fails
     closed here rather than after the model has answered. ── */
  const billable = billing.preflight({ tenantId, profile, operation });
  if (!billable.ok) {
    return failure(billable.reason, billable.message
      || "Billing is unavailable, so AI requests are paused.", { routing, context });
  }

  // ── 3. PROVIDER. All provider-specific behaviour lives behind the adapter. ──
  const prompt = buildPrompt({ context, message, period: context.meta.period, history });
  const completion = await adapter.complete({
    provider: routing.provider,
    apiKey: routing.apiKey,
    prompt,
    system: SYSTEM_RULES,
    temperature,
    assistant,
    policy: routing.policy
  });

  if (!completion.ok) {
    // A provider failure must never produce a fabricated financial answer. The
    // caller decides whether to show a deterministic fallback; this layer does
    // not invent one.
    return failure(completion.reason || "ai_request_failed", completion.detail || null, {
      routing, context, provider: completion.provider, model: completion.model
    });
  }

  // ── 4. VALIDATION. Every figure must trace to the engine. ──
  const citable = withExtraFacts(context.citable, extraFacts, run);
  const verdict = validator.validateAnswer({ text: completion.text, citable });

  if (!verdict.valid) {
    const safe = validator.safeResponse({
      verdict: verdict.verdict, issues: verdict.issues, period: context.meta.period
    });
    return Object.freeze({
      ok: false,
      blocked: true,
      reason: verdict.verdict,
      text: safe.text,
      validation: verdict,
      // NOT charged: the tenant did not receive an answer.
      charged: false,
      meta: context.meta,
      provider: completion.provider,
      model: completion.model
    });
  }

  return Object.freeze({
    ok: true,
    text: completion.text,
    provider: completion.provider,
    model: completion.model,
    validation: verdict,
    routing: Object.freeze({
      mode: routing.mode, provider: routing.provider,
      managed: routing.managed, plan: routing.plan
    }),
    meta: context.meta,
    context
  });
}

/**
 * Produce STRUCTURED output (the monthly interpretation), validated against a
 * required schema and against the same citable index.
 */
async function interpret({
  run, tenantId = null, profile = null, config = null,
  businessName = null, operation = "monthly-review", capability = null,
  assistant = null, requiredKeys = [], instruction = "", temperature = 0.15,
  maxTokens = 3072
} = {}) {
  let context;
  try {
    context = buildAiContext({
      run, tenantId,
      message: "Summarise this period for the business owner.",
      knowledgeLimit: 2
    });
  } catch (err) {
    if (err instanceof TenantMismatchError) return failure("tenant_mismatch", err.message, { fatal: true });
    return failure(err.code || "context_unavailable", err.message);
  }

  const routing = providerRouter.route({ profile, config, operation, capability });
  if (!routing.allowed) return failure(routing.reason, describeDenial(routing), { routing, context });

  const prompt = [
    SYSTEM_RULES,
    "",
    businessName ? `Business: ${businessName}` : "",
    `Period: ${context.meta.period}`,
    "",
    "=== AUTHORITATIVE FINANCIAL DATA ===",
    JSON.stringify(context.payload.financial_data),
    "",
    "=== GENERAL KNOWLEDGE ===",
    context.payload.knowledge.map((k) => `[${k.kind}] ${k.title}\n${k.text}`).join("\n\n"),
    "",
    instruction,
    "",
    "Return STRICT JSON only. No prose outside the JSON."
  ].filter(Boolean).join("\n");

  const completion = await adapter.complete({
    provider: routing.provider, apiKey: routing.apiKey, prompt,
    system: SYSTEM_RULES, temperature, assistant, maxTokens, policy: routing.policy
  });
  if (!completion.ok) {
    return failure(completion.reason || "ai_request_failed", completion.detail || null,
      { routing, context, provider: completion.provider });
  }

  const citable = Object.assign({}, context.citable, {
    riskScoreAvailable: run.riskScore.available
  });
  const verdict = validator.validateStructured({ raw: completion.text, citable, requiredKeys });
  if (!verdict.valid) {
    return Object.freeze({
      ok: false, blocked: true, reason: verdict.verdict,
      validation: verdict, charged: false, meta: context.meta,
      provider: completion.provider, model: completion.model
    });
  }

  return Object.freeze({
    ok: true, output: verdict.parsed, provider: completion.provider,
    model: completion.model, validation: verdict, meta: context.meta,
    routing: Object.freeze({ mode: routing.mode, provider: routing.provider,
      managed: routing.managed, plan: routing.plan })
  });
}

/**
 * Charge only after a validated answer was delivered.
 *
 * Goes through src/ai/billing.js so the atomic ledger is used wherever it is
 * available — the same path the copilot uses. Async, because atomicity requires
 * a database round-trip.
 */
async function chargeFor({ profile, result, operation, tenantId = null }) {
  if (!result || !result.ok) return { charged: false, reason: "not_delivered" };
  if (!result.routing || !result.routing.managed) return { charged: false, reason: "not_managed" };
  const charged = await billing.charge({
    tenantId, profile, operation: operation || "chat",
    interactionId: result.meta ? result.meta.analysisRunId : null
  });
  return { charged: charged.ok, cost: charged.cost, remaining: charged.remaining,
    atomic: charged.atomic, reason: charged.reason };
}

/**
 * Fold deterministically-computed values into the citable index.
 *
 * Walks the supplied object and collects every finite number, so a caller
 * passes the same structure it puts in the prompt and cannot accidentally
 * authorise a figure it did not show the model.
 */
function withExtraFacts(citable, extraFacts, run) {
  const base = Object.assign({}, citable, { riskScoreAvailable: run.riskScore.available });
  if (!extraFacts) return Object.freeze(base);

  const numbers = new Set(citable.numbers);
  const collect = (value, depth = 0) => {
    if (depth > 6 || value == null) return;
    if (typeof value === "number") {
      if (Number.isFinite(value)) numbers.add(Math.abs(value));
      return;
    }
    if (Array.isArray(value)) { value.forEach((v) => collect(v, depth + 1)); return; }
    if (typeof value === "object") { Object.values(value).forEach((v) => collect(v, depth + 1)); }
  };
  collect(extraFacts);

  return Object.freeze(Object.assign(base, {
    numbers: Object.freeze(Array.from(numbers).sort((a, b) => a - b))
  }));
}

function describeDenial(routing) {
  switch (routing.reason) {
    case providerRouter.DENIED.NO_KEY_BYOK:
      return "No AI key is configured for this workspace.";
    case providerRouter.DENIED.NO_KEY_MANAGED:
      return "The managed AI provider is not available right now.";
    case providerRouter.DENIED.INSUFFICIENT_CREDITS:
      return `This action costs ${routing.cost} credits and the balance is too low.`;
    case providerRouter.DENIED.NOT_ENTITLED:
      return "This plan does not include that AI feature.";
    case providerRouter.DENIED.UNSUPPORTED_PROVIDER:
      return `The configured AI provider (${routing.requested}) is not supported.`;
    case providerRouter.DENIED.DISABLED:
      return "AI analysis is disabled on this deployment.";
    default:
      return "The AI request could not be made.";
  }
}

function failure(reason, detail = null, extra = {}) {
  return Object.freeze(Object.assign({
    ok: false, blocked: false, reason, detail, charged: false, text: null
  }, extra));
}

module.exports = { ask, interpret, chargeFor, buildPrompt, withExtraFacts, SYSTEM_RULES };
