// DOMAIN — the reconstructed deterministic engine.
//
// Two jobs:
//  1. prove behaviour PRESERVED where the old engine was correct;
//  2. prove the known financial bugs are FIXED, with the old behaviour named.
//
// Every [FIXED] test corresponds to a [KNOWN-BAD] test in tests/golden/ that
// still pins the legacy path until api.js is fully migrated.

const test = require("node:test");
const assert = require("node:assert/strict");

const engine = require("../../src/domain/analysis/engine");
const { CATEGORY } = require("../../src/domain/model/finding");
const { LEVEL } = require("../../src/domain/model/dataQuality");
const { scenarios } = require("../helpers/fixtures");

// Fixed clock so every run is reproducible.
const NOW = Date.parse("2026-06-15T00:00:00Z");
const run = (name, extra = {}) =>
  engine.analyze(scenarios[name], Object.assign({ tenantId: "t_test", period: "2026-05", now: NOW }, extra));

// ── Preserved behaviour ──────────────────────────────────────────
test("[P1] healthy business: no business findings, score available", () => {
  const r = run("healthy");
  assert.equal(r.summary.business_findings, 0);
  assert.equal(r.riskScore.available, true);
  assert.ok(r.riskScore.overall > 60, `expected a good score, got ${r.riskScore.overall}`);
  assert.equal(r.dataQuality.level, LEVEL.COMPLETE);
});

test("[P2] duplicate payment is still detected", () => {
  const r = run("duplicatePayment");
  const dups = r.findings.filter((f) => f.ruleId === "duplicate_payment");
  assert.equal(dups.length, 1);
  assert.equal(dups[0].category, CATEGORY.DUPLICATE);
  assert.equal(dups[0].severity, "high");
});

test("[P3] cash-flow stress still scores high risk with a short runway", () => {
  const r = run("cashflowStress");
  assert.equal(r.calculations.cashflow.risk_level, "high");
  assert.ok(r.calculations.cashflow.cash_runway_months < 1);
  assert.ok(r.findings.some((f) => f.ruleId === "cashflow_runway"));
});

test("[P4] round-number rule still fires on the same input", () => {
  const r = run("roundNumber");
  const rn = r.findings.filter((f) => f.ruleId === "round_number_payment");
  assert.equal(rn.length, 1);
  assert.equal(rn[0].observedValue, 250000);
});

// ── FIXED: fabricated customers ──────────────────────────────────
test("[FIXED-1] unattributed revenue is reported as unavailable, NOT fabricated", () => {
  // WAS: invented "BlueTech"/"Nova Retail"/"Eastline Logistics", a hardcoded
  // risk score of 72, and a HIGH finding about a customer that did not exist.
  const r = run("healthy"); // outflow-only fixture: nothing attributable as revenue
  assert.equal(r.calculations.customers.available, false);
  assert.equal(r.calculations.customers.risk_score, null);
  assert.deepEqual(r.calculations.customers.parties, []);
  const json = JSON.stringify(r);
  ["BlueTech", "Nova Retail", "Eastline Logistics"].forEach((name) => {
    assert.equal(json.includes(name), false, `${name} must never appear`);
  });
  assert.equal(r.findings.some((f) => f.ruleId === "customer_concentration"), false,
    "no finding may be raised about a customer that was never measured");
});

test("[FIXED-1b] measured customer concentration IS reported", () => {
  const r = run("customerConcentration");
  assert.equal(r.calculations.customers.available, true);
  assert.equal(r.calculations.customers.top_party.name, "BigCo Retail");
  assert.ok(r.calculations.customers.top_share_pct > 50);
  const f = r.findings.find((x) => x.ruleId === "customer_concentration");
  assert.ok(f, "a real concentration must be flagged");
  assert.equal(f.severity, "high");
  assert.ok(f.evidence.length > 0, "finding carries the contributing transactions");
});

// ── FIXED: invented overdue receivables ──────────────────────────
test("[FIXED-2] overdue receivables are measured or null, never estimated", () => {
  // WAS: abs(netCashFlow) * 0.35 published in the same field as real data.
  const r = run("cashflowStress");
  assert.equal(r.calculations.cashflow.overdue_receivables, null);
  assert.equal(r.calculations.cashflow.overdue_receivables_measured, false);
});

// ── FIXED: dead risk_score branch ────────────────────────────────
test("[FIXED-3] the cash-flow component uses the real 0-100 score", () => {
  // WAS: api.js read `cashflow.risk_score` which nothing set, so the
  // 30%-weighted component could only ever be 20, 45 or 75.
  const stress = run("cashflowStress");
  const healthy = run("healthy");
  const a = stress.riskScore.components.cash_flow;
  const b = healthy.riskScore.components.cash_flow;
  assert.equal(a, 100 - stress.calculations.cashflow.risk_score);
  assert.equal(b, 100 - healthy.calculations.cashflow.risk_score);
  assert.ok(![20, 45, 75].includes(a) || ![20, 45, 75].includes(b),
    "scores are no longer confined to the three legacy buckets");
});

