// DOMAIN MODEL — Finding, Evidence, Metric, RiskScore, AnalysisRun, records.
//
// Covers JOB 5 test requirements 1-8 (creation, validation, provenance, CSV
// ids, duplicate evidence, unavailable metrics, risk score). Persistence and
// end-to-end live in tests/db/domainPersistence.test.js.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createFinding, createEvidence, createMatchCriteria, computeFindingId,
  CATEGORY, SEVERITY, REQUIRES_CAUTIOUS_LANGUAGE,
  businessFindings, dataQualityFindings
} = require("../../src/domain/model/finding");
const { createMetric, unavailableMetric, METRIC, UNAVAILABLE_REASON, toMetricMap } = require("../../src/domain/model/metric");
const { createRiskScore, unavailableComponents, COMPONENT } = require("../../src/domain/model/riskScore");
const { createAnalysisRun, STATUS } = require("../../src/domain/model/analysisRun");
const records = require("../../src/domain/model/records");
const { parseFinancialCsv } = require("../../src/services/csvFinancialImporter");
const engine = require("../../src/domain/analysis/engine");
const { scenarios } = require("../helpers/fixtures");

const NOW = Date.parse("2026-06-15T00:00:00Z");
const baseFinding = {
  tenantId: "t1", period: "2026-05", ruleId: "duplicate_payment", ruleVersion: "2.0.0",
  category: CATEGORY.DUPLICATE, severity: SEVERITY.HIGH, title: "Possible duplicate payment"
};

// ── 1. Finding creation ──────────────────────────────────────────
test("[M1] a finding carries the full JOB 5 contract", () => {
  const f = createFinding(Object.assign({}, baseFinding, {
    description: "Two payments share date, amount and counterparty.",
    metric: "matching_transactions",
    observedValue: 2,
    threshold: 2,
    comparator: ">=",
    confidence: 0.9,
    calculation: "grouped by (date, amount, counterparty)",
    matchCriteria: createMatchCriteria(["date", "amount", "counterparty"]),
    evidence: [createEvidence({ label: "A", sourceSystem: "zoho-books", sourceRecordId: "INV-1", recordType: "invoice", relationship: "matched", field: "amount", value: 48500 })]
  }));
  ["findingId", "tenantId", "analysisRunId", "ruleId", "ruleVersion", "category", "severity",
   "title", "description", "metric", "observedValue", "threshold", "confidence", "calculation",
   "evidence", "sourceRecordIds", "createdAt"].forEach((k) => {
    assert.ok(k in f, `finding is missing ${k}`);
  });
  assert.match(f.findingId, /^fnd_[0-9a-f]{24}$/);
  assert.deepEqual([...f.sourceRecordIds], ["INV-1"]);
});

test("[M2] finding ids are deterministic and content-derived", () => {
  const args = { tenantId: "t1", period: "2026-05", ruleId: "r", sourceRecordIds: ["B", "A"] };
  assert.equal(computeFindingId(args), computeFindingId(Object.assign({}, args, { sourceRecordIds: ["A", "B"] })),
    "record order must not change identity");
  assert.notEqual(computeFindingId(args), computeFindingId(Object.assign({}, args, { tenantId: "t2" })),
    "different tenants produce different ids");
});

// ── 2. Finding validation ────────────────────────────────────────
test("[M3] a finding that cannot name its rule is rejected", () => {
  assert.throws(() => createFinding(Object.assign({}, baseFinding, { ruleId: undefined })), /requires ruleId/);
  assert.throws(() => createFinding(Object.assign({}, baseFinding, { ruleVersion: undefined })), /requires ruleVersion/);
  assert.throws(() => createFinding(Object.assign({}, baseFinding, { category: "made_up" })), /unknown category/);
  assert.throws(() => createFinding(Object.assign({}, baseFinding, { severity: "catastrophic" })), /unknown severity/);
  assert.throws(() => createFinding(Object.assign({}, baseFinding, { title: "" })), /requires a title/);
  assert.throws(() => createFinding(Object.assign({}, baseFinding, { confidence: 1.5 })), /within 0\.\.1/);
});

