// Golden scenario fixtures for the baseline suite.
//
// These are hand-built, minimal datasets in the shape the deterministic engine
// consumes (`normalizePayload` output: transactions / journalEntries /
// reconciliations / statements). Each scenario isolates ONE behaviour so a
// regression points at a specific rule rather than "something changed".
//
// Amounts are integers in a single currency unless the scenario is explicitly
// about currency. Dates are fixed so runs are repeatable.

const PERIOD = "2026-05";
const D = (day) => `${PERIOD}-${String(day).padStart(2, "0")}`;

function statements({ inflow = 0, outflow = 0, cash = 0, revenue = 0, netIncome = null } = {}) {
  return {
    cashFlow: { inflow, outflow },
    profitAndLoss: { revenue, netIncome: netIncome == null ? inflow - outflow : netIncome },
    balanceSheet: { cashAndEquivalents: cash }
  };
}

function dataset({ transactions = [], journalEntries = [], reconciliations = [], receivables, payables, noStatements, ...rest }) {
  const out = {
    period: PERIOD,
    transactions,
    journalEntries,
    reconciliations,
    // `noStatements` models a source that returned no financial statements at
    // all. Without it the helper zero-fills, which asserts "inflow was measured
    // as 0" — a very different claim from "we have no statement".
    statements: noStatements ? {} : statements(rest)
  };
  if (receivables) out.receivables = receivables;
  if (payables) out.payables = payables;
  return out;
}

const tx = (date, amount, counterparty, description, extra = {}) =>
  Object.assign({ date, amount, counterparty, description, account: "Main Bank" }, extra);

// 1 — Healthy business: positive net flow, no anomalies, everything reconciled,
// and spend spread across enough vendors that concentration rules do not fire
// (a 4-vendor business is inherently concentrated -- that is a real signal, not
// a bug, so the fixture models a genuinely diversified payer).
const healthy = dataset({
  transactions: [
    tx(D(3), 4200, "Acme Supplies", "Office stock"),
    tx(D(5), 3980, "Harbour Print", "Marketing materials"),
    tx(D(9), 3100, "Metro Freight", "Delivery services"),
    tx(D(12), 4460, "Kite Software", "SaaS subscriptions"),
    tx(D(17), 2750, "City Power", "Utilities"),
    tx(D(19), 3640, "Vera Cleaning", "Facilities"),
    tx(D(22), 4180, "Ольга Legal", "Legal advice"),
    tx(D(24), 5300, "Northwind Ltd", "Consulting fees"),
    tx(D(26), 3870, "Pace Insurance", "Insurance premium")
  ],
  journalEntries: [{ date: D(3), debitAccount: "Inventory", creditAccount: "Main Bank", amount: 4200 }],
  reconciliations: [{ accountName: "Main Bank", isReconciled: true }],
  inflow: 900000, outflow: 600000, cash: 1200000, revenue: 900000
});

// 2 — Duplicate payment: two transactions identical on date + amount + counterparty.
const duplicatePayment = dataset({
  transactions: [
    tx(D(11), 48500, "Rivera Logistics", "Freight invoice 8841"),
    tx(D(11), 48500, "Rivera Logistics", "Freight invoice 8841"),
    tx(D(19), 6200, "City Power", "Utilities")
  ],
  reconciliations: [{ accountName: "Main Bank", isReconciled: true }],
  inflow: 500000, outflow: 400000, cash: 800000, revenue: 500000
});

// 3 — Round-number transaction: >= 10,000 and an exact multiple of 1,000.
const roundNumber = dataset({
  transactions: [
    tx(D(6), 250000, "Halden Consulting", "Advisory retainer"),
    tx(D(14), 7350, "City Power", "Utilities"),
    tx(D(21), 4180, "Acme Supplies", "Stationery")
  ],
  reconciliations: [{ accountName: "Main Bank", isReconciled: true }],
  inflow: 700000, outflow: 500000, cash: 900000, revenue: 700000
});

// 4 — Cash-flow stress: negative net flow and a short runway.
const cashflowStress = dataset({
  transactions: [
    tx(D(4), 320000, "Payroll", "Monthly salaries"),
    tx(D(12), 180000, "Landlord Ltd", "Rent"),
    tx(D(26), 96000, "City Power", "Utilities")
  ],
  reconciliations: [{ accountName: "Main Bank", isReconciled: true }],
  inflow: 250000, outflow: 700000, cash: 300000, revenue: 250000
});

// 5 — Vendor concentration: one payee dominates outflow.
const vendorConcentration = dataset({
  transactions: [
    tx(D(5), 900000, "Monolith Supplies", "Bulk purchase"),
    tx(D(13), 60000, "City Power", "Utilities"),
    tx(D(22), 40000, "Acme Supplies", "Stationery")
  ],
  reconciliations: [{ accountName: "Main Bank", isReconciled: true }],
  inflow: 1200000, outflow: 1000000, cash: 700000, revenue: 1200000
});

