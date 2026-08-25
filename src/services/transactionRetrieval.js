// Transaction retrieval — the "find the rows that answer this question" layer.
//
// Why this exists: dumping every line item into the chat prompt is slow and
// burns paid-tier tokens on data the question never touches. This module picks
// the relevant rows deterministically (instant, free, exact) so the narrating
// model receives a small, focused set instead of the whole month.
//
// Retrieval is pure string/number matching — no AI. When a question is too
// vague to parse here, the caller may fall back to an LLM to produce a
// structured filter (see applyFilter), which is then executed by this module.

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july",
  "august", "september", "october", "november", "december"];

// Questions that need individual records rather than aggregate findings.
const LINE_ITEM_HINTS = [
  "transaction", "transactions", "payment", "payments", "paid", "pay", "spent",
  "invoice", "invoices", "receipt", "receipts", "charge", "charged", "bill",
  "who", "whom", "list", "show me", "which", "what did", "how much did",
  "owe", "owes", "owed", "largest", "biggest", "smallest", "top ", "breakdown",
  "on the", "vendor", "supplier", "customer", "withdraw", "deposit", "transfer"
];

function norm(value) {
  return String(value == null ? "" : value).toLowerCase().trim();
}
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function isLineItemQuestion(message) {
  const text = norm(message);
  return LINE_ITEM_HINTS.some((hint) => text.includes(hint));
}

/** Distinct counterparties/accounts present in the data, for name matching. */
function knownParties(monthlyData) {
  const set = new Set();
  ((monthlyData && monthlyData.transactions) || []).forEach((tx) => {
    if (tx && tx.counterparty) set.add(String(tx.counterparty));
  });
  ((monthlyData && monthlyData.receivables) || []).forEach((r) => {
    if (r && r.customer) set.add(String(r.customer));
  });
  ((monthlyData && monthlyData.payables) || []).forEach((p) => {
    if (p && p.vendor) set.add(String(p.vendor));
  });
  return Array.from(set);
}

/**
 * Parse a natural-language question into a structured filter.
 * Everything is optional; an empty filter means "no specific narrowing".
 */
function parseQuestion(message, monthlyData) {
  const text = norm(message);
  const filter = {};

  // --- day of month: "on the 14th", "june 14", "2026-06-14", "14/06" ---
  const isoDay = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (isoDay) {
    filter.date = isoDay[0];
  } else {
    const ordinal = text.match(/\bon the (\d{1,2})(?:st|nd|rd|th)?\b/);
    const monthDay = text.match(new RegExp("\\b(" + MONTH_NAMES.join("|") + ")\\s+(\\d{1,2})\\b"));
    if (ordinal) filter.day = Number(ordinal[1]);
    else if (monthDay) filter.day = Number(monthDay[2]);
  }

  // --- counterparty: match names that actually exist in the data ---
  const parties = knownParties(monthlyData);
  const hits = parties.filter((party) => {
    const p = norm(party);
    if (!p) return false;
    if (text.includes(p)) return true;
    // Also match on the distinctive first word ("Safaricom" in "Safaricom Ltd"),
    // ignoring short/generic tokens.
    const first = p.split(/\s+/)[0];
    return first.length >= 4 && text.includes(first);
  });
  if (hits.length) filter.parties = hits;

  // --- free-text keyword from quoted phrases ("airtime") ---
  const quoted = message && message.match(/["“']([^"”']{3,40})["”']/);
  if (quoted) filter.text = quoted[1];

  // --- superlatives / ranking ---
  if (/\b(largest|biggest|highest|top|most expensive)\b/.test(text)) filter.rank = "desc";
  else if (/\b(smallest|lowest|cheapest)\b/.test(text)) filter.rank = "asc";
  const topN = text.match(/\btop\s+(\d{1,2})\b/);
  if (topN) filter.limit = Math.min(20, Number(topN[1]));

  // --- amount thresholds: "over 100000", "more than 50k" ---
  const over = text.match(/\b(?:over|above|more than|greater than|>)\s*([\d,.]+)\s*(k)?\b/);
  if (over) {
    const base = Number(String(over[1]).replace(/[,\s]/g, ""));
    if (Number.isFinite(base)) filter.minAmount = over[2] ? base * 1000 : base;
  }

  // --- which ledgers the question is about ---
  if (/\b(owe|owes|owed|receivable|receivables|debtor|unpaid invoice)\b/.test(text)) filter.wantReceivables = true;
  if (/\b(payable|payables|creditor|bill|bills|supplier owed)\b/.test(text)) filter.wantPayables = true;

  return filter;
}

/**
 * Execute a structured filter against the period's records.
 * Returns the matched rows plus a description of how they were selected.
 */
function applyFilter(monthlyData, filter, options) {
  const opts = options || {};
  const limit = Math.max(1, Math.min(60, filter.limit || opts.limit || 25));
  const all = Array.isArray(monthlyData && monthlyData.transactions) ? monthlyData.transactions : [];
  const criteria = [];

  let rows = all.slice();

  if (filter.date) {
    rows = rows.filter((tx) => String((tx && tx.date) || "").slice(0, 10) === filter.date);
    criteria.push("date " + filter.date);
  } else if (filter.day) {
    const dd = String(filter.day).padStart(2, "0");
    rows = rows.filter((tx) => String((tx && tx.date) || "").slice(8, 10) === dd);
    criteria.push("day " + filter.day);
  }

  if (filter.parties && filter.parties.length) {
    const wanted = filter.parties.map(norm);
    rows = rows.filter((tx) => {
      const party = norm(tx && tx.counterparty);
      return wanted.some((w) => party.includes(w) || w.includes(party));
    });
    criteria.push("counterparty " + filter.parties.join(", "));
  }

  if (filter.text) {
    const needle = norm(filter.text);
    rows = rows.filter((tx) =>
      norm(tx && tx.description).includes(needle) || norm(tx && tx.counterparty).includes(needle));
    criteria.push('text "' + filter.text + '"');
  }

  if (filter.minAmount) {
    rows = rows.filter((tx) => Math.abs(num(tx && tx.amount)) >= filter.minAmount);
    criteria.push("amount >= " + filter.minAmount);
  }

  const matchedCount = rows.length;

  if (filter.rank === "desc") {
    rows.sort((a, b) => Math.abs(num(b && b.amount)) - Math.abs(num(a && a.amount)));
    criteria.push("largest first");
  } else if (filter.rank === "asc") {
    rows.sort((a, b) => Math.abs(num(a && a.amount)) - Math.abs(num(b && b.amount)));
    criteria.push("smallest first");
  } else {
    rows.sort((a, b) => String((a && a.date) || "").localeCompare(String((b && b.date) || "")));
  }

  const truncated = rows.length > limit;
  rows = rows.slice(0, limit);

  return {
    rows,
    matchedCount,
    totalCount: all.length,
    truncated,
    criteria,
    receivables: filter.wantReceivables,
    payables: filter.wantPayables
  };
}

/**
 * Full deterministic retrieval for a question.
 * `needsInterpretation` tells the caller the question mentions line items but
 * no concrete filter could be derived — the point where an LLM assist helps.
 */
function retrieve(monthlyData, message, options) {
  const filter = parseQuestion(message, monthlyData);
  const specific = Boolean(filter.date || filter.day || filter.parties || filter.text ||
    filter.minAmount || filter.rank || filter.wantReceivables || filter.wantPayables);
  const result = applyFilter(monthlyData, filter, options);
  return Object.assign({ filter, specific, needsInterpretation: !specific }, result);
}

module.exports = {
  isLineItemQuestion,
  knownParties,
  parseQuestion,
  applyFilter,
  retrieve
};
