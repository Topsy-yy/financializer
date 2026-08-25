// THE RULES REGISTRY — structure, versioning, and the guarantee that nothing
// else in the production path declares a financial threshold.
//
// The registry is only worth having if it is the ONLY place these decisions are
// made. Several tests here are therefore mechanical guards over the source tree
// rather than behavioural tests: they fail if a literal creeps back in.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const registry = require("../../src/domain/rules/registry");
const severity = require("../../src/domain/rules/severity");
const materiality = require("../../src/domain/rules/materiality");
const currency = require("../../src/domain/rules/currency");
const coverage = require("../../src/domain/rules/evidenceCoverage");
const methodology = require("../../src/domain/rules/methodology");
const engine = require("../../src/domain/analysis/engine");
const { scenarios } = require("../helpers/fixtures");

const NOW = Date.parse("2026-06-15T00:00:00Z");
const SRC = path.join(__dirname, "../../src");
const read = (p) => fs.readFileSync(path.join(SRC, p), "utf-8");

/**
 * Source with COMMENTS REMOVED.
 *
 * The guards below assert that certain literals do not appear in executable
 * code. The comments in these files deliberately QUOTE the old literals to
 * explain what was removed and why, so matching raw source would flag the
 * documentation of the fix as the defect.
 */
function code(p) {
  return read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments
    .replace(/(^|[^:])\/\/.*$/gm, "$1"); // line comments (leaving URLs alone)
}

// ── Structure ────────────────────────────────────────────────────

test("[REG1] every rule declares the complete contract", () => {
  const required = ["id", "version", "title", "category", "summary", "rationale",
    "params", "applicability", "methodology", "enabled", "severity", "confidence", "evidence"];
  const rules = registry.allRules();
  assert.ok(rules.length >= 14, `expected the full rule set, got ${rules.length}`);

  rules.forEach((rule) => {
    required.forEach((field) =>
      assert.notEqual(rule[field], undefined, `rule ${rule.id} is missing ${field}`));
    assert.match(rule.version, /^\d+\.\d+\.\d+$/, `${rule.id} version is not semver`);
    assert.ok(Object.values(registry.CATEGORY).includes(rule.category),
      `${rule.id} has an unknown category`);
    assert.ok(rule.rationale.length > 40, `${rule.id} has no real rationale`);
    assert.ok(Array.isArray(rule.applicability.requires),
      `${rule.id} does not declare what data it needs`);
  });
});

test("[REG2] rule ids are unique and stable-looking", () => {
  const ids = registry.allRules().map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate rule id");
  ids.forEach((id) => assert.match(id, /^[a-z][a-z0-9_]*$/, `${id} is not a stable identifier`));
});

test("[REG3] an unknown rule id throws rather than silently producing nothing", () => {
  assert.throws(() => registry.getRule("no_such_rule"), /unknown rule id/);
});

test("[REG4] ruleVersions() stamps every rule plus the scoring methodologies", () => {
  const versions = registry.ruleVersions();
  registry.allRules().forEach((r) =>
    assert.equal(versions[r.id], r.version, `${r.id} missing from the version stamp`));
  ["cashflow_risk", "health_score", "forecast", "materiality"].forEach((k) =>
    assert.ok(versions[k], `${k} methodology version is not stamped`));
});

// ── The production path actually consumes the registry ───────────

test("[REG5] no detector declares a severity or a confidence of its own", () => {
  const src = code("domain/analysis/detectors.js");
  // The whole point of JOB 7: these decisions come from resolveRule().
  assert.equal(/severity:\s*SEVERITY\./.test(src), false, "a detector picks its own severity");
  assert.equal(/confidence:\s*0\.\d/.test(src), false, "a detector picks its own confidence");
  assert.match(src, /resolveRule/, "detectors resolve through the registry");
});

