// Expense arithmetic. PURE: no HTTP, no fs, no database, no AI.
//
// NEW in JOB 6. Expenses were previously only ever visible as `outflow` inside
// the cash-flow statement, so "what did we spend, on what, and was it unusual?"
// could not be answered from an authoritative number — the chat layer was
// summing transactions itself.

const { num, round1, classifyDirection, recordIdOf } = require("./shared");
const { analyzeDirectionCurrency, UNAVAILABLE } = require("../rules/currency");

/**
 * Total expenses for the period, derived from OUTFLOW transactions.
 *
 * Reported as unavailable — not zero — when there are no transactions to sum.
 * A period with no records is unmeasured; claiming expenses of 0 would assert
 * that the business spent nothing.
 */
function computeExpenses(data = {}) {
  const transactions = Array.isArray(data.transactions) ? data.transactions : null;
  if (!transactions || transactions.length === 0) {
    return Object.freeze({
      available: false,
      reason: transactions ? "no_transactions" : "no_transaction_data",
      total_expenses: null,
      expense_count: null,
      average_expense: null,
      largest_expense: null
    });
  }

  // CURRENCY GATE (JOB 7 §3): a total is a sum, and incompatible currencies
  // cannot be summed. The per-currency totals are preserved so the information
  // is not lost — only the meaningless combined figure is withheld.
  const cur = analyzeDirectionCurrency(transactions, "outflow");
  if (!cur.aggregatable) {
    return Object.freeze({
      available: false,
      reason: UNAVAILABLE.MIXED_CURRENCY,
      currency: null,
      currency_basis: cur.basis,
      currencies: cur.currencies,
      by_currency: cur.byCurrency,
      currency_note: cur.reason,
      total_expenses: null,
      expense_count: cur.byCurrency.reduce((sum, b) => sum + b.count, 0),
      average_expense: null,
      largest_expense: null
    });
  }

  const outflows = transactions
    .map((tx, index) => ({ tx, index, amount: Math.abs(num(tx.amount)) }))
    .filter(({ tx }) => classifyDirection(tx) === "outflow");

  if (outflows.length === 0) {
    return Object.freeze({
      available: false,
      reason: "no_outflows",
      total_expenses: null,
      expense_count: 0,
      average_expense: null,
      largest_expense: null
    });
  }

  const total = outflows.reduce((sum, o) => sum + o.amount, 0);
  const largest = outflows.reduce((max, o) => (o.amount > max.amount ? o : max), outflows[0]);

  return Object.freeze({
    available: true,
    currency: cur.currency,
    currency_basis: cur.basis,
    total_expenses: Math.round(total),
    expense_count: outflows.length,
    average_expense: round1(total / outflows.length),
    largest_expense: Object.freeze({
      amount: largest.amount,
      counterparty: largest.tx.counterparty || null,
      date: largest.tx.date || null,
      sourceRecordId: recordIdOf(largest.tx, largest.index)
    }),
    calculation: `${outflows.length} outflow transactions summed = ${Math.round(total)}`
  });
}

module.exports = { computeExpenses };
