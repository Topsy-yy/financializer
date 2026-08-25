// Adapter: domain AnalysisRun -> the legacy `context` shape consumed by
// src/routes/api.js and public/app.js.
//
// WHY AN ADAPTER: the deterministic engine is now the single source of truth,
// but the 4,600-line frontend reads a specific response contract. Rewriting both
// at once would be one large, unverifiable change. This adapter lets the ENGINE
// migrate immediately (bugs fixed, evidence attached, versions stamped) while
// the wire format stays compatible, and it ADDS the new capabilities as extra
// fields rather than removing anything.
//
// This file is intentionally the ONLY place that knows the legacy shape, so
// deleting it later removes the compatibility layer in one step.
//
// Where behaviour legitimately changed, the legacy field now carries an honest
// value (null / empty) rather than the fabricated one:
//   * customers: no invented "BlueTech" rows -> customer_list is []
//   * cashflow.overdue_receivables: null when not measured (never estimated)
//   * health.overall_score: null when data is insufficient to score

const { CATEGORY } = require("../model/finding");

/** Legacy anomaly item: {type, severity, description} — plus new, additive fields. */
function toLegacyAnomalyItem(f) {
  return {
    type: f.ruleId,
    severity: f.severity,
    description: f.description || f.title,
    // Additive: everything the old shape could not express.
    id: f.findingId,
    finding_id: f.findingId,
    category: f.category,
    title: f.title,
    metric: f.metric,
    value: f.observedValue,
    observed_value: f.observedValue,
    threshold: f.threshold,
    confidence: f.confidence,
    calculation: f.calculation,
    match_criteria: f.matchCriteria,
    rule_id: f.ruleId,
    rule_version: f.ruleVersion,
    source_record_ids: f.sourceRecordIds,
    evidence: f.evidence,
    is_data_quality: f.isDataQuality
  };
}

function toLegacyCashflow(run) {
  const c = run.calculations.cashflow;
  const findings = run.findings.filter((f) => f.ruleId === "cashflow_runway");
  return {
    available: c.available,
    cash_runway: c.runway_days,
    runway_days: c.runway_days,
    cash_runway_months: c.cash_runway_months,
    never_depletes: c.never_depletes,
    risk_level: c.risk_level,
    risk_score: c.risk_score,          // now populated (was the dead branch)
    net_cash_flow: c.net_cash_flow,
    monthly_burn: c.monthly_burn,
    cash_on_hand: c.cash_on_hand,
    /* WHY A FIGURE IS MISSING, carried through to the user (JOB 13 Phase C).
       This adapter mapped `cash_on_hand` and dropped every provenance field, so
       the dashboard rendered an unexplained blank where the engine had a precise
       reason: "no cash balance was supplied, and the estimate derived from net
       income is not a cash position". An unexplained blank invites the reader to
       assume zero, which is the outcome all of this exists to prevent.
       ADDITIVE -- no existing field changes name or meaning. */
    cash_on_hand_basis: c.cash_on_hand_basis,
    cash_on_hand_available: c.cash_on_hand_available,
    cash_on_hand_unavailable_reason: c.cash_on_hand_unavailable_reason,
    cash_estimate: c.cash_estimate,
    cash_estimate_basis: c.cash_estimate_basis,
    cash_runway_unavailable_reason: c.cash_runway_unavailable_reason,
    liquidity_ratio: c.cash_on_hand != null && c.outflow > 0
      ? (c.cash_on_hand / c.outflow).toFixed(2)
      : "—",
    overdue_receivables: c.overdue_receivables,
    overdue_receivables_measured: c.overdue_receivables_measured,
    findings: findings.map((f) => ({ severity: f.severity, description: f.description })),
    recommendations: findings.length
      ? ["Review the runway finding below and prioritise collections."]
      : [],
    skills: ["cashflow-risk-analyzer"]
  };
}

function toLegacyConcentration(conc, run, kind) {
  const ruleId = kind === "vendor" ? "vendor_concentration" : "customer_concentration";
  const findings = run.findings.filter((f) => f.ruleId === ruleId);
  const list = conc.available ? conc.parties : [];
  const top = conc.available ? conc.top_party : null;

  const base = {
    available: conc.available,
    // When unavailable this is null, NOT a fabricated 72.
    [`${kind}_risk_score`]: conc.risk_score,
    concentration: {
      [kind === "vendor" ? "top_vendor" : "top_customer"]: top,
      top_3_percentage: conc.top_three_share_pct,
      [kind === "vendor" ? "total_vendors" : "total_customers"]: list.length,
      [kind === "vendor" ? "total_spend" : "total_revenue"]: conc.total
    },
    [`${kind}_list`]: list,
    [kind === "vendor" ? "top_vendor" : "top_customer"]: top,
    [kind === "vendor" ? "top_vendor_share" : "top_customer_share"]: conc.top_share_pct,
    findings: findings.map((f) => ({ type: f.ruleId, severity: f.severity, description: f.description })),
    skills: kind === "vendor" ? ["vendor-dependency-detector"] : ["customer-concentration-detector"]
  };
  if (!conc.available) {
    // Explicit, honest reason instead of silently inventing data.
    base.unavailable_reason = conc.reason;
    base.unattributed_amount = conc.unattributed_amount;
    // When the reason is MIXED CURRENCY the parts are still known, so they are
    // carried through. A client that cannot show one combined figure can still
    // show the per-currency totals rather than nothing.
    if (conc.by_currency) {
      base.by_currency = conc.by_currency;
      base.currencies = conc.currencies;
      base.currency_note = conc.currency_note;
    }
  }
  base.currency = conc.currency || null;
  base.currency_basis = conc.currency_basis || null;
  return base;
}

