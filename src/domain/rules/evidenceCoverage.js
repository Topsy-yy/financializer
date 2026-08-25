// THE evidence-coverage methodology.
//
// THE PRINCIPLE, stated once and enforced here:
//
//   ABSENCE OF DATA MUST NEVER IMPROVE A BUSINESS'S SCORE.
//
// This is not a stylistic preference. The audited system scored an empty
// dataset as a healthy business, and JOB 6 found a period with no financial
// statements at all scoring 94/100 "Excellent". Both had the same cause: a
// component with nothing to measure defaulted to a good value instead of to
// "unmeasured".
//
// WHY A DEDICATED MODULE. JOB 6 fixed the symptom with a single constant,
// `minWeightCovered = 0.5`. That number was a judgement made mid-refactor and
// carried no methodology behind it. This module replaces it with a stated,
// versioned policy answering the five questions the mandate asks:
//
//   1. WHAT COUNTS AS EVIDENCE?
//      A component is MEASURED only if the datasets its rules require were
//      actually present AND carried enough records to be meaningful. The
//      requirement comes from each rule's `applicability` in the registry, so
//      adding a rule cannot silently change what "measured" means.
//
//   2. HOW IS COVERAGE CALCULATED?
//      Coverage is the share of the model's WEIGHT that was measured — not the
//      count of components. Missing the 30%-weighted cash-flow component is a
//      bigger evidential gap than missing the two 15% concentration components,
//      and weighting says so.
//
//   3. WHICH COMPONENTS REQUIRE WHICH EVIDENCE?
//      Declared in COMPONENT_EVIDENCE below, one entry per component.
//
//   4. WHAT HAPPENS WHEN DATA IS MISSING?
//      The component is null, is excluded from the weighted average, and the
//      remaining weights are renormalised. It is never defaulted to a number:
//      substituting a value asserts a measurement nobody took.
//
//   5. WHEN IS THE SCORE INSUFFICIENT_EVIDENCE RATHER THAN A NUMBER?
//      When coverage falls below the floor, OR when the ingestion layer reports
//      the data is not reliable enough to score at all. Both produce an
//      explicit reason, never a low number — "we cannot tell" and "this is bad"
//      are different answers and must look different.
//
// THE HONEST LIMITATION, recorded rather than hidden: the 0.5 floor is a
// judgement, not a derived quantity. What this module fixes is that it is now a
// STATED, VERSIONED, CONFIGURABLE judgement with a rationale, rather than a
// literal in a scoring function. See `rationale` on the policy below.

const { HEALTH_SCORE, getRule } = require("./registry");

const COVERAGE_POLICY_VERSION = "1.0.0";

/** Why a risk score could not be produced. */
const INSUFFICIENT = Object.freeze({
  // The ingestion layer graded the data too poor to score against.
  DATA_QUALITY: "insufficient_data_quality",
  // Nothing at all was measurable.
  NO_COMPONENTS: "no_measurable_components",
  // Something was measurable, but too little of the model.
  COVERAGE: "insufficient_component_coverage"
});

/**
 * What each scoring component needs before it may be called MEASURED.
 *
 * `requiresRecords` names the dataset that must be non-empty. `viaRules` names
 * the registry rules that populate the component, so a component's evidence
 * requirement is derived from the rules themselves rather than restated here.
 */
const COMPONENT_EVIDENCE = Object.freeze({
  cash_flow: Object.freeze({
    requires: ["statements.cashFlow"],
    viaRules: ["cashflow_runway"],
    reason: "Runway and burn need a cash-flow statement; there is nothing to infer them from."
  }),
  fraud_indicators: Object.freeze({
    // THE IMPORTANT ONE. This component is 100 minus anomaly pressure, so with
    // no records at all it computed a PERFECT 100 — a business was rewarded for
    // having no data. "No anomalies found" only means something if there was
    // something to find them in.
    requires: ["transactions"],
    minRecords: HEALTH_SCORE.minEvidenceForAnomalyComponent,
    viaRules: ["duplicate_payment", "round_number_payment", "statistical_outlier",
      "mixed_personal_business"],
    reason: "A clean anomaly result requires transactions the detectors could have fired on."
  }),
  revenue_stability: Object.freeze({
    requires: ["statements.profitAndLoss"],
    needsPriorPeriod: true,
    reason: "Growth is a comparison; it needs this period's revenue and a prior period's."
  }),
  vendor_risk: Object.freeze({
    requires: ["transactions"],
    viaRules: ["vendor_concentration"],
    reason: "Concentration is a share of attributable outflow; unattributed spend is not a vendor."
  }),
  customer_risk: Object.freeze({
    requires: ["transactions"],
    viaRules: ["customer_concentration"],
    reason: "Concentration is a share of attributable inflow; unattributed revenue is not a customer."
  })
});

/**
 * THE coverage policy. Versioned and overridable, so a business or a future job
 * can change the floor deliberately rather than by editing a scoring function.
 */
const DEFAULT_POLICY = Object.freeze({
  version: COVERAGE_POLICY_VERSION,

  /**
   * Minimum share of the model's weight that must be measured to publish a score.
   *
   * RATIONALE FOR 0.5, stated plainly because it is a judgement:
   * a score is a weighted claim about the whole model. Below half the weight,
   * the claim rests on a minority of the evidence and the unmeasured majority
   * could move it in either direction. A majority is the weakest defensible
   * bar — it is not a standard drawn from accounting practice, and no such
   * standard exists for a composite score of this kind.
   *
   * The failure it prevents is specific and observed: `fraud_indicators` alone
   * (0.20 weight) scored a statement-less period 94/100.
   */
  minWeightCovered: HEALTH_SCORE.minWeightCovered,

  /**
   * A component may not be measured from a single record when the rules behind
   * it need a distribution. Enforced per rule via `applicability.minRecords`.
   */
  honourRuleMinRecords: true,

  /**
   * Never publish a numeric score when the ingestion layer says the data is not
   * reliable. This gate is independent of coverage: complete-looking data that
   * arrived from a failed fetch is worse than obviously-missing data.
   */
  requireReliableIngestion: true
});

