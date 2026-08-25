// RiskScore — the overall score and its components, kept explicitly distinct.
//
// POLICY (established in JOB 3, preserved verbatim here):
//   * A component that cannot be calculated is `null`. It is NEVER fabricated
//     to fill a UI slot. `customer_risk: null` is correct; `customer_risk: 72`
//     invented from nothing is not.
//   * Unavailable components are EXCLUDED from the weighted average and the
//     remaining weights are RENORMALISED, so a missing input neither counts as
//     healthy nor drags the score down.
//   * `weightCovered` reports how much of the model was actually measurable, so
//     a partial score is never mistaken for a complete one.
//   * When no component is measurable, or data quality is insufficient, the
//     score is `available: false` with `overall: null` — "Unknown", not zero.
//
// This module defines the SHAPE. The arithmetic lives in
// src/domain/analysis/riskAggregation.js, which is the single implementation.

const COMPONENT = Object.freeze({
  CASH_FLOW: "cash_flow",
  FRAUD_INDICATORS: "fraud_indicators",
  REVENUE_STABILITY: "revenue_stability",
  VENDOR_RISK: "vendor_risk",
  CUSTOMER_RISK: "customer_risk"
});

function createRiskScore({
  overall,
  category,
  components,
  weights,
  measuredComponents,
  weightCovered,
  weakestComponent = null,
  strongestComponent = null,
  calculation = null,
  scoringVersion,
  // Which version of the evidence-coverage policy decided this score was
  // publishable. Part of making a historical run re-explainable.
  coveragePolicyVersion = null,
  available = true,
  unavailableReason = null,
  summary = null,
  // Counts, carried so a consumer can see that a low score is driven by real
  // business findings rather than by bookkeeping gaps.
  dataQualityFindings = 0,
  businessFindings = 0
}) {
  if (!scoringVersion) throw new Error("risk score requires scoringVersion");
  if (available && (overall == null || !Number.isFinite(overall))) {
    throw new Error("an available risk score requires a finite overall value");
  }
  if (!available && overall != null) {
    throw new Error("an unavailable risk score must have overall = null");
  }
  return Object.freeze({
    available,
    overall: available ? overall : null,
    category: category || (available ? null : "Unknown"),
    unavailableReason,
    // Each component is a number 0-100 or NULL (never invented).
    components: Object.freeze(Object.assign({}, components)),
    weights: Object.freeze(Object.assign({}, weights)),
    measuredComponents: Object.freeze([...(measuredComponents || [])]),
    // 0..1 — the share of the model that could be measured.
    weightCovered: weightCovered == null ? null : Number(weightCovered),
    weakestComponent,
    strongestComponent,
    calculation,
    scoringVersion,
    coveragePolicyVersion,
    summary,
    dataQualityFindings,
    businessFindings
  });
}

/** Components with no measurable value, for UI and audit. */
function unavailableComponents(score) {
  return Object.keys(score.components || {}).filter((k) => score.components[k] == null);
}

module.exports = { COMPONENT, createRiskScore, unavailableComponents };
