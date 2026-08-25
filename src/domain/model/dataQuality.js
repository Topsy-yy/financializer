// Data quality as a FIRST-CLASS financial signal.
//
// The audit's most dangerous finding: an empty or partial dataset scored as a
// healthy business (severity "low", 12-month runway, no warning). An ingestion
// failure was indistinguishable from a genuinely quiet, solvent month.
//
// This module makes the distinction explicit and separate from business risk:
//
//     Business risk : HIGH        Business risk : UNKNOWN
//     Data quality  : COMPLETE    Data quality  : CRITICAL
//
// A business-risk score is only meaningful when there is enough evidence to
// compute it. `INSUFFICIENT_EVIDENCE` is a legitimate answer.

const LEVEL = Object.freeze({
  COMPLETE: "COMPLETE",                         // everything expected is present
  PARTIAL: "PARTIAL",                           // usable, but something is missing
  STALE: "STALE",                               // present but older than expected
  FAILED: "FAILED",                             // retrieval failed
  INSUFFICIENT_EVIDENCE: "INSUFFICIENT_EVIDENCE" // too little to analyse at all
});

// Ordered worst-last so we can take a maximum.
const LEVEL_RANK = Object.freeze({
  COMPLETE: 0, PARTIAL: 1, STALE: 2, INSUFFICIENT_EVIDENCE: 3, FAILED: 4
});

// Levels at which a business-risk score must NOT be presented as authoritative.
const BLOCKS_SCORING = Object.freeze([LEVEL.INSUFFICIENT_EVIDENCE, LEVEL.FAILED]);

/**
 * The datasets a complete monthly analysis expects. Each is reported
 * individually so the user learns exactly WHICH input is missing rather than
 * being handed a single opaque quality grade.
 */
const EXPECTED_DATASETS = Object.freeze([
  "transactions",
  "statements.cashFlow",
  "statements.profitAndLoss",
  "statements.balanceSheet",
  "reconciliations",
  "journalEntries"
]);

