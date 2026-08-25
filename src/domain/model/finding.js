// The Finding domain object.
//
// Replaces the prose triples `{type, severity, description}` that the audit
// found everywhere. A Finding must be able to answer "why did you flag this?"
// WITHOUT asking an LLM to reconstruct the reasoning: the metric, the threshold
// it crossed, the rule and version that produced it, and the exact source
// records involved all travel with the finding.
//
// This module is pure data + validation. It performs no I/O and knows nothing
// about SQL, HTTP or AI.

const crypto = require("crypto");

/**
 * What KIND of problem this is. The audit found data-quality gaps being scored
 * as "fraud indicators"; separating the categories is what makes that fixable.
 */
const CATEGORY = Object.freeze({
  ANOMALY: "anomaly",                     // statistically unusual, needs a look
  DATA_QUALITY: "data_quality",           // the books are incomplete, not the business
  BUSINESS_RISK: "business_risk",         // concentration, runway, growth
  CONTROL_WEAKNESS: "control_weakness",   // reconciliation, approval, documentation
  DUPLICATE: "duplicate",                 // "possible duplicate" -- see title wording
  FRAUD_INDICATOR: "fraud_indicator"      // a PATTERN associated with fraud -- never a verdict
});

/**
 * Categories that must never be phrased as an accusation. A pattern associated
 * with fraud is an INDICATOR requiring investigation, not a finding of fraud.
 * Titles for these categories are checked in tests to stay cautious.
 */
const REQUIRES_CAUTIOUS_LANGUAGE = Object.freeze([CATEGORY.FRAUD_INDICATOR, CATEGORY.DUPLICATE]);

const SEVERITY = Object.freeze({ LOW: "low", MEDIUM: "medium", HIGH: "high" });

const SEVERITY_RANK = Object.freeze({ low: 1, medium: 2, high: 3 });

/**
 * Categories that describe the QUALITY OF THE DATA rather than the health of the
 * business. These must never contribute to a business-risk score — a business
 * with messy bookkeeping is not a business committing fraud.
 */
const DATA_QUALITY_CATEGORIES = Object.freeze([CATEGORY.DATA_QUALITY, CATEGORY.CONTROL_WEAKNESS]);

function isDataQualityCategory(category) {
  return DATA_QUALITY_CATEGORIES.includes(category);
}

/**
 * A single piece of supporting evidence.
 *
 * `sourceRecordId` is the identifier from the SOURCE SYSTEM (e.g. a Zoho
 * invoice_id), so a finding can be traced back to the original accounting
 * record. `fields` carries the specific values that mattered.
 */
function createEvidence({
  label,
  sourceSystem = null,
  sourceRecordId = null,
  recordType = null,
  relationship = null,
  field = null,
  value = undefined,
  fields = {}
}) {
  if (!label) throw new Error("evidence requires a label");
  return Object.freeze({
    label: String(label),
    // Provenance: which system, which record, what kind of record.
    sourceSystem: sourceSystem == null ? null : String(sourceSystem),
    sourceRecordId: sourceRecordId == null ? null : String(sourceRecordId),
    recordType: recordType == null ? null : String(recordType),
    // Why this record is here: "matched", "exceeded_threshold", "outlier",
    // "missing_field", "contributes_to_total"...
    relationship: relationship == null ? null : String(relationship),
    // The specific field/value that mattered, when a single one does.
    field: field == null ? null : String(field),
    value: value === undefined ? null : value,
    // The captured snapshot: only what is needed to justify the finding, never
    // a copy of the whole transaction.
    fields: Object.freeze(Object.assign({}, fields))
  });
}

/** Which fields of a record were compared to produce a match. */
function createMatchCriteria(fieldNames, comparison = "equals") {
  return Object.freeze({ fields: Object.freeze([...fieldNames]), comparison });
}

/**
 * Deterministic identity for a finding.
 *
 * Derived from tenant + period + rule + the source records involved, so the SAME
 * finding recomputed for the same period keeps the same id across runs. This is
 * what lets us say "this is the issue you already dismissed" instead of
 * re-alerting, and it does not depend on the wording of a description (the old
 * fingerprint did, which silently collapsed distinct payments).
 */
function computeFindingId({ tenantId, period, ruleId, sourceRecordIds = [], discriminator = "" }) {
  const basis = [
    tenantId || "unknown-tenant",
    period || "unknown-period",
    ruleId || "unknown-rule",
    sourceRecordIds.slice().sort().join(","),
    discriminator
  ].join("|");
  return "fnd_" + crypto.createHash("sha256").update(basis).digest("hex").slice(0, 24);
}

