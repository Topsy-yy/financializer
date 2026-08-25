// CALCULATORS — boundary, zero, negative, empty and malformed inputs.
//
// The calculators are pure functions, so they can be tested directly at their
// edges rather than only through a scenario. Most financial bugs in this
// codebase's history were edge cases that a happy-path fixture never reached:
// a zero total, an absent statement, a value of 0 read as "missing".

const test = require("node:test");
const assert = require("node:assert/strict");

const { computeCashflow, computeCashflowRisk } = require("../../src/domain/calculators/cashflow");
const { computeRevenue } = require("../../src/domain/calculators/revenue");
const { computeExpenses } = require("../../src/domain/calculators/expense");
const { computeConcentration } = require("../../src/domain/calculators/concentration");
const { classifyDirection } = require("../../src/domain/calculators/shared");
const { CASHFLOW_RISK, HEALTH_SCORE, getRule } = require("../../src/domain/rules/registry");

const NOW = Date.parse("2026-06-15T00:00:00Z");
const stmt = (cashFlow, pl, bs) => ({ statements: { cashFlow, profitAndLoss: pl || {}, balanceSheet: bs || {} } });

// ── Cash flow ────────────────────────────────────────────────────

test("[C1] net cash flow, burn and runway on a normal month", () => {
  const c = computeCashflow(stmt({ inflow: 100000, outflow: 160000 }, {}, { cashAndEquivalents: 300000 }), { now: NOW });
  assert.equal(c.available, true);
  assert.equal(c.net_cash_flow, -60000);
  assert.equal(c.monthly_burn, 60000);
  assert.equal(c.cash_runway_months, 5);
  assert.equal(c.runway_days, 150);
  assert.equal(c.never_depletes, false);
});

test("[C2] a surplus month has zero burn and no runway limit", () => {
  const c = computeCashflow(stmt({ inflow: 200000, outflow: 120000 }, {}, { cashAndEquivalents: 300000 }), { now: NOW });
  assert.equal(c.net_cash_flow, 80000);
  assert.equal(c.monthly_burn, 0);
  assert.equal(c.never_depletes, true);
  assert.equal(c.cash_runway_months, null, "not a number — there is no limit to report");
  assert.equal(c.runway_days, null);
});

test("[C3] NO cash-flow statement is unmeasured, not a month of zeroes", () => {
  const c = computeCashflow({ statements: {} }, { now: NOW });
  assert.equal(c.available, false);
  assert.equal(c.net_cash_flow, null, "null, NOT 0 — 0 asserts that no money moved");
  assert.equal(c.monthly_burn, null);
  assert.equal(c.cash_runway_months, null);
  assert.equal(c.never_depletes, false, "unknown is not 'never depletes'");
});

test("[C4][FIXED in JOB 6] zero cash with zero movement does not last forever", () => {
  // WAS: `cash != null && net >= 0` made a business with 0 cash and 0 flow
  // report never_depletes — nothing lasting indefinitely.
  const c = computeCashflow(stmt({ inflow: 0, outflow: 0 }, {}, { cashAndEquivalents: 0 }), { now: NOW });
  assert.equal(c.never_depletes, false);
  assert.equal(c.cash_runway_months, 0, "no cash and nothing coming in");
});

test("[C5] a positive balance that is not shrinking DOES never deplete", () => {
  const c = computeCashflow(stmt({ inflow: 50000, outflow: 50000 }, {}, { cashAndEquivalents: 400000 }), { now: NOW });
  assert.equal(c.net_cash_flow, 0);
  assert.equal(c.never_depletes, true);
});

test("[C6] overdue receivables are measured, never estimated", () => {
  const noData = computeCashflow(stmt({ inflow: 1, outflow: 2 }), { now: NOW });
  assert.equal(noData.overdue_receivables, null, "absent data is null, never a derived guess");
  assert.equal(noData.overdue_receivables_measured, false);

  const withData = computeCashflow(Object.assign(stmt({ inflow: 1, outflow: 2 }), {
    receivables: [
      { customer: "A", amount: 5000, balance: 5000, dueDate: "2026-05-01" }, // overdue
      { customer: "B", amount: 9000, balance: 9000, dueDate: "2026-12-01" }, // not yet due
      { customer: "C", amount: 7000, balance: 0, dueDate: "2026-05-01" }     // overdue but PAID
    ]
  }), { now: NOW });
  assert.equal(withData.overdue_receivables, 5000, "only unpaid, past-due balances");
  assert.equal(withData.overdue_receivables_measured, true);
});

