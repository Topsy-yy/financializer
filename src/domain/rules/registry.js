// THE authoritative financial-control rules registry.
//
// Every rule the system can apply is defined HERE, once, with:
//
//   id           stable, never reused, recorded on every finding it produces
//   version      semver; bump when the rule's BEHAVIOUR changes
//   category     which of the six finding categories it emits
//   severity     a policy (fixed, or bands), never a literal at the call site
//   confidence   a base level plus modifiers, with the evidence that justifies it
//   params       the thresholds it uses — no detector may hardcode one
//   rationale    why this rule exists and what crossing it means
//   evidence     what a finding from this rule must cite
//
// NOTHING ELSE MAY DECLARE A FINANCIAL THRESHOLD. Detectors read `params` from
// here; the human-readable methodology is GENERATED from here (see
// methodology.js) rather than maintained as a separate document that drifts.
//
// This file replaces src/domain/analysis/thresholds.js, which held the rule
// parameters but not the severity, confidence or evidence policy — those were
// still literals scattered across the detectors.
//
// VERSIONING CONTRACT
//   * Bump a RULE version when what it detects, or how strongly, changes.
//   * Bump ENGINE_VERSION when any rule version, weight or policy changes.
//   * Never change a rule id. A finding persisted last year must still resolve.

const {
  SEVERITY, SEVERITY_BASIS, CONFIDENCE, CONFIDENCE_BASIS,
  resolveSeverity, resolveConfidence, SEVERITY_RANK, maxSeverity
} = require("./severity");
const materiality = require("./materiality");
const currency = require("./currency");

// Bumped by JOB 7: rules now carry severity/confidence policy, materiality is
// currency-aware, and currency-incompatible aggregation is refused.
const ENGINE_VERSION = "4.0.0";

const CATEGORY = Object.freeze({
  ANOMALY: "anomaly",
  DATA_QUALITY: "data_quality",
  BUSINESS_RISK: "business_risk",
  CONTROL_WEAKNESS: "control_weakness",
  DUPLICATE: "duplicate",
  FRAUD_INDICATOR: "fraud_indicator"
});

/** Categories whose wording must stay cautious — an indicator is not a verdict. */
const REQUIRES_CAUTIOUS_LANGUAGE = Object.freeze([CATEGORY.FRAUD_INDICATOR, CATEGORY.DUPLICATE]);

// ─────────────────────────────────────────────────────────────────
// The rules.
// ─────────────────────────────────────────────────────────────────

