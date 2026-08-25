// THE risk aggregation. One implementation, one weighting, one set of bands.
//
// Before JOB 6 this formula existed FOUR times:
//   1. routes/api.js buildHealthSummary        (deleted in JOB 5)
//   2. services/whatIfSimulator.js             (now calls this module)
//   3. domain/analysis/scoring.js              (this file, renamed)
//   4. a third, already-drifted copy in the skill markdown
// They disagreed. §5 of the JOB 6 mandate requires exactly one.
//
// UNAVAILABLE COMPONENTS — the rule, stated once:
//   A component with no measurable input scores `null`, is EXCLUDED from the
//   weighted average, and the remaining weights are RENORMALISED over the
//   coverage that was actually measured. It is never defaulted to a number.
//   `weight_covered` reports what fraction of the model was scored, so a score
//   built on 45% of the inputs is visibly different from a complete one.
//
//   Rationale: substituting a value (whatIfSimulator used 60) asserts a
//   measurement that was never taken. Substituting 0 asserts the worst case.
//   Both are inventions; exclusion is the only honest option.
//
// FIXES CARRIED FORWARD from the audit, each with a regression test:
//   1. DEAD BRANCH. api.js read `cashflow.risk_score`, which nothing ever set,
//      so the 30%-weighted cash-flow component collapsed to one of three values
//      (100-80 / 100-55 / 100-25 => 20 / 45 / 75). It now consumes the real
//      continuous 0-100 score.
//   2. DATA-QUALITY CONTAMINATION. Every data-quality gap fed a component named
//      `fraud_indicators`, so an unreconciled account scored identically to a
//      duplicate payment. Data-quality findings are excluded and reported apart.
//   3. HARDCODED NARRATIVE. The summary asserted "strongest pressure from
//      cashflow and concentration risk" unconditionally. It is now derived.
//   4. UNKNOWN != FINE. See above.

const { HEALTH_SCORE } = require("../rules/registry");
const evidenceCoverage = require("../rules/evidenceCoverage");
const { businessFindings, dataQualityFindings, SEVERITY_RANK } = require("../model/finding");
const { createRiskScore } = require("../model/riskScore");
const { clamp } = require("../calculators/shared");

const COMPONENT_LABELS = {
  cash_flow: "cash flow",
  fraud_indicators: "anomaly signals",
  revenue_stability: "revenue stability",
  vendor_risk: "vendor concentration",
  customer_risk: "customer concentration"
};

/**
 * Anomaly pressure from BUSINESS findings only (fix #2).
 * Higher points = more pressure; the component score is its inverse.
 */
function anomalyPressure(findings) {
  const pts = HEALTH_SCORE.anomalyPoints;
  const total = businessFindings(findings)
    // JOB 7: ONLY engine-authored findings move the deterministic score. A
    // tenant's own rules are shown and persisted like any other finding, but a
    // user must not be able to change their own risk score by writing rules —
    // previously a custom rule matching 12 transactions added 12 items of
    // anomaly pressure to it.
    .filter((f) => (f.authorityScope || "engine") === "engine")
    .reduce((sum, f) => sum + (pts[f.severity] == null ? pts.default : pts[f.severity]), 0);
  return clamp(total, 0, 100);
}

function revenueComponent(revenue) {
  if (!revenue || !revenue.available || revenue.growth_rate == null) return null;
  const band = HEALTH_SCORE.revenueBands.find((b) => revenue.growth_rate >= b.minGrowthPct);
  return band ? band.score : null;
}

/** Invert a 0-100 risk score into a 0-100 health score, or null if unmeasured. */
function inverted(metric) {
  return metric && metric.available && metric.risk_score != null
    ? clamp(100 - metric.risk_score, 0, 100)
    : HEALTH_SCORE.unknownComponentScore;
}

/**
 * THE weighted-average primitive. Everything that produces an overall score —
 * the dashboard, the what-if simulator, any future scenario tool — calls this,
 * so two numbers presented side by side are always computed the same way.
 *
 * Components valued `null` are excluded and the weights renormalised.
 */
function weightedScore(components) {
  const weights = HEALTH_SCORE.weights;
  const measured = Object.keys(weights).filter((k) => components[k] != null);
  const covered = measured.reduce((sum, k) => sum + weights[k], 0);
  if (!measured.length || covered === 0) return { score: null, measured: [], covered: 0 };
  const raw = measured.reduce((sum, k) => sum + components[k] * weights[k], 0) / covered;
  return {
    score: Math.round(clamp(raw, 0, 100)),
    measured,
    covered: Number(covered.toFixed(2))
  };
}

function categoryFor(score) {
  const entry = HEALTH_SCORE.categories.find((c) => score >= c.minScore);
  return entry ? entry.label : "Critical";
}

/**
 * Derive the five component scores from calculator output plus findings.
 * Exported so the what-if simulator builds its components the same way.
 */
