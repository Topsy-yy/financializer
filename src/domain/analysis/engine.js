// THE deterministic financial analysis engine.
//
// PURITY CONTRACT (enforced mechanically by tests/domain/purity.test.js):
//   no http · no express · no fs · no database · no AI · no provider imports
//
// PIPELINE (the dependency direction is one-way and must stay that way):
//
//   normalized records
//        -> calculators        pure arithmetic, no findings
//        -> metrics            authoritative values with provenance
//        -> detectors          findings + evidence, no arithmetic of their own
//        -> risk aggregation   one weighting, one set of bands
//        -> RiskScore
//
// The engine emits the domain contracts DIRECTLY — Metric, Finding,
// FindingEvidence, RiskScore, AnalysisRun. JOB 5's engineResult.js adapter,
// which derived them after the fact, was deleted in JOB 6.
//
// The AI layer consumes this output. It never produces it.

const crypto = require("crypto");

const { computeCashflow } = require("../calculators/cashflow");
const { computeRevenue } = require("../calculators/revenue");
const { computeExpenses } = require("../calculators/expense");
const { computeConcentration, publicConcentration } = require("../calculators/concentration");

const { runDetectors, runMetricDetectors } = require("./detectors");
const { buildMetrics } = require("./metricSet");
const { aggregateRisk, summarizeDataQuality } = require("./riskAggregation");

const { assessDataQuality } = require("../model/dataQuality");
const { businessFindings, dataQualityFindings, maxSeverity } = require("../model/finding");
const { toMetricMap } = require("../model/metric");
const { createAnalysisRun, STATUS } = require("../model/analysisRun");
const { ENGINE_VERSION, ruleVersions, materiality: materialityPolicy } = require("../rules/registry");
const { analyzeCurrency } = require("../rules/currency");
const evidenceCoverage = require("../rules/evidenceCoverage");

/**
 * Stable hash of the analysed input, so a run can be tied to the exact dataset
 * that produced it and an identical re-run can be recognised.
 */
