// THE FINANCIAL COPILOT — conversation, capabilities, claims and privacy.

const test = require("node:test");
const assert = require("node:assert/strict");

const copilot = require("../../src/ai/copilot/copilot");
const conversation = require("../../src/ai/copilot/conversation");
const copilotStore = require("../../src/ai/copilot/store");
const capabilities = require("../../src/ai/capabilities");
const claimValidator = require("../../src/ai/validation/claimValidator");
const redaction = require("../../src/ai/context/redaction");
const legacy = require("../../src/services/aiAnalysisClient");
const engine = require("../../src/domain/analysis/engine");
const { scenarios } = require("../helpers/fixtures");

const NOW = Date.parse("2026-06-15T00:00:00Z");
const CONFIG = { enableAiAnalysis: true, nvidiaApiKey: "managed-key", mistralAppKey: "m" };

function currentPeriod() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
const profile = (extra = {}) => Object.assign(
  { plan: "starter", credits: 1000, creditsPeriod: currentPeriod(), aiAssistant: "controller-core" },
  extra);

const runFor = (name, tenantId = "t1", period = "2026-05") =>
  engine.analyze(scenarios[name], { tenantId, period, now: NOW });

/** Prime the provider with a structured answer. */
function stub(payload) {
  legacy.callProvider = async () => ({
    ok: true, provider: "nvidia", model: "stub",
    text: typeof payload === "string" ? payload : JSON.stringify(payload)
  });
}
function stubFailure(reason) {
  legacy.callProvider = async () => ({ ok: false, reason, provider: "nvidia" });
}
const originalProvider = legacy.callProvider;
test.afterEach(() => { legacy.callProvider = originalProvider; });

/**
 * A well-formed answer citing a real finding.
 *
 * Some fixtures (healthy, emptyResponse) legitimately have NO findings, so this
 * falls back to citing the analysis run itself — which is always a valid
 * reference.
 */
function goodAnswer(run) {
  const finding = run.findings.find((f) => !f.isDataQuality) || run.findings[0];
  const citation = finding ? `finding:${finding.findingId}` : `analysis_run:${run.analysisRunId}`;
  return {
    summary: "One issue was flagged for review this period.",
    facts: [{ claim: "A finding was raised.", citations: [citation] }],
    inferences: [{ claim: "This may need checking against the invoice.",
      supportingReferences: [citation] }],
    recommendations: [{ claim: "Review the supporting records." }],
    limitations: ["I cannot confirm the outcome from the records alone."]
  };
}

async function ask(overrides = {}) {
  const run = overrides.run || runFor("duplicatePayment");
  return copilot.ask(Object.assign({
    run, tenantId: "t1", profile: profile(), config: CONFIG,
    message: "what needs attention?", store: copilotStore.createStore(null)
  }, overrides));
}

// ── Conversation ─────────────────────────────────────────────────

test("[K1] a follow-up question continues the same conversation", async () => {
  const run = runFor("duplicatePayment");
  const store = copilotStore.createStore(null);
  stub(goodAnswer(run));

  const first = await ask({ run, store, message: "what needs attention?" });
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = await ask({
    run, store, message: "and what should I do about it?",
    conversationId: first.conversationId
  });
  assert.equal(second.conversationId, first.conversationId, "the same conversation");
  assert.ok(second.meta.turnCount > first.meta.turnCount, "turns accumulate");
});

test("[K2] a conversation belongs to ONE tenant and cannot be read by another", () => {
  const store = conversation.createStore();
  const owned = store.open({ tenantId: "tenant-A", period: "2026-05" });
  assert.throws(() => store.get(owned.id, "tenant-B"),
    conversation.ConversationAccessError,
    "another tenant must not resume this conversation");
  // Throwing matters: returning null would look like a new conversation and
  // hide the attempt.
  assert.ok(store.get(owned.id, "tenant-A"));
});

test("[K3] conversation context is BOUNDED — old turns are dropped, not summarised", () => {
  const store = conversation.createStore();
  const c = store.open({ tenantId: "t1", period: "2026-05" });
  for (let i = 0; i < 80; i++) store.append(c, { role: "user", text: `turn ${i}` });

  const snapshot = store.snapshot(c);
  assert.ok(c.turns.length <= conversation.LIMITS.maxTurnsStored, "the buffer is bounded");
  assert.ok(snapshot.droppedTurns > 0, "older turns were dropped");
  assert.ok(snapshot.recentTurns.length <= conversation.LIMITS.turnsInPrompt,
    "only a recent window reaches the prompt");
  assert.equal(snapshot.turnCount, 80, "but the true count is still known");
});