function componentScores({ cashflow, revenue, vendors, customers, findings = [], anomalyEvidence }) {
  return {
    cash_flow: inverted(cashflow),
    // EVIDENCE GATE (§10). "No anomalies found" only means something if there
    // were records to find them in. With nothing to inspect this component used
    // to compute a PERFECT 100, so a business was rewarded for having no data.
    // `anomalyEvidence` is resolved by the engine from the coverage policy;
    // when it is absent (a direct caller) the component is measured, preserving
    // the old behaviour for callers that pass their own components.
    fraud_indicators: anomalyEvidence && !anomalyEvidence.measurable
      ? null
      : clamp(100 - anomalyPressure(findings), 0, 100),
    revenue_stability: revenueComponent(revenue),
    vendor_risk: inverted(vendors),
    customer_risk: inverted(customers)
  };
}

/**
 * Aggregate calculator output and findings into THE authoritative RiskScore.
 *
 * @returns {object} a frozen RiskScore (see domain/model/riskScore.js)
 */
function aggregateRisk(input = {}) {
  const { findings = [], dataQuality, coveragePolicy } = input;
  const components = componentScores(input);
  const { score, measured, covered } = weightedScore(components);

  // THE evidence-coverage decision, delegated to the versioned policy in
  // domain/rules/evidenceCoverage.js rather than made with a literal here.
  const coverage = evidenceCoverage.assessCoverage({
    score,
    covered,
    measured,
    dataQualityReliable: !dataQuality || dataQuality.scoringReliable
  }, coveragePolicy);

  if (!coverage.sufficient) {
    return createRiskScore({
      available: false,
      overall: null,
      category: "Unknown",
      unavailableReason: coverage.reason,
      components,
      weights: HEALTH_SCORE.weights,
      measuredComponents: measured,
      weightCovered: covered,
      scoringVersion: HEALTH_SCORE.version,
      coveragePolicyVersion: coverage.policyVersion,
      summary: coverage.explanation,
      dataQualityFindings: dataQualityFindings(findings).length,
      businessFindings: businessFindings(findings).length
    });
  }

  const weakest = measured.slice().sort((a, b) => components[a] - components[b])[0];
  const strongest = measured.slice().sort((a, b) => components[b] - components[a])[0];
  const category = categoryFor(score);
  const partial = measured.length < Object.keys(components).length;
  const weights = HEALTH_SCORE.weights;

  return createRiskScore({
    available: true,
    overall: score,
    category,
    components,
    weights,
    measuredComponents: measured,
    weightCovered: covered,
    weakestComponent: weakest,
    strongestComponent: strongest,
    // Traceability: exactly how the number was produced (fix #3's replacement
    // for the hardcoded narrative).
    calculation: measured.map((k) => `${k} ${components[k]} x ${weights[k]}`).join(" + ") +
      (partial ? ` , renormalised over ${covered.toFixed(2)}` : ""),
    scoringVersion: HEALTH_SCORE.version,
    coveragePolicyVersion: coverage.policyVersion,
    summary: `Financial health is ${category.toLowerCase()} (${score}/100). ` +
      `Strongest pressure comes from ${COMPONENT_LABELS[weakest]} (${components[weakest]}/100); ` +
      `${COMPONENT_LABELS[strongest]} is the strongest area (${components[strongest]}/100).` +
      (partial ? ` Scored on ${Math.round(covered * 100)}% of the model — some inputs were unavailable.` : ""),
    dataQualityFindings: dataQualityFindings(findings).length,
    businessFindings: businessFindings(findings).length
  });
}

/**
 * Data-quality grade, reported SEPARATELY from business risk so the two are
 * never conflated (mandate §9): "we don't have the data" is not "the business
 * is risky".
 */
function summarizeDataQuality(findings, dataQuality) {
  const dq = dataQualityFindings(findings);
  const worstSeverity = dq.reduce(
    (worst, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[worst] ? f.severity : worst), "low");

  // The ingestion assessment measures whether each DATASET arrived. Field-level
  // gaps inside those datasets are found by the detectors. The EFFECTIVE level
  // must reflect both, or a period full of incomplete records reports COMPLETE.
  let effective = dataQuality ? dataQuality.level : null;
  if (effective === "COMPLETE" && dq.length > 0) effective = "PARTIAL";

  return Object.freeze({
    level: effective,
    ingestion_level: dataQuality ? dataQuality.level : null,
    completeness: dataQuality ? dataQuality.completeness : null,
    issue_count: dq.length,
    worst_severity: dq.length ? worstSeverity : null,
    scoring_reliable: dataQuality ? dataQuality.scoringReliable : true,
    summary: dq.length && effective === "PARTIAL" && dataQuality && dataQuality.level === "COMPLETE"
      ? `All expected datasets arrived, but ${dq.length} record(s) are incomplete.`
      : (dataQuality ? dataQuality.summary : null)
  });
}

module.exports = {
  aggregateRisk,
  componentScores,
  weightedScore,
  summarizeDataQuality,
  anomalyPressure,
  revenueComponent,
  categoryFor,
  COMPONENT_LABELS
};