function hashInput(data) {
  const canonical = JSON.stringify({
    period: data.period || null,
    transactions: (data.transactions || []).map((t) => [t.date, t.amount, t.counterparty, t.description]),
    journalEntries: (data.journalEntries || []).map((j) => [j.date, j.amount, j.debitAccount, j.creditAccount]),
    reconciliations: (data.reconciliations || []).map((r) => [r.accountName, r.isReconciled, r.amount]),
    statements: data.statements || {},
    receivables: (data.receivables || []).map((r) => [r.customer, r.amount, r.balance, r.dueDate]),
    payables: (data.payables || []).map((p) => [p.vendor, p.amount, p.balance, p.dueDate])
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * The currency the period is reported in.
 *
 * Currency is PRESERVED, never converted. A period whose records disagree
 * carries NO currency label rather than being labelled with one of them — see
 * domain/rules/currency.js for the policy and the multi-currency scenario.
 */
function resolveCurrency(data) {
  return analyzeCurrency(data.transactions).currency;
}

/**
 * Run a full deterministic analysis.
 *
 * @param {object} data normalized monthly dataset
 * @param {object} ctx
 *   tenantId       {string}
 *   period         {string}   YYYY-MM
 *   now            {number}   epoch ms — INJECTED so runs are reproducible.
 *                             v1 called new Date() inside the engine, so
 *                             re-running a historical month produced different
 *                             findings.
 *   reviewHistory  {array}    prior periods, for growth comparison
 *   ownerKeywords  {string[]}
 *   analysisRunId  {string}
 *   fetchFailures  {string[]} datasets whose retrieval failed
 */
/**
 * How many times this process has actually run an analysis.
 *
 * WHY A COUNTER LIVES IN THE ENGINE. Restart recovery must load a stored run,
 * not quietly recompute one — a recomputation would run against TODAY's rules
 * and the now-absent period inputs, producing a different answer while
 * presenting itself as the original. "It returned the right numbers" cannot
 * distinguish those two cases, so the tests need to observe the engine itself.
 *
 * This is an observation counter only: it is never read by production logic,
 * and nothing branches on it. Exposed via `analysisCount()` and reset in tests.
 */
let ANALYSIS_INVOCATIONS = 0;

/** How many analyses this process has run. */
function analysisCount() { return ANALYSIS_INVOCATIONS; }

/** Test hook: zero the counter before an assertion window. */
function resetAnalysisCount() { ANALYSIS_INVOCATIONS = 0; }

function analyze(data, ctx = {}) {
  ANALYSIS_INVOCATIONS += 1;
  const nowMs = ctx.now == null ? Date.now() : ctx.now;
  const startedAt = new Date(nowMs).toISOString();
  const input = data || {};
  const period = ctx.period || input.period || null;
  const runId = ctx.analysisRunId || ("run_" + crypto.randomBytes(8).toString("hex"));
  const context = Object.assign({}, ctx, { period, analysisRunId: runId, now: nowMs });

  // 1. DATA QUALITY FIRST — it decides whether scoring is meaningful at all.
  const dataQuality = assessDataQuality(input, {
    fetchFailures: ctx.fetchFailures,
    now: nowMs,
    fetchedAt: ctx.fetchedAt
  });

  // 2. MATERIALITY — resolved ONCE per run, from the registry's methodology,
  //    and passed to every rule that needs a significance threshold. Depends on
  //    the currency the records are in and the size of this business's own
  //    activity, so no detector can hardcode "10,000".
  const periodCurrency = analyzeCurrency(input.transactions);
  const provisionalOutflow = (input.statements && input.statements.cashFlow
    && input.statements.cashFlow.outflow) || null;
  const materiality = materialityPolicy.resolveMateriality({
    currency: periodCurrency.currency,
    periodOutflow: periodCurrency.aggregatable ? provisionalOutflow : null,
    sampleSize: (input.transactions || []).length,
    override: ctx.materialityOverride || null
  });
  context.materiality = materiality;

  // PER-CURRENCY materiality. A period holding both KES and USD records has no
  // single significance threshold: 10,000 is routine in one and substantial in
  // the other. Each record is judged against the threshold for ITS OWN currency,
  // which is the whole point of making materiality currency-aware.
  const byCurrency = new Map();
  periodCurrency.byCurrency.forEach((bucket) => {
    byCurrency.set(bucket.currency, materialityPolicy.resolveMateriality({
      currency: bucket.currency,
      // The relative floor uses that currency's own volume, not the period's.
      periodOutflow: bucket.total,
      sampleSize: bucket.count,
      override: ctx.materialityOverride || null
    }));
  });
  context.materialityFor = (code) => {
    const key = code ? String(code).toUpperCase() : null;
    return byCurrency.get(key) || materiality;
  };
  const materialityByCurrency = Object.freeze(
    Array.from(byCurrency.entries()).map(([code, m]) => Object.freeze({ currency: code, ...m })));

  // 3. CALCULATORS — pure arithmetic. No findings produced here.
  const calculations = {
    cashflow: computeCashflow(input, context),
    revenue: computeRevenue(input, context),
    expenses: computeExpenses(input),
    vendors: computeConcentration(input, context, "vendor"),
    customers: computeConcentration(input, context, "customer")
  };

  // 4. DETECTORS — record-level and metric-derived. Findings carry evidence.
  const findings = []
    .concat(runDetectors(input, context), runMetricDetectors(calculations, context))
    .map((f) => Object.freeze(Object.assign({}, f, { analysisRunId: runId })));

  // 5. EVIDENCE COVERAGE — which rules could actually RUN against this dataset.
  //    A rule that could not run has not "found nothing"; it has not looked.
  const applicability = evidenceCoverage.assessRuleApplicability(input);
  const anomalyEvidence = evidenceCoverage.anomalyComponentMeasurable(input, ctx.coveragePolicy);

  // 6. RISK AGGREGATION — one implementation, one weighting, one coverage policy.
  const riskScore = aggregateRisk({
    cashflow: calculations.cashflow,
    revenue: calculations.revenue,
    vendors: calculations.vendors,
    customers: calculations.customers,
    findings,
    dataQuality,
    anomalyEvidence,
    coveragePolicy: ctx.coveragePolicy
  });
  const quality = summarizeDataQuality(findings, dataQuality);

  // 7. METRICS — authoritative values, each stamped with what computed it.
  const transactionCount = Array.isArray(input.transactions) ? input.transactions.length : null;
  const metrics = buildMetrics({
    calculations,
    findings,
    riskScore,
    engineVersion: ENGINE_VERSION,
    period,
    currency: periodCurrency.currency,
    transactionCount
  });

  const analysisRun = createAnalysisRun({
    analysisRunId: runId,
    tenantId: ctx.tenantId || null,
    financialPeriod: period,
    status: STATUS.COMPLETED,
    engineVersion: ENGINE_VERSION,
    ruleVersions: ruleVersions(),
    dataQuality: quality,
    dataSource: (input.meta && input.meta.source) || null,
    inputHash: hashInput(input),
    startedAt,
    completedAt: new Date(nowMs).toISOString()
  });

  const business = businessFindings(findings);
  const dq = dataQualityFindings(findings);

  return Object.freeze({
    // ── The domain contracts, emitted natively ──
    analysisRun,
    riskScore,
    metrics,
    metricsByKey: toMetricMap(metrics),
    findings,

    // ── Flattened run fields (same values, read directly by consumers) ──
    analysisRunId: runId,
    tenantId: ctx.tenantId || null,
    period,
    startedAt: analysisRun.startedAt,
    completedAt: analysisRun.completedAt,
    status: analysisRun.status,
    engineVersion: ENGINE_VERSION,
    ruleVersions: analysisRun.ruleVersions,
    inputHash: analysisRun.inputHash,
    dataSource: analysisRun.dataSource,

    dataQuality,
    quality,
    transactionCount,

    // ── Methodology actually applied to this run (mandate §15) ──
    // A historical run must be re-explainable, so it records not just WHICH
    // rules ran but the resolved configuration they ran with.
    methodology: Object.freeze({
      engineVersion: ENGINE_VERSION,
      ruleVersions: analysisRun.ruleVersions,
      materiality,
      materialityByCurrency,
      coveragePolicy: evidenceCoverage.resolvePolicy(ctx.coveragePolicy),
      currency: periodCurrency,
      rulesApplied: applicability.applicable,
      rulesNotApplicable: applicability.notApplicable,
      anomalyEvidence
    }),

    // ── Calculator output ──
    // The intermediate arithmetic behind the metrics above, retained because the
    // legacy API contract is shaped around it. `metrics` is the authoritative
    // representation; this is the same numbers, one step earlier.
    calculations: Object.freeze({
      cashflow: calculations.cashflow,
      revenue: calculations.revenue,
      expenses: calculations.expenses,
      vendors: publicConcentration(calculations.vendors),
      customers: publicConcentration(calculations.customers)
    }),

    summary: Object.freeze({
      total_findings: findings.length,
      business_findings: business.length,
      data_quality_findings: dq.length,
      worst_business_severity: maxSeverity(business),
      worst_data_quality_severity: maxSeverity(dq)
    })
  });
}

module.exports = {
  analyze, hashInput, resolveCurrency, ENGINE_VERSION,
  // Observation only — see ANALYSIS_INVOCATIONS above.
  analysisCount, resetAnalysisCount
};
