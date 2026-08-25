// OUTPUT VALIDATION — can we actually detect a fabricated financial claim?
//
// This is the test file that matters most in JOB 8. The subsystem's central
// promise is that a number the model invented never reaches a user, and that
// promise is only worth as much as these tests.
//
// The prior baseline pinned the opposite behaviour:
//   [16c][KNOWN-BAD] "the false figure is returned verbatim to the user"

const test = require("node:test");
const assert = require("node:assert/strict");

const validator = require("../../src/ai/validation/outputValidator");
const { buildAiContext } = require("../../src/ai/context/contextBuilder");
const engine = require("../../src/domain/analysis/engine");
const { scenarios } = require("../helpers/fixtures");

const NOW = Date.parse("2026-06-15T00:00:00Z");
const runFor = (name, tenantId = "t1") =>
  engine.analyze(scenarios[name], { tenantId, period: "2026-05", now: NOW });

/** The citable index for a scenario, as the orchestrator would build it. */
function citableFor(name, message = "how are we doing?") {
  const run = runFor(name);
  const ctx = buildAiContext({ run, tenantId: "t1", message });
  return Object.assign({}, ctx.citable, { riskScoreAvailable: run.riskScore.available });
}

// ── Number extraction ────────────────────────────────────────────

test("[V1] financial figures are extracted from prose in every form a model writes them", () => {
  const text = "Revenue was KES 1,234,567, up 12.5%, with 2.4m in the pipeline and 45k outstanding.";
  const values = validator.extractNumbers(text).map((n) => n.value);
  assert.ok(values.includes(1234567), "comma-separated");
  assert.ok(values.includes(12.5), "decimal percentage");
  assert.ok(values.includes(2400000), "'2.4m' expanded");
  assert.ok(values.includes(45000), "'45k' expanded");
});

test("[V2] ambient numbers are not treated as financial claims", () => {
  // Flagging these would make validation fire on every answer and be ignored.
  ["3 steps", "the top 5 vendors", "in 2026", "100% of the total"].forEach((phrase) => {
    const result = validator.validateAnswer({
      text: `Here are ${phrase}.`,
      citable: { numbers: [], findingIds: [], ruleIds: [], allKnownRuleIds: [] }
    });
    assert.equal(result.valid, true, `"${phrase}" should not be flagged`);
  });
});

// ── The core promise ─────────────────────────────────────────────

test("[V3] a FABRICATED figure is detected and the answer is invalid", () => {
  const citable = citableFor("duplicatePayment");
  // The exact failure the old baseline pinned as acceptable.
  const result = validator.validateAnswer({
    text: "Revenue fell by 87% to KES 12,345,678 this month.",
    citable
  });
  assert.equal(result.valid, false);
  assert.equal(result.verdict, validator.VERDICT.UNSUPPORTED_NUMBERS);
  assert.ok(result.unsupported.length > 0, "the offending figures are named");
  assert.ok(result.issues[0].detail.includes("deterministic engine"));
});

test("[V4] a TRUE figure copied from the data passes", () => {
  const run = runFor("duplicatePayment");
  const ctx = buildAiContext({ run, tenantId: "t1", message: "explain the duplicate" });
  const citable = Object.assign({}, ctx.citable, { riskScoreAvailable: run.riskScore.available });

  const dup = run.findings.find((f) => f.ruleId === "duplicate_payment");
  const amount = dup.evidence[0].fields.amount;
  const result = validator.validateAnswer({
    text: `Two payments of ${amount} to the same supplier on the same day were flagged.`,
    citable
  });
  assert.equal(result.valid, true, JSON.stringify(result.issues));
});

test("[V5] legitimate ROUNDING is accepted, invention is not", () => {
  const citable = { numbers: [123456, 4.2], findingIds: [], ruleIds: [], allKnownRuleIds: [] };

  // "about 123,000" is the same figure, rounded. A model saying this is correct.
  assert.equal(validator.validateAnswer({
    text: "You spent about 123,000 last month.", citable
  }).valid, true);
  // 4.2 months narrated as "around 4 months".
  assert.equal(validator.isSupported(4, [4.2]), true);
  // A different number entirely is not a rounding of it.
  assert.equal(validator.validateAnswer({
    text: "You spent about 890,000 last month.", citable
  }).valid, false);
});

test("[V6] a claim that a rule FIRED when it did not is rejected", () => {
  const citable = citableFor("healthy");
  // The healthy fixture produces no duplicate finding.
  assert.ok(!citable.ruleIds.includes("duplicate_payment"));
  const result = validator.validateAnswer({
    text: "We detected duplicate_payment issues this month that need review.",
    citable
  });
  assert.equal(result.valid, false);
  assert.equal(result.verdict, validator.VERDICT.UNSUPPORTED_FINDING);
});

test("[V7] naming a rule WITHOUT claiming it fired is allowed", () => {
  const citable = citableFor("healthy");
  const result = validator.validateAnswer({
    text: "Nothing was flagged this month. We routinely check for duplicate_payment "
      + "and unreconciled_account, and neither raised anything.",
    citable
  });
  assert.equal(result.valid, true, JSON.stringify(result.issues));
});

test("[V8] a citation to a finding that does not exist is rejected", () => {
  const citable = citableFor("duplicatePayment");
  const result = validator.validateAnswer({
    text: "See finding fnd_000000000000000000000000 for details.",
    citable
  });
  assert.equal(result.valid, false);
  assert.equal(result.verdict, validator.VERDICT.UNSUPPORTED_FINDING);
});