test("[K4] conversation memory holds IDs, never remembered figures", () => {
  const store = conversation.createStore();
  const c = store.open({ tenantId: "t1", period: "2026-05" });
  store.remember(c, "finding", "fnd_abc", "Possible duplicate payment");
  const snapshot = store.snapshot(c);
  const entity = snapshot.entities[0];
  assert.equal(entity.id, "fnd_abc");
  // A figure would make the transcript a competing source of truth.
  assert.equal(entity.value, undefined);
  assert.equal(entity.amount, undefined);
});

test("[K5] a reference resolves to a remembered entity, and does not guess", () => {
  const store = conversation.createStore();
  const c = store.open({ tenantId: "t1", period: "2026-05" });
  store.remember(c, "finding", "fnd_one", "duplicate payment");
  const snapshot = store.snapshot(c);

  assert.equal(conversation.resolveReference("show me the evidence for this", snapshot, "finding").id,
    "fnd_one");
  // With two candidates and no demonstrative, it declines rather than picking.
  store.remember(c, "finding", "fnd_two", "vendor concentration");
  const wider = store.snapshot(c);
  assert.equal(conversation.resolveReference("tell me about vendors", wider, "finding"), null);
});

test("[K6] a changed analysis run is flagged so figures are not carried across turns", () => {
  const store = conversation.createStore();
  const first = store.open({ tenantId: "t1", analysisRunId: "run_a", period: "2026-05" });
  store.append(first, { role: "user", text: "how are we?" });
  const reopened = store.open({
    tenantId: "t1", conversationId: first.id, analysisRunId: "run_b", period: "2026-06"
  });
  assert.equal(store.snapshot(reopened).runChanged, true);
});

// ── Intent routing and capabilities ──────────────────────────────

test("[K7] questions route to the right authoritative capability", () => {
  const cases = [
    ["why did my financial health score drop?", "compare"],
    ["what are my biggest risks this month?", "top_risks"],
    ["show me the evidence behind this finding", "evidence"],
    ["what happens if revenue drops by 20%?", "what_if"],
    ["compare this month with my previous analysis", "compare"],
    ["how is the health score calculated?", "methodology"],
    ["which supplier do we depend on?", "counterparty"]
  ];
  cases.forEach(([question, expected]) =>
    assert.equal(copilot.classifyIntent(question), expected, `"${question}"`));
});

test("[K8] every capability result comes from authoritative data", async () => {
  const run = runFor("duplicatePayment");
  const dup = run.findings.find((f) => f.ruleId === "duplicate_payment");

  const evidence = capabilities.invoke("get_finding_evidence",
    { run, tenantId: "t1", findingId: dup.findingId });
  assert.equal(evidence.ok, true);
  assert.equal(evidence.data.evidence.length, dup.evidence.length,
    "the evidence IS the finding's evidence, not a reconstruction");
  assert.deepEqual(
    evidence.data.evidence.map((e) => e.source_record_id).sort(),
    dup.evidence.map((e) => e.sourceRecordId).sort());
});

test("[K9] a capability with no data returns an honest unavailable, never a substitute", () => {
  const run = runFor("healthy");
  [
    ["explain_finding", { findingId: "fnd_nope" }, "finding_not_found"],
    ["compare_analysis_runs", { previousRun: null }, "no_previous_analysis"],
    ["run_authoritative_what_if", { scenario: "not_a_scenario" }, "unknown_scenario"],
    ["get_methodology_explanation", { ruleId: "not_a_rule" }, "unknown_rule"]
  ].forEach(([name, args, expected]) => {
    const result = capabilities.invoke(name, Object.assign({ run, tenantId: "t1" }, args));
    assert.equal(result.ok, false, `${name} should be unavailable`);
    assert.equal(result.reason, expected);
    assert.equal(result.data, null, "no plausible substitute is returned");
  });
});

