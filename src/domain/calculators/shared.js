// Numeric helpers shared by the calculators.
//
// These were copy-pasted into riskEngine.js, routes/api.js, metrics.js and
// whatIfSimulator.js with subtly different fallbacks (some returned 0 for a
// missing value, some NaN). One definition each, so a missing number behaves
// the same everywhere.

/** Coerce to a finite number, else the default. Never returns NaN. */
function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Coerce to a finite number, or NULL when absent — for values where 0 is a lie. */
function numOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

function round1(value) {
  return Number(Number(value).toFixed(1));
}

/** Display formatting only — never a source of numerical truth. */
function fmt(value) {
  return Math.round(num(value)).toLocaleString("en-KE");
}

/**
 * Inflow when money arrives, outflow when it leaves.
 *
 * PREFER AN EXPLICIT DIRECTION. Every ingestion source states `direction` on the
 * records it produces, because only the source knows its own sign convention.
 *
 * THE SIGN FALLBACK, and why it is only a fallback (JOB 7): this function used
 * to infer direction from the sign, treating a POSITIVE amount as an outflow.
 * The CSV importer follows the opposite, bank-statement convention (a credit is
 * positive). The two disagreed silently, so for every CSV upload the vendor
 * metric was computed over customers and the customer metric over vendors.
 *
 * The fallback is retained for records that state no direction — hand-built
 * fixtures and any source not yet migrated — and its convention is unchanged so
 * those keep working. New sources must set `direction` and not rely on it.
 */
function classifyDirection(tx) {
  if (tx.direction === "in" || tx.direction === "out") {
    return tx.direction === "in" ? "inflow" : "outflow";
  }
  if (tx.direction === "inflow" || tx.direction === "outflow") return tx.direction;
  return num(tx.amount) < 0 ? "inflow" : "outflow";
}

/** Stable identifier for a record, falling back to its position when absent. */
function recordIdOf(tx, index) {
  return tx.sourceRecordId || tx.id || tx.source_record_id || `row:${index}`;
}

module.exports = { num, numOrNull, clamp, round1, fmt, classifyDirection, recordIdOf };