test("[V9] a WITHHELD risk score cannot be supplied by the model", () => {
  const run = runFor("emptyResponse");
  assert.equal(run.riskScore.available, false, "precondition: the engine withheld it");
  const ctx = buildAiContext({ run, tenantId: "t1", message: "how healthy are we?" });
  const citable = Object.assign({}, ctx.citable, { riskScoreAvailable: false });

  const result = validator.validateAnswer({
    text: "Your financial health score is 72/100, which is good.",
    citable
  });
  assert.equal(result.valid, false);
  assert.ok([validator.VERDICT.FABRICATED_SCORE, validator.VERDICT.UNSUPPORTED_NUMBERS]
    .includes(result.verdict), `unexpected verdict ${result.verdict}`);

  // Explaining the absence is the correct answer, and passes.
  assert.equal(validator.validateAnswer({
    text: "I can't give you a health score for this period — the engine withheld it "
      + "because there wasn't enough data to measure enough of the model.",
    citable
  }).valid, true);
});

// ── Malformed provider output ────────────────────────────────────

test("[V10] an empty answer is a failure, not an empty success", () => {
  const result = validator.validateAnswer({ text: "", citable: citableFor("healthy") });
  assert.equal(result.valid, false);
  assert.equal(result.verdict, validator.VERDICT.EMPTY);
});

test("[V11] without a citable index nothing is claimed to be verified", () => {
  // Failing open here would mean an unverified answer looked verified.
  const result = validator.validateAnswer({ text: "Revenue was KES 900,000.", citable: null });
  assert.equal(result.valid, false);
  assert.equal(result.verdict, validator.VERDICT.MALFORMED);
});

test("[V12] structured output that will not parse is rejected", () => {
  const citable = citableFor("healthy");
  ["not json at all", "{unclosed: ", ""].forEach((raw) => {
    const result = validator.validateStructured({ raw, citable, requiredKeys: ["a"] });
    assert.equal(result.valid, false, `"${raw}" should not validate`);
    assert.equal(result.verdict, validator.VERDICT.MALFORMED);
  });
});

test("[V13] structured output missing required keys is rejected", () => {
  const result = validator.validateStructured({
    raw: JSON.stringify({ overall_summary: "fine" }),
    citable: citableFor("healthy"),
    requiredKeys: ["overall_summary", "overall_risk_level", "pages"]
  });
  assert.equal(result.valid, false);
  assert.equal(result.verdict, validator.VERDICT.MALFORMED);
  assert.match(result.issues[0].detail, /overall_risk_level/);
});

test("[V14] JSON wrapped in prose or a code fence is still parsed", () => {
  const payload = { overall_summary: "Steady month.", overall_risk_level: "low", pages: {} };
  ["```json\n" + JSON.stringify(payload) + "\n```",
    "Here you go:\n" + JSON.stringify(payload) + "\nHope that helps."
  ].forEach((raw) => {
    const result = validator.validateStructured({
      raw, citable: citableFor("healthy"),
      requiredKeys: ["overall_summary", "overall_risk_level", "pages"]
    });
    assert.equal(result.valid, true, JSON.stringify(result.issues));
    assert.equal(result.parsed.overall_risk_level, "low");
  });
});

test("[V15] a fabricated figure inside STRUCTURED output is caught too", () => {
  const result = validator.validateStructured({
    raw: JSON.stringify({
      overall_summary: "Revenue reached KES 8,675,309 this month.",
      overall_risk_level: "low",
      pages: {}
    }),
    citable: citableFor("healthy"),
    requiredKeys: ["overall_summary", "overall_risk_level", "pages"]
  });
  assert.equal(result.valid, false);
  assert.equal(result.verdict, validator.VERDICT.UNSUPPORTED_NUMBERS);
});

// ── The safe response ────────────────────────────────────────────

test("[V16] a blocked answer produces an honest response, not a corrected one", () => {
  const verdict = validator.validateAnswer({
    text: "Revenue was KES 9,999,999.", citable: citableFor("healthy")
  });
  const safe = validator.safeResponse({
    verdict: verdict.verdict, issues: verdict.issues, period: "2026-05"
  });

  assert.equal(safe.ok, false);
  assert.equal(safe.safe, true);
  // Crucially: it does NOT contain the fabricated number, and does not attempt
  // to answer the question with a substituted figure.
  assert.doesNotMatch(safe.text, /9,999,999/);
  assert.match(safe.text, /could not|held/i, "it says the answer was withheld");
  assert.match(safe.text, /2026-05/, "and points at the dashboard for the period");
  assert.match(safe.text, /rules engine/i, "and reassures that the analysis is unaffected");
});

// ── Deterministic values are preserved ───────────────────────────

test("[V17] validation never MODIFIES the answer or the authoritative data", () => {
  const run = runFor("cashflowStress");
  const before = JSON.stringify(run.riskScore);
  const ctx = buildAiContext({ run, tenantId: "t1", message: "what is my runway?" });
  const text = "Your runway is short.";
  const result = validator.validateAnswer({
    text, citable: Object.assign({}, ctx.citable, { riskScoreAvailable: true })
  });
  assert.equal(result.valid, true);
  assert.equal(JSON.stringify(run.riskScore), before,
    "the authoritative score is untouched by the AI path");
});

test("[V18] every metric the engine published is citable", () => {
  const run = runFor("healthy");
  const ctx = buildAiContext({ run, tenantId: "t1", message: "summarise the month" });
  run.metrics.filter((m) => m.available && typeof m.value === "number").forEach((m) => {
    assert.equal(
      validator.isSupported(Math.abs(m.value), ctx.citable.numbers), true,
      `metric ${m.key} (${m.value}) is not citable — the model could not state a real figure`);
  });
});
