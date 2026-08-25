// THE severity and confidence model.
//
// Before JOB 7 severity was a literal at each detector call site (`SEVERITY.HIGH`
// with no stated reason) and confidence was a bare number with a trailing
// comment (`confidence: 0.4, // a weak signal on its own`). Two rules could pick
// different numbers for the same strength of evidence and nothing would notice.
//
// Severity and confidence answer DIFFERENT questions and must not be conflated:
//
//   SEVERITY   — if this finding is real, how much does it matter?
//   CONFIDENCE — how likely is it to be real?
//
// A round-number payment is MEDIUM severity (worth checking) at LOW confidence
// (most round payments are legitimate). An unreconciled account is MEDIUM
// severity at CERTAIN confidence (the source told us directly). Collapsing the
// two would rank a certain bookkeeping gap alongside a speculative fraud signal.

const SEVERITY = Object.freeze({
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low"
});

const SEVERITY_RANK = Object.freeze({ high: 3, medium: 2, low: 1 });

/**
 * WHY a severity was chosen. Every rule declares one, so the registry can
 * explain a ranking rather than asserting it.
 */
const SEVERITY_BASIS = Object.freeze({
  // Money is at risk of being lost or already gone.
  DIRECT_FINANCIAL_LOSS: "direct_financial_loss",
  // The business depends on something it does not control.
  STRUCTURAL_EXPOSURE: "structural_exposure",
  // A control that should exist is absent or not operating.
  CONTROL_GAP: "control_gap",
  // The books are incomplete; the business itself may be fine.
  RECORD_INCOMPLETE: "record_incomplete",
  // Worth a human look, with no claim beyond that.
  WARRANTS_REVIEW: "warrants_review"
});

/**
 * Named confidence levels, with the evidence that justifies each.
 *
 * These are not probabilities in a statistical sense — no rule here has a
 * calibrated base rate. They are an ordered scale of evidential strength, and
 * the labels state exactly what the number is claiming.
 */
const CONFIDENCE = Object.freeze({
  // The source system asserted it directly. There is nothing to infer.
  CERTAIN: 1.0,
  // Multiple independent attributes agree; a coincidence is implausible.
  STRONG: 0.9,
  // The defining attributes agree, but a legitimate explanation is common.
  PROBABLE: 0.75,
  // A statistical or structural signal, meaningful only in context.
  POSSIBLE: 0.6,
  // A heuristic that fires often on ordinary activity. Needs corroboration.
  WEAK: 0.4
});

const CONFIDENCE_BASIS = Object.freeze({
  SOURCE_ASSERTED: "source_asserted",        // the system of record said so
  MULTI_ATTRIBUTE_MATCH: "multi_attribute_match",
  MEASURED_THRESHOLD: "measured_threshold",  // a number crossed a stated line
  STATISTICAL: "statistical",                // derived from the period's distribution
  HEURISTIC: "heuristic"                     // pattern matching on text or shape
});

/**
 * Resolve a rule's severity for a specific observation.
 *
 * A rule declares EITHER a fixed severity, or a set of bands evaluated against
 * the observed value. Bands are checked in order and the first match wins, so
 * they must be declared strongest-first.
 *
 * @param {object} rule       a registry rule
 * @param {number} observed   the value the rule measured (optional)
 * @returns {{severity: string, basis: string, reason: string}}
 */
function resolveSeverity(rule, observed) {
  const policy = rule.severity;
  if (!policy) throw new Error(`rule ${rule.id} declares no severity policy`);

  if (policy.fixed) {
    return Object.freeze({
      severity: policy.fixed,
      basis: policy.basis,
      reason: policy.reason || `${rule.id} is always ${policy.fixed} severity.`
    });
  }

  if (Array.isArray(policy.bands)) {
    const band = policy.bands.find((b) => matchesBand(b, observed));
    if (!band) {
      throw new Error(`rule ${rule.id}: no severity band matches observed value ${observed}`);
    }
    return Object.freeze({
      severity: band.severity,
      basis: policy.basis,
      reason: band.reason || `${describeBand(band)} => ${band.severity}.`
    });
  }

  throw new Error(`rule ${rule.id} has an unrecognised severity policy`);
}

function matchesBand(band, observed) {
  if (band.atOrAbove != null) return observed >= band.atOrAbove;
  if (band.above != null) return observed > band.above;
  if (band.below != null) return observed < band.below;
  if (band.atOrBelow != null) return observed <= band.atOrBelow;
  return true; // the catch-all band
}

function describeBand(band) {
  if (band.atOrAbove != null) return `observed >= ${band.atOrAbove}`;
  if (band.above != null) return `observed > ${band.above}`;
  if (band.below != null) return `observed < ${band.below}`;
  if (band.atOrBelow != null) return `observed <= ${band.atOrBelow}`;
  return "otherwise";
}

/**
 * Resolve a rule's confidence for a specific observation.
 *
 * A rule declares a base level plus optional MODIFIERS — corroborating facts
 * that raise or lower it. Every modifier that applied is returned, so a finding
 * can state why it is more or less confident than the rule's default.
 *
 * @param {object} rule
 * @param {object} signals  facts the detector observed, e.g. { matchedFields: 4 }
 * @returns {{confidence: number, basis: string, applied: string[], reason: string}}
 */
function resolveConfidence(rule, signals = {}) {
  const policy = rule.confidence;
  if (!policy) throw new Error(`rule ${rule.id} declares no confidence policy`);

  let value = policy.base;
  const applied = [];

  (policy.modifiers || []).forEach((mod) => {
    if (!mod.when(signals)) return;
    value = mod.to;
    applied.push(mod.label);
  });

  // Confidence is a scale, not an arbitrary number: keep it inside it.
  value = Math.max(0, Math.min(1, value));

  return Object.freeze({
    confidence: value,
    basis: policy.basis,
    applied: Object.freeze(applied),
    reason: applied.length
      ? `${policy.rationale} ${applied.join("; ")}.`
      : policy.rationale
  });
}

/** The highest severity in a set of findings, or null. */
function maxSeverity(findings) {
  return (findings || []).reduce((worst, f) => {
    if (!worst) return f.severity;
    return SEVERITY_RANK[f.severity] > SEVERITY_RANK[worst] ? f.severity : worst;
  }, null);
}

module.exports = {
  SEVERITY,
  SEVERITY_RANK,
  SEVERITY_BASIS,
  CONFIDENCE,
  CONFIDENCE_BASIS,
  resolveSeverity,
  resolveConfidence,
  maxSeverity
};
