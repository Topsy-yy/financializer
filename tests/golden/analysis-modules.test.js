// BASELINE — forecast, what-if and custom rules.
// See tests/golden/engine.test.js for the [KNOWN-BAD] convention.

const test = require("node:test");
const assert = require("node:assert/strict");

const { computeCashflowForecast } = require("../../src/services/cashflowForecast");
const whatIf = require("../../src/services/whatIfSimulator");
const customRules = require("../../src/services/customRules");
// JOB 6: riskEngine.js is deleted. The legacy analysis shape is now PROJECTED
// from the one deterministic engine.
const domainEngine = require("../../src/domain/analysis/engine");
const { toLegacyAnalysis } = require("../../src/domain/adapters/legacyAnalysis");
const analyzeFinancialRisk = (data) =>
  toLegacyAnalysis(domainEngine.analyze(data, { period: "2026-05", now: Date.parse("2026-06-15T00:00:00Z") }));
const { scenarios } = require("../helpers/fixtures");

// ── 13. Forecast ─────────────────────────────────────────────────
const BURNING = { startingCash: 300000, monthlyNet: -50000, monthlyBurn: 200000, overdueReceivables: 40000 };

test("[13] forecast projects 30/60/90 days from the run-rate", () => {
  const f = computeCashflowForecast(BURNING);
  assert.equal(f.starting_cash, 300000);
  assert.equal(f.monthly_net, -50000);
  assert.deepEqual(f.horizons.map((h) => h.days), [30, 60, 90]);
  assert.equal(f.horizons[0].projected_balance, 250000);
  assert.equal(f.horizons[2].projected_balance, 150000);
  assert.equal(f.days_to_zero, 180);
  assert.equal(f.status, "burning");
  assert.equal(f.series.length, 4, "now + 3 months");
});

test("[13b] a cash-positive business never depletes", () => {
  const f = computeCashflowForecast({ startingCash: 500000, monthlyNet: 80000, monthlyBurn: 0, overdueReceivables: 0 });
  assert.equal(f.days_to_zero, null);
  assert.equal(f.status, "surplus");
});

test("[13c] forecast is pure — identical input yields identical output", () => {
  assert.deepEqual(computeCashflowForecast(BURNING), computeCashflowForecast(BURNING));
});

test("[13d][KNOWN-BAD] forecast assumes a 30-day month and a flat run-rate", () => {
  const f = computeCashflowForecast(BURNING);
  // 300000 / (50000/30) = 180 exactly — no calendar, no seasonality, no variance.
  assert.equal(f.days_to_zero, 180);
});

// ── 12. What-if ──────────────────────────────────────────────────
const BASELINE = {
  startingCash: 300000, monthlyNet: -50000, monthlyBurn: 200000, overdueReceivables: 40000,
  monthlyRevenue: 500000,
  componentScores: { cash_flow: 45, revenue_stability: 72, vendor_risk: 60, customer_risk: 65, fraud_indicators: 80 }
};

test("[12] what-if hiring worsens runway and health", () => {
  const r = whatIf.simulate({ type: "hire_employees", params: { count: 2, salary: 60000 }, baseline: BASELINE });
  assert.equal(r.adjusted.monthly_net, -170000, "-50,000 minus 2 x 60,000");
  assert.ok(r.forecast_after.days_to_zero < r.forecast_before.days_to_zero);
  assert.ok(r.health_after.score < r.health_before.score);
  const runway = r.risk_changes.find((c) => c.label.startsWith("Runway"));
  assert.equal(runway.direction, "worse");
});

test("[12b] what-if reuses the forecast engine (before/after are comparable)", () => {
  const r = whatIf.simulate({ type: "increase_rent", params: { amount: 0 }, baseline: BASELINE });
  assert.deepEqual(r.forecast_before, r.forecast_after, "a zero-delta scenario must be a no-op");
});

test("[12c] a one-time purchase moves cash but not the run-rate", () => {
  const r = whatIf.simulate({ type: "large_purchase", params: { amount: 100000 }, baseline: BASELINE });
  assert.equal(r.adjusted.starting_cash, 200000);
  assert.equal(r.adjusted.monthly_net, BASELINE.monthlyNet, "run-rate unchanged");
});