// ── 3. Evidence validation ───────────────────────────────────────
test("[M4] evidence preserves machine-readable provenance, not prose", () => {
  const e = createEvidence({
    label: "Duplicate side A", sourceSystem: "zoho-books", sourceRecordId: "INV-1",
    recordType: "invoice", relationship: "matched", field: "amount", value: 48500,
    fields: { date: "2026-05-11", counterparty: "Rivera" }
  });
  assert.equal(e.sourceSystem, "zoho-books");
  assert.equal(e.sourceRecordId, "INV-1");
  assert.equal(e.recordType, "invoice");
  assert.equal(e.relationship, "matched");
  assert.equal(e.field, "amount");
  assert.equal(e.value, 48500);
  assert.equal(e.fields.date, "2026-05-11");
  assert.throws(() => createEvidence({ sourceRecordId: "X" }), /requires a label/);
});

// ── 5. Categories are distinct ───────────────────────────────────
test("[M5] all six categories exist and data-quality is separated", () => {
  ["anomaly", "data_quality", "business_risk", "control_weakness", "duplicate", "fraud_indicator"]
    .forEach((c) => assert.ok(Object.values(CATEGORY).includes(c), `missing category ${c}`));

  const dq = createFinding(Object.assign({}, baseFinding, { category: CATEGORY.DATA_QUALITY, severity: SEVERITY.LOW, title: "Missing field" }));
  const biz = createFinding(Object.assign({}, baseFinding, { category: CATEGORY.ANOMALY, severity: SEVERITY.MEDIUM, title: "Unusual" }));
  assert.equal(dq.isDataQuality, true);
  assert.equal(biz.isDataQuality, false);
  assert.equal(businessFindings([dq, biz]).length, 1);
  assert.equal(dataQualityFindings([dq, biz]).length, 1);
});

test("[M6] fraud/duplicate findings use cautious language, never an accusation", () => {
  const run = engine.analyze(scenarios.duplicatePayment, { tenantId: "t", period: "2026-05", now: NOW });
  const cautious = run.findings.filter((f) => REQUIRES_CAUTIOUS_LANGUAGE.includes(f.category));
  assert.ok(cautious.length > 0, "the fixture produces at least one such finding");
  cautious.forEach((f) => {
    const text = `${f.title} ${f.description}`.toLowerCase();
    ["fraud detected", "fraudulent", "is fraud", "confirmed fraud", "theft"].forEach((phrase) => {
      assert.equal(text.includes(phrase), false, `accusatory phrase "${phrase}" in: ${f.title}`);
    });
  });
  const dup = run.findings.find((f) => f.category === CATEGORY.DUPLICATE);
  assert.match(dup.title, /possible/i, "duplicates are 'possible', never asserted");
});

// ── 4/5. Source record provenance ────────────────────────────────
test("[M7] normalized records require provenance", () => {
  assert.throws(() => records.createTransaction({ date: "2026-05-01", amount: 1 }), /missing sourceSystem/);
  assert.throws(() => records.createTransaction({ sourceSystem: "csv-upload", date: "2026-05-01", amount: 1 }), /missing sourceRecordId/);
  const tx = records.createTransaction({
    sourceSystem: "zoho-books", sourceRecordId: "INV-1", date: "2026-05-01",
    amount: -5000, currency: "KES", recordType: "invoice"
  });
  assert.equal(tx.direction, "inflow", "negative amount = inflow");
  assert.equal(tx.currency, "KES");
  assert.equal(tx.hasReceipt, null, "tri-state: unknown is not false");
});

test("[M8] batch validation reports invalid rows instead of dropping them silently", () => {
  const { valid, invalid } = records.validateTransactions([
    { sourceSystem: "csv-upload", sourceRecordId: "a", date: "2026-05-01", amount: 10 },
    { sourceSystem: "csv-upload", date: "2026-05-01", amount: 10 },       // no id
    { sourceSystem: "csv-upload", sourceRecordId: "c", date: "nope", amount: 10 } // bad date
  ]);
  assert.equal(valid.length, 1);
  assert.equal(invalid.length, 2);
  assert.match(invalid[0].reason, /sourceRecordId/);
  assert.match(invalid[1].reason, /invalid date/);
});