test("[K10] a capability refuses another tenant's run", () => {
  const run = runFor("duplicatePayment", "tenant-A");
  const result = capabilities.invoke("get_top_risks", { run, tenantId: "tenant-B" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "tenant_mismatch");
});

test("[K11] the what-if capability runs the DETERMINISTIC simulator", () => {
  const run = runFor("cashflowStress");
  const result = capabilities.invoke("run_authoritative_what_if", {
    run, tenantId: "t1", scenario: "reduce_revenue", params: { percent: 20 }
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.data.result.forecast_after, "the simulator's own output");
  assert.ok(result.data.assumptions.starting_cash != null, "assumptions are stated");
  assert.ok(result.data.limitations.length >= 2, "and so are the limitations");
  assert.match(result.data.limitations[0], /linear/i);
});

test("[K12] comparison is COMPUTED from stored runs, not inferred by a model", () => {
  const may = runFor("duplicatePayment", "t1", "2026-05");
  const apr = runFor("healthy", "t1", "2026-04");
  const result = capabilities.invoke("compare_analysis_runs",
    { run: may, previousRun: apr, tenantId: "t1" });

  assert.equal(result.ok, true);
  assert.equal(result.data.score.before, apr.riskScore.overall);
  assert.equal(result.data.score.after, may.riskScore.overall);
  assert.equal(result.data.score.delta, may.riskScore.overall - apr.riskScore.overall);
  assert.equal(result.data.score.direction, "worsened");
  // Findings are matched by RULE — finding ids are period-scoped and never match.
  assert.ok(result.data.findings.new.some((f) => f.rule_id === "duplicate_payment"));
  assert.deepEqual(result.citations.sort(),
    [`analysis_run:${apr.analysisRunId}`, `analysis_run:${may.analysisRunId}`].sort());
});

test("[K13] an unmeasured metric is a measurement gap, not a movement to zero", () => {
  const withData = runFor("healthy", "t1", "2026-04");
  const without = runFor("emptyResponse", "t1", "2026-05");
  const result = capabilities.invoke("compare_analysis_runs",
    { run: without, previousRun: withData, tenantId: "t1" });

  assert.equal(result.data.score.direction, "not_comparable",
    "a withheld score is not a score of zero");
  assert.match(result.data.score.note, /not measured/i);
  assert.ok(result.data.score.after_reason, "the engine's own reason is given");
});

test("[K14] a comparison across engine versions says so", () => {
  const a = runFor("healthy", "t1", "2026-04");
  const b = Object.assign({}, runFor("healthy", "t1", "2026-05"), { engineVersion: "99.0.0" });
  const result = capabilities.invoke("compare_analysis_runs",
    { run: b, previousRun: a, tenantId: "t1" });
  assert.equal(result.data.engine_changed, true);
  assert.match(result.data.engine_note, /methodology update/i);
});

// ── Fact / inference / recommendation ────────────────────────────

test("[K15] a FACT with a valid citation is accepted", () => {
  const run = runFor("duplicatePayment");
  const finding = run.findings[0];
  const index = claimValidator.buildClaimIndex(
    { numbers: [], findingIds: [finding.findingId], ruleIds: [finding.ruleId],
      metricKeys: [], allKnownRuleIds: [], analysisRunId: run.analysisRunId }, { run });

  const result = claimValidator.validateClaim({
    type: "fact", claim: "A duplicate payment was flagged.",
    citations: [`finding:${finding.findingId}`]
  }, index);
  assert.equal(result.action, "accepted");
  assert.equal(result.type, "fact");
});

test("[K16] an UNSUPPORTED QUALITATIVE claim is not shown as a fact", () => {
  // The gap JOB 8's numeric validator could not close: a confident assertion
  // containing no figures at all.
  const index = claimValidator.buildClaimIndex(
    { numbers: [], findingIds: [], ruleIds: [], metricKeys: [], allKnownRuleIds: [],
      analysisRunId: "run_x" }, {});

  const asserted = claimValidator.validateClaim({
    type: "fact", claim: "Your largest supplier is financially unstable.", citations: []
  }, index);
  assert.equal(asserted.action, "rejected",
    "an uncited assertion must not reach the user as a detected fact");

  // A HEDGED version is demoted to an interpretation rather than removed.
  const hedged = claimValidator.validateClaim({
    type: "fact", claim: "This may suggest supplier concentration risk.", citations: []
  }, index);
  assert.equal(hedged.action, "downgraded");
  assert.equal(hedged.type, "inference");
});

test("[K17] a fact citing a finding from ANOTHER analysis is rejected", () => {
  const mine = runFor("duplicatePayment", "t1");
  const theirs = runFor("duplicatePayment", "tenant-B");
  const index = claimValidator.buildClaimIndex(
    { numbers: [], findingIds: mine.findings.map((f) => f.findingId),
      ruleIds: [], metricKeys: [], allKnownRuleIds: [], analysisRunId: mine.analysisRunId },
    { run: mine });

  const result = claimValidator.validateClaim({
    type: "fact", claim: "A duplicate was found.",
    citations: [`finding:${theirs.findings[0].findingId}`]
  }, index);
  assert.equal(result.action, "rejected", "a cross-analysis citation is not support");
});

test("[K18] a RECOMMENDATION needs no citation, but may not smuggle a figure", () => {
  const index = claimValidator.buildClaimIndex(
    { numbers: [48500], findingIds: [], ruleIds: [], metricKeys: [], allKnownRuleIds: [],
      analysisRunId: "run_x" }, {});

  assert.equal(claimValidator.validateClaim(
    { type: "recommendation", claim: "Reconcile the account this week." }, index).action,
  "accepted");

  assert.equal(claimValidator.validateClaim(
    { type: "recommendation", claim: "Chase the 999,999 outstanding immediately." }, index).action,
  "rejected", "a fabricated figure is rejected wherever it appears");
});

test("[K19] the model's OWN labels are not trusted", () => {
  const index = claimValidator.buildClaimIndex(
    { numbers: [], findingIds: [], ruleIds: [], metricKeys: [], allKnownRuleIds: [],
      analysisRunId: "run_x" }, {});
  const validated = claimValidator.validateResponse({
    summary: "All good.",
    // The model labels an invention as a fact. The label does not make it one.
    facts: [{ claim: "Revenue is growing steadily.", citations: [] }],
    inferences: [], recommendations: [], limitations: []
  }, index);

  assert.equal(validated.response.facts.length, 0, "the unsupported 'fact' is not shown as one");
  assert.ok(validated.report.rejected + validated.report.downgraded > 0);
  assert.ok(validated.response.limitations.some((l) => /removed|interpretation/i.test(l)),
    "and the user is told something was withheld");
});

test("[K20] a response where NOTHING survives validation is not a response", () => {
  const index = claimValidator.buildClaimIndex(
    { numbers: [], findingIds: [], ruleIds: [], metricKeys: [], allKnownRuleIds: [],
      analysisRunId: "run_x" }, {});
  const validated = claimValidator.validateResponse({
    summary: "Your revenue was KES 8,675,309.",
    facts: [{ claim: "Revenue grew 40%.", citations: [] }],
    inferences: [], recommendations: [], limitations: []
  }, index);
  assert.equal(validated.valid, false);
});

// ── Privacy and redaction ────────────────────────────────────────

test("[K21] counterparty identity is NOT sent when the question does not need it", () => {
  const policy = redaction.resolveLevel({
    role: "owner", message: "what are my biggest risks?",
    knownParties: ["Rivera Logistics", "City Power"]
  });
  assert.equal(policy.level, redaction.LEVEL.REDACTED);
  assert.equal(policy.reason, "identity_not_required_for_this_question");
  assert.deepEqual(policy.namedParties, []);
});

test("[K22] an AUTHORIZED user who names a counterparty gets identity expansion", () => {
  const policy = redaction.resolveLevel({
    role: "owner", message: "why is Rivera Logistics flagged?",
    knownParties: ["Rivera Logistics", "City Power"]
  });
  assert.equal(policy.level, redaction.LEVEL.FULL);
  assert.deepEqual(policy.namedParties, ["Rivera Logistics"]);
});

test("[K23] an UNAUTHORIZED role cannot expand identity, even by naming it", () => {
  const policy = redaction.resolveLevel({
    role: "investor", message: "why is Rivera Logistics flagged?",
    knownParties: ["Rivera Logistics"]
  });
  assert.equal(policy.level, redaction.LEVEL.REDACTED,
    "an investor must not have a portfolio company's suppliers confirmed");
  assert.equal(policy.reason, "named_but_not_authorized");
  assert.deepEqual(policy.namedParties, []);

  // And an explicit request for FULL is refused rather than honoured.
  const forced = redaction.resolveLevel({
    role: "auditor", message: "list my suppliers", knownParties: ["Rivera Logistics"],
    requested: redaction.LEVEL.FULL
  });
  assert.equal(forced.level, redaction.LEVEL.REDACTED);
  assert.equal(forced.reason, "not_authorized_for_identity");
});

test("[K24] pseudonyms are stable and reversible, and preserve relationships", () => {
  const aliases = redaction.buildAliasMap({
    tenantId: "t1", period: "2026-05",
    vendors: ["Rivera Logistics", "City Power"], customers: ["BigCo Retail"]
  });
  assert.equal(aliases.toAlias("Rivera Logistics"), "Vendor A");
  assert.equal(aliases.toAlias("City Power"), "Vendor B");
  assert.equal(aliases.toAlias("BigCo Retail"), "Customer A");
  // Stable within the period, so a follow-up means the same supplier.
  assert.equal(aliases.toAlias("Rivera Logistics"), "Vendor A");
  // Reversible for display.
  assert.equal(redaction.rehydrate("Vendor A is your largest supplier.", aliases),
    "Rivera Logistics is your largest supplier.");
});

test("[K25] the AI context contains NO real counterparty name at the redacted level", async () => {
  const run = runFor("vendorConcentration");
  const names = (run.calculations.vendors.parties || []).map((p) => p.name);
  assert.ok(names.length > 0, "precondition: this fixture has named vendors");

  const aliases = redaction.buildAliasMap({
    tenantId: "t1", period: "2026-05", vendors: names, customers: []
  });
  const { buildAiContext } = require("../../src/ai/context/contextBuilder");
  const ctx = buildAiContext({ run, tenantId: "t1", message: "how concentrated am I?" });
  const redacted = copilot.redactPayload(ctx.payload.financial_data,
    redaction.LEVEL.REDACTED, aliases);

  const leaked = redaction.containsIdentity(JSON.stringify(redacted), names);
  assert.deepEqual(leaked, [],
    `real counterparty names reached the model: ${leaked.join(", ")}`);
});

// ── End to end ───────────────────────────────────────────────────

test("[K26] a validated copilot answer separates fact, inference and recommendation", async () => {
  const run = runFor("duplicatePayment");
  stub(goodAnswer(run));
  const result = await ask({ run, message: "what needs attention this month?" });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.answer.facts.length, 1);
  assert.ok(result.answer.facts[0].citations.length > 0, "a fact carries its citation");
  assert.equal(result.answer.inferences.length, 1);
  assert.equal(result.answer.recommendations.length, 1);
  assert.ok(result.answer.limitations.length > 0);
  assert.ok(result.capabilities.length > 0, "authoritative data was retrieved first");
});

test("[K27] a copilot answer that cites nothing real is BLOCKED and not billed", async () => {
  const run = runFor("duplicatePayment");
  stub({
    summary: "Revenue reached KES 9,999,999 this month.",
    facts: [{ claim: "Revenue grew 42%.", citations: [] }],
    inferences: [], recommendations: [], limitations: []
  });
  const p = profile();
  const before = p.credits;
  const result = await ask({ run, profile: p, message: "how did revenue do?" });

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.creditsCharged, 0);
  assert.equal(p.credits, before, "a blocked answer is not billed");
});

