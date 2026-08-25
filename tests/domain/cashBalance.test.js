// JOB 12 PART D — cash-balance semantics.
//
// THE DEFECT. When an upload supplies no cash balance, ingestion derives one as
// `Math.max(0, netIncome)` and writes it into the balance sheet
// indistinguishably from an observed figure. Every downstream consumer then
// treated an inference as an observation.
//
// WHY THAT DERIVATION IS NOT DEFENSIBLE AS A CASH BALANCE:
//
//   A NET INCOME IS A FLOW; A CASH BALANCE IS A STOCK. One period's profit says
//   nothing about the money in the account, which accumulates across every
//   prior period and includes financing and capital movements this calculation
//   never sees.
//
//   THE CLAMP MANUFACTURES INSOLVENCY. Any loss-making month derives exactly 0,
//   producing `cash_on_hand: 0` and a runway of 0 — telling a business with
//   money in the bank that it has none and cannot make payroll. That is the
//   most alarming statement this system can make, and it was being made from an
//   input nobody supplied.
//
//   A PROFITABLE MONTH UNDERSTATES IT. Cash becomes that month's profit alone,
//   discarding everything accumulated before it.
//
// THE DECISION, asserted below: a derived balance is retained and LABELLED but
// is authoritative for nothing. The cash position and runway become UNAVAILABLE
// with an explicit reason. Zero is never substituted for unavailable.

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseFinancialCsv } = require("../../src/services/csvFinancialImporter");
const { computeCashflow } = require("../../src/domain/calculators/cashflow");
const { assessDataQuality } = require("../../src/domain/model/dataQuality");
const { UNAVAILABLE_REASON } = require("../../src/domain/model/metric");
const { buildMetrics } = require("../../src/domain/analysis/metricSet");

const HEADER = "Date,Description,Amount,Counterparty";
const LOSS = [HEADER,
  "2026-05-03,Rent,-300000,Landlord Ltd",
  "2026-05-09,Software,-45000,SaaS Vendor"].join("\n");
const PROFIT = [HEADER,
  "2026-05-03,Client settlement,500000,BigCo",
  "2026-05-09,Rent,-100000,Landlord Ltd"].join("\n");
const BREAK_EVEN = [HEADER,
  "2026-05-03,Client settlement,100000,BigCo",
  "2026-05-09,Rent,-100000,Landlord Ltd"].join("\n");

function analyse(csv, currentCashBalance) {
  const monthlyData = parseFinancialCsv({
    csvText: csv, period: "2026-05", businessName: "Test Co", currentCashBalance
  });
  return { monthlyData, cashflow: computeCashflow(monthlyData, {}) };
}

// ── 1. OBSERVED ──────────────────────────────────────────────────
test("[CB1] an OBSERVED cash balance is used, and labelled observed", () => {
  const { cashflow } = analyse(LOSS, 1200000);

  assert.equal(cashflow.cash_on_hand, 1200000, "the supplied figure is used as-is");
  assert.equal(cashflow.cash_on_hand_basis, "observed");
  assert.equal(cashflow.cash_on_hand_available, true);
  assert.equal(cashflow.cash_estimate, null, "there is no estimate -- it was observed");

  // Burn is 345,000; 1.2M / 345k = 3.5 months.
  assert.equal(cashflow.cash_runway_months, 3.5, "runway is computed from it");
  assert.equal(cashflow.cash_runway_unavailable_reason, null);
});

test("[CB1b] an observed ZERO is a real cash position, not an absence", () => {
  /* A business that tells us it has nothing is making a statement. That must
     not be confused with a business that told us nothing. */
  const { cashflow } = analyse(LOSS, 0);
  assert.equal(cashflow.cash_on_hand, 0, "zero is a value, and it is kept");
  assert.equal(cashflow.cash_on_hand_basis, "observed");
  assert.equal(cashflow.cash_on_hand_available, true,
    "an observed zero is AVAILABLE -- it is a measurement");
});