/**
 * Build the legacy context from a domain AnalysisRun.
 *
 * @param {object} run     output of domain/analysis/engine.analyze
 * @param {object} extras  { report, followUp, onchain, aiInsights }
 */
function toLegacyContext(run, extras = {}) {
  const anomalyItems = run.findings.map(toLegacyAnomalyItem);
  const businessItems = anomalyItems.filter((i) => !i.is_data_quality);

  const health = {
    overall_score: run.riskScore.available ? run.riskScore.overall : null,
    risk_category: run.riskScore.category,
    summary: run.riskScore.summary,
    component_scores: run.riskScore.components,
    // Additive: the audit's "why is it 78?" question is now answerable.
    available: run.riskScore.available,
    component_weights: run.riskScore.weights,
    measured_components: run.riskScore.measuredComponents,
    weight_covered: run.riskScore.weightCovered,
    weakest_component: run.riskScore.weakestComponent,
    unavailable_reason: run.riskScore.unavailableReason,
    scoring_version: run.riskScore.scoringVersion,
    calculation: run.riskScore.calculation,
    skills: ["financial-health-scorer"]
  };

  const cashflow = toLegacyCashflow(run);
  const revenue = {
    available: run.calculations.revenue.available,
    total_revenue: run.calculations.revenue.total_revenue,
    growth_rate: run.calculations.revenue.growth_rate,
    direction: run.calculations.revenue.direction,
    prior_period_revenue: run.calculations.revenue.prior_period_revenue,
    findings: [],
    trends: [],
    skills: ["revenue-intelligence"]
  };

  const vendors = toLegacyConcentration(run.calculations.vendors, run, "vendor");
  const customers = toLegacyConcentration(run.calculations.customers, run, "customer");

  const actionItems = Array.isArray(extras.followUp && extras.followUp.actions)
    ? extras.followUp.actions.map((a) => ({
      priority: a.priority || "normal",
      task: a.task,
      owner: a.owner,
      due: `${a.dueInDays} days`,
      status: "Pending"
    }))
    : [];

  const aiSummary =
    (extras.report && extras.report.summary && (extras.report.summary.founderSummary || []).join("\n")) ||
    (extras.report && extras.report.summary && extras.report.summary.headline) ||
    run.riskScore.summary;

  return {
    period: run.period,
    health,
    cashflow,
    revenue,
    anomalies: { items: anomalyItems, skills: ["fraud-and-errors-detector"] },
    vendors,
    customers,
    onchain: extras.onchain || { scope: "unavailable", count: 0, items: [] },
    actions: { actions: actionItems, skills: ["followup-orchestrator", "recommendation-engine"] },
    reports: { report: extras.report || {}, followUp: extras.followUp || {} },

    // ── New, additive: the capabilities the legacy shape could not carry ──
    analysis_run_id: run.analysisRunId,
    engine_version: run.engineVersion,
    rule_versions: run.ruleVersions,
    input_hash: run.inputHash,
    data_source: run.dataSource,
    data_quality: run.quality,
    data_quality_detail: run.dataQuality,
    findings: run.findings,
    findings_summary: run.summary,
    // The authoritative Metric[] the engine emits, carried through so a client
    // can read a number together with what computed it.
    metrics: run.metrics,
    risk_score: run.riskScore,

    overview: {
      health_score: health.overall_score,
      health_available: run.riskScore.available,
      // ── Reproducibility (mandate §15), carried into the payload the client
      // actually receives so a displayed number can always be traced back to
      // the exact run, engine build and rule set that produced it. ──
      analysis_run_id: run.analysisRunId,
      engine_version: run.engineVersion,
      rule_versions: run.ruleVersions,
      input_hash: run.inputHash,
      data_source: run.dataSource,
      methodology: run.methodology || null,
      cashflow,
      risk: { items: businessItems },
      revenue,
      onchain: extras.onchain || { scope: "unavailable", count: 0, items: [] },
      findings: businessItems,
      data_quality: run.quality,
      ai_summary: aiSummary,
      pending_actions: actionItems.length,
      skills: ["financial-health-scorer", "financial-controller-core"]
    }
  };
}

module.exports = { toLegacyContext, toLegacyAnomalyItem };
