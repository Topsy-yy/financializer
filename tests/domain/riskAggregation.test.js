// RISK AGGREGATION — the one scoring implementation, at its boundaries.
//
// Section 7 of the JOB 6 mandate asks specifically for regression tests proving
// the dead branch is gone: a cash-flow risk of 15 must not collapse into the old
// 20/45/75 buckets. "Do not simply test one number. Test boundary cases."

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  aggregateRisk, componentScores, weightedScore, categoryFor,
  anomalyPressure, revenueComponent
} = require("../../src/domain/analysis/riskAggregation");
const { HEALTH_SCORE } = require("../../src/domain/rules/registry");
const { computeCashflowRisk } = require("../../src/domain/calculators/cashflow");
const whatIf = require("../../src/services/whatIfSimulator");

/** A cash-flow calculator result with a chosen risk score. */
const cashflowAt = (riskScore) => ({ available: true, risk_score: riskScore });
const concAt = (riskScore) => ({ available: true, risk_score: riskScore });

// ── §7: THE DEAD BRANCH ──────────────────────────────────────────

test("[D1][FIXED] the cash-flow component is CONTINUOUS — every risk score maps "
  + "to its own component value", () => {
  // WAS: api.js read `cashflow.risk_score`, which nothing set, so the branch
  // `risk_level === "high" ? 80 : medium ? 55 : 25` ran instead and the
  // 30%-weighted component could only ever be 20, 45 or 75.
  const seen = new Set();
  for (let risk = 0; risk <= 100; risk++) {
    const c = componentScores({ cashflow: cashflowAt(risk), findings: [] });
    assert.equal(c.cash_flow, 100 - risk, `risk ${risk} must map to component ${100 - risk}`);
    seen.add(c.cash_flow);
  }
  assert.equal(seen.size, 101, "101 distinct component values, not 3");
  [20, 45, 75].forEach((bucket) =>
    assert.ok(seen.has(bucket), `${bucket} is still reachable — as one value among many`));
});

test("[D2][FIXED] a cash-flow risk of 15 stays 15, and its neighbours differ", () => {
  // The mandate's example, plus the values either side, so a test cannot pass by
  // coincidence on a single point.
  [13, 14, 15, 16, 17].forEach((risk) => {
    assert.equal(componentScores({ cashflow: cashflowAt(risk), findings: [] }).cash_flow, 100 - risk);
  });
  const at15 = componentScores({ cashflow: cashflowAt(15), findings: [] }).cash_flow;
  assert.equal(at15, 85);
  assert.notEqual(at15, 75, "not the old 'low risk' bucket");
  assert.notEqual(at15, 45);
  assert.notEqual(at15, 20);
});

test("[D3][FIXED] the bucket boundaries no longer create cliffs", () => {
  // Under the dead branch, crossing the medium cut-off (40) jumped the component
  // from 75 to 45 — a 30-point cliff from a 1-point change in risk.
  const at = (risk) => componentScores({ cashflow: cashflowAt(risk), findings: [] }).cash_flow;
  assert.equal(at(39) - at(40), 1, "one point of risk moves the component by one point");
  assert.equal(at(69) - at(70), 1, "and again at the high cut-off");
});

test("[D4][FIXED] the overall score responds smoothly to cash-flow risk", () => {
  const scoreAt = (risk) => aggregateRisk({
    cashflow: cashflowAt(risk),
    revenue: { available: true, growth_rate: 5 },
    vendors: concAt(20),
    customers: concAt(20),
    findings: []
  }).overall;
  // Monotonically non-increasing, and it actually moves.
  let prev = scoreAt(0);
  for (let risk = 1; risk <= 100; risk++) {
    const s = scoreAt(risk);
    assert.ok(s <= prev, `score must not rise as risk rises (${risk})`);
    prev = s;
  }
  assert.ok(scoreAt(0) - scoreAt(100) >= 25,
    "a full swing in cash-flow risk moves the 30%-weighted overall score");
});