const RULE_LIST = [
  {
    id: "duplicate_payment",
    version: "3.0.0", // v3: currency is part of the match key
    title: "Possible duplicate payment",
    category: CATEGORY.DUPLICATE,
    summary: "Two or more transactions share the same date, amount and counterparty.",
    rationale:
      "A payment recorded twice is money that may have left the business twice. "
      + "This is the single most recoverable error the engine looks for, which is "
      + "why it is high severity despite legitimate explanations existing "
      + "(instalments, recurring same-day charges).",
    params: {
      // v2 removed the fallback to `description`, which collided unrelated records.
      requireCounterparty: true,
      // v3: amounts in different declared currencies are never the same payment.
      matchOn: ["date", "amount", "counterparty", "currency"],
      corroborating: ["reference", "account"]
    },
    // What this rule needs in order to be meaningful. Drives evidence
    // coverage: a rule that could not run leaves its component UNMEASURED
    // rather than counting as "nothing found".
    applicability: { requires: ["transactions"], minRecords: 2, currencySafe: true },
    methodology:
      "Group transactions by (date, amount, counterparty, currency); a group of 2 or more is a candidate.",
    enabled: true,
    severity: {
      fixed: SEVERITY.HIGH,
      basis: SEVERITY_BASIS.DIRECT_FINANCIAL_LOSS,
      reason: "If real, the same money left the business twice."
    },
    confidence: {
      base: CONFIDENCE.PROBABLE,
      basis: CONFIDENCE_BASIS.MULTI_ATTRIBUTE_MATCH,
      rationale:
        "Date, amount and counterparty all matching is unlikely by chance, but "
        + "recurring same-day payments to one supplier are legitimate and common.",
      modifiers: [
        { label: "a shared reference or account corroborates the match",
          when: (s) => s.matchedFields >= 4, to: CONFIDENCE.STRONG },
        { label: "both a shared reference AND account corroborate the match",
          when: (s) => s.matchedFields >= 5, to: 0.97 }
      ]
    },
    evidence: { mustCiteRecords: true, minRecords: 2 }
  },

  {
    id: "round_number_payment",
    version: "3.0.0", // v3: materiality is currency-aware and business-relative
    title: "Round-number payment",
    category: CATEGORY.FRAUD_INDICATOR,
    summary: "A material payment for an exact round amount, worth confirming against an invoice.",
    rationale:
      "Invoiced amounts are rarely round. A large exact multiple can indicate an "
      + "estimate paid without a document, or a fabricated figure. On its own it "
      + "is weak: rent, retainers and round-number contracts are entirely normal, "
      + "which is why this rule carries the lowest confidence in the registry.",
    params: {
      // NO fixed amount here. The threshold comes from the materiality
      // methodology, which accounts for currency and the size of the business.
      materialityDriven: true
    },
    // What this rule needs in order to be meaningful. Drives evidence
    // coverage: a rule that could not run leaves its component UNMEASURED
    // rather than counting as "nothing found".
    applicability: { requires: ["transactions"], minRecords: 1, currencySafe: true },
    methodology:
      "Flag amounts at or above the resolved materiality threshold that are an exact multiple of the currency's round-number unit.",
    enabled: true,
    severity: {
      fixed: SEVERITY.MEDIUM,
      basis: SEVERITY_BASIS.WARRANTS_REVIEW,
      reason: "Worth matching to a document; not evidence of loss by itself."
    },
    confidence: {
      base: CONFIDENCE.WEAK,
      basis: CONFIDENCE_BASIS.HEURISTIC,
      rationale: "Round amounts are common in legitimate business activity.",
      modifiers: [
        { label: "the amount is far above this period's materiality threshold",
          when: (s) => s.multipleOfMateriality >= 10, to: CONFIDENCE.POSSIBLE }
      ]
    },
    evidence: { mustCiteRecords: true, minRecords: 1 }
  },

  {
    id: "statistical_outlier",
    version: "2.1.0", // v2.1: outliers are computed within a single currency
    title: "Unusually large transaction",
    category: CATEGORY.ANOMALY,
    summary: "A transaction more than 2 standard deviations above the period mean.",
    rationale:
      "An amount far outside the period's own distribution is worth a look "
      + "regardless of its absolute size. Because the comparison is to THIS "
      + "business's own activity, it needs no materiality threshold — but it does "
      + "need a minimum sample, since a mean over three transactions means little.",
    params: { sigma: 2, minSampleSize: 4, perCurrency: true },
    // What this rule needs in order to be meaningful. Drives evidence
    // coverage: a rule that could not run leaves its component UNMEASURED
    // rather than counting as "nothing found".
    applicability: { requires: ["transactions"], minRecords: 4, currencySafe: true },
    methodology:
      "Within each currency: mean + 2 standard deviations of absolute amounts; flag anything above.",
    enabled: true,
    severity: {
      fixed: SEVERITY.MEDIUM,
      basis: SEVERITY_BASIS.WARRANTS_REVIEW,
      reason: "Unusual size alone indicates nothing about legitimacy."
    },
    confidence: {
      base: CONFIDENCE.POSSIBLE,
      basis: CONFIDENCE_BASIS.STATISTICAL,
      rationale: "Derived from this period's own distribution, not an external assumption.",
      modifiers: [
        { label: "the sample is large enough for the distribution to be meaningful",
          when: (s) => s.sampleSize >= 20, to: CONFIDENCE.PROBABLE }
      ]
    },
    evidence: { mustCiteRecords: true, minRecords: 1 }
  },

  {
    id: "mixed_personal_business",
    version: "3.0.0", // v3: one owner-keyword list, shared with custom rules
    title: "Possible personal/business mix",
    category: CATEGORY.FRAUD_INDICATOR,
    summary: "A transaction's description matches an owner or personal-spending keyword.",
    rationale:
      "Personal spending through the business is a tax and governance problem "
      + "even when it is not dishonest. Keyword matching is crude — a supplier "
      + "legitimately named 'Director Supplies Ltd' will match — so this reports "
      + "a question, never a conclusion.",
    params: {
      // ONE list. customRules.js previously had a second, different one
      // (["director","owner","personal","withdrawal","drawings"]) so the same
      // transaction could match a user rule and not the engine rule.
      keywords: ["owner", "personal", "director", "drawings", "family", "withdrawal"]
    },
    // What this rule needs in order to be meaningful. Drives evidence
    // coverage: a rule that could not run leaves its component UNMEASURED
    // rather than counting as "nothing found".
    applicability: { requires: ["transactions"], minRecords: 1, currencySafe: true },
    methodology:
      "Case-insensitive substring match of the registry keyword list against description and counterparty.",
    enabled: true,
    severity: {
      fixed: SEVERITY.HIGH,
      basis: SEVERITY_BASIS.CONTROL_GAP,
      reason: "Blurred personal and business funds undermine every other control."
    },
    confidence: {
      base: CONFIDENCE.WEAK,
      basis: CONFIDENCE_BASIS.HEURISTIC,
      rationale: "A keyword in free text is a hint, not a determination."
    },
    evidence: { mustCiteRecords: true, minRecords: 1 }
  },

  {
    id: "unreconciled_account",
    version: "2.0.0",
    title: "Unreconciled bank activity",
    category: CATEGORY.CONTROL_WEAKNESS,
    summary: "Bank activity has not been reconciled against the books.",
    rationale:
      "Reconciliation is the control that makes every other number trustworthy. "
      + "Its absence does not mean anything is wrong — it means nothing can be "
      + "confirmed, which is why it is a control finding and not a business risk.",
    params: {},
    // What this rule needs in order to be meaningful. Drives evidence
    // coverage: a rule that could not run leaves its component UNMEASURED
    // rather than counting as "nothing found".
    applicability: { requires: ["reconciliations"], minRecords: 1, currencySafe: true },
    methodology:
      "Flag any reconciliation record whose isReconciled is explicitly false.",
    enabled: true,
    severity: {
      fixed: SEVERITY.MEDIUM,
      basis: SEVERITY_BASIS.CONTROL_GAP,
      reason: "Unreconciled activity can conceal errors that other rules would catch."
    },
    confidence: {
      base: CONFIDENCE.CERTAIN,
      basis: CONFIDENCE_BASIS.SOURCE_ASSERTED,
      rationale: "The accounting system states the reconciliation status directly."
    },
    evidence: { mustCiteRecords: true, minRecords: 1 }
  },

  {
    id: "missing_transaction_fields",
    version: "3.0.0", // v3: a zero amount counts as missing
    title: "Incomplete transaction record",
    category: CATEGORY.DATA_QUALITY,
    summary: "A transaction is missing a date, an amount or a counterparty.",
    rationale:
      "An incomplete record cannot be analysed, attributed or reconciled. This "
      + "describes the BOOKS, not the business, so it never contributes to the "
      + "business risk score.",
    params: { required: ["date", "amount", "counterparty"] },
    // What this rule needs in order to be meaningful. Drives evidence
    // coverage: a rule that could not run leaves its component UNMEASURED
    // rather than counting as "nothing found".
    applicability: { requires: ["transactions"], minRecords: 1, currencySafe: true },
    methodology:
      "Flag any transaction lacking a date, a usable amount, or a counterparty.",
    enabled: true,
    severity: {
      fixed: SEVERITY.LOW,
      basis: SEVERITY_BASIS.RECORD_INCOMPLETE,
      reason: "One incomplete record is a bookkeeping task, not a business risk."
    },
    confidence: {
      base: CONFIDENCE.CERTAIN,
      basis: CONFIDENCE_BASIS.SOURCE_ASSERTED,
      rationale: "The field is either present in the record or it is not."
    },
    evidence: { mustCiteRecords: true, minRecords: 1 }
  },

  {
    id: "missing_journal_references",
    version: "2.0.0",
    title: "Journal entry missing debit/credit account",
    category: CATEGORY.DATA_QUALITY,
    summary: "A journal entry does not state both sides of the posting.",
    rationale: "A one-sided entry is not double-entry bookkeeping and cannot be traced.",
    params: { required: ["debitAccount", "creditAccount"] },
    // What this rule needs in order to be meaningful. Drives evidence
    // coverage: a rule that could not run leaves its component UNMEASURED
    // rather than counting as "nothing found".
    applicability: { requires: ["journalEntries"], minRecords: 1, currencySafe: true },
    methodology:
      "Flag any journal entry missing a debit or credit account.",
    enabled: true,
    severity: {
      fixed: SEVERITY.LOW,
      basis: SEVERITY_BASIS.RECORD_INCOMPLETE,
      reason: "A posting gap to correct, not a loss."
    },
    confidence: {
      base: CONFIDENCE.CERTAIN,
      basis: CONFIDENCE_BASIS.SOURCE_ASSERTED,
      rationale: "Both sides are recorded or they are not."
    },
    evidence: { mustCiteRecords: true, minRecords: 1 }
  },

  {
    id: "missing_receipt",
    version: "2.0.0",
    title: "Missing receipt",
    category: CATEGORY.DATA_QUALITY,
    summary: "An expense has no attached receipt.",
    rationale:
      "IMPORTANT ASYMMETRY: `hasReceipt` is only populated by Zoho-sourced "
      + "expenses. A source that never sets it produces zero findings — absence "
      + "of evidence, not evidence of compliance. Because this is a data-quality "
      + "finding it cannot inflate a business score, which is what previously let "
      + "a CSV import score better than a connected accounting system.",
    params: {},
    // What this rule needs in order to be meaningful. Drives evidence
    // coverage: a rule that could not run leaves its component UNMEASURED
    // rather than counting as "nothing found".
    applicability: { requires: ["transactions"], minRecords: 1, currencySafe: true },
    methodology:
      "Flag expenses whose hasReceipt is explicitly false. Records that do not carry the field are not flagged.",
    enabled: true,
    severity: {
      fixed: SEVERITY.LOW,
      basis: SEVERITY_BASIS.RECORD_INCOMPLETE,
      reason: "Weak documentation affects audit readiness, not solvency."
    },
    confidence: {
      base: CONFIDENCE.CERTAIN,
      basis: CONFIDENCE_BASIS.SOURCE_ASSERTED,
      rationale: "The expense record states whether a receipt is attached."
    },
    evidence: { mustCiteRecords: true, minRecords: 1 }
  },

  {
    id: "overdue_receivable",
    version: "2.0.0",
    title: "Overdue receivable",
    category: CATEGORY.BUSINESS_RISK,
    summary: "An invoice with an outstanding balance is past its due date.",
    rationale:
      "Money owed past its due date is the most direct near-term cash risk a "
      + "small business faces. v2 fixed a rule that flagged any past-due invoice "
      + "regardless of whether it had already been paid.",
    params: { requireOutstandingBalance: true },
    // What this rule needs in order to be meaningful. Drives evidence
    // coverage: a rule that could not run leaves its component UNMEASURED
    // rather than counting as "nothing found".
    applicability: { requires: ["receivables"], minRecords: 1, currencySafe: true },
    methodology:
      "Flag receivables past their due date (against the injected clock) with an outstanding balance above zero.",
    enabled: true,
    severity: {
      fixed: SEVERITY.HIGH,
      basis: SEVERITY_BASIS.DIRECT_FINANCIAL_LOSS,
      reason: "Cash the business is counting on has not arrived."
    },
    confidence: {
      base: CONFIDENCE.CERTAIN,
      basis: CONFIDENCE_BASIS.SOURCE_ASSERTED,
      rationale: "The due date and the outstanding balance both come from the ledger."
    },
    evidence: { mustCiteRecords: true, minRecords: 1 }
  },

  {
    id: "overdue_payable",
    version: "2.0.0",
    title: "Overdue payable",
    category: CATEGORY.BUSINESS_RISK,
    summary: "A bill with an outstanding balance is past its due date.",
    rationale: "Unpaid bills past their due date risk supply interruption and late fees.",
    params: { requireOutstandingBalance: true },
    // What this rule needs in order to be meaningful. Drives evidence
    // coverage: a rule that could not run leaves its component UNMEASURED
    // rather than counting as "nothing found".
    applicability: { requires: ["payables"], minRecords: 1, currencySafe: true },
    methodology:
      "Flag payables past their due date (against the injected clock) with an outstanding balance above zero.",
    enabled: true,
    severity: {
      fixed: SEVERITY.HIGH,
      basis: SEVERITY_BASIS.DIRECT_FINANCIAL_LOSS,
      reason: "Late payment carries direct cost and relationship risk."
    },
    confidence: {
      base: CONFIDENCE.CERTAIN,
      basis: CONFIDENCE_BASIS.SOURCE_ASSERTED,
      rationale: "The due date and the outstanding balance both come from the ledger."
    },
    evidence: { mustCiteRecords: true, minRecords: 1 }
  },

  {
    id: "vendor_concentration",
    version: "3.0.0", // v3: a share of a zero or mixed-currency total is unavailable
    title: "Vendor concentration",
    category: CATEGORY.BUSINESS_RISK,
    summary: "A large share of spend depends on a single vendor.",
    rationale:
      "Dependence on one supplier is a real exposure regardless of that "
      + "supplier's quality. The thresholds are judgement, not accounting "
      + "standard: above 30% a disruption is disruptive, above 50% it is "
      + "existential.",
    params: { highSharePct: 50, mediumSharePct: 30, topThreeSharePct: 80 },
    // What this rule needs in order to be meaningful. Drives evidence
    // coverage: a rule that could not run leaves its component UNMEASURED
    // rather than counting as "nothing found".
    applicability: { requires: ["transactions"], minRecords: 1, currencySafe: false },
    methodology:
      "Top vendor's share of total attributable outflow, within a single currency basis.",
    enabled: true,
    severity: {
      basis: SEVERITY_BASIS.STRUCTURAL_EXPOSURE,
      bands: [
        { above: 50, severity: SEVERITY.HIGH,
          reason: "Over half of spend with one vendor: losing them halts operations." },
        { above: 30, severity: SEVERITY.MEDIUM,
          reason: "Concentrated enough that a disruption would be material." }
      ]
    },
    confidence: {
      base: CONFIDENCE.CERTAIN,
      basis: CONFIDENCE_BASIS.MEASURED_THRESHOLD,
      rationale: "The share is measured from the transactions themselves."
    },
    evidence: { mustCiteRecords: true, minRecords: 1 }
  },

  {
    id: "customer_concentration",
    version: "3.0.0",
    title: "Customer concentration",
    category: CATEGORY.BUSINESS_RISK,
    summary: "A large share of revenue depends on a single customer.",
    rationale:
      "Revenue concentration is the mirror of vendor concentration and usually "
      + "the more dangerous of the two: losing a customer removes income "
      + "immediately, while losing a supplier can often be replaced.",
    params: { highSharePct: 50, mediumSharePct: 30, topThreeSharePct: 80 },
    // What this rule needs in order to be meaningful. Drives evidence
    // coverage: a rule that could not run leaves its component UNMEASURED
    // rather than counting as "nothing found".
    applicability: { requires: ["transactions"], minRecords: 1, currencySafe: false },
    methodology:
      "Top customer's share of total attributable inflow, within a single currency basis.",
    enabled: true,
    severity: {
      basis: SEVERITY_BASIS.STRUCTURAL_EXPOSURE,
      bands: [
        { above: 50, severity: SEVERITY.HIGH,
          reason: "Over half of revenue from one customer: losing them is existential." },
        { above: 30, severity: SEVERITY.MEDIUM,
          reason: "Concentrated enough that losing them would be material." }
      ]
    },
    confidence: {
      base: CONFIDENCE.CERTAIN,
      basis: CONFIDENCE_BASIS.MEASURED_THRESHOLD,
      rationale: "The share is measured from the transactions themselves."
    },
    evidence: { mustCiteRecords: true, minRecords: 1 }
  },

  {
    id: "cashflow_runway",
    version: "2.0.0",
    title: "Cash runway",
    category: CATEGORY.BUSINESS_RISK,
    summary: "Months of cash remaining at the current net burn rate.",
    rationale:
      "Runway is the number that decides whether every other finding matters. "
      + "Six months is the point at which a business still has time to act; "
      + "three is the point at which its options narrow sharply.",
    params: { criticalMonths: 3, warningMonths: 6 },
    // What this rule needs in order to be meaningful. Drives evidence
    // coverage: a rule that could not run leaves its component UNMEASURED
    // rather than counting as "nothing found".
    applicability: { requires: ["statements.cashFlow", "statements.balanceSheet"], minRecords: 0, currencySafe: false },
    methodology:
      "cash on hand / monthly burn, where burn is max(0, outflow - inflow). Unavailable if either input is missing.",
    enabled: true,
    severity: {
      basis: SEVERITY_BASIS.DIRECT_FINANCIAL_LOSS,
      bands: [
        { below: 3, severity: SEVERITY.HIGH,
          reason: "Under three months: immediate action is required." },
        { below: 6, severity: SEVERITY.MEDIUM,
          reason: "Under six months: there is still time to change course." }
      ]
    },
    confidence: {
      base: CONFIDENCE.CERTAIN,
      basis: CONFIDENCE_BASIS.MEASURED_THRESHOLD,
      rationale: "Computed from the reported cash balance and the period's burn rate."
    },
    evidence: { mustCiteRecords: false, minRecords: 0 }
  },

  {
    id: "custom_rule",
    version: "2.0.0", // v2: emits the full Finding contract with evidence
    title: "Custom financial rule",
    category: CATEGORY.BUSINESS_RISK,
    summary: "A condition defined by the business itself.",
    rationale:
      "User-defined rules encode a business's own controls. They use the same "
      + "Finding and Evidence contract as built-in rules — before JOB 7 they "
      + "emitted a bare {type, severity, description} object with no id, no "
      + "version and no evidence, so a user rule could not be traced or audited. "
      + "Their VERSION is that of the rule record the user authored, not this "
      + "registry entry, which versions the evaluation machinery.",
    params: { maxFindingsPerRule: 12 },
    // What this rule needs in order to be meaningful. Drives evidence
    // coverage: a rule that could not run leaves its component UNMEASURED
    // rather than counting as "nothing found".
    applicability: { requires: ["transactions"], minRecords: 1, currencySafe: true },
    methodology:
      "Evaluates the author's declared condition against the period's records.",
    enabled: true,
    severity: {
      // The author chooses; the registry constrains the vocabulary.
      fixed: SEVERITY.MEDIUM,
      basis: SEVERITY_BASIS.WARRANTS_REVIEW,
      reason: "Defaults to medium; the rule's author may set low, medium or high."
    },
    confidence: {
      base: CONFIDENCE.CERTAIN,
      basis: CONFIDENCE_BASIS.MEASURED_THRESHOLD,
      rationale:
        "A custom rule is a deterministic condition on the records. It is certain "
        + "that the condition matched; whether the condition is a good one is the "
        + "author's judgement, not the engine's."
    },
    evidence: { mustCiteRecords: true, minRecords: 1 }
  }
];