// ── 2-4. MISSING, across the sign of net income ──────────────────
test("[CB2] MISSING balance + NEGATIVE net income does not manufacture insolvency", () => {
  /* THE WORST CASE, and the reason for this whole change. `Math.max(0, -345000)`
     is 0, which used to become `cash_on_hand: 0` and `runway: 0` — a confident
     claim that the business is out of money, derived from an input nobody
     supplied. */
  const { cashflow } = analyse(LOSS, null);

  assert.equal(cashflow.cash_on_hand, null,
    "the cash position is UNAVAILABLE, not zero");
  assert.notEqual(cashflow.cash_on_hand, 0,
    "specifically NOT zero -- that would assert insolvency we cannot support");
  assert.equal(cashflow.cash_on_hand_basis, "derived_from_net_income");
  assert.equal(cashflow.cash_on_hand_unavailable_reason, "input_not_authoritative");

  assert.equal(cashflow.cash_runway_months, null, "and no runway is reported");
  assert.equal(cashflow.cash_runway_unavailable_reason, "cash_balance_not_observed",
    "with an explicit reason rather than a bare null");
  assert.equal(cashflow.never_depletes, false);

  // The derived figure is retained, labelled, and used by nothing.
  assert.equal(cashflow.cash_estimate, 0, "the estimate is not discarded");
  assert.equal(cashflow.cash_estimate_basis, "derived_from_net_income",
    "but it is unmistakably an estimate");
});

test("[CB3] MISSING balance + POSITIVE net income still reports no cash position", () => {
  const { cashflow } = analyse(PROFIT, null);

  assert.equal(cashflow.cash_on_hand, null,
    "a profitable month does not tell us the bank balance");
  assert.equal(cashflow.cash_estimate, 400000, "the derivation is retained as an estimate");
  assert.equal(cashflow.cash_estimate_basis, "derived_from_net_income");

  /* Net cash flow is POSITIVE, so the position is not depleting regardless of
     where it started. That is a real answer, and it is reported as one — with a
     reason, so a null month count is never a silent absence. */
  assert.equal(cashflow.never_depletes, true);
  assert.equal(cashflow.cash_runway_unavailable_reason, "not_depleting");
});

test("[CB4] MISSING balance + ZERO net income reports unavailable, not 'no cash'", () => {
  const { cashflow } = analyse(BREAK_EVEN, null);
  assert.equal(cashflow.cash_on_hand, null);
  assert.notEqual(cashflow.cash_on_hand, 0);
  assert.equal(cashflow.cash_runway_months, null);
  assert.equal(cashflow.cash_runway_unavailable_reason, "cash_balance_not_observed");
});

// ── 5-6. The metric layer carries it ─────────────────────────────
test("[CB5] the METRIC for a derived balance is unavailable with the right reason", () => {
  const { cashflow } = analyse(LOSS, null);
  const metrics = buildMetrics({
    calculations: { cashflow },
    findings: [],
    riskScore: { available: false },
    engineVersion: "test",
    period: "2026-05"
  });

  const cash = metrics.find((m) => m.key === "cash.on_hand");
  assert.ok(cash, "the cash metric is emitted");
  assert.equal(cash.available, false);
  assert.equal(cash.value, null, "null, NEVER 0");
  assert.equal(cash.reason, UNAVAILABLE_REASON.INPUT_NOT_AUTHORITATIVE,
    "'no data' would be wrong -- there IS a number, it is just not a cash balance");
  assert.match(cash.detail, /not a cash position|derived/i,
    "and it explains itself");

  const runway = metrics.find((m) => m.key === "cashflow.runway_months");
  assert.equal(runway.available, false);
  assert.equal(runway.value, null);
  assert.equal(runway.reason, UNAVAILABLE_REASON.INPUT_NOT_AUTHORITATIVE);
});

test("[CB6] an observed balance produces an AVAILABLE runway metric", () => {
  const { cashflow } = analyse(LOSS, 1200000);
  const metrics = buildMetrics({
    calculations: { cashflow },
    findings: [],
    riskScore: { available: false },
    engineVersion: "test",
    period: "2026-05"
  });

  const runway = metrics.find((m) => m.key === "cashflow.runway_months");
  assert.equal(runway.available, true, "an observed balance DOES yield a runway");
  assert.equal(runway.value, 3.5);
  assert.equal(runway.unit, "months");

  const cash = metrics.find((m) => m.key === "cash.on_hand");
  assert.equal(cash.available, true);
  assert.equal(cash.value, 1200000);
});

