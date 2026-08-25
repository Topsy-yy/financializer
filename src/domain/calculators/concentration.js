// Vendor / customer concentration arithmetic. PURE: no HTTP, no fs, no DB, no AI.
//
// Bug fix preserved from the JOB 3 extraction: the audited buildCustomerSummary
// FABRICATED named customers ("BlueTech", "Nova Retail", "Eastline Logistics")
// with a hardcoded risk score of 72 whenever revenue could not be attributed,
// then raised a HIGH-severity finding about a business relationship that did
// not exist. Unattributable revenue now reports `available: false` with the
// unattributed amount, so "we cannot tell" is distinguishable from "diversified".

const { num, round1, classifyDirection, recordIdOf } = require("./shared");
const { analyzeDirectionCurrency, BASIS, UNAVAILABLE } = require("../rules/currency");

/**
 * Share of a directional total by counterparty, retaining the contributing rows
 * so a concentration finding can cite the transactions behind it.
 */
function aggregateCounterpartyShare(transactions, direction) {
  const totals = new Map();

  (transactions || []).forEach((tx, index) => {
    if (classifyDirection(tx) !== direction) return;
    const name = tx.counterparty || null;
    // Unattributed money is a DATA-QUALITY matter, not a vendor named "".
    if (!name) return;
    const amount = Math.abs(num(tx.amount));
    if (!totals.has(name)) totals.set(name, { name, amount: 0, rows: [] });
    const entry = totals.get(name);
    entry.amount += amount;
    entry.rows.push({
      index,
      sourceRecordId: recordIdOf(tx, index),
      sourceSystem: tx.sourceSystem || null,
      amount,
      date: tx.date || null
    });
  });

  const rows = Array.from(totals.values());
  const total = rows.reduce((sum, r) => sum + r.amount, 0);
  const unattributed = (transactions || [])
    .filter((tx) => classifyDirection(tx) === direction && !tx.counterparty)
    .reduce((sum, tx) => sum + Math.abs(num(tx.amount)), 0);

  return {
    total,
    unattributed,
    rows: rows
      .sort((a, b) => b.amount - a.amount)
      .map((r) => ({
        name: r.name,
        amount: r.amount,
        percentage: total > 0 ? round1((r.amount / total) * 100) : 0,
        rows: r.rows
      }))
  };
}

/**
 * @param {string} kind "vendor" (outflow) or "customer" (inflow)
 */
function computeConcentration(data = {}, ctx = {}, kind = "vendor") {
  const direction = kind === "vendor" ? "outflow" : "inflow";

  // CURRENCY GATE (JOB 7 §3). A "share of total spend" is only meaningful if the
  // amounts being shared are in the same unit. 40,000 KES out of a 40,000 KES +
  // 1,000 USD total is not 97.6% — that figure is arithmetic performed on
  // incompatible quantities. Rather than invent a rate, the metric is reported
  // unavailable with the per-currency breakdown preserved.
  //
  // The check is per DIRECTION: a business that invoices in USD and pays
  // suppliers in KES has a perfectly aggregatable vendor total and a perfectly
  // aggregatable customer total, so assessing the whole period would needlessly
  // refuse both.
  const cur = analyzeDirectionCurrency(data.transactions, direction);
  if (!cur.aggregatable) {
    return Object.freeze({
      kind,
      available: false,
      reason: UNAVAILABLE.MIXED_CURRENCY,
      currency: null,
      currency_basis: cur.basis,
      currencies: cur.currencies,
      by_currency: cur.byCurrency,
      currency_note: cur.reason,
      total: null,
      unattributed_amount: null,
      parties: Object.freeze([]),
      top_party: null,
      top_share_pct: null,
      top_three_share_pct: null,
      risk_score: null
    });
  }

  const agg = aggregateCounterpartyShare(data.transactions, direction);

  // A SHARE OF ZERO IS UNDEFINED, not 0%.
  //
  // JOB 6 BUG FIX. `total > 0 ? (amount/total)*100 : 0` made every party 0% of a
  // zero total, so a period whose only named counterparty had a zero-value
  // record reported `risk_score: 0` — a PERFECT concentration score — which then
  // fed the health score as a fully-measured 100/100 component. Missing data
  // must not read as a good result any more than as a bad one (mandate §9).
  if (agg.rows.length === 0 || agg.total <= 0) {
    return Object.freeze({
      kind,
      available: false,
      // WHY it is unavailable, so the caller can tell "no data" from
      // "money moved but we could not attribute it".
      reason: agg.rows.length === 0
        ? (agg.unattributed > 0 ? "unattributed_transactions" : "no_transactions")
        : "no_attributable_value",
      currency: cur.currency,
      currency_basis: cur.basis,
      total: agg.total,
      unattributed_amount: agg.unattributed,
      parties: Object.freeze([]),
      top_party: null,
      top_share_pct: null,
      top_three_share_pct: null,
      risk_score: null
    });
  }

  const top = agg.rows[0];
  const topThree = round1(agg.rows.slice(0, 3).reduce((sum, r) => sum + r.percentage, 0));

  return Object.freeze({
    kind,
    available: true,
    // The unit every figure below is denominated in. Null when the records
    // carry no currency at all (a CSV upload), which is honest: we know the
    // amounts are comparable to each other, but not what they are.
    currency: cur.currency,
    currency_basis: cur.basis,
    total: agg.total,
    unattributed_amount: agg.unattributed,
    parties: agg.rows.map((r) => ({ name: r.name, amount: r.amount, percentage: r.percentage })),
    top_party: Object.freeze({ name: top.name, amount: top.amount, percentage: top.percentage }),
    top_share_pct: top.percentage,
    top_three_share_pct: topThree,
    // The risk score IS the measured share — no separate opaque formula.
    risk_score: Math.max(0, Math.min(100, Math.round(top.percentage))),
    risk_calculation: `top ${kind} ${top.name}: ${top.amount} of ${agg.total} = ${top.percentage}%`,
    // Contributing rows, for evidence. Stripped before the metric leaves the domain.
    _rows: agg.rows
  });
}

/** Strip internal row detail before publishing the metric. */
function publicConcentration(conc) {
  const { _rows, ...rest } = conc;
  return rest;
}

module.exports = { computeConcentration, aggregateCounterpartyShare, publicConcentration };
