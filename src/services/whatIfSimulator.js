// AI What-If Simulator — deterministic "before vs after" modelling of a business
// decision. It REUSES the cash-flow forecast engine (computeCashflowForecast);
// it never re-implements forecasting. Each scenario is reduced to a small set of
// deltas applied to the current run-rate, then both the baseline and the adjusted
// position are run through the same forecaster so the two are strictly comparable.
//
// The AI only narrates the numbers this produces (see /api/what-if); all figures
// here are pure math.

const { computeCashflowForecast } = require("./cashflowForecast");
// EVERY number below comes from the authoritative domain implementation. This
// module used to re-declare the 0.3/0.2/0.2/0.15/0.15 weights, the category
// cut-offs AND its own three-valued cash-flow score, giving the product two
// sources of truth that had already drifted apart.
const { weightedScore, categoryFor } = require("../domain/analysis/riskAggregation");
const { computeCashflowRisk } = require("../domain/calculators/cashflow");

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
function round(v) {
  return Math.round(num(v));
}

// Scenario catalogue — the single source of truth the client mirrors so its form
// fields always match what the server understands.
const SCENARIOS = {
  increase_payroll: {
    label: "Increase payroll",
    hint: "Add a recurring monthly staff cost.",
    inputs: [{ key: "amount", label: "Extra monthly payroll", type: "money", default: 50000 }]
  },
  reduce_revenue: {
    label: "Reduce revenue",
    hint: "Model a drop in monthly sales.",
    inputs: [{ key: "percent", label: "Revenue drop (%)", type: "percent", default: 20 }]
  },
  hire_employees: {
    label: "Hire employees",
    hint: "Add headcount at an average monthly salary.",
    inputs: [
      { key: "count", label: "New hires", type: "number", default: 2 },
      { key: "salary", label: "Avg monthly salary each", type: "money", default: 60000 }
    ]
  },
  increase_rent: {
    label: "Increase rent",
    hint: "A higher recurring monthly rent.",
    inputs: [{ key: "amount", label: "Extra monthly rent", type: "money", default: 30000 }]
  },
  large_purchase: {
    label: "Large purchase",
    hint: "A one-time cash outlay (equipment, inventory).",
    inputs: [{ key: "amount", label: "Purchase amount", type: "money", default: 200000 }]
  },
  loan_repayment: {
    label: "Loan repayment",
    hint: "A recurring monthly loan repayment.",
    inputs: [
      { key: "amount", label: "Monthly repayment", type: "money", default: 40000 },
      { key: "months", label: "Term (months)", type: "number", default: 12 }
    ]
  },
  custom: {
    label: "Custom scenario",
    hint: "Any change: a monthly net effect and/or a one-time cash change.",
    inputs: [
      { key: "label", label: "Scenario name", type: "text", default: "" },
      { key: "monthlyNetDelta", label: "Monthly net change (+/-)", type: "signed-money", default: 0 },
      { key: "oneTimeCashDelta", label: "One-time cash change (+/-)", type: "signed-money", default: 0 }
    ]
  }
};

// Reduce a scenario to deltas against the current run-rate:
//   monthlyNetDelta   change to net cash flow per month (negative = worse)
//   monthlyBurnDelta  change to gross monthly burn (for display)
//   oneTimeCashDelta  immediate change to cash on hand (negative = spend)
//   revenueDelta      change to monthly revenue (feeds the health re-score)
function computeDeltas(type, params, baseline) {
  const p = params || {};
  const revenue = num(baseline.monthlyRevenue);
  const mk = (monthlyNetDelta, monthlyBurnDelta, oneTimeCashDelta, revenueDelta, summary) => ({
    monthlyNetDelta: round(monthlyNetDelta),
    monthlyBurnDelta: round(monthlyBurnDelta),
    oneTimeCashDelta: round(oneTimeCashDelta),
    revenueDelta: round(revenueDelta),
    summary
  });

  switch (type) {
    case "increase_payroll": {
      const a = Math.abs(num(p.amount));
      return mk(-a, a, 0, 0, `Payroll up ${round(a)}/mo`);
    }
    case "increase_rent": {
      const a = Math.abs(num(p.amount));
      return mk(-a, a, 0, 0, `Rent up ${round(a)}/mo`);
    }
    case "hire_employees": {
      const c = Math.max(0, Math.round(num(p.count)));
      const s = Math.abs(num(p.salary));
      const cost = c * s;
      return mk(-cost, cost, 0, 0, `${c} new hire(s) at ${round(s)}/mo`);
    }
    case "loan_repayment": {
      const a = Math.abs(num(p.amount));
      return mk(-a, a, 0, 0, `Loan repayment ${round(a)}/mo`);
    }
    case "large_purchase": {
      const a = Math.abs(num(p.amount));
      return mk(0, 0, -a, 0, `One-time purchase of ${round(a)}`);
    }
    case "reduce_revenue": {
      let drop = Math.abs(num(p.amount));
      if (!drop && p.percent != null) drop = revenue * clamp(num(p.percent), 0, 100) / 100;
      return mk(-drop, 0, 0, -drop, `Revenue down ${round(drop)}/mo`);
    }
    case "custom": {
      const netD = num(p.monthlyNetDelta);
      const cashD = num(p.oneTimeCashDelta);
      // Extra recurring spend also raises gross burn; extra income does not.
      const burnD = netD < 0 ? -netD : 0;
      return mk(netD, burnD, cashD, 0, p.label ? String(p.label) : "Custom scenario");
    }
    default:
      return mk(0, 0, 0, 0, "No change");
  }
}