test("[D5][FIXED] the what-if simulator uses the same continuous scale", () => {
  // The dashboard and a scenario must be on one scale, or a comparison is
  // meaningless. This is the same assertion as [D1], through the simulator.
  const seen = new Set();
  [-500000, -200000, -80000, -30000, -5000, 0, 5000, 90000].forEach((monthlyNet) => {
    const r = whatIf.simulate({
      type: "increase_rent",
      params: { amount: 0 },
      baseline: {
        startingCash: 300000, monthlyNet, monthlyBurn: Math.max(0, -monthlyNet),
        overdueReceivables: 0, monthlyRevenue: 500000,
        componentScores: { fraud_indicators: 80, revenue_stability: 72, vendor_risk: 60, customer_risk: 65 }
      }
    });
    seen.add(r.health_before.cashflow_score);
    // Whatever it is, it must equal the authoritative computation.
    const burn = Math.max(0, -monthlyNet);
    const runway = burn > 0 ? (300000 > 0 ? 300000 / burn : 0) : Infinity;
    assert.equal(r.health_before.cashflow_score, 100 - computeCashflowRisk({
      netCashFlow: monthlyNet, monthlyBurn: burn, runwayMonths: runway,
      overdueReceivables: null, inflow: 0
    }).risk_score);
  });
  assert.ok(seen.size > 3, `expected a continuous range, got ${[...seen].join(",")}`);
});

// ── Unavailable components ───────────────────────────────────────

test("[U1] an unmeasured component is null, excluded, and the weights renormalise", () => {
  const c = componentScores({
    cashflow: cashflowAt(20),
    revenue: { available: false },
    vendors: { available: false, risk_score: null },
    customers: { available: false, risk_score: null },
    findings: []
  });
  assert.equal(c.revenue_stability, null);
  assert.equal(c.vendor_risk, null);
  assert.equal(c.customer_risk, null);

  const { score, measured, covered } = weightedScore(c);
  assert.deepEqual(measured.sort(), ["cash_flow", "fraud_indicators"]);
  assert.equal(covered, 0.5, "0.30 + 0.20");
  // Renormalised: (80*0.30 + 100*0.20) / 0.50 = 88
  assert.equal(score, 88);
});

test("[U2] an unmeasured component neither helps nor hurts", () => {
  const withAll = weightedScore({
    cash_flow: 80, fraud_indicators: 80, revenue_stability: 80, vendor_risk: 80, customer_risk: 80
  });
  const withSome = weightedScore({
    cash_flow: 80, fraud_indicators: 80, revenue_stability: null, vendor_risk: null, customer_risk: null
  });
  assert.equal(withSome.score, withAll.score,
    "identical measured values give an identical score regardless of coverage");
  assert.notEqual(withSome.covered, withAll.covered, "but the coverage is visibly different");
});

test("[U3] no measurable component at all yields Unknown, never zero", () => {
  const r = aggregateRisk({
    cashflow: { available: false }, revenue: { available: false },
    vendors: { available: false }, customers: { available: false },
    findings: [],
    dataQuality: { scoringReliable: false }
  });
  assert.equal(r.available, false);
  assert.equal(r.overall, null, "null, NEVER 0 — 0 is the worst possible score");
  assert.equal(r.category, "Unknown");
  assert.equal(r.unavailableReason, "insufficient_data_quality");
});

test("[U4][FIXED in JOB 6] a minority of the model cannot produce a score", () => {
  // WAS: renormalisation alone let `fraud_indicators` — which is ALWAYS
  // measurable, being 100 minus the anomaly pressure — score a period with no
  // financial statements at all as 94/100 "Excellent" on 20% coverage.
  const r = aggregateRisk({
    cashflow: { available: false }, revenue: { available: false },
    vendors: { available: false }, customers: { available: false },
    findings: [],                       // no anomalies => fraud_indicators = 100
    dataQuality: { scoringReliable: true }
  });
  assert.equal(r.components.fraud_indicators, 100, "the always-measurable component");
  assert.equal(r.weightCovered, 0.2);
  assert.equal(r.available, false, "20% of the model is not a score");
  assert.equal(r.unavailableReason, "insufficient_component_coverage");
  assert.match(r.summary, /only 20% of the model/);
});

test("[U5] the coverage floor is exactly at the configured threshold", () => {
  const floor = HEALTH_SCORE.minWeightCovered;
  assert.equal(floor, 0.5);
  // cash_flow (0.30) + fraud (0.20) = 0.50 — exactly at the floor, so allowed.
  const atFloor = aggregateRisk({
    cashflow: cashflowAt(20), revenue: { available: false },
    vendors: { available: false }, customers: { available: false }, findings: []
  });
  assert.equal(atFloor.weightCovered, 0.5);
  assert.equal(atFloor.available, true, "the floor is inclusive");

  // vendor (0.15) + fraud (0.20) = 0.35 — below the floor.
  const belowFloor = aggregateRisk({
    cashflow: { available: false }, revenue: { available: false },
    vendors: concAt(10), customers: { available: false }, findings: []
  });
  assert.equal(belowFloor.weightCovered, 0.35);
  assert.equal(belowFloor.available, false);
});