// ── Part E. Data quality reflects the derived input ──────────────
test("[CB7] the DataQualityReport records that an input was derived", () => {
  const derived = analyse(LOSS, null);
  const dq = assessDataQuality(derived.monthlyData, {});

  assert.equal(dq.hasDerivedInputs, true,
    "the analysis knows it ran on a partly-inferred input");
  assert.equal(dq.derivedInputs.length, 1);
  assert.equal(dq.derivedInputs[0].basis, "derived_from_net_income");
  assert.ok(dq.derivedInputs[0].affects.includes("cash_on_hand"),
    "and names what it affects, so a consumer can explain the consequence");
  assert.ok(dq.derivedInputs[0].detail, "with a human-readable explanation");
});

test("[CB8] an observed balance leaves the derived-input list EMPTY", () => {
  const observed = analyse(LOSS, 1200000);
  const dq = assessDataQuality(observed.monthlyData, {});
  assert.equal(dq.hasDerivedInputs, false);
  assert.deepEqual(dq.derivedInputs, [],
    "nothing was inferred, and the report does not imply otherwise");
});

test("[CB9] a derived input does NOT by itself degrade the quality level", () => {
  /* Deliberate. Nothing is missing, stale or failed — the affected metrics
     already report themselves unavailable, so downgrading the whole analysis
     would overstate the problem and make every unpriced upload look broken. */
  const derived = analyse(LOSS, null);
  const observed = analyse(LOSS, 1200000);
  assert.equal(
    assessDataQuality(derived.monthlyData, {}).level,
    assessDataQuality(observed.monthlyData, {}).level,
    "the level is unchanged; the DERIVATION is recorded separately");
});

// ── Regression guards ────────────────────────────────────────────
test("[CB10] the derivation is still LABELLED at the point it happens", () => {
  const { monthlyData } = analyse(LOSS, null);
  assert.equal(monthlyData.statements.balanceSheet.cashAndEquivalentsBasis,
    "derived_from_net_income",
    "the basis travels with the figure into the domain");
  assert.equal(monthlyData.meta.cashBalance.basis, "derived_from_net_income");
  assert.equal(monthlyData.meta.cashBalance.providedValue, null,
    "and records that nothing was provided");

  const observed = analyse(LOSS, 1200000);
  assert.equal(observed.monthlyData.statements.balanceSheet.cashAndEquivalentsBasis,
    "observed");
  assert.equal(observed.monthlyData.meta.cashBalance.providedValue, 1200000);
});

test("[CB11] an UNLABELLED balance is treated as observed, not silently dropped", () => {
  /* Sources that predate this labelling (Zoho, demo) supply a real retrieved
     balance and say nothing about basis. Defaulting those to "derived" would
     make previously-working runway figures vanish overnight, which is a
     regression dressed up as caution. */
  const cashflow = computeCashflow({
    period: "2026-05",
    transactions: [],
    statements: {
      cashFlow: { inflow: 100000, outflow: 300000 },
      balanceSheet: { cashAndEquivalents: 900000 }   // no basis field at all
    }
  }, {});

  assert.equal(cashflow.cash_on_hand, 900000, "an unlabelled balance is still used");
  assert.equal(cashflow.cash_on_hand_basis, "observed");
  assert.equal(cashflow.cash_runway_months, 4.5, "and runway is computed");
});

test("[CB12] a genuinely ABSENT balance is 'no data', not 'not authoritative'", () => {
  // The two absences are different and must not collapse.
  const cashflow = computeCashflow({
    period: "2026-05",
    transactions: [],
    statements: { cashFlow: { inflow: 100000, outflow: 300000 }, balanceSheet: {} }
  }, {});

  assert.equal(cashflow.cash_on_hand, null);
  assert.equal(cashflow.cash_on_hand_basis, null, "no figure, so no basis");
  assert.equal(cashflow.cash_on_hand_unavailable_reason, "no_data",
    "nothing was supplied at all -- distinct from a supplied-but-inferred figure");
  assert.equal(cashflow.cash_runway_unavailable_reason, "no_cash_balance");
});
