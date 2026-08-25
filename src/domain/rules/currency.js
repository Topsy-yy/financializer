// THE currency policy.
//
// RULE, stated once and enforced everywhere: amounts in different currencies
// are NEVER added, compared or averaged as though they were the same number.
//
// Before JOB 7 the engine had no currency awareness at all. 100,000 KES +
// 1,000 USD + 900 EUR were summed to 101,900 of nothing, that figure was
// labelled "KES" by the PDF renderer, and 1,000 USD matched 1,000 KES as a
// duplicate payment. The golden suite pinned all three as [KNOWN-BAD].
//
// WHAT THIS MODULE DOES NOT DO: convert. There is no rate source in this
// system, and inventing a rate would be exactly the kind of fabricated number
// the audit exists to prevent. So the policy is:
//
//   single currency  -> aggregate normally, label the result with that currency
//   mixed currency   -> DO NOT aggregate. Report each currency separately and
//                       mark the combined metric unavailable with a reason.
//   unknown currency -> treat as one unlabelled basis (the common case for CSV
//                       uploads), aggregate, but carry no currency label.
//
// A metric that cannot be computed is unavailable. It is never a wrong number.

const { num, classifyDirection } = require("../calculators/shared");

const BASIS = Object.freeze({
  SINGLE: "single",     // every record declares the same currency
  UNKNOWN: "unknown",   // no record declares a currency
  MIXED: "mixed"        // records declare two or more different currencies
});

/** Why a currency-dependent aggregate could not be produced. */
const UNAVAILABLE = Object.freeze({
  MIXED_CURRENCY: "mixed_currency"
});

/**
 * Classify the currency basis of a set of records, with a per-currency
 * breakdown so nothing is lost when the aggregate cannot be produced.
 *
 * Records that declare no currency are counted under the `null` key. A dataset
 * mixing declared and undeclared currencies is MIXED: we cannot assume the
 * undeclared ones share the declared one.
 *
 * @param {Array} records  anything with `.currency` and `.amount`
 * @returns {object} { basis, currency, currencies, byCurrency, aggregatable }
 */
function analyzeCurrency(records) {
  const rows = Array.isArray(records) ? records : [];
  const byCurrency = {};

  rows.forEach((r) => {
    const key = r && r.currency ? String(r.currency).toUpperCase() : null;
    const bucket = byCurrency[key] || (byCurrency[key] = { currency: key, count: 0, total: 0 });
    bucket.count += 1;
    bucket.total += Math.abs(num(r && r.amount));
  });

  const keys = Object.keys(byCurrency);
  const declared = keys.filter((k) => k !== "null");

  let basis;
  let currency = null;
  if (rows.length === 0) {
    basis = BASIS.UNKNOWN;
  } else if (declared.length === 0) {
    // Nothing declares a currency. One unlabelled basis — aggregatable, but the
    // result carries no currency label, because we do not know one.
    basis = BASIS.UNKNOWN;
  } else if (declared.length === 1 && keys.length === 1) {
    basis = BASIS.SINGLE;
    currency = declared[0];
  } else {
    // Either two declared currencies, or a declared currency alongside records
    // that declare none. Both are unsafe to add together.
    basis = BASIS.MIXED;
  }

  return Object.freeze({
    basis,
    currency,
    currencies: Object.freeze(declared.sort()),
    // Present whenever there is more than one basis, so a caller that cannot
    // produce a combined figure can still show the parts.
    byCurrency: Object.freeze(Object.values(byCurrency).map((b) => Object.freeze(Object.assign({}, b, {
      total: Math.round(b.total)
    })))),
    // The single question every calculator asks.
    aggregatable: basis !== BASIS.MIXED,
    reason: basis === BASIS.MIXED
      ? `Records span ${keys.length} currency bases (${keys.map((k) => k === "null" ? "unspecified" : k).join(", ")}) and no conversion rate is available.`
      : null
  });
}

/**
 * The currency basis of one DIRECTION of transactions.
 *
 * Concentration is computed per direction, so a business that invoices in USD
 * and pays suppliers in KES has a perfectly aggregatable vendor total and a
 * perfectly aggregatable customer total, even though the period as a whole is
 * mixed. Assessing the whole period would needlessly refuse both.
 */
function analyzeDirectionCurrency(transactions, direction) {
  return analyzeCurrency(
    (transactions || []).filter((tx) => classifyDirection(tx) === direction));
}

/**
 * Can these two records' amounts be compared as equal values?
 *
 * Used by duplicate detection. Two records with DIFFERENT declared currencies
 * are never the same payment, whatever their numbers say. Two records where at
 * least one currency is unknown fall back to comparing the numbers — refusing
 * would lose genuine duplicates in CSV uploads, which carry no currency at all.
 */
function comparableAmounts(a, b) {
  const ca = a && a.currency ? String(a.currency).toUpperCase() : null;
  const cb = b && b.currency ? String(b.currency).toUpperCase() : null;
  if (ca && cb) return ca === cb;
  return true; // one or both undeclared — the number is all we have
}

/** The currency key used to partition records that must not be compared across. */
function currencyKey(tx) {
  return tx && tx.currency ? String(tx.currency).toUpperCase() : "";
}

module.exports = {
  BASIS,
  UNAVAILABLE,
  analyzeCurrency,
  analyzeDirectionCurrency,
  comparableAmounts,
  currencyKey
};
