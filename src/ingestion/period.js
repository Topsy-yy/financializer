// Strict period handling.
//
// The audit found THREE different behaviours for a bad period, none of them an
// error: zohoClient silently substituted the CURRENT month, zohoBooksClient
// produced "undefined-NaN" date params and returned an empty dataset, and an
// out-of-range month was clamped (2026-13 -> December).
//
// Analysing the wrong month and reporting it as the requested one is a
// correctness failure. A malformed period is now an ERROR.

class InvalidPeriodError extends Error {
  constructor(value, reason) {
    super(`Invalid accounting period "${value}": ${reason}`);
    this.name = "InvalidPeriodError";
    this.code = "invalid_period";
    this.value = value;
  }
}

const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Validate a YYYY-MM period. Throws rather than guessing. */
function parsePeriod(value) {
  if (value == null || value === "") throw new InvalidPeriodError(String(value), "a period is required");
  const str = String(value).trim();
  const m = PERIOD_RE.exec(str);
  if (!m) {
    throw new InvalidPeriodError(str, "expected YYYY-MM with a month between 01 and 12");
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (year < 1970 || year > 2200) throw new InvalidPeriodError(str, "year is out of range");
  return { period: `${m[1]}-${m[2]}`, year, month };
}

function isValidPeriod(value) {
  try { parsePeriod(value); return true; } catch { return false; }
}

/** Inclusive date bounds for a period. */
function periodRange(value) {
  const { period, year, month } = parsePeriod(value);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    period,
    start: `${period}-01`,
    end: `${period}-${String(lastDay).padStart(2, "0")}`,
    days: lastDay
  };
}

/** Current period — used only where "now" is genuinely the intent. */
function currentPeriod(now = Date.now()) {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function withinPeriod(dateStr, value) {
  const { start, end } = periodRange(value);
  const d = String(dateStr || "").slice(0, 10);
  return d >= start && d <= end;
}

module.exports = { InvalidPeriodError, parsePeriod, isValidPeriod, periodRange, currentPeriod, withinPeriod };