/** Merge a caller override over the default policy, keeping it frozen. */
function resolvePolicy(override) {
  if (!override) return DEFAULT_POLICY;
  return Object.freeze(Object.assign({}, DEFAULT_POLICY, override, {
    // A caller may tune the floor, but not below zero or above one.
    minWeightCovered: Math.max(0, Math.min(1,
      override.minWeightCovered == null ? DEFAULT_POLICY.minWeightCovered : override.minWeightCovered))
  }));
}

/** Count the records available for a named dataset path in the normalized input. */
function datasetSize(input, path) {
  if (path === "transactions") return (input.transactions || []).length;
  if (path === "journalEntries") return (input.journalEntries || []).length;
  if (path === "reconciliations") return (input.reconciliations || []).length;
  if (path === "receivables") return Array.isArray(input.receivables) ? input.receivables.length : 0;
  if (path === "payables") return Array.isArray(input.payables) ? input.payables.length : 0;
  if (path.startsWith("statements.")) {
    const key = path.slice("statements.".length);
    const block = (input.statements || {})[key];
    return block && Object.keys(block).length > 0 ? 1 : 0;
  }
  return 0;
}

/**
 * Which rules could actually RUN against this dataset, and which could not.
 *
 * A rule that could not run has not "found nothing" — it has not looked. That
 * distinction is what stops a missing dataset reading as a clean result.
 */
function assessRuleApplicability(input) {
  const applicable = [];
  const notApplicable = [];

  Object.keys(require("./registry").RULES).forEach((id) => {
    const rule = getRule(id);
    if (!rule.enabled) {
      notApplicable.push({ ruleId: id, reason: "rule_disabled" });
      return;
    }
    const requires = (rule.applicability && rule.applicability.requires) || [];
    const minRecords = (rule.applicability && rule.applicability.minRecords) || 0;
    const missing = requires.filter((path) => datasetSize(input, path) === 0);
    if (missing.length) {
      notApplicable.push({ ruleId: id, reason: "missing_dataset", missing });
      return;
    }
    const smallest = requires.reduce(
      (min, path) => Math.min(min, datasetSize(input, path)), Infinity);
    if (minRecords > 0 && smallest < minRecords) {
      notApplicable.push({ ruleId: id, reason: "insufficient_records", have: smallest, need: minRecords });
      return;
    }
    applicable.push(id);
  });

  return Object.freeze({
    applicable: Object.freeze(applicable),
    notApplicable: Object.freeze(notApplicable)
  });
}

/**
 * Is there enough evidence for the anomaly component to mean anything?
 *
 * Separated out because it is the component that silently rewarded missing
 * data, and because the answer must be readable from a test.
 */
function anomalyComponentMeasurable(input, policy = DEFAULT_POLICY) {
  const spec = COMPONENT_EVIDENCE.fraud_indicators;
  const have = datasetSize(input, "transactions");
  const need = policy.honourRuleMinRecords ? (spec.minRecords || 1) : 1;
  return { measurable: have >= need, have, need, reason: spec.reason };
}

/**
 * Decide whether a computed score may be published.
 *
 * @returns {object} { sufficient, reason, covered, floor, explanation }
 */
function assessCoverage({ score, covered, measured = [], dataQualityReliable = true }, override) {
  const policy = resolvePolicy(override);
  const floor = policy.minWeightCovered;

  if (policy.requireReliableIngestion && !dataQualityReliable) {
    return Object.freeze({
      sufficient: false,
      reason: INSUFFICIENT.DATA_QUALITY,
      covered,
      floor,
      policyVersion: policy.version,
      explanation: "Financial health cannot be scored: there is not enough accounting data for this period."
    });
  }

  if (score == null || !measured.length) {
    return Object.freeze({
      sufficient: false,
      reason: INSUFFICIENT.NO_COMPONENTS,
      covered,
      floor,
      policyVersion: policy.version,
      explanation: "Financial health cannot be scored: none of the required inputs were available."
    });
  }

  if (covered < floor) {
    return Object.freeze({
      sufficient: false,
      reason: INSUFFICIENT.COVERAGE,
      covered,
      floor,
      policyVersion: policy.version,
      explanation:
        `Financial health cannot be scored: only ${Math.round(covered * 100)}% of the model could be measured `
        + `(at least ${Math.round(floor * 100)}% is required). Measured: ${measured.join(", ")}.`
    });
  }

  return Object.freeze({
    sufficient: true,
    reason: null,
    covered,
    floor,
    policyVersion: policy.version,
    explanation: covered < 1
      ? `Scored on ${Math.round(covered * 100)}% of the model; the remainder could not be measured.`
      : "Scored on the complete model."
  });
}

module.exports = {
  COVERAGE_POLICY_VERSION,
  INSUFFICIENT,
  COMPONENT_EVIDENCE,
  DEFAULT_POLICY,
  resolvePolicy,
  datasetSize,
  assessRuleApplicability,
  anomalyComponentMeasurable,
  assessCoverage
};