const RULES = Object.freeze(RULE_LIST.reduce((acc, rule) => {
  if (acc[rule.id]) throw new Error(`duplicate rule id in registry: ${rule.id}`);
  acc[rule.id] = Object.freeze(Object.assign({}, rule, {
    params: Object.freeze(Object.assign({}, rule.params))
  }));
  return acc;
}, {}));

// ─────────────────────────────────────────────────────────────────
// Scoring methodology. Also authoritative, also versioned.
// ─────────────────────────────────────────────────────────────────

/** Cash-flow risk: additive points, clamped to 0-100. */
const CASHFLOW_RISK = Object.freeze({
  version: "2.1.0",
  baseline: 20,
  negativeNetCashFlow: 25,
  hasBurn: 15,
  runwayUnderWarningMonths: 25,
  runwayUnderCriticalMonths: 15,
  overdueReceivablesRatio: 0.25,
  overdueReceivablesPoints: 10,
  severityHighAt: 70,
  severityMediumAt: 40
});

/**
 * The health/risk score weighting, bands and EVIDENCE-COVERAGE policy.
 *
 * §10 — evidence coverage, stated once:
 *   A component may only be counted as MEASURED if there was evidence to
 *   measure it from. Absence of records is not a clean bill of health.
 *   Two rules enforce this:
 *
 *   1. minEvidenceForAnomalyComponent — the `fraud_indicators` component is
 *      100 minus anomaly pressure, so with no transactions at all it scored a
 *      perfect 100. A business with no data was rewarded for it. It is now
 *      unmeasured unless there are records the detectors could have fired on.
 *
 *   2. minWeightCovered — even with renormalisation, a score assembled from a
 *      minority of the model is extrapolation. Below this share the score is
 *      unavailable rather than optimistic.
 */