// --- Deterministic health re-score ---------------------------------------
// Only the two components a scenario can actually move (cash flow, revenue) are
// recomputed; fraud / vendor / customer are held at their MEASURED values.
//
// JOB 6 FIX. This function previously scored the hypothetical cash position with
// its own three-valued lookup — high=80 / medium=55 / low=25, yielding component
// scores of only 20, 45 or 75. That is the same dead branch the audit found in
// api.js, reproduced here: a scenario was scored by different arithmetic than the
// dashboard it was displayed next to, so a change that moved the real risk score
// by 8 points could show as no change at all. It now calls the authoritative
// computeCashflowRisk().
//
// JOB 6 FIX. Unmeasured components were substituted with 60, which defeated the
// null-preserving renormalisation in weightedScore(): a business with no
// attributable customers was scored as if its customer risk had been measured
// and found average. Unmeasured components are now passed through as null.
function cashflowScoreFrom(monthlyNet, startingCash) {
  // Model the hypothetical position the same way the engine models the real one.
  const monthlyBurn = monthlyNet < 0 ? Math.abs(monthlyNet) : 0;
  const runwayMonths = monthlyBurn > 0
    ? (startingCash > 0 ? startingCash / monthlyBurn : 0)
    : Infinity; // not burning
  const { risk_score } = computeCashflowRisk({
    netCashFlow: monthlyNet,
    monthlyBurn,
    runwayMonths,
    overdueReceivables: null,
    inflow: 0
  });
  return clamp(100 - risk_score, 0, 100);
}
// Delegates to the authoritative category bands.
function healthCategory(score) {
  return categoryFor(score);
}
/** A measured component score, or NULL when it was never measured. */
function measured(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function recomputeHealth(baseline, monthlyNet, startingCash, revenueDelta) {
  const cs = (baseline && baseline.componentScores) || {};
  const revenue = num(baseline.monthlyRevenue);
  let revenueScore = measured(cs.revenue_stability);
  if (revenueDelta && revenue > 0 && revenueScore != null) {
    // A proportional revenue shift nudges the revenue-stability component.
    revenueScore = clamp(revenueScore + (revenueDelta / revenue) * 40, 0, 100);
  }
  const cashflowScore = cashflowScoreFrom(monthlyNet, startingCash);
  // Single source of truth for the weighting AND for how unmeasured components
  // are excluded and the remaining weights renormalised.
  const { score: overall, covered } = weightedScore({
    cash_flow: cashflowScore,
    fraud_indicators: measured(cs.fraud_indicators),
    revenue_stability: revenueScore,
    vendor_risk: measured(cs.vendor_risk),
    customer_risk: measured(cs.customer_risk)
  });
  return {
    score: overall,
    category: overall == null ? "Unknown" : healthCategory(overall),
    cashflow_score: Math.round(cashflowScore),
    revenue_score: revenueScore == null ? null : Math.round(revenueScore),
    // Visible when a scenario is scored on part of the model only.
    weight_covered: covered
  };
}

function dir(delta) {
  return delta > 0 ? "better" : delta < 0 ? "worse" : "same";
}
function runwayDir(before, after) {
  if (before == null && after == null) return "same"; // never depleting either way
  if (after == null) return "better"; // was depleting, now stable
  if (before == null) return "worse"; // was stable, now depleting
  return dir(after - before);
}
function statusRank(s) {
  return s === "surplus" ? 2 : s === "burning" ? 1 : 0; // critical = 0
}
function statusDir(before, after) {
  return dir(statusRank(after) - statusRank(before));
}

function buildRiskChanges(fb, fa, hb, ha) {
  return [
    {
      label: "90-day cash balance",
      before: fb.horizons[2].projected_balance,
      after: fa.horizons[2].projected_balance,
      format: "money",
      direction: dir(fa.horizons[2].projected_balance - fb.horizons[2].projected_balance)
    },
    {
      label: "Runway (days to zero)",
      before: fb.days_to_zero,
      after: fa.days_to_zero,
      format: "days",
      direction: runwayDir(fb.days_to_zero, fa.days_to_zero)
    },
    {
      label: "Cash status",
      before: fb.status,
      after: fa.status,
      format: "text",
      direction: statusDir(fb.status, fa.status)
    },
    {
      label: "Health score",
      before: hb.score,
      after: ha.score,
      format: "score",
      direction: dir(ha.score - hb.score)
    }
  ];
}

/**
 * Run a what-if simulation.
 * @param {object} input
 *   type      scenario id (key of SCENARIOS)
 *   params    scenario inputs (amounts, counts, etc.)
 *   baseline  { startingCash, monthlyNet, monthlyBurn, overdueReceivables,
 *               monthlyRevenue, componentScores }
 */
/** Finite number, or null. No fallback — a missing measurement stays missing. */
function measured(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function simulate(input) {
  const baseline = (input && input.baseline) || {};
  const type = (input && input.type) || "custom";
  const params = (input && input.params) || {};

  /* NO ZERO FALLBACKS IN THE BASELINE. `num(x)` defaults to 0, so an unmeasured
   * cash position, net flow or burn rate became a scenario projected from
   * zero — and a what-if answer is advice about a decision the owner is about
   * to make. The HTTP and capability callers already refuse first; a module
   * that fabricates a baseline when called directly is one call site away from
   * doing it again.
   *
   * A MEASURED ZERO IS STILL VALID: only a missing measurement is refused. */
  const startingCash = measured(baseline.startingCash);
  const monthlyNet = measured(baseline.monthlyNet);
  const monthlyBurn = measured(baseline.monthlyBurn);

  const missing = [
    [startingCash, "startingCash", "a measured cash position"],
    [monthlyNet, "monthlyNet", "net cash flow"],
    [monthlyBurn, "monthlyBurn", "a monthly burn rate"]
  ].filter(([v]) => v === null);

  if (missing.length) {
    return Object.freeze({
      available: false,
      reason: "unmeasured_baseline",
      missing: Object.freeze(missing.map((m) => m[1])),
      detail: "A scenario cannot be simulated without "
        + missing.map((m) => m[2]).join(", ")
        + ". Values that were not measured are not substituted with zero.",
      /* The REAL result fields, explicitly nulled, so a consumer that reads
         them gets nothing rather than `undefined` — which reads as "not set"
         and is easy to skip past. */
      scenario: null, baseline: null, adjusted: null,
      forecast_before: null, forecast_after: null,
      health_before: null, health_after: null, risk_changes: null
    });
  }

  // Optional: gates only the optimistic branch of the projection.
  const overdue = num(baseline.overdueReceivables, 0);

  const deltas = computeDeltas(type, params, baseline);
  const adjStart = startingCash + deltas.oneTimeCashDelta;
  const adjNet = monthlyNet + deltas.monthlyNetDelta;
  const adjBurn = Math.max(0, monthlyBurn + deltas.monthlyBurnDelta);

  // Same engine, run twice — this is the whole point (no second forecaster).
  const forecastBefore = computeCashflowForecast({
    startingCash, monthlyNet, monthlyBurn, overdueReceivables: overdue
  });
  const forecastAfter = computeCashflowForecast({
    startingCash: adjStart, monthlyNet: adjNet, monthlyBurn: adjBurn, overdueReceivables: overdue
  });

  // Both scored with the same method so the delta reflects only the scenario.
  const healthBefore = recomputeHealth(baseline, monthlyNet, startingCash, 0);
  const healthAfter = recomputeHealth(baseline, adjNet, adjStart, deltas.revenueDelta);

  return {
    scenario: {
      type,
      label: (SCENARIOS[type] && SCENARIOS[type].label) || "Scenario",
      summary: deltas.summary,
      params,
      deltas
    },
    baseline: { starting_cash: round(startingCash), monthly_net: round(monthlyNet), monthly_burn: round(monthlyBurn) },
    adjusted: { starting_cash: round(adjStart), monthly_net: round(adjNet), monthly_burn: round(adjBurn) },
    forecast_before: forecastBefore,
    forecast_after: forecastAfter,
    health_before: healthBefore,
    health_after: healthAfter,
    risk_changes: buildRiskChanges(forecastBefore, forecastAfter, healthBefore, healthAfter),
    skills: ["cashflow-forecaster", "financial-health-scorer", "scenario-simulator"]
  };
}

module.exports = { SCENARIOS, simulate };
