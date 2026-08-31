// PROVIDER ROUTING, FAILURE HANDLING AND CREDIT ACCOUNTING.
//
// The router decides which provider serves a request and whose key pays for it.
// The bug this replaced spent the SERVER's managed NVIDIA key on every tenant's
// line-item question — outside plan routing and outside credit accounting — so
// these tests care as much about whose key is used as about which provider.

const test = require("node:test");
const assert = require("node:assert/strict");

const router = require("../../src/ai/providers/router");
const adapter = require("../../src/ai/providers/adapter");
const orchestrator = require("../../src/ai/orchestrator");
const entitlements = require("../../src/services/entitlements");
const engine = require("../../src/domain/analysis/engine");
const { scenarios } = require("../helpers/fixtures");

const NOW = Date.parse("2026-06-15T00:00:00Z");
const run = () => engine.analyze(scenarios.duplicatePayment,
  { tenantId: "t1", period: "2026-05", now: NOW });

const CONFIG = Object.freeze({
  enableAiAnalysis: true,
  nvidiaApiKey: "managed-nvidia-key",
  mistralAppKey: "managed-mistral-key"
});

/**
 * A profile on a given plan.
 *
 * `creditsPeriod` must be the CURRENT period, or entitlements.ensurePeriod()
 * treats the profile as a new month and refills the allowance — which would
 * silently undo a deliberately-broke fixture.
 */
function currentPeriod() {
  return entitlements.currentPeriod();
}
function profileOn(plan, extra = {}) {
  return Object.assign(
    { plan, credits: 10000, creditsPeriod: currentPeriod(), aiAssistant: "controller-core" },
    extra);
}

// ── Plan → provider routing ──────────────────────────────────────

test("[P1] the managed plans route to their managed provider and the SERVER's key", () => {
  const starter = router.route({ profile: profileOn("starter"), config: CONFIG, operation: "chat" });
  assert.equal(starter.allowed, true);
  assert.equal(starter.managed, true);
  assert.equal(starter.apiKey, CONFIG.nvidiaApiKey);
  assert.equal(starter.provider, "nvidia");

  const growth = router.route({ profile: profileOn("growth"), config: CONFIG, operation: "chat" });
  assert.equal(growth.allowed, true);
  assert.equal(growth.managed, true);
  assert.equal(growth.apiKey, CONFIG.mistralAppKey);
});

test("[P2] BYOK uses the TENANT's key and provider, and is never metered", async () => {
  const byok = router.route({
    profile: profileOn("custom", { aiProvider: "anthropic", aiApiKey: "tenant-own-key" }),
    config: CONFIG,
    operation: "chat"
  });
  assert.equal(byok.allowed, true);
  assert.equal(byok.managed, false);
  assert.equal(byok.mode, "byok");
  assert.equal(byok.provider, "anthropic");
  assert.equal(byok.apiKey, "tenant-own-key");
  // The server's managed keys must not leak into a BYOK route.
  assert.notEqual(byok.apiKey, CONFIG.nvidiaApiKey);
  assert.notEqual(byok.apiKey, CONFIG.mistralAppKey);

  // Charging lives in src/ai/billing.js; BYOK is unmetered there.
  const billing = require("../../src/ai/billing");
  return billing.charge({ profile: profileOn("custom"), operation: "chat" })
    .then((result) => {
      assert.equal(result.ok, true);
      assert.equal(result.cost, 0, "a BYOK tenant is never metered");
      assert.equal(result.reason, "byok_unmetered");
    });
});

test("[P3] ONE tenant's BYOK key never reaches another tenant's route", () => {
  const a = router.route({
    profile: profileOn("custom", { aiProvider: "openai", aiApiKey: "key-of-tenant-A" }),
    config: CONFIG, operation: "chat"
  });
  const b = router.route({
    profile: profileOn("custom", { aiProvider: "openai", aiApiKey: "key-of-tenant-B" }),
    config: CONFIG, operation: "chat"
  });
  assert.equal(a.apiKey, "key-of-tenant-A");
  assert.equal(b.apiKey, "key-of-tenant-B");
  assert.notEqual(a.apiKey, b.apiKey);
});