test("[12d][FIXED in JOB 3] what-if delegates the WEIGHTING to the authoritative module", () => {
  // WAS: the 0.3/0.2/0.2/0.15/0.15 weighting and the category cut-offs were
  // re-declared here, duplicating routes/api.js buildHealthSummary — two
  // sources of truth that could silently drift.
  // NOW: both call domain/analysis/riskAggregation.weightedScore().
  const src = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../../src/services/whatIfSimulator.js"), "utf-8");
  assert.doesNotMatch(src, /cashflowScore \* 0\.3/, "no local weighted sum remains");
  assert.match(src, /require\("\.\.\/domain\/analysis\/riskAggregation"\)/,
    "delegates to the domain module");
});

test("[12e][FIXED in JOB 6] what-if scores the cash-flow component with the REAL "
  + "0-100 risk score, not the three-valued dead branch", () => {
  // WAS: cashflowScoreFrom() ran its own lookup — high=80 / medium=55 / low=25 —
  // so the component could only ever be 20, 45 or 75. That is the same dead
  // branch the audit found in api.js, reproduced inside the simulator, meaning a
  // scenario was scored by different arithmetic than the dashboard beside it.
  // NOW: it calls domain/calculators/cashflow.computeCashflowRisk().
  const src = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../../src/services/whatIfSimulator.js"), "utf-8");
  assert.doesNotMatch(src, /=== "high" \? 80 : /, "the three-valued lookup is gone");
  assert.match(src, /computeCashflowRisk/, "uses the authoritative cash-flow risk");

  // A business with a healthy surplus: baseline 20 points and nothing else, so
  // the component is 80 — NOT the old bucket value of 75.
  const { computeCashflowRisk } = require("../../src/domain/calculators/cashflow");
  const authoritative = 100 - computeCashflowRisk({
    netCashFlow: 50000, monthlyBurn: 0, runwayMonths: Infinity,
    overdueReceivables: null, inflow: 0
  }).risk_score;
  assert.equal(authoritative, 80, "sanity: the authoritative score for this position");

  const r = whatIf.simulate({
    type: "increase_rent",
    params: { amount: 0 },
    baseline: {
      startingCash: 300000, monthlyNet: 50000, monthlyBurn: 0, overdueReceivables: 0,
      monthlyRevenue: 500000,
      componentScores: { fraud_indicators: 80, revenue_stability: 72, vendor_risk: 60, customer_risk: 65 }
    }
  });
  assert.equal(r.health_before.cashflow_score, 80,
    "the simulator uses the continuous score (was 75 from the dead branch)");

  // And the overall score is the authoritative weighting of those components.
  const { weightedScore } = require("../../src/domain/analysis/riskAggregation");
  assert.equal(r.health_before.score, weightedScore({
    cash_flow: 80, fraud_indicators: 80, revenue_stability: 72, vendor_risk: 60, customer_risk: 65
  }).score);
});

test("[12f][FIXED in JOB 6] an unmeasured component stays null in a what-if "
  + "instead of being invented as 60", () => {
  // WAS: recomputeHealth() substituted 60 for any missing component, which
  // defeated the null-preserving renormalisation — a business with no
  // attributable customers was scored as if its customer risk had been measured
  // and found average.
  const r = whatIf.simulate({
    type: "increase_rent",
    params: { amount: 0 },
    baseline: {
      startingCash: 300000, monthlyNet: 50000, monthlyBurn: 0, overdueReceivables: 0,
      monthlyRevenue: 500000,
      // Only cash flow is measurable here.
      componentScores: {}
    }
  });
  const { weightedScore } = require("../../src/domain/analysis/riskAggregation");
  // Scored on the cash-flow weight alone (0.30), renormalised.
  assert.equal(r.health_before.weight_covered, 0.3);
  assert.equal(r.health_before.score, weightedScore({ cash_flow: 80 }).score);
  assert.equal(r.health_before.score, 80, "renormalised over what was measured");
  assert.equal(r.health_before.revenue_score, null, "never invented");
});

// ── 14. Custom rules ─────────────────────────────────────────────
test("[14] a custom expense-threshold rule matches and reports evidence", () => {
  const rule = {
    name: "Large expense",
    severity: "high",
    condition: { type: "expense_over", amount: 200000 },
    action: "require_approval"
  };
  const v = customRules.validateRule(rule);
  assert.equal(v.ok, true, v.error);

  const data = scenarios.customRuleData;
  const analysis = analyzeFinancialRisk(data);
  const res = customRules.evaluateCustomRules([v.rule], data, analysis, {});
  assert.equal(res.findings.length, 1, "only the 260,000 expense matches");
  assert.match(res.findings[0].description, /260,?000|260000/);
  assert.equal(res.executions.length, 1);
  assert.equal(res.executions[0].matchCount, 1);
});