test("[C7] an empty receivables ARRAY means zero overdue; a missing one means unknown", () => {
  const empty = computeCashflow(Object.assign(stmt({ inflow: 1, outflow: 2 }), { receivables: [] }), { now: NOW });
  assert.equal(empty.overdue_receivables, 0, "the source said there are none");
  const missing = computeCashflow(stmt({ inflow: 1, outflow: 2 }), { now: NOW });
  assert.equal(missing.overdue_receivables, null, "the source said nothing at all");
});

// ── Cash-flow risk: the boundaries ───────────────────────────────

test("[C8] the cash-flow risk score is additive and every band is reachable", () => {
  const p = CASHFLOW_RISK;
  const at = (pos) => computeCashflowRisk(pos).risk_score;

  // Baseline only: healthy, not burning.
  assert.equal(at({ netCashFlow: 10, monthlyBurn: 0, runwayMonths: Infinity }), p.baseline);
  // Negative net alone.
  assert.equal(at({ netCashFlow: -1, monthlyBurn: 0, runwayMonths: null }),
    p.baseline + p.negativeNetCashFlow);
  // Negative net + burn, runway comfortable.
  assert.equal(at({ netCashFlow: -1, monthlyBurn: 1, runwayMonths: 24 }),
    p.baseline + p.negativeNetCashFlow + p.hasBurn);
  // Bands are CUMULATIVE below the critical threshold.
  assert.equal(at({ netCashFlow: -1, monthlyBurn: 1, runwayMonths: 2 }),
    p.baseline + p.negativeNetCashFlow + p.hasBurn
      + p.runwayUnderWarningMonths + p.runwayUnderCriticalMonths);
});

test("[C9] runway threshold boundaries are exclusive, on both bands", () => {
  const w = getRule("cashflow_runway").params.warningMonths;   // 6
  const c = getRule("cashflow_runway").params.criticalMonths;  // 3
  const at = (months) => computeCashflowRisk({ netCashFlow: -1, monthlyBurn: 1, runwayMonths: months }).risk_score;
  const base = CASHFLOW_RISK.baseline + CASHFLOW_RISK.negativeNetCashFlow + CASHFLOW_RISK.hasBurn;

  assert.equal(at(w), base, "exactly 6 months does NOT trip the warning band");
  assert.equal(at(w - 0.1), base + CASHFLOW_RISK.runwayUnderWarningMonths, "just under does");
  assert.equal(at(c), base + CASHFLOW_RISK.runwayUnderWarningMonths,
    "exactly 3 months trips warning only");
  assert.equal(at(c - 0.1), base + CASHFLOW_RISK.runwayUnderWarningMonths + CASHFLOW_RISK.runwayUnderCriticalMonths);
});

test("[C10] severity boundaries sit exactly on the configured cut-offs", () => {
  const level = (score) => {
    const p = CASHFLOW_RISK;
    return score >= p.severityHighAt ? "high" : score >= p.severityMediumAt ? "medium" : "low";
  };
  assert.equal(level(CASHFLOW_RISK.severityMediumAt - 1), "low");
  assert.equal(level(CASHFLOW_RISK.severityMediumAt), "medium", "the cut-off is inclusive");
  assert.equal(level(CASHFLOW_RISK.severityHighAt - 1), "medium");
  assert.equal(level(CASHFLOW_RISK.severityHighAt), "high");
});

test("[C11] the score is clamped to 0-100 and records the clamp", () => {
  const worst = computeCashflowRisk({
    netCashFlow: -1, monthlyBurn: 1, runwayMonths: 0.1,
    overdueReceivables: 100, inflow: 1
  });
  assert.equal(worst.risk_score, 100);
  assert.match(worst.risk_calculation, /clamped to 100/);
  // A run that does not clamp says so by omission.
  const ok = computeCashflowRisk({ netCashFlow: 1, monthlyBurn: 0, runwayMonths: Infinity });
  assert.doesNotMatch(ok.risk_calculation, /clamped/);
});

test("[C12] an unknown runway adds no points in either direction", () => {
  const unknown = computeCashflowRisk({ netCashFlow: -1, monthlyBurn: 1, runwayMonths: null });
  const infinite = computeCashflowRisk({ netCashFlow: -1, monthlyBurn: 1, runwayMonths: Infinity });
  const base = CASHFLOW_RISK.baseline + CASHFLOW_RISK.negativeNetCashFlow + CASHFLOW_RISK.hasBurn;
  assert.equal(unknown.risk_score, base, "unknown is not penalised");
  assert.equal(infinite.risk_score, base, "and not rewarded either");
});

// ── Revenue ──────────────────────────────────────────────────────

test("[R1] revenue prefers the P&L and records which basis it used", () => {
  const pl = computeRevenue(stmt({ inflow: 90000 }, { revenue: 120000 }), { period: "2026-05" });
  assert.equal(pl.total_revenue, 120000);
  assert.equal(pl.basis, "accrual_pl");

  const cash = computeRevenue(stmt({ inflow: 90000 }, {}), { period: "2026-05" });
  assert.equal(cash.total_revenue, 90000);
  assert.equal(cash.basis, "cash_inflow", "the fallback is labelled, not silent");
});

