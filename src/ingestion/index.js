// THE ingestion boundary.
//
// Target pipeline (JOB 4):
//   source -> fetch -> validate -> normalize -> quality report -> domain data
//
// The audit found two competing Zoho clients with two different normalizers and
// three different behaviours for a bad period, plus a silent fallback to
// fabricated data. This module is now the ONLY way analysis data enters the
// system, and it enforces four rules the old paths broke:
//
//   NEVER  API failure            -> []
//   NEVER  missing data           -> zero
//   NEVER  invalid period         -> silently substitute the current month
//   NEVER  no connection          -> fabricated financials
//
// Every result carries provenance (which source, when) and a DataQualityReport,
// so downstream code can distinguish "quiet month" from "we got nothing".

const { parsePeriod, InvalidPeriodError } = require("./period");
const { loadDemoData, DemoDataDisabledError } = require("./sources/demoSource");
const { assessDataQuality, LEVEL } = require("../domain/model/dataQuality");

const SOURCE = Object.freeze({
  ZOHO: "zoho-books",
  CSV: "csv-upload",
  DEMO: "demo"
});

class NoDataSourceError extends Error {
  constructor(period) {
    super(`No accounting data source is connected for ${period}. Connect Zoho Books or upload a CSV.`);
    this.name = "NoDataSourceError";
    this.code = "no_data_source";
  }
}

class IngestionFailedError extends Error {
  constructor(source, period, cause) {
    super(`Could not retrieve ${source} data for ${period}: ${cause}`);
    this.name = "IngestionFailedError";
    this.code = "ingestion_failed";
    this.source = source;
    this.period = period;
  }
}

/** Uniform envelope. `data` is null only when status is "failed". */
function envelope({ period, source, data, quality, failures = [], warnings = [] }) {
  return Object.freeze({
    period,
    source,
    data,
    quality,
    failures: Object.freeze(failures),
    warnings: Object.freeze(warnings),
    fetchedAt: (data && data.meta && data.meta.fetchedAt) || new Date().toISOString(),
    isDemo: source === SOURCE.DEMO
  });
}

/**
 * Retrieve a period of accounting data.
 *
 * @param {object} opts
 *   period        {string}  YYYY-MM — validated strictly, never guessed
 *   uploaded      {object}  a CSV dataset already held for this period
 *   zoho          {object}  { fetch(period) } — injected so this module needs no
 *                           HTTP client and stays testable
 *   allowDemo     {boolean} EXPLICIT opt-in. Demo data is never a fallback.
 *   now           {number}
 */
async function ingestPeriod(opts = {}) {
  // 1. Period — hard failure, never substitution.
  const { period } = parsePeriod(opts.period);
  const now = opts.now == null ? Date.now() : opts.now;
  const failures = [];
  const warnings = [];

  // 2. Source selection is EXPLICIT and ordered; there is no silent fallback.
  let source = null;
  let data = null;

  if (opts.uploaded) {
    source = SOURCE.CSV;
    data = opts.uploaded;
  } else if (opts.zoho && (typeof opts.zoho.fetchWithOutcomes === "function" || typeof opts.zoho.fetch === "function")) {
    source = SOURCE.ZOHO;
    try {
      if (typeof opts.zoho.fetchWithOutcomes === "function") {
        // Preferred: per-dataset outcomes, so a partial failure is visible.
        const result = await opts.zoho.fetchWithOutcomes(period);
        data = result.data;
        (result.failures || []).forEach((f) => failures.push(Object.assign({ source }, f)));
        (result.truncated || []).forEach((dataset) => warnings.push({
          code: "pagination_truncated",
          message: `More ${dataset} exist than were retrieved; this period is incomplete.`,
          dataset
        }));
      } else {
        data = await opts.zoho.fetch(period);
      }
    } catch (err) {
      // Authentication or total failure: FAILED, never an empty month.
      const quality = assessDataQuality({}, { fetchFailures: ["transactions", "statements.cashFlow"], now });
      return envelope({
        period, source, data: null,
        quality: Object.assign({}, quality, {
          level: LEVEL.FAILED,
          summary: `Could not retrieve accounting data from Zoho Books: ${err.message}`
        }),
        failures: [{ dataset: "all", source, message: err.message, code: err.code || null }]
      });
    }
  } else if (opts.allowDemo) {
    // Only ever reached by explicit request.
    source = SOURCE.DEMO;
    data = loadDemoData(period);
    warnings.push({
      code: "demo_data",
      message: "This analysis uses DEMO data, not your accounting records."
    });
  } else {
    throw new NoDataSourceError(period);
  }

  // 3. Normalize provenance so every dataset declares itself.
  data = Object.assign({}, data, {
    period,
    meta: Object.assign({ source, fetchedAt: new Date(now).toISOString() }, data.meta || {}, { source })
  });

  // 4. Quality assessment travels WITH the data.
  //    Datasets the source could not retrieve are passed through as FAILED, so
  //    "we could not read it" never collapses into "there is none".
  const failedDatasets = failures.map((f) => f.dataset).filter(Boolean);
  const quality = assessDataQuality(data, {
    now,
    fetchedAt: data.meta.fetchedAt,
    fetchFailures: failedDatasets
  });

  // Statements that were computed locally rather than retrieved are a quality
  // signal in their own right (the audit found them silently derived).
  const derived = (data.meta && data.meta.statementsDerived) || {};
  Object.keys(derived).filter((k) => derived[k]).forEach((k) => warnings.push({
    code: "statement_derived",
    message: `The ${k} statement was computed from transactions because Zoho did not return the report.`,
    dataset: `statements.${k}`
  }));

  if (failures.length) {
    warnings.push({
      code: "partial_ingestion",
      message: `Some datasets could not be retrieved: ${failedDatasets.join(", ")}.`
    });
  }

  if (quality.level === LEVEL.INSUFFICIENT_EVIDENCE) {
    warnings.push({
      code: "insufficient_evidence",
      message: "There is not enough accounting data in this period to analyse."
    });
  }

  return envelope({ period, source, data, quality, failures, warnings });
}

module.exports = {
  SOURCE,
  ingestPeriod,
  NoDataSourceError,
  IngestionFailedError,
  InvalidPeriodError,
  DemoDataDisabledError
};