const HEALTH_SCORE = Object.freeze({
  version: "4.0.0",
  weights: Object.freeze({
    cash_flow: 0.30,
    fraud_indicators: 0.20,
    revenue_stability: 0.20,
    vendor_risk: 0.15,
    customer_risk: 0.15
  }),
  anomalyPoints: Object.freeze({ high: 12, medium: 6, low: 2, default: 1 }),
  revenueBands: Object.freeze([
    { minGrowthPct: 10, score: 88 },
    { minGrowthPct: 0, score: 72 },
    { minGrowthPct: -10, score: 55 },
    { minGrowthPct: -Infinity, score: 38 }
  ]),
  categories: Object.freeze([
    { minScore: 80, label: "Excellent" },
    { minScore: 60, label: "Good" },
    { minScore: 40, label: "Fair" },
    { minScore: 20, label: "Poor" },
    { minScore: -Infinity, label: "Critical" }
  ]),
  unknownComponentScore: null,
  minWeightCovered: 0.5,
  // At least one record must exist for "no anomalies found" to mean anything.
  minEvidenceForAnomalyComponent: 1
});

const FORECAST = Object.freeze({
  version: "2.0.0",
  daysPerMonth: 30,
  horizonDays: Object.freeze([30, 60, 90]),
  seriesMonths: Object.freeze([0, 1, 2, 3]),
  criticalDaysToZero: 90
});

