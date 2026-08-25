// Revenue arithmetic. PURE: no HTTP, no fs, no database, no AI.

const { num, round1 } = require("./shared");

/**
 * Revenue for the period, and growth against the most recent prior period.
 *
 * Revenue is taken from the P&L when present, and falls back to cash inflow.
 * That fallback is CASH revenue, not accrual revenue — the two differ for a
 * business with receivables, so the source is reported alongside the number.
 *
 * @param {object} ctx { period, reviewHistory }
 */
function computeRevenue(data = {}, ctx = {}) {
  const pl = (data.statements && data.statements.profitAndLoss) || {};
  const cashFlow = (data.statements && data.statements.cashFlow) || {};

  const fromPL = pl.revenue != null;
  const fromCash = !fromPL && cashFlow.inflow != null;
  const available = fromPL || fromCash;
  const total = fromPL ? num(pl.revenue) : (fromCash ? num(cashFlow.inflow) : null);

  const history = Array.isArray(ctx.reviewHistory) ? ctx.reviewHistory : [];
  const prior = history
    .filter((h) => h && h.period && h.period < (ctx.period || ""))
    .slice(-1)[0];
  const priorRevenue = prior && prior.revenue != null ? num(prior.revenue) : null;

  // Growth needs a non-zero base: dividing by zero prior revenue is undefined,
  // not "infinite growth".
  let growthRate = null;
  if (total != null && priorRevenue != null && priorRevenue > 0) {
    growthRate = round1(((total - priorRevenue) / priorRevenue) * 100);
  }

  return Object.freeze({
    available,
    total_revenue: total,
    basis: fromPL ? "accrual_pl" : fromCash ? "cash_inflow" : null,
    prior_period_revenue: priorRevenue,
    prior_period: prior ? prior.period : null,
    growth_rate: growthRate,
    growth_calculation: growthRate == null ? null
      : `(${total} - ${priorRevenue}) / ${priorRevenue} x 100 = ${growthRate}%`,
    direction: growthRate == null ? "unknown"
      : growthRate > 0 ? "up" : growthRate < 0 ? "down" : "flat"
  });
}

module.exports = { computeRevenue };