test("[K28] a provider failure produces no answer and no charge", async () => {
  stubFailure("provider_unavailable");
  const p = profile();
  const before = p.credits;
  const result = await ask({ profile: p });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "provider_unavailable");
  assert.equal(result.answer, null);
  assert.equal(p.credits, before);
});

test("[K29] malformed provider JSON is blocked, not partially rendered", async () => {
  stub("this is not json at all");
  const result = await ask();
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, "malformed");
});

test("[K30] with no analysis run the copilot refuses rather than improvising", async () => {
  stub(goodAnswer(runFor("healthy")));
  const result = await copilot.ask({
    run: null, tenantId: "t1", profile: profile(), config: CONFIG,
    message: "how much did we spend?", store: copilotStore.createStore(null)
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_analysis_run");
  assert.match(result.text, /nothing authoritative/i);
});

test("[K31] the copilot refuses another tenant's analysis", async () => {
  stub(goodAnswer(runFor("healthy")));
  const result = await copilot.ask({
    run: runFor("duplicatePayment", "tenant-A"), tenantId: "tenant-B",
    profile: profile(), config: CONFIG, message: "what happened?",
    store: copilotStore.createStore(null)
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "tenant_mismatch");
  assert.equal(result.answer, null);
});

test("[K32] an unavailable comparison is explained, not fabricated", async () => {
  stub(goodAnswer(runFor("healthy")));
  const result = await ask({
    run: runFor("healthy"), previousRun: null,
    message: "why is this month worse than last month?"
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "data_unavailable");
  assert.match(result.text, /only have one analysis|nothing to compare/i);
});
