// BASELINE — CSV importer (still a live component behind the ingestion boundary).
//
// HISTORY: this file previously pinned the LEGACY zohoClient mock path with
// [KNOWN-BAD] tests — silent synthetic data, unlabelled provenance, malformed
// periods silently swapped for the current month. JOB 4 replaced that path with
// src/ingestion, and those behaviours are now asserted as FIXED in
// tests/ingestion/ingest.test.js and tests/ingestion/zohoSource.test.js.
// The legacy client was deleted once proven unreferenced, so the tests that
// imported it were moved rather than kept against a dead module.

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseFinancialCsv } = require("../../src/services/csvFinancialImporter");

const CSV_OK = "date,description,amount\n2026-05-03,Office stock,-4200\n2026-05-09,Client payment,15000\n";

test("[CSV] a valid CSV imports, stamps provenance and reports row counts", () => {
  const out = parseFinancialCsv({ csvText: CSV_OK, period: "2026-05" });
  assert.equal(out.transactions.length, 2);
  assert.equal(out.meta.rowCount, 2);
  assert.equal(out.meta.skippedRows, 0);
  assert.equal(out.meta.source, "csv-upload", "CSV stamps its provenance");
});

test("[CSV-b] malformed CSV is rejected with a specific error (not silently zeroed)", () => {
  assert.throws(() => parseFinancialCsv({ csvText: "", period: "2026-05" }), /no data rows/i);
  assert.throws(
    () => parseFinancialCsv({ csvText: "foo,bar\n1,2\n", period: "2026-05" }),
    /date column/i,
    "a missing date column is a hard error -- the correct pattern for ingestion"
  );
});

test("[CSV-c][KNOWN-BAD] CSV derives a cash balance when none is supplied", () => {
  // cashAndEquivalents = Math.max(0, netIncome) -- a computed figure presented
  // in the same field as a measured bank balance. Still outstanding; the CSV
  // importer has not yet been migrated behind the normalizer.
  const out = parseFinancialCsv({ csvText: CSV_OK, period: "2026-05" });
  assert.equal(out.statements.profitAndLoss.netIncome, 10800);
  assert.equal(out.statements.balanceSheet.cashAndEquivalents, 10800,
    "balance equals net income -- derived, not measured");
});

test("[CSV-d][FIXED in JOB 5] CSV records now carry deterministic source ids", () => {
  // WAS: CSV rows had no sourceRecordId, so a finding from a CSV import could
  // not cite the record that produced it.
  const out = parseFinancialCsv({ csvText: CSV_OK, period: "2026-05" });
  out.transactions.forEach((t) => {
    assert.equal(t.sourceSystem, "csv-upload");
    assert.match(t.sourceRecordId, /^csv:[0-9a-f]{16}(:\d+)?$/, "content-derived id");
  });
});
