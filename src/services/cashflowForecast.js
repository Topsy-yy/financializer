// Deterministic cash-flow projection. Pure math (no AI) — the AI only narrates
// the numbers this produces, never recomputes them.
//
// JOB 6: the horizon, series and cutoff constants were literals here AND
// declared as FORECAST in domain/analysis/thresholds.js, which this file did not
// import — two copies that could drift. They now come from the one definition.
//
// This is a LINEAR run-rate projection: it assumes the current monthly net
// repeats unchanged. It is not a trend model and does not claim to be; the
// horizon numbers are "if nothing changes", which is what makes it explainable.

const { FORECAST } = require("../domain/rules/registry");
const { num } = require("../domain/calculators/shared");

/**
 * Project cash balance forward from the current position at the current run-rate.
 * @param {object} input
 *   startingCash        current cash on hand
 *   monthlyNet          net cash flow per month (+ surplus / - burn)
 *   monthlyBurn         gross monthly outflow-over-inflow (>= 0)
 *   overdueReceivables  money owed to the business (optimistic inflow scenario)
 */
/** The inputs a projection cannot be produced without. */
const REQUIRED_INPUTS = Object.freeze([
  ["startingCash", "a measured cash position"],
  ["monthlyNet", "net cash flow"],
  ["monthlyBurn", "a monthly burn rate"]
]);

/** Finite number, or null. Never a fallback — that is the whole point here. */
function measured(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function computeCashflowForecast(input) {
  const source = input || {};

  /* NO ZERO FALLBACKS. This used `num(x, 0)`, which turns null, undefined, NaN
   * and Infinity into 0 — so an unmeasured cash position became a projection
   * starting from zero, and every horizon, the days-to-zero figure and the
   * status ("critical") were computed from a number nobody supplied. A forecast
   * is a claim about what happens to this business next quarter; it is the last
   * place a missing value may quietly become a zero.
   *
   * The HTTP callers already refuse before reaching here, but a module that
   * fabricates a projection when called directly is one call site away from
   * doing it again. It now refuses on its own account.
   *
   * A MEASURED ZERO REMAINS VALID: `measured(0)` is 0, not null, so a business
   * that genuinely has no cash is projected normally. Only the absence of a
   * measurement is refused. */
  const values = {};
  const missing = [];
  REQUIRED_INPUTS.forEach(([key, label]) => {
    const v = measured(source[key]);
    if (v === null) missing.push({ input: key, detail: label });
    values[key] = v;
  });

  if (missing.length) {
    return Object.freeze({
      available: false,
      reason: "unmeasured_input",
      missing: Object.freeze(missing.map((m) => m.input)),
      detail: "A cash-flow projection cannot be produced without "
        + missing.map((m) => m.detail).join(", ")
        + ". Values that were not measured are not substituted with zero.",
      // Explicitly null rather than absent, so a consumer reading these fields
      // gets nothing rather than something that looks like a result.
      starting_cash: null, monthly_net: null, monthly_burn: null,
      days_to_zero: null, status: null, horizons: null, series: null,
      optimistic_30d_balance: null,
      method: "linear_run_rate",
      forecast_version: FORECAST.version
    });
  }

  const startingCash = values.startingCash;
  const monthlyNet = values.monthlyNet;
  const monthlyBurn = values.monthlyBurn;
  /* OPTIONAL. Overdue receivables gate only the optimistic scenario, which is
     omitted entirely when there are none. Treating "not measured" as "none"
     therefore withholds an optimistic figure rather than inventing one, which
     is the conservative direction. */
  const overdue = num(source.overdueReceivables, 0);
  const dailyNet = monthlyNet / FORECAST.daysPerMonth;

  const horizons = FORECAST.horizonDays.map((days) => ({
    days,
    projected_balance: Math.round(startingCash + dailyNet * days)
  }));

  // Days until cash hits zero, only meaningful when burning cash.
  let daysToZero = null;
  if (monthlyNet < 0 && startingCash > 0) {
    daysToZero = Math.floor(startingCash / (Math.abs(monthlyNet) / FORECAST.daysPerMonth));
  }

  let status = "surplus";
  if (monthlyNet < 0) {
    status = daysToZero != null && daysToZero <= FORECAST.criticalDaysToZero ? "critical" : "burning";
  }

  // Balance path for the chart: now, +1, +2, +3 months.
  const series = FORECAST.seriesMonths.map((m) => ({
    label: m === 0 ? "Now" : `+${m}mo`,
    balance: Math.round(startingCash + monthlyNet * m)
  }));

  // Optimistic: overdue receivables collected within 30 days.
  const optimistic30d = overdue > 0
    ? Math.round(startingCash + overdue + dailyNet * FORECAST.daysPerMonth)
    : null;

  return {
    available: true,
    starting_cash: Math.round(startingCash),
    monthly_net: Math.round(monthlyNet),
    monthly_burn: Math.round(monthlyBurn),
    overdue_receivables: Math.round(overdue),
    days_to_zero: daysToZero,
    status,
    horizons,
    series,
    optimistic_30d_balance: optimistic30d,
    method: "linear_run_rate",
    forecast_version: FORECAST.version,
    skills: ["cashflow-risk-analyzer", "cashflow-forecaster"]
  };
}

module.exports = { computeCashflowForecast };
