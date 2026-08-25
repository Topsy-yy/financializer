// THE ONE PLACE A CASH BALANCE IS INTERPRETED.
//
// THE DEFECT THIS CLOSES. When an upload supplies no cash balance, ingestion
// derives one as `Math.max(0, netIncome)`. JOB 12 labelled that derivation and
// taught the cash-flow calculator to refuse it — but the LABEL was advisory.
// `balanceSheet.cashAndEquivalents` remained a plain number that any consumer
// could read, and one did: `customRules.js` read it raw to evaluate
// user-authored `cash_below` rules. On a loss-making month the derived value is
// exactly 0, which is below almost any threshold a user would set, so a custom
// rule would fire "cash balance is below X" against a figure nobody supplied.
//
// A provenance convention that depends on every consumer remembering it is not
// a boundary. This module is the boundary: it returns a CLASSIFIED position
// rather than a number, so a consumer that wants "the cash balance" has to say
// which meaning it wants and cannot get an estimate by accident.
//
// THE THREE STATES, which must never collapse into one another:
//
//   OBSERVED   the source told us. Usable for any cash-dependent calculation.
//   DERIVED    inferred from net income. Exists, carries provenance, and is
//              authoritative for NOTHING. A net income is a flow; a cash
//              balance is a stock. One period's profit says nothing about the
//              money in the account, which accumulates across every prior
//              period and includes financing this system never sees.
//   ABSENT     no figure at all. Distinct from derived: there is nothing here,
//              rather than something of the wrong kind.
//
// Zero is never substituted for any of them.

/** How a cash figure came to exist. */
const CASH_BASIS = Object.freeze({
  OBSERVED: "observed",
  DERIVED_FROM_NET_INCOME: "derived_from_net_income",
  ABSENT: "absent"
});

/** Why an authoritative cash position is unavailable. */
const CASH_UNAVAILABLE = Object.freeze({
  NO_DATA: "no_data",
  NOT_AUTHORITATIVE: "input_not_authoritative"
});

function finite(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Classify the cash position on a balance sheet.
 *
 * @param {object} balanceSheet  `monthlyData.statements.balanceSheet`
 * @returns {object} frozen:
 *   available          {boolean} true ONLY when observed
 *   value              {number|null} the authoritative position, or null
 *   basis              {string} one of CASH_BASIS
 *   estimate           {number|null} the derived figure, when there is one
 *   unavailableReason  {string|null} why `value` is null
 */
function readCashPosition(balanceSheet) {
  const sheet = balanceSheet || {};
  const raw = finite(sheet.cashAndEquivalents);

  if (raw == null) {
    return Object.freeze({
      available: false, value: null, basis: CASH_BASIS.ABSENT,
      estimate: null, unavailableReason: CASH_UNAVAILABLE.NO_DATA
    });
  }

  /* An UNLABELLED figure is treated as OBSERVED. Sources that predate this
     labelling (Zoho, the demo generator) supply a real retrieved balance and
     say nothing about basis; defaulting those to derived would make working
     runway figures vanish, which is a regression dressed up as caution. Every
     source that DERIVES a value labels it. */
  const basis = sheet.cashAndEquivalentsBasis || CASH_BASIS.OBSERVED;

  if (basis === CASH_BASIS.OBSERVED) {
    // Includes an observed ZERO, which is a real measurement about a business.
    return Object.freeze({
      available: true, value: raw, basis: CASH_BASIS.OBSERVED,
      estimate: null, unavailableReason: null
    });
  }

  return Object.freeze({
    available: false,
    value: null,               // never the estimate, and never 0
    basis,
    estimate: raw,             // retained and labelled; authoritative for nothing
    unavailableReason: CASH_UNAVAILABLE.NOT_AUTHORITATIVE
  });
}

/**
 * The authoritative cash balance, or null.
 *
 * For consumers that only need the number and must not see an estimate. Named
 * so the intent is unmistakable at the call site: an `authoritativeCash(...)`
 * that returns null is obviously different from a raw field read that returns 0.
 */
function authoritativeCash(balanceSheet) {
  return readCashPosition(balanceSheet).value;
}

module.exports = {
  readCashPosition, authoritativeCash, CASH_BASIS, CASH_UNAVAILABLE
};