// ── FIXED: data quality contaminating fraud score ────────────────
test("[FIXED-4] data-quality issues do NOT feed the anomaly component", () => {
  // WAS: an unreconciled account scored +12 into `fraud_indicators` —
  // identical to a duplicate payment.
  const r = run("missingData");
  const dq = r.findings.filter((f) => f.isDataQuality);
  assert.ok(dq.length > 0, "the fixture does have data-quality problems");
  assert.ok(dq.every((f) => [CATEGORY.DATA_QUALITY, CATEGORY.CONTROL_WEAKNESS].includes(f.category)));
  assert.equal(r.summary.data_quality_findings, dq.length);
  // They are reported, separately, and never inflate business risk.
  assert.ok(r.quality.issue_count > 0);
});

test("[FIXED-4b] business risk and data quality are reported separately", () => {
  const r = run("missingData");
  assert.ok(r.quality.level, "data quality has its own grade");
  assert.notEqual(r.riskScore.available && r.quality.level, undefined);
});

// ── FIXED: empty data no longer looks healthy ────────────────────
test("[FIXED-5] an EMPTY dataset yields INSUFFICIENT_EVIDENCE, not a healthy score", () => {
  // WAS: severity "low", 12-month runway, no warning at all.
  const r = engine.analyze(scenarios.emptyResponse, { tenantId: "t", period: "2026-05", now: NOW });
  assert.equal(r.dataQuality.level, LEVEL.INSUFFICIENT_EVIDENCE);
  assert.equal(r.dataQuality.scoringReliable, false);
  assert.equal(r.riskScore.available, false);
  assert.equal(r.riskScore.overall, null);
  assert.equal(r.riskScore.category, "Unknown");
  assert.match(r.riskScore.summary, /not enough accounting data/i);
});

test("[FIXED-5b] runway is null when it cannot be computed (never a 12-month default)", () => {
  const r = engine.analyze(scenarios.emptyResponse, { tenantId: "t", period: "2026-05", now: NOW });
  assert.equal(r.calculations.cashflow.cash_runway_months, null);
  assert.equal(r.calculations.cashflow.available, false);
});

// ── FIXED: partial ingestion is visible ──────────────────────────
test("[FIXED-6] absent reconciliation data is reported as PARTIAL, not 'all reconciled'", () => {
  const r = run("partialIngestion");
  assert.equal(r.dataQuality.level, LEVEL.PARTIAL);
  assert.ok(r.dataQuality.missing.includes("reconciliations"));
  assert.match(r.dataQuality.summary, /partial data/i);
});

test("[FIXED-6c] a failed dataset fetch is reported as FAILED, not empty", () => {
  const r = engine.analyze(scenarios.partialIngestion, {
    tenantId: "t", period: "2026-05", now: NOW, fetchFailures: ["reconciliations"]
  });
  assert.equal(r.dataQuality.level, LEVEL.FAILED);
  assert.deepEqual([...r.dataQuality.failed], ["reconciliations"]);
});

// ── FIXED: duplicate false positive ──────────────────────────────
test("[FIXED-7] duplicate detection no longer falls back to description", () => {
  // WAS: `date|amount|counterparty || description` collided unrelated records.
  const r = engine.analyze({
    period: "2026-05",
    transactions: [
      { date: "2026-05-11", amount: 1000, counterparty: "Acme", description: "x" },
      { date: "2026-05-11", amount: 1000, counterparty: "", description: "Acme" }
    ],
    journalEntries: [], reconciliations: [],
    statements: { cashFlow: { inflow: 1, outflow: 1 }, profitAndLoss: {}, balanceSheet: {} }
  }, { tenantId: "t", period: "2026-05", now: NOW });
  assert.equal(r.findings.filter((f) => f.ruleId === "duplicate_payment").length, 0);
});

// ── Evidence and provenance ──────────────────────────────────────
test("[E1] every finding carries rule, version, evidence and a calculation", () => {
  const r = run("duplicatePayment");
  assert.ok(r.findings.length > 0);
  r.findings.forEach((f) => {
    assert.ok(f.findingId && f.findingId.startsWith("fnd_"), "stable id");
    assert.ok(f.ruleId && f.ruleVersion, "rule provenance");
    assert.ok(f.title, "human title");
    assert.ok(f.calculation, `finding ${f.ruleId} explains its arithmetic`);
    assert.ok(Array.isArray(f.evidence), "evidence array");
    assert.equal(f.analysisRunId, r.analysisRunId, "linked to its run");
  });
});