function worst(a, b) {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

function get(obj, dottedPath) {
  return dottedPath.split(".").reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

function isPresent(value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/**
 * Assess a normalized monthly dataset.
 *
 * @param {object} monthlyData  normalized ingestion output
 * @param {object} opts
 *   fetchFailures  {string[]} datasets whose retrieval failed outright
 *   fetchedAt      {string}   ISO timestamp of retrieval
 *   staleAfterDays {number}   age beyond which data is STALE (default 45)
 *   now            {number}   epoch ms, injectable for reproducible tests
 */
function assessDataQuality(monthlyData, opts = {}) {
  const data = monthlyData || {};
  const failures = new Set(opts.fetchFailures || []);
  const datasets = {};
  const missing = [];
  const failed = [];

  /* A RETRIEVAL FAILURE THAT WAS RECOVERED IS NOT A FAILURE.
   *
   * A dataset used to be stamped FAILED purely because its name appeared in
   * `fetchFailures`, before anything looked at whether a value was actually
   * produced. Zoho routinely refuses the Cash Flow *report* endpoint while
   * happily serving the transactions underneath it, and the source already
   * handles that: it computes the statement from those transactions and records
   * it in `meta.statementsDerived`. The value was present, correct and labelled
   * — and still counted as a hard failure, which forced level = FAILED, which
   * is in BLOCKS_SCORING, which refused to analyse the month.
   *
   * A user whose June data had been fetched successfully was told June could
   * not be analysed, because one optional report was unavailable.
   *
   * A derivation is weaker evidence than a retrieved statement, so it is
   * recorded in `derivedInputs` below and reported as PARTIAL — never silently
   * promoted to COMPLETE. What it must not do is claim the data is missing when
   * it is sitting right there. */
  const derivedStatements = (data.meta && data.meta.statementsDerived) || {};
  const recovered = [];

  EXPECTED_DATASETS.forEach((name) => {
    const present = isPresent(get(data, name));

    if (failures.has(name)) {
      const key = name.startsWith("statements.") ? name.slice("statements.".length) : null;
      if (present && key && derivedStatements[key]) {
        // Retrieval failed; the value was derived from data we DID get.
        datasets[name] = LEVEL.PARTIAL;
        recovered.push(name);
        return;
      }
      // Retrieval failed and nothing replaced it — a real failure.
      datasets[name] = LEVEL.FAILED;
      failed.push(name);
      return;
    }

    datasets[name] = present ? LEVEL.COMPLETE : LEVEL.INSUFFICIENT_EVIDENCE;
    if (!present) missing.push(name);
  });

  // Overall level -------------------------------------------------------
  let level = LEVEL.COMPLETE;
  if (failed.length) level = worst(level, LEVEL.FAILED);
  if (missing.length) level = worst(level, LEVEL.PARTIAL);
  // A recovered statement keeps the month analysable, but never COMPLETE.
  if (recovered.length) level = worst(level, LEVEL.PARTIAL);

  // Nothing to analyse at all: no transactions AND no statements.
  const hasTransactions = isPresent(data.transactions);
  const hasAnyStatement =
    isPresent(get(data, "statements.cashFlow")) ||
    isPresent(get(data, "statements.profitAndLoss")) ||
    isPresent(get(data, "statements.balanceSheet"));
  if (!hasTransactions && !hasAnyStatement) {
    level = worst(level, LEVEL.INSUFFICIENT_EVIDENCE);
  }

  // Staleness -----------------------------------------------------------
  const fetchedAt = opts.fetchedAt || (data.meta && data.meta.fetchedAt) || null;
  const staleAfterDays = opts.staleAfterDays == null ? 45 : opts.staleAfterDays;
  let ageDays = null;
  if (fetchedAt) {
    const t = Date.parse(fetchedAt);
    if (Number.isFinite(t)) {
      const now = opts.now == null ? Date.now() : opts.now;
      ageDays = Math.floor((now - t) / 86400000);
      if (ageDays > staleAfterDays) level = worst(level, LEVEL.STALE);
    }
  }

  /* DERIVED INPUTS ARE A DATA-QUALITY FACT (JOB 12 Part E).
   *
   * When an upload supplies no cash balance, ingestion derives one from net
   * income. That derivation is labelled and is no longer used for any metric,
   * but the ANALYSIS still needs to say that it ran on partly-inferred inputs
   * — otherwise a report can read as fully observed when one of its headline
   * inputs was never supplied. This does not downgrade `level`: nothing is
   * missing or stale, and the affected metrics already report themselves
   * unavailable. It is recorded so consumers can disclose it. */
  const derivedInputs = [];

  /* A statement the provider would not serve, rebuilt from the transactions.
     Recorded here so the report says "computed from your transactions because
     Zoho did not return the report" rather than presenting it as retrieved. */
  recovered.forEach((name) => derivedInputs.push({
    input: name,
    basis: "derived_from_transactions",
    affects: [name],
    detail: `The ${name.replace("statements.", "")} statement could not be `
      + "retrieved from the accounting system, so it was computed from the "
      + "transactions in this period. The underlying transactions were "
      + "retrieved in full."
  }));

  const cashBasis = get(data, "statements.balanceSheet.cashAndEquivalentsBasis");
  if (cashBasis && cashBasis !== "observed") {
    derivedInputs.push({
      input: "statements.balanceSheet.cashAndEquivalents",
      basis: cashBasis,
      // Named so a consumer can explain the consequence rather than only the cause.
      affects: ["cash_on_hand", "cashflow.runway_months"],
      detail: "No cash balance was supplied; an estimate was derived from net "
        + "income. It is not used for the cash position or for runway, which "
        + "are reported as unavailable."
    });
  }

  const completeness = EXPECTED_DATASETS.length
    ? Math.round(((EXPECTED_DATASETS.length - missing.length - failed.length) / EXPECTED_DATASETS.length) * 100)
    : 0;

  return Object.freeze({
    level,
    completeness,          // 0-100, share of expected datasets present
    datasets: Object.freeze(datasets),
    missing: Object.freeze(missing),
    failed: Object.freeze(failed),
    /* Datasets the source could not retrieve but which were rebuilt from data
       it DID retrieve. Neither missing nor failed — present, and weaker. */
    recovered: Object.freeze(recovered),
    ageDays,
    // Provenance: what produced this data. `null` means the source did not
    // declare itself -- which is itself a quality problem worth surfacing.
    source: (data.meta && data.meta.source) || null,
    fetchedAt,
    /* Inputs that were INFERRED rather than observed. Empty is the normal case.
       A non-empty list means the analysis is sound but not fully observed, and
       anything presenting it (executive report, AI narration) must say so
       rather than implying every figure came from the books. */
    derivedInputs: Object.freeze(derivedInputs),
    hasDerivedInputs: derivedInputs.length > 0,
    // Can a business-risk score be presented as authoritative?
    scoringReliable: !BLOCKS_SCORING.includes(level),
    summary: buildSummary(level, missing, failed, ageDays, staleAfterDays, recovered)
  });
}

function buildSummary(level, missing, failed, ageDays, staleAfterDays, recovered = []) {
  switch (level) {
    case LEVEL.COMPLETE:
      return "All expected accounting data was available for this period.";
    case LEVEL.FAILED:
      return `Could not retrieve: ${failed.join(", ")}. Analysis of the affected areas is unavailable.`;
    case LEVEL.INSUFFICIENT_EVIDENCE:
      return "There is not enough accounting data for this period to assess financial health.";
    case LEVEL.STALE:
      return `Accounting data is ${ageDays} days old (expected within ${staleAfterDays} days); findings may not reflect current activity.`;
    case LEVEL.PARTIAL:
    default: {
      /* Two different partial cases, and saying "Missing: ." because a
         statement was recovered rather than absent would be nonsense. */
      const parts = [];
      if (missing.length) parts.push(`Missing: ${missing.join(", ")}.`);
      if (recovered.length) {
        parts.push(`Computed from transactions because the accounting system `
          + `did not return them: ${recovered.join(", ")}.`);
      }
      return parts.length
        ? `Analysis is based on partial data. ${parts.join(" ")}`
        : "Analysis is based on partial data.";
    }
  }
}

module.exports = {
  LEVEL,
  LEVEL_RANK,
  BLOCKS_SCORING,
  EXPECTED_DATASETS,
  assessDataQuality,
  worst
};