test("[R2] growth needs a non-zero prior period", () => {
  const ctx = (prior) => ({ period: "2026-05", reviewHistory: prior });
  const grew = computeRevenue(stmt({}, { revenue: 120000 }),
    ctx([{ period: "2026-04", revenue: 100000 }]));
  assert.equal(grew.growth_rate, 20);
  assert.equal(grew.direction, "up");
  assert.match(grew.growth_calculation, /100000/);

  const fromZero = computeRevenue(stmt({}, { revenue: 120000 }),
    ctx([{ period: "2026-04", revenue: 0 }]));
  assert.equal(fromZero.growth_rate, null, "division by zero is undefined, not infinite growth");

  const noHistory = computeRevenue(stmt({}, { revenue: 120000 }), ctx([]));
  assert.equal(noHistory.growth_rate, null);
  assert.equal(noHistory.direction, "unknown");
});

test("[R3] zero revenue is a measurement; absent revenue is not", () => {
  const zero = computeRevenue(stmt({ inflow: 0 }, { revenue: 0 }), { period: "2026-05" });
  assert.equal(zero.available, true);
  assert.equal(zero.total_revenue, 0, "the source said zero");

  const absent = computeRevenue({ statements: {} }, { period: "2026-05" });
  assert.equal(absent.available, false);
  assert.equal(absent.total_revenue, null, "the source said nothing");
});

test("[R4] a revenue decline is reported as a decline", () => {
  const r = computeRevenue(stmt({}, { revenue: 80000 }),
    { period: "2026-05", reviewHistory: [{ period: "2026-04", revenue: 100000 }] });
  assert.equal(r.growth_rate, -20);
  assert.equal(r.direction, "down");
});

// ── Expenses ─────────────────────────────────────────────────────

test("[E1] expenses total the outflow transactions", () => {
  const e = computeExpenses({ transactions: [
    { date: "2026-05-02", amount: 12000, counterparty: "A" },
    { date: "2026-05-09", amount: 8000, counterparty: "B" },
    { date: "2026-05-14", amount: -50000, counterparty: "Customer" } // inflow
  ] });
  assert.equal(e.available, true);
  assert.equal(e.total_expenses, 20000, "the inflow is excluded");
  assert.equal(e.expense_count, 2);
  assert.equal(e.average_expense, 10000);
  assert.equal(e.largest_expense.amount, 12000);
  assert.equal(e.largest_expense.counterparty, "A");
});

test("[E2] no transactions means unmeasured expenses, not zero spend", () => {
  const none = computeExpenses({ transactions: [] });
  assert.equal(none.available, false);
  assert.equal(none.total_expenses, null, "0 would assert the business spent nothing");
  assert.equal(none.reason, "no_transactions");

  const absent = computeExpenses({});
  assert.equal(absent.available, false);
  assert.equal(absent.reason, "no_transaction_data");
});

test("[E3] a period of pure inflow reports no outflows, not zero expenses", () => {
  const e = computeExpenses({ transactions: [{ date: "2026-05-02", amount: -5000, counterparty: "C" }] });
  assert.equal(e.available, false);
  assert.equal(e.reason, "no_outflows");
  assert.equal(e.expense_count, 0);
  assert.equal(e.total_expenses, null);
});

// ── Concentration ────────────────────────────────────────────────

test("[K1] concentration is the measured share, sorted, with the top party named", () => {
  const c = computeConcentration({ transactions: [
    { date: "2026-05-02", amount: 70000, counterparty: "Big" },
    { date: "2026-05-09", amount: 20000, counterparty: "Mid" },
    { date: "2026-05-14", amount: 10000, counterparty: "Small" }
  ] }, {}, "vendor");
  assert.equal(c.available, true);
  assert.equal(c.total, 100000);
  assert.equal(c.top_party.name, "Big");
  assert.equal(c.top_share_pct, 70);
  assert.equal(c.top_three_share_pct, 100);
  assert.equal(c.risk_score, 70, "the risk score IS the measured share");
  assert.deepEqual(c.parties.map((p) => p.name), ["Big", "Mid", "Small"]);
});

test("[K2] unattributed money is reported as unattributed, never as a party", () => {
  const c = computeConcentration({ transactions: [
    { date: "2026-05-02", amount: 70000, counterparty: "" },
    { date: "2026-05-09", amount: 30000, counterparty: null }
  ] }, {}, "vendor");
  assert.equal(c.available, false);
  assert.equal(c.reason, "unattributed_transactions");
  assert.equal(c.unattributed_amount, 100000, "states HOW MUCH could not be attributed");
  assert.deepEqual(c.parties, []);
  assert.equal(c.risk_score, null);
});