// ── Score boundaries ─────────────────────────────────────────────

test("[B1] category bands sit exactly on their cut-offs", () => {
  HEALTH_SCORE.categories.filter((c) => Number.isFinite(c.minScore)).forEach((band) => {
    assert.equal(categoryFor(band.minScore), band.label, `${band.minScore} is ${band.label}`);
    const below = HEALTH_SCORE.categories.find((c) => band.minScore - 1 >= c.minScore);
    assert.equal(categoryFor(band.minScore - 1), below.label,
      `${band.minScore - 1} falls to the band below`);
  });
  assert.equal(categoryFor(100), "Excellent");
  assert.equal(categoryFor(0), "Critical");
});

test("[B2] the overall score is clamped to 0-100", () => {
  assert.equal(weightedScore({ cash_flow: 1000 }).score, 100);
  assert.equal(weightedScore({ cash_flow: -1000 }).score, 0);
});

test("[B3] anomaly pressure counts BUSINESS findings only, and is capped", () => {
  const f = (severity, isDataQuality) => ({ severity, isDataQuality, category: isDataQuality ? "data_quality" : "anomaly" });
  assert.equal(anomalyPressure([]), 0);
  assert.equal(anomalyPressure([f("high")]), HEALTH_SCORE.anomalyPoints.high);
  assert.equal(anomalyPressure([f("high"), f("medium"), f("low")]),
    HEALTH_SCORE.anomalyPoints.high + HEALTH_SCORE.anomalyPoints.medium + HEALTH_SCORE.anomalyPoints.low);
  // Data-quality findings do NOT contribute — the audit's contamination bug.
  assert.equal(anomalyPressure([f("high", true), f("high", true)]), 0,
    "an unreconciled account must not score as a fraud signal");
  // Capped at 100 so the component floors at 0 rather than going negative.
  assert.equal(anomalyPressure(Array.from({ length: 50 }, () => f("high"))), 100);
});

test("[B4] revenue bands are selected by growth rate, at their edges", () => {
  HEALTH_SCORE.revenueBands.filter((b) => Number.isFinite(b.minGrowthPct)).forEach((band) => {
    assert.equal(revenueComponent({ available: true, growth_rate: band.minGrowthPct }), band.score);
  });
  assert.equal(revenueComponent({ available: true, growth_rate: null }), null, "no growth data");
  assert.equal(revenueComponent({ available: false }), null);
  assert.equal(revenueComponent({ available: true, growth_rate: -999 }), 38, "the floor band");
});

// ── Explainability ───────────────────────────────────────────────

test("[X1] the score states its own arithmetic and names its versions", () => {
  const r = aggregateRisk({
    cashflow: cashflowAt(20),
    revenue: { available: true, growth_rate: 15 },
    vendors: concAt(10), customers: concAt(10),
    findings: []
  });
  assert.equal(r.available, true);
  assert.match(r.calculation, /cash_flow 80 x 0\.3/);
  assert.equal(r.scoringVersion, HEALTH_SCORE.version);
  assert.ok(r.weakestComponent && r.strongestComponent);
  // The narrative is DERIVED, not the old hardcoded sentence.
  assert.doesNotMatch(r.summary, /strongest pressure from cashflow and concentration risk/);
  assert.match(r.summary, new RegExp(`${r.overall}/100`));
});

test("[X2] a partial score says how much of the model it covered", () => {
  const r = aggregateRisk({
    cashflow: cashflowAt(20), revenue: { available: true, growth_rate: 5 },
    vendors: { available: false }, customers: { available: false }, findings: []
  });
  assert.equal(r.weightCovered, 0.7);
  assert.match(r.summary, /70% of the model/);
  assert.match(r.calculation, /renormalised over 0\.70/);
});

test("[X3] business and data-quality finding counts are reported separately", () => {
  const r = aggregateRisk({
    cashflow: cashflowAt(20), revenue: { available: true, growth_rate: 5 },
    vendors: concAt(10), customers: concAt(10),
    findings: [
      { severity: "high", isDataQuality: false, category: "anomaly" },
      { severity: "low", isDataQuality: true, category: "data_quality" },
      { severity: "low", isDataQuality: true, category: "data_quality" }
    ]
  });
  assert.equal(r.businessFindings, 1);
  assert.equal(r.dataQualityFindings, 2);
});