/**
 * Build a validated Finding.
 *
 * Required: ruleId, ruleVersion, category, severity, title. A finding that
 * cannot name the rule that produced it is rejected — that is the whole point.
 */
function createFinding(input) {
  const {
    tenantId = null,
    analysisRunId = null,
    period = null,
    ruleId,
    ruleVersion,
    category,
    severity,
    title,
    description = "",
    metric = null,
    observedValue = null,
    threshold = null,
    comparator = null,
    confidence = null,
    calculation = null,
    matchCriteria = null,
    evidence = [],
    createdAt = null,
    discriminator = "",
    // JOB 7: WHY this severity and this confidence, resolved from the registry
    // rather than chosen at the detector's call site.
    severityBasis = null,
    severityReason = null,
    confidenceBasis = null,
    confidenceReason = null,
    // The currency the observed value is denominated in, when it is money.
    // A finding about an amount is meaningless without one.
    currency = null,
    evidenceComplete = null,
    // WHO authored the rule behind this finding.
    //   "engine" — a rule in the authoritative registry
    //   "tenant" — a rule the business defined for itself
    // A tenant-authored finding is shown, persisted and traceable exactly like
    // an engine one, but it is EXCLUDED from the deterministic risk score, so a
    // user cannot move their own score by writing rules.
    authorityScope = "engine"
  } = input || {};

  if (!ruleId) throw new Error("finding requires ruleId");
  if (!ruleVersion) throw new Error(`finding ${ruleId} requires ruleVersion`);
  if (!Object.values(CATEGORY).includes(category)) {
    throw new Error(`finding ${ruleId} has unknown category: ${category}`);
  }
  if (!Object.values(SEVERITY).includes(severity)) {
    throw new Error(`finding ${ruleId} has unknown severity: ${severity}`);
  }
  if (!title) throw new Error(`finding ${ruleId} requires a title`);
  if (confidence != null && (confidence < 0 || confidence > 1)) {
    throw new Error(`finding ${ruleId} confidence must be within 0..1`);
  }

  const evidenceList = Object.freeze(evidence.map((e) => (e && e.label ? e : createEvidence(e))));
  const sourceRecordIds = Object.freeze(
    Array.from(new Set(evidenceList.map((e) => e.sourceRecordId).filter(Boolean)))
  );

  return Object.freeze({
    findingId: computeFindingId({ tenantId, period, ruleId, sourceRecordIds: [...sourceRecordIds], discriminator }),
    tenantId,
    analysisRunId,
    period,
    ruleId,
    ruleVersion,
    category,
    severity,
    severityBasis,
    severityReason,
    title,
    description,
    metric,
    currency,
    // The value actually observed in the data.
    observedValue,
    // The boundary it was compared against (null when the rule has no threshold).
    threshold,
    comparator,
    // How likely the finding is to be REAL. Distinct from severity, which is
    // how much it matters if it is. Resolved from the registry, never chosen
    // at a call site.
    confidence,
    confidenceBasis,
    confidenceReason,
    // Plain-language statement of HOW the value was produced. Populated by the
    // detector so the UI never has to ask an LLM to explain the arithmetic.
    calculation,
    // Structured statement of WHICH fields were compared, when applicable.
    matchCriteria,
    evidence: evidenceList,
    sourceRecordIds,
    // Did the finding cite everything its rule requires? Computed here so a
    // consumer never has to re-derive the registry's evidence requirement.
    evidenceComplete: evidenceComplete == null
      ? evidenceList.length > 0
      : Boolean(evidenceComplete),
    isDataQuality: isDataQualityCategory(category),
    authorityScope,
    createdAt: createdAt || new Date().toISOString()
  });
}

/** Highest severity present, or null. */
function maxSeverity(findings) {
  let best = null;
  (findings || []).forEach((f) => {
    if (!best || SEVERITY_RANK[f.severity] > SEVERITY_RANK[best]) best = f.severity;
  });
  return best;
}

function byCategory(findings, category) {
  return (findings || []).filter((f) => f.category === category);
}

/** Findings that describe the BUSINESS (everything except data-quality). */
function businessFindings(findings) {
  return (findings || []).filter((f) => !f.isDataQuality);
}

/** Findings that describe the BOOKS. */
function dataQualityFindings(findings) {
  return (findings || []).filter((f) => f.isDataQuality);
}

module.exports = {
  CATEGORY,
  SEVERITY,
  SEVERITY_RANK,
  DATA_QUALITY_CATEGORIES,
  REQUIRES_CAUTIOUS_LANGUAGE,
  isDataQualityCategory,
  createEvidence,
  createMatchCriteria,
  createFinding,
  computeFindingId,
  maxSeverity,
  byCategory,
  businessFindings,
  dataQualityFindings
};
