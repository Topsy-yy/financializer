// DEMO data source — explicit, opt-in, and always labelled.
//
// The audit's most damaging product defect: any user without a Zoho connection
// silently received procedurally generated financials (with deliberately
// injected duplicates and cash-flow stress), unlabelled, through the full
// report/PDF/alert/AI pipeline. It was indistinguishable from real accounting
// data.
//
// Demo data is legitimate for evaluation. Silent demo data is not. This module:
//   * only runs when EXPLICITLY requested (never as a fallback);
//   * refuses to run in production unless ALLOW_DEMO_DATA is set;
//   * stamps every dataset with meta.source = "demo" and is_demo = true.

const fs = require("fs");
const path = require("path");
const { parsePeriod } = require("../period");

const SAMPLE = path.resolve(process.cwd(), "data", "sample-zoho-response.json");

class DemoDataDisabledError extends Error {
  constructor() {
    super("Demo data is disabled in this environment. Connect Zoho Books or upload a CSV.");
    this.name = "DemoDataDisabledError";
    this.code = "demo_data_disabled";
  }
}

function isAllowed() {
  if (process.env.NODE_ENV !== "production") return true;
  return String(process.env.ALLOW_DEMO_DATA || "false") === "true";
}

function toNumber(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }

/**
 * Deterministic demo dataset for a period.
 * Amounts vary by month so the demo is not identical every time, but the
 * generation is pure: the same period always yields the same data.
 */
function loadDemoData(periodValue) {
  if (!isAllowed()) throw new DemoDataDisabledError();
  const { period, year, month } = parsePeriod(periodValue);
  const payload = JSON.parse(fs.readFileSync(SAMPLE, "utf-8"));

  const scale = 0.86 + month * 0.025;
  const day = (d) => `${period}-${String(Math.max(1, Math.min(28, d))).padStart(2, "0")}`;

  const transactions = (payload.transactions || []).map((tx, i) => ({
    sourceSystem: "demo",
    sourceRecordId: `demo-txn-${period}-${i}`,
    date: day(Number(String(tx.date || "").split("-")[2] || i + 1)),
    amount: Math.max(100, Math.round(toNumber(tx.amount) * (scale + i * 0.035))),
    currency: payload.currency || "KES",
    counterparty: tx.counterparty || null,
    description: tx.description || null,
    account: tx.account || null
  }));

  const inflow = Math.round(toNumber(payload.statements?.cashFlow?.inflow) * scale);
  const outflow = Math.round(toNumber(payload.statements?.cashFlow?.outflow) * scale);

  return {
    period,
    currency: payload.currency || "KES",
    transactions,
    journalEntries: (payload.journalEntries || []).map((je, i) => ({
      sourceSystem: "demo",
      sourceRecordId: `demo-je-${period}-${i}`,
      date: day(Number(String(je.date || "").split("-")[2] || i + 1)),
      amount: Math.round(toNumber(je.amount) * scale),
      debitAccount: je.debitAccount || null,
      creditAccount: je.creditAccount || null
    })),
    reconciliations: (payload.reconciliations || []).map((r, i) => ({
      sourceSystem: "demo",
      sourceRecordId: `demo-rec-${period}-${i}`,
      accountName: r.accountName || "Bank Account",
      isReconciled: r.isReconciled !== false
    })),
    statements: {
      cashFlow: { inflow, outflow },
      profitAndLoss: { revenue: inflow, netIncome: inflow - outflow },
      balanceSheet: { cashAndEquivalents: Math.round(toNumber(payload.statements?.balanceSheet?.cashAndEquivalents) * scale) }
    },
    // The label the old path never carried.
    is_demo: true,
    meta: {
      source: "demo",
      is_demo: true,
      generated_for: period,
      fetchedAt: new Date().toISOString(),
      notice: "DEMO DATA — not real accounting records."
    }
  };
}

module.exports = { loadDemoData, isAllowed, DemoDataDisabledError };