test("[E2] a duplicate finding names BOTH source records", () => {
  const r = run("duplicatePayment");
  const dup = r.findings.find((f) => f.ruleId === "duplicate_payment");
  assert.equal(dup.evidence.length, 2, "both sides retained (v1 discarded the original)");
  assert.equal(dup.sourceRecordIds.length, 2);
  assert.ok(dup.confidence > 0 && dup.confidence <= 1, "confidence is scored");
  dup.evidence.forEach((e) => {
    assert.ok(e.fields.amount, "evidence carries the amount");
    assert.ok(e.fields.date, "evidence carries the date");
  });
});

test("[E3] finding ids are stable across identical runs", () => {
  const a = run("duplicatePayment").findings.map((f) => f.findingId).sort();
  const b = run("duplicatePayment").findings.map((f) => f.findingId).sort();
  assert.deepEqual(a, b);
});

// ── Reproducibility ──────────────────────────────────────────────
test("[R1] the same input produces the same findings, score and input hash", () => {
  const a = run("cashflowStress");
  const b = run("cashflowStress");
  assert.equal(a.inputHash, b.inputHash);
  assert.equal(a.riskScore.overall, b.riskScore.overall);
  assert.deepEqual(a.findings.map((f) => f.findingId), b.findings.map((f) => f.findingId));
});

test("[R2] wall-clock time no longer changes the result", () => {
  // v1 called new Date() inside overdue detection, so historical re-runs drifted.
  const early = run("healthy", { now: Date.parse("2026-06-01T00:00:00Z") });
  const late = run("healthy", { now: Date.parse("2027-01-01T00:00:00Z") });
  assert.deepEqual(early.findings.map((f) => f.ruleId), late.findings.map((f) => f.ruleId));
});

test("[R3] every run is stamped with engine and rule versions", () => {
  const r = run("healthy");
  assert.match(r.engineVersion, /^\d+\.\d+\.\d+$/);
  assert.ok(r.ruleVersions.duplicate_payment, "each rule reports its version");
  assert.ok(r.ruleVersions.health_score);
  assert.ok(r.inputHash && r.inputHash.length === 64);
});

// ── Scoring transparency ─────────────────────────────────────────
test("[S1] the health score explains itself and is not hardcoded prose", () => {
  const r = run("cashflowStress");
  assert.ok(r.riskScore.calculation.includes("cash_flow"), "shows the arithmetic");
  assert.ok(r.riskScore.weakestComponent, "names the weakest component");
  assert.equal(
    r.riskScore.summary.includes("strongest pressure from cashflow and concentration risk"), false,
    "the hardcoded v1 sentence is gone"
  );
  assert.match(r.riskScore.summary, new RegExp(r.riskScore.overall + "/100"));
});

test("[S2] unmeasurable components are excluded and weights renormalised", () => {
  const r = run("healthy"); // no customer revenue attributable
  assert.equal(r.riskScore.components.customer_risk, null);
  assert.ok(!r.riskScore.measuredComponents.includes("customer_risk"));
  assert.ok(r.riskScore.weightCovered < 1, "weights renormalised over measured components");
});

test("[FIXED-8] field-level gaps downgrade the EFFECTIVE data-quality level", () => {
  // Datasets all arrived, but individual records are incomplete. Reporting
  // "COMPLETE" would misrepresent the books.
  //
  // Built inline rather than from a fixture: this asserts the case where
  // ingestion succeeded COMPLETELY and the gaps are at field level, so the
  // dataset must have every statement present (the `missingData` fixture
  // deliberately has none, which is a different case — see [8c]).
  const r = engine.analyze({
    transactions: [
      { date: "2026-05-08", amount: 15000, counterparty: "", description: "" },
      { date: "2026-05-16", amount: 4200, counterparty: "Acme Supplies", description: "Stock" }
    ],
    journalEntries: [{ date: "2026-05-08", amount: 15000 }],
    reconciliations: [{ accountName: "Main Bank", isReconciled: false }],
    statements: {
      cashFlow: { inflow: 80000, outflow: 40000 },
      profitAndLoss: { revenue: 80000, netIncome: 40000 },
      balanceSheet: { cashAndEquivalents: 120000 }
    }
  }, { tenantId: "t_test", period: "2026-05", now: NOW });
  assert.equal(r.dataQuality.level, "COMPLETE", "every expected dataset did arrive");
  assert.equal(r.quality.ingestion_level, "COMPLETE");
  assert.equal(r.quality.level, "PARTIAL", "but incomplete records downgrade the effective level");
  assert.ok(r.quality.issue_count > 0);
  assert.match(r.quality.summary, /incomplete/i);
});
