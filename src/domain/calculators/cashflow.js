// Cash-flow arithmetic. PURE: no HTTP, no fs, no database, no AI.
//
// This is THE cash-flow calculation. Before JOB 6 the same numbers were derived
// in three places — services/riskEngine.js, routes/api.js buildCashFlowSummary
// and services/whatIfSimulator.js — which disagreed with each other (see the
// JOB 6 inventory). Everything that needs a runway, a burn rate or a cash-flow
// risk score now calls this.
//
// Bug fixes preserved from the JOB 3 extraction:
//  * Overdue receivables are MEASURED, never estimated as `abs(net) * 0.35`.
//  * Runway reports null when it cannot be computed, instead of defaulting to
//    12 months and making an empty dataset look solvent.
//  * The risk score is returned as a continuous 0-100 number. api.js read
//    `cashflow.risk_score`, which nothing ever set, so the 30%-weighted health
//    component silently collapsed to one of three values.

const { CASHFLOW_RISK, getRule } = require("../rules/registry");
const { num, clamp, round1 } = require("./shared");
// The ONE authoritative reading of a cash balance. See domain/model/cashPosition.
const { readCashPosition, CASH_BASIS } = require("../model/cashPosition");

/**
 * @param {object} data normalized monthly dataset
 * @param {object} ctx  { now } — injected so results are reproducible
 */
function computeCashflow(data = {}, ctx = {}) {
  const cashFlow = (data.statements && data.statements.cashFlow) || {};
  // The statement's own currency. Statements arrive already aggregated by the
  // source in ONE currency, so unlike transaction-derived metrics there is
  // nothing here to mix — but the unit must still be carried, or a figure is
  // reported without saying what it is denominated in.
  const statementCurrency = (data.statements && data.statements.currency)
    || (ctx.baseCurrency || null);
  const balanceSheet = (data.statements && data.statements.balanceSheet) || {};
  // A period with no cash-flow statement is UNMEASURED, not a period of zeroes.
  const hasCashFlowStatement = Object.keys(cashFlow).length > 0;

  const inflow = num(cashFlow.inflow);
  const outflow = num(cashFlow.outflow);
  const netCashFlow = hasCashFlowStatement ? inflow - outflow : null;
  const monthlyBurn = hasCashFlowStatement ? Math.max(0, outflow - inflow) : null;
  /* ── THE CASH BALANCE, AND WHETHER IT MAY BE USED ────────────────
   *
   * THE DEFECT. When an upload supplies no cash balance, ingestion derives one
   * as `Math.max(0, netIncome)` and writes it into the balance sheet
   * indistinguishably from an observed figure. That derivation is not
   * financially defensible as a cash position, and the consequences were not
   * small:
   *
   *   A NET INCOME IS A FLOW; A CASH BALANCE IS A STOCK. One period's profit
   *   says nothing about the money in the account, which is the accumulation of
   *   every prior period plus financing and capital movements this calculation
   *   never sees.
   *
   *   THE CLAMP MANUFACTURES INSOLVENCY. Any loss-making month derives exactly
   *   0, which produces `cash_on_hand: 0` and a runway of 0 — telling a
   *   business with money in the bank that it has none and is out of runway.
   *   That is the most alarming statement this system can make, and it was
   *   being made from an input nobody supplied.
   *
   *   A PROFITABLE MONTH UNDERSTATES IT. Cash becomes that month's profit
   *   alone, discarding every shilling accumulated before it.
   *
   * THE DECISION. A DERIVED balance is not authoritative for runway or for the
   * reported cash position, so those become UNAVAILABLE with an explicit
   * reason. The estimate is not thrown away — it is surfaced separately and
   * labelled — but it is never presented as an observation, and no metric is
   * computed from it. An unavailable runway is a worse-looking output than a
   * confident one; it is a far better one than a fabricated number about
   * whether a business can pay its staff next month.
   *
   * Zero is NOT substituted for unavailable anywhere below.
   */
  /* Classified by the ONE authoritative accessor (domain/model/cashPosition),
     so this calculator and the custom-rules engine cannot disagree about what
     counts as a usable cash balance. */
  const cashPosition = readCashPosition(balanceSheet);
  const rawCash = cashPosition.available ? cashPosition.value : cashPosition.estimate;
  const cashBasis = cashPosition.basis === CASH_BASIS.ABSENT ? null : cashPosition.basis;
  const cashObserved = cashPosition.available;

  // Only an OBSERVED balance may be used as the cash position.
  const cash = cashPosition.value;
  // The derived figure, kept visible and labelled, used by nothing.
  const cashEstimate = cashPosition.estimate;

  // Runway needs BOTH an observed cash balance and a burn rate.
  let runwayMonths = null;
  if (cash != null && monthlyBurn != null && monthlyBurn > 0) {
    runwayMonths = round1(cash / monthlyBurn);
  } else if (netCashFlow != null && (netCashFlow > 0 || (netCashFlow === 0 && cash > 0))) {
    // Not burning — distinct from "unknown".
    //
    // JOB 6 BUG FIX: this previously required only `cash != null && net >= 0`,
    // so a business with ZERO cash and zero movement was reported as "never
    // depletes" — nothing lasting forever. A position only never depletes if it
    // is growing, or if there is a positive balance that is not shrinking.
    runwayMonths = Infinity;
  } else if (cash === 0 && monthlyBurn === 0) {
    runwayMonths = 0; // no cash, and none coming in
  }

  const overdueReceivables = computeOverdueReceivables(data, ctx);

  return Object.freeze({
    available: hasCashFlowStatement,
    currency: statementCurrency,
    inflow: hasCashFlowStatement ? inflow : null,
    outflow: hasCashFlowStatement ? outflow : null,
    net_cash_flow: netCashFlow,
    monthly_burn: monthlyBurn,
    // Only ever an OBSERVED position. Null when the only figure available was
    // derived — never the estimate, and never zero.
    cash_on_hand: cash,
    /* PROVENANCE, so no consumer has to guess:
         "observed"                -> supplied by the source
         "derived_from_net_income" -> inferred; NOT used for any metric
         null                      -> no figure at all                        */
    cash_on_hand_basis: cashBasis,
    cash_on_hand_available: cashObserved,
    cash_on_hand_unavailable_reason: cashPosition.unavailableReason,
    /* The derived estimate, retained and LABELLED. Nothing computes from it;
       it exists so the figure is not silently discarded and so a caller can
       show "estimated from this period's net income" if it chooses to. */
    cash_estimate: cashEstimate,
    cash_estimate_basis: cashEstimate == null ? null : cashBasis,
    cash_runway_months: runwayMonths === Infinity ? null : runwayMonths,
    /* WHY runway is missing, when it is. A null with no reason is what let a
       fabricated 0 look reasonable in the first place. */
    cash_runway_unavailable_reason: (() => {
      /* `runwayMonths === Infinity` is serialized as a null month count, so
         without this the caller would see "no runway figure and no reason".
         Not depleting is an ANSWER, not an absence -- it is reported as one. */
      if (runwayMonths === Infinity) return "not_depleting";
      if (runwayMonths != null) return null;
      if (!cashObserved) {
        return rawCash == null ? "no_cash_balance" : "cash_balance_not_observed";
      }
      return monthlyBurn == null ? "no_cash_flow_statement" : null;
    })(),
    never_depletes: runwayMonths === Infinity,
    runway_days: runwayMonths == null || runwayMonths === Infinity ? null : Math.round(runwayMonths * 30),
    overdue_receivables: overdueReceivables,
    overdue_receivables_measured: Array.isArray(data.receivables),
    ...computeCashflowRisk({ netCashFlow, monthlyBurn, runwayMonths, overdueReceivables, inflow })
  });
}

