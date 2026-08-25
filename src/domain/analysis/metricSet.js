// Calculator output -> the authoritative Metric[] the engine publishes.
//
// This is where a raw number becomes an AUTHORITATIVE metric: it gains a key, a
// unit, a currency, the version of the engine that computed it, and — when it
// could not be computed — an explicit reason instead of a zero.
//
// `computedBy` is the guarantee the mandate asks for: every metric names the
// deterministic engine that produced it, so an AI-generated number could never
// be mistaken for one of these. Nothing in this file consults an AI provider,
// and nothing outside the engine may construct a Metric.

const {
  createMetric, unavailableMetric, METRIC, UNAVAILABLE_REASON
} = require("../model/metric");

/**
 * Emit an available metric, or an explicit unavailable one.
 * A null/non-finite value NEVER becomes 0.
 */
function metricOrUnavailable(key, value, opts) {
  if (value == null || (typeof value === "number" && !Number.isFinite(value))) {
    return unavailableMetric({
      key,
      reason: opts.reason || UNAVAILABLE_REASON.NO_DATA,
      computedBy: opts.computedBy,
      period: opts.period,
      detail: opts.detail || null
    });
  }
  return createMetric({
    key,
    value,
    unit: opts.unit,
    currency: opts.unit === "currency" ? opts.currency : null,
    computedBy: opts.computedBy,
    period: opts.period,
    calculation: opts.calculation || null
  });
}

/**
 * Build the full authoritative metric set.
 *
 * @param {object} args
 *   calculations { cashflow, revenue, expenses, vendors, customers }
 *   findings     Finding[]
 *   riskScore    RiskScore
 *   engineVersion, period, currency, transactionCount
 */
function buildMetrics({ calculations, findings = [], riskScore, engineVersion, period, currency = null, transactionCount = null }) {
  const computedBy = `engine@${engineVersion}`;
  const { cashflow = {}, revenue = {}, expenses = {}, vendors = {}, customers = {} } = calculations || {};

  const m = (key, value, unit, extra = {}) =>
    metricOrUnavailable(key, value, Object.assign({ unit, currency, computedBy, period }, extra));

  const duplicateCount = findings.filter((f) => f.ruleId === "duplicate_payment").length;

  return [
    // ── Cash flow ──
    m(METRIC.CASHFLOW_INFLOW, cashflow.available ? cashflow.inflow : null, "currency"),
    m(METRIC.CASHFLOW_OUTFLOW, cashflow.available ? cashflow.outflow : null, "currency"),
    m(METRIC.CASHFLOW_NET, cashflow.net_cash_flow, "currency"),
    m(METRIC.CASHFLOW_BURN, cashflow.monthly_burn, "currency"),
    /* CASH ON HAND is reported only when OBSERVED. When the only figure
       available was derived from net income, this is unavailable with
       INPUT_NOT_AUTHORITATIVE -- there IS a number, it is simply not a cash
       balance -- rather than NO_DATA, which would misdescribe the situation. */
    m(METRIC.CASH_ON_HAND, cashflow.cash_on_hand, "currency", {
      reason: cashflow.cash_on_hand_unavailable_reason === "input_not_authoritative"
        ? UNAVAILABLE_REASON.INPUT_NOT_AUTHORITATIVE
        : UNAVAILABLE_REASON.NO_DATA,
      detail: cashflow.cash_on_hand_basis === "derived_from_net_income"
        ? "A cash balance was not supplied. An estimate was derived from this "
          + "period's net income, which is not a cash position and is not used here."
        : null
    }),
    m(METRIC.CASHFLOW_RUNWAY_MONTHS, cashflow.cash_runway_months, "months", {
      /* Three different absences, kept apart:
           not_depleting              -> NOT_APPLICABLE (a real answer)
           cash_balance_not_observed  -> INPUT_NOT_AUTHORITATIVE
           anything else              -> NO_DATA                              */
      reason: cashflow.never_depletes
        ? UNAVAILABLE_REASON.NOT_APPLICABLE
        : (cashflow.cash_runway_unavailable_reason === "cash_balance_not_observed"
          ? UNAVAILABLE_REASON.INPUT_NOT_AUTHORITATIVE
          : UNAVAILABLE_REASON.NO_DATA),
      detail: cashflow.cash_runway_unavailable_reason === "cash_balance_not_observed"
        ? "Runway needs an observed cash balance. None was supplied, and a "
          + "figure derived from net income is not a defensible substitute."
        : null,
      calculation: cashflow.cash_on_hand != null && cashflow.monthly_burn
        ? `${cashflow.cash_on_hand} / ${cashflow.monthly_burn}` : null
    }),
    m(METRIC.CASHFLOW_RISK_SCORE, cashflow.available ? cashflow.risk_score : null, "score",
      { calculation: cashflow.risk_calculation }),

    // ── Revenue and expenses ──
    m(METRIC.REVENUE_TOTAL, revenue.available ? revenue.total_revenue : null, "currency",
      { calculation: revenue.basis ? `source: ${revenue.basis}` : null }),
    m(METRIC.REVENUE_GROWTH_PCT, revenue.growth_rate, "percent",
      { calculation: revenue.growth_calculation }),
    m(METRIC.EXPENSES_TOTAL, expenses.available ? expenses.total_expenses : null, "currency",
      { calculation: expenses.calculation }),

    // ── Concentration ──
    // Unavailable because nothing was ATTRIBUTABLE is different from no data,
    // and neither is 0% concentration.
    m(METRIC.VENDOR_TOP_SHARE_PCT, vendors.available ? vendors.top_share_pct : null, "percent",
      { reason: UNAVAILABLE_REASON.NOT_ATTRIBUTABLE, calculation: vendors.risk_calculation }),
    m(METRIC.CUSTOMER_TOP_SHARE_PCT, customers.available ? customers.top_share_pct : null, "percent",
      { reason: UNAVAILABLE_REASON.NOT_ATTRIBUTABLE, calculation: customers.risk_calculation }),

    // ── Counts and the overall score ──
    m(METRIC.DUPLICATE_COUNT, duplicateCount, "count"),
    m(METRIC.TRANSACTION_COUNT, transactionCount, "count"),
    m(METRIC.HEALTH_OVERALL, riskScore && riskScore.available ? riskScore.overall : null, "score",
      { reason: UNAVAILABLE_REASON.INSUFFICIENT_EVIDENCE, calculation: riskScore ? riskScore.calculation : null })
  ];
}

module.exports = { buildMetrics, metricOrUnavailable };