test("[14b] invalid custom rules are rejected", () => {
  assert.equal(customRules.validateRule({ name: "", condition: { type: "expense_over", amount: 1 } }).ok, false);
  assert.equal(customRules.validateRule({ name: "x", condition: { type: "nope" } }).ok, false);
  assert.equal(customRules.validateRule({ name: "x", condition: { type: "expense_over", amount: -5 } }).ok, false);
});

test("[14c][FIXED in JOB 7] custom-rule findings are de-duplicated by STABLE ID, "
  + "not by description text", () => {
  // WAS: dedupe keyed on the rendered prose, so two genuinely distinct payments
  // that happened to render identically collapsed into one finding and real
  // evidence was silently discarded.
  const rule = customRules.validateRule({
    name: "Large expense", severity: "high",
    condition: { type: "expense_over", amount: 1000 }, action: "flag"
  }).rule;
  rule.id = "rule-abc";
  const data = {
    period: "2026-05",
    transactions: [
      { date: "2026-05-09", amount: 5000, counterparty: "Acme", description: "Payment" },
      { date: "2026-05-09", amount: 5000, counterparty: "Acme", description: "Payment" }
    ],
    journalEntries: [], reconciliations: [],
    statements: { cashFlow: {}, profitAndLoss: {}, balanceSheet: {} }
  };
  const res = customRules.evaluateCustomRules([rule], data, analyzeFinancialRisk(data), {});
  assert.equal(res.findings.length, 2, "both payments are kept — they are different records");
  assert.notEqual(res.findings[0].findingId, res.findings[1].findingId);
  // Each cites the record it came from.
  res.findings.forEach((f) => assert.equal(f.evidence.length, 1));
});

test("[14d][FIXED in JOB 7] custom-rule findings carry the full Finding contract", () => {
  // WAS: customRules emitted { type, severity, description } with a ruleId that
  // routes/api.js then dropped, so a user rule could not be persisted, traced
  // to a record, or explained.
  const rule = customRules.validateRule({
    name: "Large expense", severity: "high",
    condition: { type: "expense_over", amount: 1000 }, action: "flag"
  }).rule;
  rule.id = "rule-abc";
  const data = scenarios.customRuleData;
  const res = customRules.evaluateCustomRules([rule], data, analyzeFinancialRisk(data),
    { tenantId: "t1", period: "2026-05" });
  const f = res.findings[0];

  assert.equal(f.ruleId, "custom:rule-abc", "namespaced so it cannot collide with a built-in rule");
  assert.equal(f.ruleVersion, "1", "the version of the rule record the user authored");
  assert.ok(f.findingId, "a stable id, so it can be acknowledged once");
  assert.ok(f.calculation, "states the arithmetic that matched");
  assert.ok(f.evidence.length > 0, "cites the record that matched");
  assert.ok(f.confidenceBasis, "declares WHY it is confident");
  assert.equal(f.severityBasis, "warrants_review");
});

test("[14e][FIXED in JOB 7] a user cannot move their own risk score by writing rules", () => {
  // WAS: custom findings entered context.anomalies.items alongside engine
  // findings, and the anomaly component is 100 minus the pressure from those
  // items — so a rule matching 12 transactions lowered the business's own
  // deterministic health score by writing it.
  const { aggregateRisk } = require("../../src/domain/analysis/riskAggregation");
  const rule = customRules.validateRule({
    name: "Everything", severity: "high",
    condition: { type: "expense_over", amount: 1 }, action: "flag"
  }).rule;
  rule.id = "noisy";
  const data = scenarios.customRuleData;
  const custom = customRules.evaluateCustomRules([rule], data, analyzeFinancialRisk(data),
    { tenantId: "t1", period: "2026-05" }).findings;
  assert.ok(custom.length > 0, "the rule matched, so there is something to exclude");
  custom.forEach((f) => assert.equal(f.authorityScope, "tenant"));

  const components = {
    cashflow: { available: true, risk_score: 20 },
    revenue: { available: true, growth_rate: 5 },
    vendors: { available: true, risk_score: 10 },
    customers: { available: true, risk_score: 10 }
  };
  const without = aggregateRisk(Object.assign({ findings: [] }, components));
  const withCustom = aggregateRisk(Object.assign({ findings: custom }, components));
  assert.equal(withCustom.overall, without.overall,
    "tenant-authored findings do not move the deterministic score");
  assert.equal(withCustom.components.fraud_indicators, without.components.fraud_indicators);
});