/** Overdue receivables, measured from the source only — never estimated. */
function computeOverdueReceivables(data, ctx) {
  const receivables = Array.isArray(data.receivables) ? data.receivables : null;
  if (!receivables) return null;
  const now = ctx.now == null ? Date.now() : ctx.now;
  return receivables.reduce((sum, r) => {
    const due = Date.parse(r.dueDate || r.due_date || "");
    const balance = r.balance != null ? num(r.balance) : num(r.amount);
    return Number.isFinite(due) && due < now && balance > 0 ? sum + balance : sum;
  }, 0);
}

/**
 * THE cash-flow risk score: additive points, clamped to 0-100.
 *
 * Exported separately because the what-if simulator scores a HYPOTHETICAL
 * cash position. Before JOB 6 it used its own three-valued lookup
 * (high=80 / medium=55 / low=25), so a scenario was scored by different
 * arithmetic than the dashboard it was compared against.
 *
 * @param {object} position { netCashFlow, monthlyBurn, runwayMonths, overdueReceivables, inflow }
 *   runwayMonths may be Infinity (not burning) or null (unknown); neither adds points.
 */
function computeCashflowRisk(position = {}) {
  const { netCashFlow, monthlyBurn, runwayMonths, overdueReceivables, inflow } = position;
  const p = CASHFLOW_RISK;
  const reasons = [];
  let score = p.baseline;
  reasons.push(`baseline ${p.baseline}`);

  if (netCashFlow != null && netCashFlow < 0) {
    score += p.negativeNetCashFlow;
    reasons.push(`negative net cash flow +${p.negativeNetCashFlow}`);
  }
  if (monthlyBurn != null && monthlyBurn > 0) {
    score += p.hasBurn;
    reasons.push(`burning cash +${p.hasBurn}`);
  }
  // Bands are CUMULATIVE: a 2-month runway scores both. Preserved from v1.
  if (runwayMonths != null && runwayMonths !== Infinity) {
    if (runwayMonths < getRule("cashflow_runway").params.warningMonths) {
      score += p.runwayUnderWarningMonths;
      reasons.push(`runway under ${getRule("cashflow_runway").params.warningMonths}mo +${p.runwayUnderWarningMonths}`);
    }
    if (runwayMonths < getRule("cashflow_runway").params.criticalMonths) {
      score += p.runwayUnderCriticalMonths;
      reasons.push(`runway under ${getRule("cashflow_runway").params.criticalMonths}mo +${p.runwayUnderCriticalMonths}`);
    }
  }
  if (overdueReceivables != null && inflow > 0 &&
      overdueReceivables / inflow > p.overdueReceivablesRatio) {
    score += p.overdueReceivablesPoints;
    reasons.push(`overdue receivables over ${p.overdueReceivablesRatio * 100}% of inflow +${p.overdueReceivablesPoints}`);
  }

  const risk_score = clamp(score, 0, 100);
  return {
    risk_score,
    risk_level: risk_score >= p.severityHighAt ? "high"
      : risk_score >= p.severityMediumAt ? "medium" : "low",
    risk_calculation: `${reasons.join(" + ")} = ${score}${score !== risk_score ? ` (clamped to ${risk_score})` : ""}`
  };
}

module.exports = { computeCashflow, computeCashflowRisk, computeOverdueReceivables };