// ── CSV source ids ───────────────────────────────────────────────
test("[M9] CSV ids are content-derived, stable under reordering", () => {
  const a = parseFinancialCsv({ csvText: "date,description,amount\n2026-05-03,Office stock,-4200\n2026-05-09,Client payment,15000\n", period: "2026-05" });
  const b = parseFinancialCsv({ csvText: "date,description,amount\n2026-05-09,Client payment,15000\n2026-05-03,Office stock,-4200\n", period: "2026-05" });
  const idFor = (out, desc) => out.transactions.find((t) => t.description === desc).sourceRecordId;
  assert.equal(idFor(a, "Client payment"), idFor(b, "Client payment"),
    "reordering the file must not re-attribute a record");
  assert.notEqual(idFor(a, "Client payment"), idFor(a, "Office stock"));
});

test("[M10] genuinely identical CSV rows keep distinct ids", () => {
  const out = parseFinancialCsv({
    csvText: "date,description,amount\n2026-05-03,Rent,-4200\n2026-05-03,Rent,-4200\n", period: "2026-05" });
  const ids = out.transactions.map((t) => t.sourceRecordId);
  assert.equal(new Set(ids).size, 2, "a true duplicate payment is two records, not one");
  assert.match(ids[1], /:2$/, "the occurrence index disambiguates deterministically");
});

// ── 6. Duplicate evidence names BOTH records ─────────────────────
test("[M11] a duplicate finding identifies both records and the matching criteria", () => {
  const run = engine.analyze(scenarios.duplicatePayment, { tenantId: "t", period: "2026-05", now: NOW });
  const dup = run.findings.find((f) => f.ruleId === "duplicate_payment");
  assert.equal(dup.evidence.length, 2, "BOTH sides retained");
  assert.equal(dup.sourceRecordIds.length, 2);
  dup.evidence.forEach((e) => {
    assert.equal(e.relationship, "matched");
    assert.ok(e.fields.date && e.fields.amount, "the compared values travel with the evidence");
  });
  assert.deepEqual([...dup.matchCriteria.fields].sort(), ["account", "amount", "counterparty", "date"]);
  assert.equal(dup.matchCriteria.comparison, "equals");
});

// ── 7. Metrics ───────────────────────────────────────────────────
test("[M12] a metric records what computed it and is never AI-sourced", () => {
  const m = createMetric({ key: METRIC.REVENUE_TOTAL, value: 900000, unit: "currency", currency: "KES", computedBy: "engine@2.0.0" });
  assert.equal(m.available, true);
  assert.equal(m.computedBy, "engine@2.0.0");
  assert.throws(() => createMetric({ key: "x", value: 1 }), /requires computedBy/);
  assert.throws(() => createMetric({ key: "x", value: NaN, computedBy: "e" }), /no finite value/);
});

test("[M13] an unavailable metric states WHY and never carries a value", () => {
  const u = unavailableMetric({ key: METRIC.CUSTOMER_TOP_SHARE_PCT, reason: UNAVAILABLE_REASON.NOT_ATTRIBUTABLE, computedBy: "engine@2.0.0" });
  assert.equal(u.available, false);
  assert.equal(u.value, null);
  assert.equal(u.reason, "not_attributable");
  assert.throws(() => unavailableMetric({ key: "x", reason: "because" }), /unknown unavailable reason/);
});

test("[M14] the engine's metrics distinguish measured from unmeasurable", () => {
  const d = engine.analyze(scenarios.healthy, { tenantId: "t", period: "2026-05", now: NOW });
  const byKey = d.metricsByKey;
  assert.equal(byKey[METRIC.TRANSACTION_COUNT].available, true);
  assert.equal(byKey[METRIC.TRANSACTION_COUNT].value, scenarios.healthy.transactions.length);
  // No attributable revenue in this fixture -> unavailable, NOT zero.
  assert.equal(byKey[METRIC.CUSTOMER_TOP_SHARE_PCT].available, false);
  assert.equal(byKey[METRIC.CUSTOMER_TOP_SHARE_PCT].value, null);
  assert.equal(byKey[METRIC.CUSTOMER_TOP_SHARE_PCT].reason, UNAVAILABLE_REASON.NOT_ATTRIBUTABLE);
  d.metrics.forEach((m) => assert.match(String(m.computedBy || "engine@"), /^engine@/));
});