test("[P4] a BYOK tenant with no key configured is refused, not silently downgraded", () => {
  // Falling back to the managed key would spend the server's budget on a plan
  // whose whole premise is that the tenant brings their own.
  const denied = router.route({
    profile: profileOn("custom", { aiProvider: "openai", aiApiKey: "" }),
    config: CONFIG, operation: "chat"
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, router.DENIED.NO_KEY_BYOK);
  assert.equal(denied.apiKey, null);
});

test("[P5] an unsupported provider is REFUSED, not sent to the default endpoint", () => {
  // The old transport fell through to config.aiApiBaseUrl (api.openai.com by
  // default), so a user selecting an unsupported provider had their key posted
  // to OpenAI.
  const denied = router.route({
    profile: profileOn("custom", { aiProvider: "totally-made-up", aiApiKey: "k" }),
    config: CONFIG, operation: "chat"
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, router.DENIED.UNSUPPORTED_PROVIDER);
  assert.equal(denied.apiKey, null);
});

test("[P6] AI disabled at the deployment level refuses every route", () => {
  const denied = router.route({
    profile: profileOn("growth"), config: Object.assign({}, CONFIG, { enableAiAnalysis: false }),
    operation: "chat"
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, router.DENIED.DISABLED);
});

test("[P7] a missing MANAGED key is reported as such, not as the tenant's fault", () => {
  const denied = router.route({
    profile: profileOn("starter"), config: { enableAiAnalysis: true, nvidiaApiKey: "" },
    operation: "chat"
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, router.DENIED.NO_KEY_MANAGED);
});

// ── Credits ──────────────────────────────────────────────────────

test("[P8] a managed tenant who cannot afford the operation is refused BEFORE the call", () => {
  const broke = profileOn("starter", { credits: 0 });
  const denied = router.route({ profile: broke, config: CONFIG, operation: "monthly-review" });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, router.DENIED.INSUFFICIENT_CREDITS);
  assert.equal(denied.cost, entitlements.creditCost("monthly-review"));
});

test("[P9] an INTERNAL support call is metered against the same budget", () => {
  // The transaction-filter assist used to be free and on the server's key. It
  // now routes like any other call, so a tenant with no credits cannot use it.
  const broke = profileOn("starter", { credits: 0 });
  const denied = router.route({
    profile: broke, config: CONFIG, operation: "chat", internal: true
  });
  assert.equal(denied.allowed, false, "an internal call is not a free side-channel");
  assert.equal(denied.reason, router.DENIED.INSUFFICIENT_CREDITS);
});

test("[P10] a capability the plan lacks is refused before any provider work", () => {
  const denied = router.route({
    profile: profileOn("starter"), config: CONFIG,
    operation: "what-if", capability: "what_if_simulator"
  });
  if (denied.allowed) {
    // If starter DOES include it, the assertion still has to mean something.
    assert.equal(entitlements.can(profileOn("starter"), "what_if_simulator"), true);
  } else {
    assert.equal(denied.reason, router.DENIED.NOT_ENTITLED);
  }
});

test("[P11] routing NEVER returns the key in a describable form", () => {
  const routed = router.route({ profile: profileOn("starter"), config: CONFIG, operation: "chat" });
  assert.equal(routed.describe(), "managed:nvidia");
  assert.equal(routed.describe().includes(CONFIG.nvidiaApiKey), false,
    "a key must not be loggable via describe()");
});

// ── Per-provider policy ──────────────────────────────────────────

test("[P12] every supported provider has a real timeout ceiling", () => {
  // The old resolveTimeoutMs returned 0 — no timeout at all — whenever the
  // global was unset, which was the default. A wedged provider hung the request.
  router.SUPPORTED.forEach((provider) => {
    const policy = router.policyFor(provider);
    assert.ok(policy.timeoutMs > 0, `${provider} has no timeout`);
    assert.ok(policy.timeoutMs <= 120000, `${provider}'s timeout is unreasonably long`);
  });
  assert.ok(router.policyFor("unknown-provider").timeoutMs > 0,
    "even an unknown provider gets a deadline");
});

test("[P13] the adapter enforces the deadline even if the transport does not", async () => {
  const never = new Promise(() => {});   // never settles
  await assert.rejects(
    () => adapter.withDeadline(never, 25, "slow-provider"),
    /did not respond within 25ms/);
});

// ── Failure handling ─────────────────────────────────────────────

test("[P14] a provider failure is normalised, and never becomes an answer", async () => {
  const result = await adapter.complete({ provider: "nvidia", apiKey: "", prompt: "x" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing_api_key");
  assert.equal(result.text, undefined, "a failure carries no text a caller could render");
});

test("[P15] an EMPTY provider response is a failure, not an empty answer", async () => {
  const legacy = require("../../src/services/aiAnalysisClient");
  const original = legacy.callProvider;
  legacy.callProvider = async () => ({ ok: true, text: "   ", provider: "nvidia", model: "m" });
  try {
    const result = await adapter.complete({ provider: "nvidia", apiKey: "k", prompt: "x" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "empty_response");
  } finally { legacy.callProvider = original; }
});

test("[P16] a provider failure produces NO financial answer and NO charge", async () => {
  const legacy = require("../../src/services/aiAnalysisClient");
  const original = legacy.callProvider;
  legacy.callProvider = async () => ({ ok: false, reason: "provider_unavailable" });
  try {
    const profile = profileOn("starter");
    const before = entitlements.getEntitlement(profile).credits;
    const result = await orchestrator.ask({
      run: run(), tenantId: "t1", profile, config: CONFIG,
      message: "how is my cash flow?", operation: "chat"
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "provider_unavailable");
    assert.equal(result.text, null, "no fabricated answer is substituted");
    assert.equal(result.charged, false);
    assert.equal(entitlements.getEntitlement(profile).credits, before,
      "a failed call is not billed");
  } finally { legacy.callProvider = original; }
});

test("[P17] a MALFORMED provider payload cannot crash the orchestrator", async () => {
  const legacy = require("../../src/services/aiAnalysisClient");
  const original = legacy.callProvider;
  const malformed = [null, undefined, {}, { ok: true }, { ok: true, text: null },
    "a bare string", 42];
  try {
    for (const payload of malformed) {
      legacy.callProvider = async () => payload;
      const result = await orchestrator.ask({
        run: run(), tenantId: "t1", profile: profileOn("starter"), config: CONFIG,
        message: "how is my cash flow?", operation: "chat"
      });
      assert.equal(result.ok, false, `payload ${JSON.stringify(payload)} produced an answer`);
      assert.ok(result.reason, "a reason is always given");
    }
  } finally { legacy.callProvider = original; }
});

test("[P18] a provider that THROWS is caught and reported, not propagated", async () => {
  const legacy = require("../../src/services/aiAnalysisClient");
  const original = legacy.callProvider;
  legacy.callProvider = async () => { throw new Error("socket hang up"); };
  try {
    const result = await orchestrator.ask({
      run: run(), tenantId: "t1", profile: profileOn("starter"), config: CONFIG,
      message: "how is my cash flow?", operation: "chat"
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "request_failed");
  } finally { legacy.callProvider = original; }
});

// ── End-to-end through the orchestrator ──────────────────────────

test("[P19] a VALIDATED answer is delivered and charged; a blocked one is neither", async () => {
  const legacy = require("../../src/services/aiAnalysisClient");
  const original = legacy.callProvider;
  const analysis = run();
  const realAmount = analysis.findings
    .find((f) => f.ruleId === "duplicate_payment").evidence[0].fields.amount;

  try {
    // A truthful answer, using a figure that is genuinely in the data.
    legacy.callProvider = async () => ({
      ok: true, provider: "nvidia", model: "m",
      text: `Two payments of ${realAmount} to the same supplier were flagged for review.`
    });
    const good = profileOn("starter");
    const creditsBefore = entitlements.getEntitlement(good).credits;
    const ok = await orchestrator.ask({
      run: analysis, tenantId: "t1", profile: good, config: CONFIG,
      message: "what was flagged?", operation: "chat"
    });
    assert.equal(ok.ok, true, JSON.stringify(ok.validation || ok.reason));
    orchestrator.chargeFor({ profile: good, result: ok, operation: "chat" });
    assert.ok(entitlements.getEntitlement(good).credits < creditsBefore, "a delivered answer is billed");

    // A fabricated answer.
    legacy.callProvider = async () => ({
      ok: true, provider: "nvidia", model: "m",
      text: "Your revenue was KES 7,777,777 and your score is 91/100."
    });
    const bad = profileOn("starter");
    const badBefore = entitlements.getEntitlement(bad).credits;
    const blocked = await orchestrator.ask({
      run: analysis, tenantId: "t1", profile: bad, config: CONFIG,
      message: "what was flagged?", operation: "chat"
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.blocked, true);
    assert.doesNotMatch(blocked.text, /7,777,777/, "the fabrication is not shown to the user");
    orchestrator.chargeFor({ profile: bad, result: blocked, operation: "chat" });
    assert.equal(entitlements.getEntitlement(bad).credits, badBefore,
      "a blocked answer is NOT billed");
  } finally { legacy.callProvider = original; }
});

test("[P20] the orchestrator refuses to narrate ANOTHER tenant's run", async () => {
  const result = await orchestrator.ask({
    run: engine.analyze(scenarios.healthy, { tenantId: "tenant-A", period: "2026-05", now: NOW }),
    tenantId: "tenant-B",
    profile: profileOn("starter"), config: CONFIG,
    message: "how are we doing?", operation: "chat"
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "tenant_mismatch");
  assert.equal(result.fatal, true);
  assert.equal(result.text, null);
});

test("[P21] with NO analysis run the orchestrator refuses rather than improvising", async () => {
  const result = await orchestrator.ask({
    run: null, tenantId: "t1", profile: profileOn("starter"), config: CONFIG,
    message: "how much did we spend?", operation: "chat"
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_analysis_run");
});

test("[P22] extraFacts admits DETERMINISTIC derived figures, and only those", async () => {
  const legacy = require("../../src/services/aiAnalysisClient");
  const original = legacy.callProvider;
  const analysis = run();
  // A forecast projection: computed by cashflowForecast, not by the model.
  const forecast = { starting_cash: 1200000, days_to_zero: null, horizons: [{ days: 90, projected_balance: 987654 }] };

  try {
    legacy.callProvider = async () => ({
      ok: true, provider: "nvidia", model: "m",
      text: "In 90 days your projected balance is 987,654 if nothing changes."
    });
    const withFacts = await orchestrator.ask({
      run: analysis, tenantId: "t1", profile: profileOn("starter"), config: CONFIG,
      message: "what does the forecast say?", operation: "forecast", extraFacts: forecast
    });
    assert.equal(withFacts.ok, true, "a deterministic projection may be cited");

    // The SAME answer without the facts is unverifiable, and is blocked.
    const withoutFacts = await orchestrator.ask({
      run: analysis, tenantId: "t1", profile: profileOn("starter"), config: CONFIG,
      message: "what does the forecast say?", operation: "forecast"
    });
    assert.equal(withoutFacts.ok, false);
    assert.equal(withoutFacts.blocked, true,
      "extraFacts widens the index deliberately; it is not a blanket bypass");
  } finally { legacy.callProvider = original; }
});
