// Deterministic cash-flow projection. Pure math (no AI) — the AI only narrates
// the numbers this produces, never recomputes them.

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/**
 * Project cash balance forward from the current position at the current run-rate.
 * @param {object} input
 *   startingCash        current cash on hand
 *   monthlyNet          net cash flow per month (+ surplus / - burn)
 *   monthlyBurn         gross monthly outflow-over-inflow (>= 0)
 *   overdueReceivables  money owed to the business (optimistic inflow scenario)
 */
function computeCashflowForecast(input) {
  const startingCash = num(input.startingCash, 0);
  const monthlyNet = num(input.monthlyNet, 0);
  const monthlyBurn = num(input.monthlyBurn, 0);
  const overdue = num(input.overdueReceivables, 0);
  const dailyNet = monthlyNet / 30;

  const horizons = [30, 60, 90].map((days) => ({
    days,
    projected_balance: Math.round(startingCash + dailyNet * days)
  }));

  // Days until cash hits zero, only meaningful when burning cash.
  let daysToZero = null;
  if (monthlyNet < 0 && startingCash > 0) {
    daysToZero = Math.floor(startingCash / (Math.abs(monthlyNet) / 30));
  }

  let status = "surplus";
  if (monthlyNet < 0) {
    status = daysToZero != null && daysToZero <= 90 ? "critical" : "burning";
  }

  // Balance path for the chart: now, +1, +2, +3 months.
  const series = [0, 1, 2, 3].map((m) => ({
    label: m === 0 ? "Now" : `+${m}mo`,
    balance: Math.round(startingCash + monthlyNet * m)
  }));

  // Optimistic: overdue receivables collected within 30 days.
  const optimistic30d = overdue > 0
    ? Math.round(startingCash + overdue + dailyNet * 30)
    : null;

  return {
    starting_cash: Math.round(startingCash),
    monthly_net: Math.round(monthlyNet),
    monthly_burn: Math.round(monthlyBurn),
    overdue_receivables: Math.round(overdue),
    days_to_zero: daysToZero,
    status,
    horizons,
    series,
    optimistic_30d_balance: optimistic30d,
    skills: ["cashflow-risk-analyzer", "cashflow-forecaster"]
  };
}

module.exports = { computeCashflowForecast };
