// Adapter: domain AnalysisRun -> the legacy `analysis` shape.
//
// WHY THIS EXISTS
// Until JOB 6 the product ran TWO complete financial engines side by side:
//   * src/services/riskEngine.js  — v1, produced { detections, cashFlowRisk,
//     earlyWarnings } and still fed the executive report, the follow-up SLA and
//     the skill responses;
//   * src/domain/analysis/engine.js — v2, produced Findings with evidence and
//     fed the dashboard.
// They disagreed. v1's duplicate rule keyed on `counterparty || description`
// (a documented false-positive source), defaulted an uncomputable runway to 12
// months, and scored data-quality gaps as fraud pressure. Two numbers for the
// same month, both shipped, is exactly what the audit called out.
//
// riskEngine.js is deleted. Its OUTPUT SHAPE survives here, projected from the
// v2 run, so reportBuilder / followUpWorkflow / the skill responses keep working
// while there is only ONE calculation. Every number below is read from the
// domain run — nothing is recomputed.
//
// This file is temporary in the same sense legacyContext.js is: when those
// consumers are migrated to read Findings directly, delete it.

const { CATEGORY } = require("../model/finding");

/** Findings for a rule, in the order the engine produced them. */
const byRule = (run, ruleId) => run.findings.filter((f) => f.ruleId === ruleId);

/**
 * The legacy `detections` buckets.
 *
 * Each bucket is derived from the FINDINGS the engine emitted, so a bucket is
 * non-empty exactly when a finding exists. Consumers only ever read `.length`
 * (see reportBuilder.js) plus the duplicate pairs (see customRules.js), so the
 * entries carry the finding itself rather than a reconstructed transaction.
 */
function toLegacyDetections(run) {
  const duplicates = byRule(run, "duplicate_payment").map((f) => ({
    // customRules reads .original/.duplicate to avoid re-detecting duplicates.
    original: f.evidence[0] ? f.evidence[0].fields : null,
    duplicate: f.evidence[1] ? f.evidence[1].fields : null,
    // Additive: what the v1 pair could never carry.
    findingId: f.findingId,
    confidence: f.confidence,
    matchedFields: f.matchCriteria ? f.matchCriteria.fields : null,
    sourceRecordIds: f.sourceRecordIds
  }));

  const evidenceFields = (ruleId) =>
    byRule(run, ruleId).map((f) => Object.assign(
      {}, f.evidence[0] ? f.evidence[0].fields : {}, { findingId: f.findingId }));

  return {
    duplicates,
    roundNumbers: evidenceFields("round_number_payment"),
    unusualTransactions: evidenceFields("statistical_outlier"),
    mixedFunds: evidenceFields("mixed_personal_business"),
    unreconciledAccounts: evidenceFields("unreconciled_account"),
    overdueReceivables: evidenceFields("overdue_receivable"),
    overduePayables: evidenceFields("overdue_payable"),
    missingReceipts: evidenceFields("missing_receipt"),
    missingTransactionFields: evidenceFields("missing_transaction_fields"),
    missingJournalFields: evidenceFields("missing_journal_references")
  };
}

/**
 * The legacy `cashFlowRisk` block.
 *
 * BEHAVIOUR CHANGE, deliberate: `runwayMonths` is now null when it cannot be
 * computed. v1 substituted 12, which made a month with no statements read as
 * "a year of runway" in the executive report.
 */
function toLegacyCashFlowRisk(run) {
  const c = run.calculations.cashflow;
  return {
    riskScore: c.risk_score,
    severity: c.risk_level,
    netCashFlow: c.net_cash_flow,
    runwayMonths: c.cash_runway_months,
    neverDepletes: c.never_depletes,
    overdueReceivablesTotal: c.overdue_receivables == null ? null : Math.round(c.overdue_receivables),
    // Additive: the arithmetic behind the score.
    calculation: c.risk_calculation
  };
}

/**
 * Early warnings.
 *
 * v1 emitted a fixed sentence per non-empty detection bucket. That is preserved,
 * but a warning is now raised only for BUSINESS findings plus the two control
 * gaps v1 warned about — a data-quality gap no longer produces a warning that
 * reads as a business risk.
 */
function toLegacyEarlyWarnings(run) {
  const warnings = [];
  const has = (ruleId) => run.findings.some((f) => f.ruleId === ruleId);

  if (run.calculations.cashflow.risk_level === "high") {
    warnings.push("Cash flow is in high-risk zone. Review burn rate and upcoming obligations this week.");
  }
  if (has("statistical_outlier")) {
    warnings.push("Unusual high-value transactions detected. Verify approvals and source documents.");
  }
  if (has("duplicate_payment")) {
    warnings.push("Possible duplicate transactions found. Confirm if any expenses were recorded twice.");
  }
  if (has("unreconciled_account")) {
    warnings.push("Some accounts are not reconciled. Reconciliation gaps can hide reporting errors.");
  }
  if (has("overdue_receivable")) {
    warnings.push("Overdue customer invoices detected. Follow up to protect near-term cash flow.");
  }
  if (has("missing_receipt")) {
    warnings.push("Some expenses are missing receipts. Weak documentation hurts audit readiness.");
  }
  return warnings;
}

/**
 * Project a domain run onto the legacy analysis shape.
 * @param {object} run output of domain/analysis/engine.analyze
 */
function toLegacyAnalysis(run) {
  const analysis = {
    detections: toLegacyDetections(run),
    cashFlowRisk: toLegacyCashFlowRisk(run),
    earlyWarnings: toLegacyEarlyWarnings(run),

    // ── Additive: the authoritative contracts, so a consumer being migrated can
    // read them without a second analysis. ──
    analysisRunId: run.analysisRunId,
    period: run.period,
    engineVersion: run.engineVersion,
    findings: run.findings,
    riskScore: run.riskScore,
    metrics: run.metrics,
    dataQuality: run.quality
  };
  // The run itself, non-enumerable so it never lands in a JSON response. This
  // lets buildContext() reuse the analysis that already happened instead of
  // running the engine a second time on the same data.
  Object.defineProperty(analysis, "run", { value: run, enumerable: false });
  return analysis;
}

module.exports = { toLegacyAnalysis, toLegacyDetections, toLegacyCashFlowRisk, toLegacyEarlyWarnings, CATEGORY };