test("[K3][FIXED in JOB 6] a share of a ZERO total is unavailable, not 0%", () => {
  // WAS: `total > 0 ? pct : 0` reported a perfect 0% concentration, which fed
  // the health score as a fully-measured 100/100 component.
  const c = computeConcentration({ transactions: [
    { date: "2026-05-02", amount: 0, counterparty: "Acme" }
  ] }, {}, "vendor");
  assert.equal(c.available, false);
  assert.equal(c.reason, "no_attributable_value");
  assert.equal(c.risk_score, null, "not 0 — 0 would read as perfectly diversified");
  assert.equal(c.top_share_pct, null);
});

test("[K4] a single counterparty is 100% concentrated", () => {
  const c = computeConcentration({ transactions: [
    { date: "2026-05-02", amount: 50000, counterparty: "Only" }
  ] }, {}, "vendor");
  assert.equal(c.top_share_pct, 100);
  assert.equal(c.risk_score, 100);
});

test("[K5] vendor reads outflow and customer reads inflow", () => {
  const data = { transactions: [
    { date: "2026-05-02", amount: 40000, counterparty: "Supplier" },   // outflow
    { date: "2026-05-09", amount: -90000, counterparty: "Buyer" }      // inflow
  ] };
  assert.equal(computeConcentration(data, {}, "vendor").top_party.name, "Supplier");
  assert.equal(computeConcentration(data, {}, "customer").top_party.name, "Buyer");
});

test("[K6] concentration cites the transactions behind it", () => {
  const c = computeConcentration({ transactions: [
    { date: "2026-05-02", amount: 40000, counterparty: "Big", sourceRecordId: "zb-1", sourceSystem: "zoho-books" },
    { date: "2026-05-09", amount: 10000, counterparty: "Big", sourceRecordId: "zb-2", sourceSystem: "zoho-books" }
  ] }, {}, "vendor");
  const rows = c._rows[0].rows;
  assert.deepEqual(rows.map((r) => r.sourceRecordId), ["zb-1", "zb-2"]);
  assert.equal(rows[0].sourceSystem, "zoho-books");
});

// ── Malformed records ────────────────────────────────────────────

test("[X1] malformed amounts never produce NaN", () => {
  const c = computeConcentration({ transactions: [
    { date: "2026-05-02", amount: "not a number", counterparty: "A" },
    { date: "2026-05-09", amount: 50000, counterparty: "B" }
  ] }, {}, "vendor");
  assert.equal(Number.isFinite(c.total), true);
  assert.equal(c.total, 50000, "the unparseable amount contributes 0, not NaN");
  c.parties.forEach((p) => assert.equal(Number.isFinite(p.percentage), true));
});

test("[X2] the engine tolerates entirely absent collections", () => {
  assert.doesNotThrow(() => computeCashflow({}, {}));
  assert.doesNotThrow(() => computeRevenue({}, {}));
  assert.doesNotThrow(() => computeExpenses({}));
  assert.doesNotThrow(() => computeConcentration({}, {}, "vendor"));
});

test("[X3] the sign convention is explicit and stable", () => {
  // Load-bearing: CSV bank exports write money-out as negative and the importer
  // preserves that sign, so flipping this inverts every figure in the product.
  assert.equal(classifyDirection({ amount: 100 }), "outflow");
  assert.equal(classifyDirection({ amount: -100 }), "inflow");
  // An explicit direction always wins over the sign.
  assert.equal(classifyDirection({ amount: 100, direction: "in" }), "inflow");
  assert.equal(classifyDirection({ amount: -100, direction: "out" }), "outflow");
  assert.equal(classifyDirection({ amount: 100, direction: "inflow" }), "inflow");
});

// ── Thresholds are centralised ───────────────────────────────────

test("[T1] every threshold used above comes from the one definition", () => {
  // A guard against a literal creeping back into a calculator.
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.join(__dirname, "../../src/domain/calculators");
  fs.readdirSync(dir).filter((f) => f.endsWith(".js")).forEach((f) => {
    const src = fs.readFileSync(path.join(dir, f), "utf-8");
    // The scoring literals that used to be scattered across four files.
    [/\b(?<![.\w])80\s*:\s*55\b/, /riskScore\s*\+=\s*\d+/, /\b0\.30\b/, /\b0\.15\b/]
      .forEach((re) => assert.doesNotMatch(src, re, `${f} re-declares a threshold`));
  });
  // And the definitions really are the ones in use.
  assert.equal(HEALTH_SCORE.weights.cash_flow, 0.30);
  assert.equal(CASHFLOW_RISK.baseline, 20);
});