// ─────────────────────────────────────────────────────────────────
// Registry API.
// ─────────────────────────────────────────────────────────────────

/** Look up a rule. Throws rather than returning undefined — an unknown rule id
 *  is a programming error, and silently producing a finding with no rule behind
 *  it is exactly what the registry exists to prevent. */
function getRule(id) {
  const rule = RULES[id];
  if (!rule) throw new Error(`unknown rule id: ${id}`);
  return rule;
}

function allRules() {
  return RULE_LIST.map((r) => RULES[r.id]);
}

/** Every rule version plus the scoring methodology versions, for stamping a run. */
function ruleVersions() {
  const out = {};
  allRules().forEach((r) => { out[r.id] = r.version; });
  out.cashflow_risk = CASHFLOW_RISK.version;
  out.health_score = HEALTH_SCORE.version;
  out.forecast = FORECAST.version;
  out.materiality = materiality.MATERIALITY_VERSION;
  return Object.freeze(out);
}

/**
 * Resolve everything a detector needs to emit a finding for a rule.
 * A detector calls this instead of choosing a severity or confidence itself.
 */
function resolveRule(id, { observed, signals } = {}) {
  const rule = getRule(id);
  const sev = resolveSeverity(rule, observed);
  const conf = resolveConfidence(rule, signals || {});
  return Object.freeze({
    rule,
    ruleId: rule.id,
    ruleVersion: rule.version,
    category: rule.category,
    title: rule.title,
    severity: sev.severity,
    severityBasis: sev.basis,
    severityReason: sev.reason,
    confidence: conf.confidence,
    confidenceBasis: conf.basis,
    confidenceReason: conf.reason
  });
}

module.exports = {
  ENGINE_VERSION,
  CATEGORY,
  REQUIRES_CAUTIOUS_LANGUAGE,
  RULES,
  CASHFLOW_RISK,
  HEALTH_SCORE,
  FORECAST,
  getRule,
  allRules,
  ruleVersions,
  resolveRule,
  // Re-exported so there is ONE import for everything methodological.
  SEVERITY,
  SEVERITY_RANK,
  SEVERITY_BASIS,
  CONFIDENCE,
  CONFIDENCE_BASIS,
  maxSeverity,
  materiality,
  currency
};