// ── §21 verification, as executable assertions ───────────────────

test("[V1] EVERY finding from EVERY golden scenario carries a rule id, a rule "
  + "version, evidence and a calculation", () => {
  const engine = require("../../src/domain/analysis/engine");
  const { scenarios } = require("../helpers/fixtures");
  const NOW = Date.parse("2026-06-15T00:00:00Z");
  let checked = 0;

  Object.keys(scenarios).forEach((name) => {
    const r = engine.analyze(scenarios[name], { tenantId: "t", period: "2026-05", now: NOW });
    r.findings.forEach((f) => {
      checked++;
      assert.ok(f.ruleId, `${name}: a finding with no rule id`);
      assert.ok(f.ruleVersion, `${name}/${f.ruleId}: no rule version`);
      assert.ok(f.findingId, `${name}/${f.ruleId}: no stable id`);
      assert.ok(f.calculation, `${name}/${f.ruleId}: no calculation — "why?" is unanswerable`);
      assert.ok(Array.isArray(f.evidence) && f.evidence.length > 0,
        `${name}/${f.ruleId}: no evidence`);
      assert.ok(f.analysisRunId, `${name}/${f.ruleId}: not bound to a run`);
      // Evidence is structured, never prose.
      f.evidence.forEach((e) => assert.equal(typeof e.fields, "object",
        `${name}/${f.ruleId}: evidence is not machine-readable`));
    });
  });
  assert.ok(checked > 20, `expected a meaningful sample, checked ${checked}`);
});

test("[V2] EVERY metric names the deterministic engine that computed it", () => {
  const engine = require("../../src/domain/analysis/engine");
  const { scenarios } = require("../helpers/fixtures");
  const NOW = Date.parse("2026-06-15T00:00:00Z");

  Object.keys(scenarios).forEach((name) => {
    const r = engine.analyze(scenarios[name], { tenantId: "t", period: "2026-05", now: NOW });
    assert.ok(r.metrics.length > 0);
    r.metrics.forEach((m) => {
      assert.match(m.computedBy || "", /^engine@/,
        `${name}/${m.key}: not attributed to the deterministic engine`);
      if (m.available) {
        assert.notEqual(m.value, null);
      } else {
        // An unavailable metric states WHY and carries no value.
        assert.equal(m.value, null, `${name}/${m.key}: unavailable but has a value`);
        assert.ok(m.reason, `${name}/${m.key}: unavailable with no reason`);
      }
    });
  });
});

test("[V3] every rule the engine can emit is registered with a version", () => {
  const engine = require("../../src/domain/analysis/engine");
  const { scenarios } = require("../helpers/fixtures");
  const { ruleVersions } = require("../../src/domain/rules/registry");
  const registry = ruleVersions();
  const NOW = Date.parse("2026-06-15T00:00:00Z");

  const emitted = new Set();
  Object.keys(scenarios).forEach((name) => {
    engine.analyze(scenarios[name], { tenantId: "t", period: "2026-05", now: NOW })
      .findings.forEach((f) => emitted.add(f.ruleId));
  });
  assert.ok(emitted.size > 5, `expected several rules to fire, got ${emitted.size}`);
  emitted.forEach((ruleId) => assert.ok(registry[ruleId],
    `rule ${ruleId} fires but is not in the version registry`));
});

test("[V4] the analysis run stamps the engine and rule versions that produced it", () => {
  const engine = require("../../src/domain/analysis/engine");
  const { scenarios } = require("../helpers/fixtures");
  const { ENGINE_VERSION } = require("../../src/domain/rules/registry");
  const r = engine.analyze(scenarios.duplicatePayment,
    { tenantId: "t", period: "2026-05", now: Date.parse("2026-06-15T00:00:00Z") });

  assert.equal(r.analysisRun.engineVersion, ENGINE_VERSION);
  assert.equal(r.engineVersion, ENGINE_VERSION);
  assert.ok(r.analysisRun.ruleVersions.duplicate_payment);
  assert.ok(r.analysisRun.inputHash, "the exact dataset is identified");
  assert.equal(r.riskScore.scoringVersion, HEALTH_SCORE.version);
});
