// THE materiality methodology.
//
// PROBLEM THIS REPLACES. The round-number rule fired on any amount `>= 10000`
// and divisible by 1000, with no notion of currency or business size. The
// golden suite pinned it twice as [KNOWN-BAD]: 10,000 is a routine payment for
// a KES business and a significant one for a USD business, and the same fixed
// bar is trivial for a company turning over 50M a month and alarming for one
// turning over 200k.
//
// METHODOLOGY. Materiality is the smaller-of-two-floors question — what is big
// enough to be worth a person's attention here?  It is derived from:
//
//   1. CURRENCY   a per-currency absolute floor, so the bar means the same
//                 thing in each unit of account;
//   2. BUSINESS   a relative floor, a percentage of the period's own activity,
//                 so the bar scales with the business rather than a constant;
//   3. CONTEXT    an explicit per-tenant override, for a business whose auditor
//                 or board has set its own threshold.
//
// The effective threshold is the LARGER of the absolute and relative floors: a
// tiny business is protected from the absolute floor being meaninglessly high,
// and a large business is protected from it being meaninglessly low.
//
// Everything here is configuration, not code. Adding a currency is a table
// entry; changing the methodology is a version bump.

const MATERIALITY_VERSION = "1.0.0";

/**
 * Per-currency absolute floors, in units of that currency.
 *
 * These are ROUNDED ORDERS OF MAGNITUDE, not exchange rates — the point is that
 * the bar means roughly the same thing to a business operating in that unit,
 * not that the figures are convertible into each other. They are deliberately
 * coarse: a precise number here would imply a precision this methodology does
 * not have.
 */
const ABSOLUTE_FLOORS = Object.freeze({
  KES: Object.freeze({ significant: 10000, roundNumberMultiple: 1000 }),
  UGX: Object.freeze({ significant: 300000, roundNumberMultiple: 50000 }),
  TZS: Object.freeze({ significant: 200000, roundNumberMultiple: 10000 }),
  NGN: Object.freeze({ significant: 100000, roundNumberMultiple: 10000 }),
  ZAR: Object.freeze({ significant: 1500, roundNumberMultiple: 100 }),
  USD: Object.freeze({ significant: 100, roundNumberMultiple: 10 }),
  EUR: Object.freeze({ significant: 100, roundNumberMultiple: 10 }),
  GBP: Object.freeze({ significant: 100, roundNumberMultiple: 10 })
});

/**
 * The floor used when the currency is unknown.
 *
 * KES is this product's home market and the overwhelming majority of its data,
 * so it is the honest default — but the CHOICE is recorded on every finding
 * that uses it (`basis: "default_currency_assumed"`), so a user reading a
 * finding can see the assumption rather than inherit it silently.
 */
const DEFAULT_CURRENCY = "KES";

/** Relative floor: a share of the period's own outflow. */
const RELATIVE = Object.freeze({
  // 1% of monthly outflow. Below this, an individual payment is noise at the
  // scale this business operates at.
  significantPctOfOutflow: 1.0,
  // Below this many transactions the period is too small for a relative floor
  // to mean anything, so only the absolute floor applies.
  minSampleSize: 5
});

/**
 * Resolve the materiality threshold for a period.
 *
 * @param {object} args
 *   currency      {string|null} the currency basis of the records
 *   periodOutflow {number|null} total outflow for the period, if measurable
 *   sampleSize    {number}      how many transactions the period contains
 *   override      {object|null} per-tenant { significant } in the same currency
 * @returns {object} { significant, roundNumberMultiple, currency, basis, calculation }
 */
function resolveMateriality({ currency, periodOutflow, sampleSize = 0, override = null } = {}) {
  const assumed = !currency;
  const code = String(currency || DEFAULT_CURRENCY).toUpperCase();
  const floors = ABSOLUTE_FLOORS[code] || ABSOLUTE_FLOORS[DEFAULT_CURRENCY];
  const known = Object.prototype.hasOwnProperty.call(ABSOLUTE_FLOORS, code);

  // 3. An explicit business override wins outright — a board that has set its
  //    own threshold is a better authority on its materiality than this table.
  if (override && Number.isFinite(Number(override.significant)) && Number(override.significant) > 0) {
    const value = Number(override.significant);
    return Object.freeze({
      significant: value,
      roundNumberMultiple: Number(override.roundNumberMultiple) > 0
        ? Number(override.roundNumberMultiple) : floors.roundNumberMultiple,
      currency: currency || null,
      basis: "tenant_override",
      version: MATERIALITY_VERSION,
      calculation: `Business-configured materiality of ${value}${currency ? ` ${currency}` : ""}.`
    });
  }

  // 1. Absolute floor for this currency.
  const absolute = floors.significant;

  // 2. Relative floor from the period's own activity.
  let relative = null;
  if (Number.isFinite(Number(periodOutflow)) && Number(periodOutflow) > 0
      && sampleSize >= RELATIVE.minSampleSize) {
    relative = Math.round(Number(periodOutflow) * (RELATIVE.significantPctOfOutflow / 100));
  }

  const significant = relative == null ? absolute : Math.max(absolute, relative);
  const basis = !known ? "default_currency_assumed"
    : relative == null ? "absolute_floor"
      : significant === relative ? "relative_to_period" : "absolute_floor";

  const parts = [`absolute floor ${absolute} ${code}`];
  if (relative != null) {
    parts.push(`${RELATIVE.significantPctOfOutflow}% of period outflow = ${relative}`);
  }
  if (assumed) {
    parts.push(`currency not stated by the source, ${DEFAULT_CURRENCY} assumed`);
  } else if (!known) {
    parts.push(`no floor configured for ${code}, ${DEFAULT_CURRENCY} floor used`);
  }

  return Object.freeze({
    significant,
    roundNumberMultiple: floors.roundNumberMultiple,
    currency: currency || null,
    currencyAssumed: assumed || !known,
    basis,
    version: MATERIALITY_VERSION,
    calculation: `Materiality ${significant}: max of ${parts.join("; ")}.`
  });
}

/** Is this amount material at the resolved threshold? */
function isMaterial(amount, materiality) {
  return Math.abs(Number(amount) || 0) >= materiality.significant;
}

/** Currencies with a configured floor — surfaced by the methodology document. */
function configuredCurrencies() {
  return Object.keys(ABSOLUTE_FLOORS).sort();
}

module.exports = {
  MATERIALITY_VERSION,
  ABSOLUTE_FLOORS,
  DEFAULT_CURRENCY,
  RELATIVE,
  resolveMateriality,
  isMaterial,
  configuredCurrencies
};