// ── 8. Risk score ────────────────────────────────────────────────
test("[M15] unavailable components stay null and are excluded from the average", () => {
  const d = engine.analyze(scenarios.healthy, { tenantId: "t", period: "2026-05", now: NOW });
  const rs = d.riskScore;
  assert.equal(rs.available, true);
  assert.equal(rs.components[COMPONENT.CUSTOMER_RISK], null, "never an invented 72");
  assert.ok(!rs.measuredComponents.includes(COMPONENT.CUSTOMER_RISK));
  assert.ok(rs.weightCovered < 1, "weights renormalised over what was measurable");
  assert.ok(unavailableComponents(rs).includes(COMPONENT.CUSTOMER_RISK));
  assert.ok(rs.calculation, "the arithmetic is inspectable");
});

test("[M16] a risk score with insufficient evidence is Unknown, not zero", () => {
  const d = engine.analyze(scenarios.emptyResponse, { tenantId: "t", period: "2026-05", now: NOW });
  assert.equal(d.riskScore.available, false);
  assert.equal(d.riskScore.overall, null);
  assert.equal(d.riskScore.category, "Unknown");
  assert.ok(d.riskScore.unavailableReason);
});

test("[M17] the RiskScore contract refuses contradictory input", () => {
  assert.throws(() => createRiskScore({ overall: 50, scoringVersion: undefined }), /requires scoringVersion/);
  assert.throws(() => createRiskScore({ available: true, overall: null, scoringVersion: "1" }), /requires a finite overall/);
  assert.throws(() => createRiskScore({ available: false, overall: 50, scoringVersion: "1" }), /must have overall = null/);
});

// ── 9. Analysis run contract ─────────────────────────────────────
test("[M18] an analysis run records engine and rule versions", () => {
  const d = engine.analyze(scenarios.duplicatePayment, { tenantId: "t1", period: "2026-05", now: NOW });
  const ar = d.analysisRun;
  ["analysisRunId", "tenantId", "financialPeriod", "status", "engineVersion", "ruleVersions",
   "dataQuality", "startedAt", "completedAt"].forEach((k) => assert.ok(k in ar, `missing ${k}`));
  assert.equal(ar.status, STATUS.COMPLETED);
  assert.equal(ar.tenantId, "t1");
  assert.ok(ar.ruleVersions.duplicate_payment);
});

test("[M19] a failed analysis run must record an error", () => {
  assert.throws(() => createAnalysisRun({
    analysisRunId: "r1", engineVersion: "2.0.0", status: STATUS.FAILED, startedAt: new Date().toISOString()
  }), /must record an error/);
});

// ── Guard: no legacy prose-triple findings in production code ────
test("[M20] production code no longer constructs bare {type, severity, description} findings", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const offenders = [];
  function scan(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { scan(full); continue; }
      if (!entry.name.endsWith(".js")) continue;
      // The legacy adapter is the one sanctioned place that emits the old shape.
      if (full.includes(path.join("domain", "adapters"))) continue;
      const src = fs.readFileSync(full, "utf-8");
      // A findings array literal built from only type/severity/description.
      const re = /items\.push\(\{\s*\n?\s*type:[^}]*severity:[^}]*description:[^}]*\}\)/g;
      if (re.test(src)) offenders.push(path.relative(process.cwd(), full));
    }
  }
  scan(path.resolve(__dirname, "../../src"));
  assert.deepEqual(offenders, [], `legacy finding construction remains in: ${offenders.join(", ")}`);
});

/* ── A RECOVERED STATEMENT IS NOT A FAILED ONE ─────────────────────
   Reported from production: Zoho was connected and pulling June (14
   transactions, 2026-06-02 → 2026-06-25), and June still could not be
   analysed.

   Zoho refused the Cash Flow *report* endpoint — "We couldn't find any
   resource for the given ID" — while serving every transaction underneath it.
   The source already handled that: it computed the statement from those
   transactions and recorded it in meta.statementsDerived. But the quality
   assessor stamped the dataset FAILED purely because its name was in
   fetchFailures, without ever checking whether a value had been produced. One
   FAILED dataset forces level = FAILED, FAILED is in BLOCKS_SCORING, and the
   month was refused.

   The user's data was fine. One optional report was unavailable, and the app
   discarded the month. */