// 6 — Customer concentration: one payer dominates inflow.
// NOTE: inflow attribution requires negative amounts in this engine's
// convention; see aggregateCounterpartyShare. Kept explicit for clarity.
const customerConcentration = dataset({
  transactions: [
    tx(D(7), -850000, "BigCo Retail", "Invoice payment"),
    tx(D(15), -90000, "Small Trader", "Invoice payment"),
    tx(D(23), -60000, "Corner Shop", "Invoice payment")
  ],
  reconciliations: [{ accountName: "Main Bank", isReconciled: true }],
  inflow: 1000000, outflow: 400000, cash: 900000, revenue: 1000000
});

// 7 — Missing financial data: no statements, no reconciliations, sparse records.
const missingData = dataset({
  noStatements: true,                              // no cash flow, P&L or balance sheet
  transactions: [
    tx(D(8), 15000, "", ""),                      // missing counterparty + description
    tx(D(16), 0, "Acme Supplies", "Unknown line")  // zero amount
  ],
  journalEntries: [{ date: D(8), amount: 15000 }], // missing debit/credit accounts
  reconciliations: [{ accountName: "Main Bank", isReconciled: false }]
});

// 7b — Missing CUSTOMER data: money genuinely arrived, but no inflow record
// names who paid. This is the fixture that used to produce three invented
// customers ("BlueTech", "Nova Retail", "Eastline Logistics") with a hardcoded
// risk score of 72.
const missingCustomerData = dataset({
  transactions: [
    tx(D(6), -420000, "", "Bank credit"),
    tx(D(14), -180000, "", "Bank credit"),
    tx(D(21), 55000, "City Power", "Utilities")
  ],
  reconciliations: [{ accountName: "Main Bank", isReconciled: true }],
  inflow: 600000, outflow: 300000, cash: 500000, revenue: 600000
});

// 7c — Missing VENDOR data: spend occurred but no outflow record names a payee.
// Unattributed spend must not become a vendor called "Unknown Vendor".
const missingVendorData = dataset({
  transactions: [
    tx(D(6), 240000, "", "Card payment"),
    tx(D(14), 130000, "", "Card payment"),
    tx(D(21), -400000, "BigCo Retail", "Invoice payment")
  ],
  reconciliations: [{ accountName: "Main Bank", isReconciled: true }],
  inflow: 400000, outflow: 370000, cash: 300000, revenue: 400000
});

// 9 — Multi-currency: mixed currency codes on transactions.
// The engine has NO currency awareness; this fixture exists to prove that.
const multiCurrency = dataset({
  transactions: [
    tx(D(5), 100000, "Local Vendor", "KES purchase", { currency: "KES" }),
    tx(D(12), 1000, "Overseas Vendor", "USD purchase", { currency: "USD" }),
    tx(D(20), 900, "EU Vendor", "EUR purchase", { currency: "EUR" })
  ],
  reconciliations: [{ accountName: "Main Bank", isReconciled: true }],
  inflow: 500000, outflow: 300000, cash: 400000, revenue: 500000
});

// 10 — Empty response: structurally valid, entirely empty.
const emptyResponse = { period: PERIOD, transactions: [], journalEntries: [], reconciliations: [], statements: { cashFlow: {}, profitAndLoss: {}, balanceSheet: {} } };

// 11 — Partial ingestion: transactions present, reconciliations absent
// (mirrors the `.catch(() => [])` path in zohoBooksClient).
const partialIngestion = dataset({
  transactions: [
    tx(D(6), 52000, "Acme Supplies", "Office stock"),
    tx(D(18), 31000, "Metro Freight", "Delivery")
  ],
  reconciliations: [],
  inflow: 400000, outflow: 300000, cash: 500000, revenue: 400000
});

// 14 — Custom rule: an expense above a user-defined threshold.
const customRuleData = dataset({
  transactions: [
    tx(D(9), 260000, "Halden Consulting", "Advisory retainer"),
    tx(D(17), 12000, "City Power", "Utilities")
  ],
  reconciliations: [{ accountName: "Main Bank", isReconciled: true }],
  inflow: 800000, outflow: 500000, cash: 600000, revenue: 800000
});

module.exports = {
  PERIOD,
  D,
  dataset,
  statements,
  scenarios: {
    healthy,
    duplicatePayment,
    roundNumber,
    cashflowStress,
    vendorConcentration,
    customerConcentration,
    missingData,
    missingCustomerData,
    missingVendorData,
    multiCurrency,
    emptyResponse,
    partialIngestion,
    customRuleData
  }
};