test("[REG6] no financial threshold is declared outside the rules directory", () => {
  // The specific literals that were scattered before JOB 7. These match a
  // DECLARATION (`name: value`), not a READ of the registry's own constant —
  // reading HEALTH_SCORE.anomalyPoints is exactly what these files should do.
  const forbidden = [
    { re: /\b10000\b/, what: "the round-number materiality bar" },
    { re: /confidenceByMatchCount\s*[:=]/, what: "the duplicate confidence table" },
    { re: /highSharePct\s*:\s*\d/, what: "a concentration threshold" },
    { re: /criticalMonths\s*:\s*\d/, what: "a runway threshold" },
    { re: /anomalyPoints\s*:\s*\{/, what: "the anomaly weighting" },
    { re: /weights\s*:\s*(Object\.freeze\()?\{/, what: "the scoring weights" },
    { re: /minWeightCovered\s*:\s*[\d.]/, what: "the evidence-coverage floor" }
  ];
  const files = ["domain/analysis/detectors.js", "domain/analysis/engine.js",
    "domain/analysis/riskAggregation.js", "domain/analysis/metricSet.js",
    "domain/calculators/cashflow.js", "domain/calculators/concentration.js",
    "domain/calculators/revenue.js", "domain/calculators/expense.js"];

  files.forEach((file) => {
    const src = code(file);
    forbidden.forEach(({ re, what }) =>
      // assert.equal, not doesNotMatch: a failure should name the file, not
      // print the entire module.
      assert.equal(re.test(src), false, `${file} re-declares ${what}`));
  });
});

test("[REG7] every finding from every scenario names a rule that is IN the registry, "
  + "at the version the registry currently declares", () => {
  let checked = 0;
  Object.keys(scenarios).forEach((name) => {
    const run = engine.analyze(scenarios[name], { tenantId: "t", period: "2026-05", now: NOW });
    run.findings.forEach((f) => {
      checked++;
      const rule = registry.getRule(f.ruleId);
      assert.equal(f.ruleVersion, rule.version,
        `${name}: ${f.ruleId} emitted v${f.ruleVersion}, registry says v${rule.version}`);
      assert.equal(f.category, rule.category, `${name}: ${f.ruleId} category drifted`);
      // Severity and confidence are the registry's, not the detector's.
      assert.ok(f.severityBasis, `${f.ruleId} did not record WHY it is that severity`);
      assert.ok(f.confidenceBasis, `${f.ruleId} did not record WHY it is that confident`);
    });
  });
  assert.ok(checked > 30, `expected a meaningful sample, checked ${checked}`);
});

test("[REG8] the analysis run records the methodology it actually applied", () => {
  const run = engine.analyze(scenarios.duplicatePayment,
    { tenantId: "t", period: "2026-05", now: NOW });

  assert.equal(run.methodology.engineVersion, registry.ENGINE_VERSION);
  assert.deepEqual(run.methodology.ruleVersions, registry.ruleVersions());
  assert.ok(run.methodology.materiality.version, "the materiality version applied");
  assert.ok(run.methodology.coveragePolicy.version, "the coverage policy version applied");
  assert.ok(Array.isArray(run.methodology.rulesApplied));
  assert.ok(Array.isArray(run.methodology.rulesNotApplicable));

  // A rule that could not run is recorded as NOT APPLICABLE — it has not
  // "found nothing", it has not looked.
  const notRun = run.methodology.rulesNotApplicable.map((r) => r.ruleId);
  assert.ok(notRun.includes("overdue_receivable"),
    "this fixture has no receivables, so the rule could not run");
  run.methodology.rulesNotApplicable.forEach((r) => assert.ok(r.reason));
});

// ── Severity and confidence ──────────────────────────────────────

test("[SEV1] severity is resolved from a declared policy, with a reason", () => {
  const fixed = severity.resolveSeverity(registry.getRule("duplicate_payment"));
  assert.equal(fixed.severity, "high");
  assert.equal(fixed.basis, "direct_financial_loss");
  assert.ok(fixed.reason.length > 10);

  // Banded: the same rule gives different severities for different observations.
  const rule = registry.getRule("vendor_concentration");
  assert.equal(severity.resolveSeverity(rule, 80).severity, "high");
  assert.equal(severity.resolveSeverity(rule, 40).severity, "medium");
  assert.equal(severity.resolveSeverity(rule, 51).severity, "high", "just over the high band");
  assert.equal(severity.resolveSeverity(rule, 50).severity, "medium", "exactly at it is not over it");
});

test("[SEV2] a rule with no band for an observation fails loudly", () => {
  assert.throws(() => severity.resolveSeverity(registry.getRule("vendor_concentration"), 5),
    /no severity band matches/);
});

test("[CONF1] confidence is confidence in the FINDING, and states its basis", () => {
  const base = severity.resolveConfidence(registry.getRule("duplicate_payment"), {});
  assert.equal(base.confidence, severity.CONFIDENCE.PROBABLE);
  assert.equal(base.basis, "multi_attribute_match");
  assert.ok(base.reason.length > 20);

  // Corroborating evidence raises it, and the modifier is named.
  const stronger = severity.resolveConfidence(
    registry.getRule("duplicate_payment"), { matchedFields: 4 });
  assert.equal(stronger.confidence, severity.CONFIDENCE.STRONG);
  assert.equal(stronger.applied.length, 1);
});

test("[CONF2] no confidence value refers to an AI model", () => {
  // Confidence must never leak "how sure the LLM is". Every basis is evidential.
  Object.values(severity.CONFIDENCE_BASIS).forEach((basis) =>
    assert.doesNotMatch(basis, /ai|llm|model|gpt|mistral/i));
  registry.allRules().forEach((r) => {
    assert.ok(Object.values(severity.CONFIDENCE_BASIS).includes(r.confidence.basis),
      `${r.id} uses an unknown confidence basis`);
    assert.doesNotMatch(r.confidence.rationale, /\bAI\b|LLM|language model/i);
  });
});

test("[CONF3] confidence stays inside 0..1 whatever the modifiers say", () => {
  const rule = {
    id: "x",
    confidence: { base: 0.9, basis: "heuristic", rationale: "test",
      modifiers: [{ label: "runaway", when: () => true, to: 5 }] }
  };
  assert.equal(severity.resolveConfidence(rule, {}).confidence, 1);
});

// ── Materiality ──────────────────────────────────────────────────

test("[MAT1] materiality differs by currency", () => {
  const kes = materiality.resolveMateriality({ currency: "KES" });
  const usd = materiality.resolveMateriality({ currency: "USD" });
  assert.equal(kes.significant, 10000);
  assert.equal(usd.significant, 100);
  assert.equal(kes.roundNumberMultiple, 1000);
  assert.equal(usd.roundNumberMultiple, 10);
  assert.notEqual(kes.significant, usd.significant, "the whole point of the methodology");
});

test("[MAT2] an unknown or absent currency falls back, and SAYS it fell back", () => {
  const absent = materiality.resolveMateriality({});
  assert.equal(absent.significant, materiality.ABSOLUTE_FLOORS.KES.significant);
  assert.equal(absent.currencyAssumed, true, "the assumption is visible, not silent");
  assert.match(absent.calculation, /KES assumed/);

  const unknown = materiality.resolveMateriality({ currency: "XYZ" });
  assert.equal(unknown.currencyAssumed, true);
  assert.match(unknown.calculation, /no floor configured for XYZ/);
});

test("[MAT3] materiality scales with the business, not just the currency", () => {
  // A large business: 1% of a 50M outflow is 500,000, far above the KES floor.
  const large = materiality.resolveMateriality({
    currency: "KES", periodOutflow: 50000000, sampleSize: 40
  });
  assert.equal(large.significant, 500000);
  assert.equal(large.basis, "relative_to_period");

  // A small one keeps the absolute floor — the relative bar would be meaningless.
  const small = materiality.resolveMateriality({
    currency: "KES", periodOutflow: 200000, sampleSize: 40
  });
  assert.equal(small.significant, 10000);
  assert.equal(small.basis, "absolute_floor");

  // Too few transactions for a relative floor to mean anything.
  const sparse = materiality.resolveMateriality({
    currency: "KES", periodOutflow: 50000000, sampleSize: 2
  });
  assert.equal(sparse.significant, 10000, "a relative bar needs a real sample");
});

test("[MAT4] a business may configure its own threshold, and it wins", () => {
  const m = materiality.resolveMateriality({
    currency: "KES", periodOutflow: 50000000, sampleSize: 40,
    override: { significant: 25000 }
  });
  assert.equal(m.significant, 25000);
  assert.equal(m.basis, "tenant_override");
  assert.match(m.calculation, /Business-configured/);
});

test("[MAT5] the round-number rule uses the resolved threshold, per currency", () => {
  const run = engine.analyze({
    period: "2026-05",
    transactions: [
      { date: "2026-05-02", amount: 5000, counterparty: "A", currency: "KES" },   // below KES floor
      { date: "2026-05-03", amount: 50000, counterparty: "B", currency: "KES" },  // above
      { date: "2026-05-04", amount: 50, counterparty: "C", currency: "USD" },     // below USD floor
      { date: "2026-05-05", amount: 500, counterparty: "D", currency: "USD" }     // above
    ],
    journalEntries: [], reconciliations: [],
    statements: { cashFlow: { inflow: 0, outflow: 55550 }, profitAndLoss: {}, balanceSheet: {} }
  }, { tenantId: "t", period: "2026-05", now: NOW });

  const flagged = run.findings
    .filter((f) => f.ruleId === "round_number_payment")
    .map((f) => `${f.observedValue} ${f.currency}`).sort();
  assert.deepEqual(flagged, ["500 USD", "50000 KES"],
    "each currency judged on its own scale — 5,000 KES and 50 USD are immaterial");
});

// ── Currency ─────────────────────────────────────────────────────

test("[CUR1] a single-currency set aggregates and is labelled", () => {
  const c = currency.analyzeCurrency([
    { amount: 100, currency: "KES" }, { amount: 200, currency: "kes" }
  ]);
  assert.equal(c.basis, currency.BASIS.SINGLE);
  assert.equal(c.currency, "KES", "case is normalised");
  assert.equal(c.aggregatable, true);
});

test("[CUR2] an unlabelled set aggregates but carries NO currency", () => {
  const c = currency.analyzeCurrency([{ amount: 100 }, { amount: 200 }]);
  assert.equal(c.basis, currency.BASIS.UNKNOWN);
  assert.equal(c.currency, null, "we know the amounts are comparable, not what they are");
  assert.equal(c.aggregatable, true);
});

test("[CUR3] a mixed set is NOT aggregatable, and keeps the parts", () => {
  const c = currency.analyzeCurrency([
    { amount: 100000, currency: "KES" },
    { amount: 1000, currency: "USD" },
    { amount: 900, currency: "EUR" }
  ]);
  assert.equal(c.basis, currency.BASIS.MIXED);
  assert.equal(c.aggregatable, false);
  assert.equal(c.currency, null);
  assert.deepEqual(c.currencies, ["EUR", "KES", "USD"]);
  const totals = Object.fromEntries(c.byCurrency.map((b) => [b.currency, b.total]));
  assert.deepEqual(totals, { KES: 100000, USD: 1000, EUR: 900 });
  assert.match(c.reason, /no conversion rate is available/);
});

test("[CUR4] declared currency mixed with UNDECLARED is also unsafe", () => {
  // We cannot assume the unlabelled rows share the labelled one's currency.
  const c = currency.analyzeCurrency([
    { amount: 100, currency: "USD" }, { amount: 200 }
  ]);
  assert.equal(c.aggregatable, false);
});

test("[CUR5] 100,000 KES + 1,000 USD is never reported as 101,000", () => {
  const run = engine.analyze(scenarios.multiCurrency,
    { tenantId: "t", period: "2026-05", now: NOW });

  const vendors = run.calculations.vendors;
  assert.equal(vendors.available, false);
  assert.equal(vendors.reason, "mixed_currency");
  assert.equal(vendors.total, null, "no combined total is published");
  assert.equal(vendors.risk_score, null);
  // The sum the old engine produced must not appear anywhere in the metric set.
  const values = run.metrics.filter((m) => m.available).map((m) => m.value);
  assert.ok(!values.includes(101900), "the meaningless sum is not published");

  // ...but the parts are preserved.
  const totals = Object.fromEntries(vendors.by_currency.map((b) => [b.currency, b.total]));
  assert.deepEqual(totals, { KES: 100000, USD: 1000, EUR: 900 });
});

test("[CUR6] a metric is only labelled with a currency it can justify", () => {
  const mixed = engine.analyze(scenarios.multiCurrency, { period: "2026-05", now: NOW });
  assert.equal(mixed.metricsByKey["cashflow.net"].currency, null, "mixed is never labelled");

  const single = engine.analyze({
    period: "2026-05",
    transactions: [{ date: "2026-05-05", amount: 1000, counterparty: "V", currency: "KES" }],
    journalEntries: [], reconciliations: [],
    statements: { cashFlow: { inflow: 0, outflow: 1000 }, profitAndLoss: {}, balanceSheet: {} }
  }, { period: "2026-05", now: NOW });
  assert.equal(single.metricsByKey["cashflow.net"].currency, "KES");
});

test("[CUR7] amounts in different declared currencies are never duplicates", () => {
  const cross = engine.analyze({
    period: "2026-05",
    transactions: [
      { date: "2026-05-05", amount: 1000, counterparty: "V", currency: "USD" },
      { date: "2026-05-05", amount: 1000, counterparty: "V", currency: "KES" }
    ],
    journalEntries: [], reconciliations: [],
    statements: { cashFlow: {}, profitAndLoss: {}, balanceSheet: {} }
  }, { period: "2026-05", now: NOW });
  assert.equal(cross.findings.filter((f) => f.ruleId === "duplicate_payment").length, 0);
  assert.equal(currency.comparableAmounts({ currency: "USD" }, { currency: "KES" }), false);
  assert.equal(currency.comparableAmounts({ currency: "USD" }, {}), true, "unknown falls back");
});

// ── Evidence coverage ────────────────────────────────────────────

test("[EV1] the coverage policy is versioned and configurable", () => {
  assert.ok(coverage.DEFAULT_POLICY.version);
  const strict = coverage.resolvePolicy({ minWeightCovered: 0.9 });
  assert.equal(strict.minWeightCovered, 0.9);
  // Out-of-range values are clamped rather than accepted.
  assert.equal(coverage.resolvePolicy({ minWeightCovered: 5 }).minWeightCovered, 1);
  assert.equal(coverage.resolvePolicy({ minWeightCovered: -1 }).minWeightCovered, 0);
});

test("[EV2] ABSENCE OF DATA NEVER IMPROVES THE SCORE — the empty business", () => {
  const run = engine.analyze(scenarios.emptyResponse, { period: "2026-05", now: NOW });
  assert.equal(run.riskScore.available, false);
  assert.equal(run.riskScore.overall, null, "null, never a number");
  assert.equal(run.riskScore.category, "Unknown");
  // The anomaly component — the one that used to compute a perfect 100 from
  // nothing — is unmeasured, not perfect.
  assert.equal(run.riskScore.components.fraud_indicators, null,
    "no records means no anomaly result, not a clean one");
});

test("[EV3] one dataset only is not enough to score", () => {
  const run = engine.analyze({
    period: "2026-05",
    transactions: [{ date: "2026-05-02", amount: 1000, counterparty: "A" }],
    journalEntries: [], reconciliations: [], statements: {}
  }, { period: "2026-05", now: NOW });
  assert.equal(run.riskScore.available, false);
  assert.ok(run.riskScore.weightCovered < coverage.DEFAULT_POLICY.minWeightCovered);
  assert.equal(run.riskScore.unavailableReason, coverage.INSUFFICIENT.COVERAGE);
});

test("[EV4] a partial dataset scores, and says how partial", () => {
  const run = engine.analyze(scenarios.healthy, { period: "2026-05", now: NOW });
  assert.equal(run.riskScore.available, true);
  assert.ok(run.riskScore.weightCovered >= coverage.DEFAULT_POLICY.minWeightCovered);
  assert.ok(run.riskScore.weightCovered < 1, "this fixture cannot measure everything");
  assert.match(run.riskScore.summary, /% of the model/);
  assert.ok(run.riskScore.coveragePolicyVersion, "the policy version is recorded");
});

test("[EV5] a MORE complete dataset does not score worse for being complete", () => {
  // The perverse incentive this guards against: the audited engine scored a
  // CSV import better than a connected accounting system, because the richer
  // source produced more findings.
  const sparse = engine.analyze({
    period: "2026-05",
    transactions: [{ date: "2026-05-02", amount: 4000, counterparty: "A" }],
    journalEntries: [], reconciliations: [],
    statements: { cashFlow: { inflow: 10000, outflow: 4000 }, profitAndLoss: { revenue: 10000 },
      balanceSheet: { cashAndEquivalents: 50000 } }
  }, { period: "2026-05", now: NOW });

  // Same business, but the source also reports that receipts are missing —
  // a DATA-QUALITY fact about the books, not about the business.
  const rich = engine.analyze({
    period: "2026-05",
    transactions: [{ date: "2026-05-02", amount: 4000, counterparty: "A", hasReceipt: false }],
    journalEntries: [], reconciliations: [],
    statements: { cashFlow: { inflow: 10000, outflow: 4000 }, profitAndLoss: { revenue: 10000 },
      balanceSheet: { cashAndEquivalents: 50000 } }
  }, { period: "2026-05", now: NOW });

  assert.ok(rich.findings.length > sparse.findings.length, "the richer source found more");
  assert.equal(rich.riskScore.overall, sparse.riskScore.overall,
    "but a data-quality finding must not lower the BUSINESS risk score");
  assert.ok(rich.quality.issue_count > sparse.quality.issue_count,
    "it is reported separately, as data quality");
});

test("[EV6] the coverage decision is explained, not just made", () => {
  const insufficient = coverage.assessCoverage({
    score: 90, covered: 0.2, measured: ["fraud_indicators"], dataQualityReliable: true
  });
  assert.equal(insufficient.sufficient, false);
  assert.equal(insufficient.reason, coverage.INSUFFICIENT.COVERAGE);
  assert.match(insufficient.explanation, /only 20% of the model/);
  assert.match(insufficient.explanation, /at least 50% is required/);

  const unreliable = coverage.assessCoverage({
    score: 90, covered: 1, measured: ["cash_flow"], dataQualityReliable: false
  });
  assert.equal(unreliable.reason, coverage.INSUFFICIENT.DATA_QUALITY,
    "unreliable ingestion is a different problem from thin coverage");
});

test("[EV7] rule applicability distinguishes 'found nothing' from 'did not look'", () => {
  const noReceivables = coverage.assessRuleApplicability({
    transactions: [{ date: "2026-05-02", amount: 100, counterparty: "A" }],
    journalEntries: [], reconciliations: [], statements: {}
  });
  const notRun = noReceivables.notApplicable.map((r) => r.ruleId);
  assert.ok(notRun.includes("overdue_receivable"), "no receivables data => the rule did not run");
  assert.ok(notRun.includes("cashflow_runway"), "no statements => runway could not be assessed");
  assert.ok(noReceivables.applicable.includes("missing_transaction_fields"));

  // A rule needing a distribution does not run on a single record.
  assert.ok(notRun.includes("statistical_outlier"), "one transaction is not a distribution");
});

// ── Generated methodology ────────────────────────────────────────

test("[MTH1] the methodology document is generated FROM the registry", () => {
  const doc = methodology.describeMethodology();
  assert.equal(doc.engineVersion, registry.ENGINE_VERSION);
  assert.equal(doc.rules.length, registry.allRules().length);
  doc.rules.forEach((r) => {
    const rule = registry.getRule(r.ruleId);
    assert.equal(r.version, rule.version);
    assert.deepEqual(r.parameters, rule.params);
  });
  assert.deepEqual(doc.scoring.weights, registry.HEALTH_SCORE.weights);
  assert.equal(doc.materiality.version, materiality.MATERIALITY_VERSION);
});

test("[MTH2] changing the registry changes the document, with no second edit", () => {
  // The property that makes drift impossible: the document has no numbers of
  // its own to fall out of date.
  const md = methodology.renderMarkdown();
  registry.allRules().forEach((r) => {
    assert.ok(md.includes(r.id), `${r.id} missing from the rendered methodology`);
    assert.ok(md.includes(r.version), `${r.id}'s version missing`);
  });
  assert.ok(md.includes(String(registry.HEALTH_SCORE.minWeightCovered * 100)),
    "the coverage floor is documented");
});

// ── Skills are not a second source of truth ──────────────────────

test("[SKL1] no skill document restates a scoring formula or weight table", () => {
  const dir = path.join(__dirname, "../../skills");
  const files = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(dir, e.name, "skill.md"))
    .filter((f) => fs.existsSync(f));
  assert.ok(files.length > 5, "expected the skill set to be present");

  // The specific drifted methodology the JOB 7 inventory found being fed to the
  // model as instructions.
  const forbidden = [
    { re: /high_count\s*×\s*\d+/, what: "an anomaly scoring formula" },
    { re: /overall_score\s*=\s*Σ/, what: "the health score formula" },
    { re: /runwayMonths\s*=\s*\(monthlyBurn/, what: "the deleted 12-month runway fallback" },
    { re: /\|\s*Cash Flow Health\s*\|\s*30%/, what: "a component weight table" },
    { re: /\|\s*80–100\s*\|/, what: "a score band table" },
    { re: /amount\s*>=\s*10,?000/, what: "the currency-blind materiality bar" }
  ];
  files.forEach((file) => {
    const src = fs.readFileSync(file, "utf-8");
    forbidden.forEach(({ re, what }) =>
      assert.doesNotMatch(src, re, `${path.basename(path.dirname(file))} still declares ${what}`));
  });
});

test("[SKL2] skills that were stripped now point at the authoritative registry", () => {
  const dir = path.join(__dirname, "../../skills");
  ["financial-health-scorer", "cashflow-risk-analyzer", "fraud-and-errors-detector",
    "vendor-dependency-detector", "customer-concentration-detector"].forEach((name) => {
    const src = fs.readFileSync(path.join(dir, name, "skill.md"), "utf-8");
    assert.match(src, /NOT the source of truth/i, `${name} does not disclaim authority`);
    assert.match(src, /registry\.js/, `${name} does not point at the registry`);
  });
});

// ── Custom rules use the same infrastructure ─────────────────────

test("[CUS1] custom rules and engine rules share ONE owner-keyword list", () => {
  const customRules = require("../../src/domain/rules/customRules");
  const registryKeywords = registry.getRule("mixed_personal_business").params.keywords;
  const src = fs.readFileSync(
    path.join(SRC, "domain/rules/customRules.js"), "utf-8");
  assert.doesNotMatch(src, /DEFAULT_OWNER_KEYWORDS\s*=\s*\[/,
    "custom rules had a SECOND, different keyword list");
  assert.match(src, /getRule\("mixed_personal_business"\)/);

  // Behavioural proof: a keyword only in the registry list matches.
  const rule = customRules.validateRule({
    name: "Owner spend", severity: "medium",
    condition: { type: "director_expense" }, action: "flag"
  }).rule;
  rule.id = "own";
  const data = { period: "2026-05", transactions: registryKeywords.map((k, i) => ({
    date: "2026-05-0" + ((i % 9) + 1), amount: 5000, counterparty: "X", description: `${k} payment`
  })) };
  const res = customRules.evaluateCustomRules([rule], data, {}, { tenantId: "t", period: "2026-05" });
  assert.equal(res.findings.length, registryKeywords.length,
    "every registry keyword is matched by the custom rule too");
});

test("[CUS2] the severity vocabulary is the registry's, not a second list", () => {
  const customRules = require("../../src/domain/rules/customRules");
  assert.deepEqual(customRules.SEVERITIES.slice().sort(),
    Object.values(registry.SEVERITY).slice().sort());
  // An invalid severity is normalised, never passed through.
  const v = customRules.validateRule({
    name: "X", severity: "catastrophic",
    condition: { type: "keyword", keyword: "a" }, action: "flag"
  });
  assert.equal(v.rule.severity, registry.SEVERITY.MEDIUM);
});

test("[CUS3] a custom rule threshold only applies within its own currency", () => {
  const customRules = require("../../src/domain/rules/customRules");
  const rule = customRules.validateRule({
    name: "Big KES spend", severity: "high",
    condition: { type: "expense_over", amount: 100000, currency: "KES" }, action: "flag"
  }).rule;
  rule.id = "kes-only";

  const data = { period: "2026-05", transactions: [
    { date: "2026-05-02", amount: 150000, counterparty: "A", currency: "KES" },
    // Far more valuable, but the rule was written about KES.
    { date: "2026-05-03", amount: 150000, counterparty: "B", currency: "USD" }
  ] };
  const res = customRules.evaluateCustomRules([rule], data, {}, { tenantId: "t", period: "2026-05" });
  assert.equal(res.findings.length, 1, "the USD record is not judged by a KES threshold");
  assert.equal(res.findings[0].currency, "KES");
});

test("[CUS4] a rule matching more records than the cap REPORTS the truncation", () => {
  const customRules = require("../../src/domain/rules/customRules");
  const cap = registry.getRule("custom_rule").params.maxFindingsPerRule;
  const rule = customRules.validateRule({
    name: "Everything", severity: "low",
    condition: { type: "expense_over", amount: 1 }, action: "flag"
  }).rule;
  rule.id = "all";

  const data = { period: "2026-05", transactions: Array.from({ length: cap + 7 }, (_, i) => ({
    date: "2026-05-01", amount: 1000 + i, counterparty: `V${i}`
  })) };
  const res = customRules.evaluateCustomRules([rule], data, {}, { tenantId: "t", period: "2026-05" });
  assert.equal(res.findings.length, cap);
  assert.equal(res.executions[0].truncated, 7, "the dropped matches are reported, not silent");
  assert.equal(res.executions[0].matchCount, cap + 7);
});