const { assessDataQuality: assessQ, LEVEL: QLEVEL } =
  require("../../src/domain/model/dataQuality");

/** A June-shaped dataset: transactions retrieved, cash flow derived. */
function juneLikeData({ derived = true } = {}) {
  return {
    period: "2026-06",
    transactions: [
      { sourceRecordId: "z1", date: "2026-06-02", amount: -120000, counterparty: "Mwangi Ltd" },
      { sourceRecordId: "z2", date: "2026-06-25", amount: 340000, counterparty: "BigCo" }
    ],
    reconciliations: [{ sourceRecordId: "z1", isReconciled: true }],
    statements: {
      cashFlow: { inflow: 340000, outflow: 120000 },
      profitAndLoss: { revenue: 340000, netProfit: 220000 },
      balanceSheet: { cashAndEquivalents: 500000, cashAndEquivalentsBasis: "observed" }
    },
    meta: {
      source: "zoho-books",
      fetchedAt: new Date().toISOString(),
      statementsDerived: derived ? { cashFlow: true } : {}
    }
  };
}

test("[DQ-R1] a statement rebuilt from transactions does not fail the month", () => {
  const q = assessQ(juneLikeData(), { fetchFailures: ["statements.cashFlow"] });

  assert.notEqual(q.level, QLEVEL.FAILED,
    "the month is analysable: the transactions were all retrieved");
  assert.equal(q.scoringReliable, true,
    "and a risk score may be presented — this is what was blocking June");
  assert.deepEqual(q.failed, [], "nothing actually failed to produce a value");
  assert.deepEqual(q.recovered, ["statements.cashFlow"],
    "the recovery is recorded as its own fact");
});

test("[DQ-R2] but it is never presented as fully observed", () => {
  const q = assessQ(juneLikeData(), { fetchFailures: ["statements.cashFlow"] });

  assert.equal(q.level, QLEVEL.PARTIAL, "weaker evidence than a retrieved statement");
  assert.equal(q.datasets["statements.cashFlow"], QLEVEL.PARTIAL,
    "the dataset itself is not COMPLETE");
  assert.equal(q.hasDerivedInputs, true);

  const disclosed = q.derivedInputs.find((d) => d.input === "statements.cashFlow");
  assert.ok(disclosed, "it appears in the disclosure list");
  assert.equal(disclosed.basis, "derived_from_transactions");
  assert.match(disclosed.detail, /computed from the\s*\n?\s*transactions/,
    "and says plainly where the number came from");

  assert.match(q.summary, /Computed from transactions/,
    "the summary states the derivation");
  assert.equal(/Missing: \./.test(q.summary), false,
    "and does not print an empty Missing list");
});

test("[DQ-R3] a failure with NOTHING to replace it is still a failure", () => {
  /* The distinction the fix turns on. If the report could not be retrieved AND
     nothing was derived, the month genuinely cannot be analysed for that area,
     and saying otherwise would be the opposite lie. */
  const data = juneLikeData({ derived: false });
  delete data.statements.cashFlow;

  const q = assessQ(data, { fetchFailures: ["statements.cashFlow"] });
  assert.equal(q.level, QLEVEL.FAILED, "no value was produced");
  assert.deepEqual(q.failed, ["statements.cashFlow"]);
  assert.deepEqual(q.recovered, []);
  assert.equal(q.scoringReliable, false);
});

test("[DQ-R4] a claimed derivation with no value is not accepted", () => {
  /* meta.statementsDerived must not be able to launder an absent statement
     into a recovered one. The VALUE has to be there. */
  const data = juneLikeData({ derived: true });
  delete data.statements.cashFlow;

  const q = assessQ(data, { fetchFailures: ["statements.cashFlow"] });
  assert.equal(q.level, QLEVEL.FAILED,
    "a derivation flag without a derived value is still a failure");
  assert.deepEqual(q.recovered, []);
});

test("[DQ-R5] an unrelated failure is unaffected by the derivation path", () => {
  const q = assessQ(juneLikeData(), { fetchFailures: ["reconciliations"] });
  assert.equal(q.level, QLEVEL.FAILED, "reconciliations were not derived");
  assert.deepEqual(q.failed, ["reconciliations"]);
});
