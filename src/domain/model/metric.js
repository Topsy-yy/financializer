// Metric — an authoritative calculated value.
//
// RULE: metrics are produced by deterministic code ONLY. The AI may read and
// narrate a metric; it may never create or alter one. `computedBy` records the
// engine that produced it so an AI-sourced number could never masquerade as
// authoritative.
//
// A metric that could not be calculated is `available: false` with a `reason` —
// never a zero, and never a placeholder.

const METRIC = Object.freeze({
  REVENUE_TOTAL: "revenue.total",
  REVENUE_GROWTH_PCT: "revenue.growth_pct",
  EXPENSES_TOTAL: "expenses.total",
  CASHFLOW_NET: "cashflow.net",
  CASHFLOW_INFLOW: "cashflow.inflow",
  CASHFLOW_OUTFLOW: "cashflow.outflow",
  CASHFLOW_BURN: "cashflow.monthly_burn",
  CASHFLOW_RUNWAY_MONTHS: "cashflow.runway_months",
  CASHFLOW_RISK_SCORE: "cashflow.risk_score",
  CASH_ON_HAND: "cash.on_hand",
  VENDOR_TOP_SHARE_PCT: "vendor.top_share_pct",
  CUSTOMER_TOP_SHARE_PCT: "customer.top_share_pct",
  DUPLICATE_COUNT: "findings.duplicate_count",
  TRANSACTION_COUNT: "transactions.count",
  HEALTH_OVERALL: "health.overall_score"
});

const UNAVAILABLE_REASON = Object.freeze({
  NO_DATA: "no_data",                       // the inputs were not present
  NOT_ATTRIBUTABLE: "not_attributable",     // present but not assignable (e.g. no counterparty)
  NOT_APPLICABLE: "not_applicable",         // the metric has no meaning here
  INSUFFICIENT_EVIDENCE: "insufficient_evidence",
  /* An input EXISTS but is not authoritative for this particular calculation.
     Distinct from NO_DATA, which means nothing was there at all. Introduced for
     the cash balance: when none is supplied, ingestion derives an estimate from
     net income, and that estimate is not a defensible basis for cash runway
     even though it is a real number. Saying "no data" would be inaccurate --
     there IS data, it is simply not of the kind this metric requires. */
  INPUT_NOT_AUTHORITATIVE: "input_not_authoritative"
});

/** An available metric with an explicit unit and provenance. */
function createMetric({ key, value, unit = null, currency = null, computedBy, calculation = null, period = null }) {
  if (!key) throw new Error("metric requires a key");
  if (!computedBy) throw new Error(`metric ${key} requires computedBy (the engine version)`);
  if (value == null || (typeof value === "number" && !Number.isFinite(value))) {
    throw new Error(`metric ${key} has no finite value; use unavailableMetric() instead`);
  }
  return Object.freeze({
    key: String(key),
    available: true,
    value,
    unit,            // "currency" | "percent" | "months" | "count" | "score"
    currency,        // set when unit === "currency"; never converted
    period,
    computedBy,      // e.g. "engine@2.0.0" — deterministic, never an AI model
    calculation
  });
}

/** A metric that genuinely could not be calculated. */
function unavailableMetric({ key, reason, computedBy, period = null, detail = null }) {
  if (!key) throw new Error("metric requires a key");
  if (!Object.values(UNAVAILABLE_REASON).includes(reason)) {
    throw new Error(`metric ${key} has unknown unavailable reason: ${reason}`);
  }
  return Object.freeze({
    key: String(key),
    available: false,
    value: null,
    reason,
    detail,
    period,
    computedBy: computedBy || null
  });
}

/** Build a keyed map from a list, for easy lookup by the API layer. */
function toMetricMap(metrics) {
  const out = {};
  (metrics || []).forEach((m) => { out[m.key] = m; });
  return Object.freeze(out);
}

module.exports = { METRIC, UNAVAILABLE_REASON, createMetric, unavailableMetric, toMetricMap };
