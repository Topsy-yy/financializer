// INGESTION — the four "NEVER" rules from JOB 4.
//
//   NEVER  API failure     -> []
//   NEVER  missing data    -> zero
//   NEVER  invalid period  -> silently substitute the current month
//   NEVER  no connection   -> fabricated financials

const test = require("node:test");
const assert = require("node:assert/strict");

const ingestion = require("../../src/ingestion");
const period = require("../../src/ingestion/period");
const demo = require("../../src/ingestion/sources/demoSource");
const { LEVEL } = require("../../src/domain/model/dataQuality");

const NOW = Date.parse("2026-06-15T00:00:00Z");

// ── Period validation ────────────────────────────────────────────
test("[I1] a malformed period is an ERROR, never a substitution", () => {
  // WAS: zohoClient silently analysed the CURRENT month instead.
  assert.throws(() => period.parsePeriod("not-a-period"), /Invalid accounting period/);
  assert.throws(() => period.parsePeriod("2026-13"), /between 01 and 12/);
  assert.throws(() => period.parsePeriod(""), /required/);
  assert.throws(() => period.parsePeriod(undefined), /required/);
});

test("[I2] a valid period parses and yields correct inclusive bounds", () => {
  assert.equal(period.parsePeriod("2026-05").period, "2026-05");
  assert.deepEqual(period.periodRange("2026-02"), { period: "2026-02", start: "2026-02-01", end: "2026-02-28", days: 28 });
  assert.equal(period.periodRange("2024-02").days, 29, "leap year handled");
  assert.equal(period.periodRange("2026-12").end, "2026-12-31");
});

test("[I3] ingestion refuses a malformed period before touching any source", async () => {
  await assert.rejects(
    () => ingestion.ingestPeriod({ period: "2026-13", allowDemo: true, now: NOW }),
    /Invalid accounting period/
  );
});

// ── No silent fabrication ────────────────────────────────────────
test("[I4] with no connected source, ingestion FAILS rather than fabricating", async () => {
  // WAS: fetchMonthlyData() silently returned procedurally generated financials.
  await assert.rejects(
    () => ingestion.ingestPeriod({ period: "2026-05", now: NOW }),
    (err) => err.code === "no_data_source"
  );
});

test("[I5] demo data requires an EXPLICIT opt-in and is always labelled", async () => {
  const res = await ingestion.ingestPeriod({ period: "2026-05", allowDemo: true, now: NOW });
  assert.equal(res.source, "demo");
  assert.equal(res.isDemo, true);
  assert.equal(res.data.meta.source, "demo");
  assert.equal(res.data.meta.is_demo, true);
  assert.match(res.data.meta.notice, /DEMO DATA/);
  assert.ok(res.warnings.some((w) => w.code === "demo_data"), "the caller is warned");
});

test("[I6] demo data is refused in production unless explicitly allowed", () => {
  const saved = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    delete process.env.ALLOW_DEMO_DATA;
    assert.equal(demo.isAllowed(), false);
    assert.throws(() => demo.loadDemoData("2026-05"), /disabled/i);
    process.env.ALLOW_DEMO_DATA = "true";
    assert.equal(demo.isAllowed(), true);
  } finally {
    process.env.NODE_ENV = saved;
    delete process.env.ALLOW_DEMO_DATA;
  }
});

test("[I7] demo generation is deterministic and carries source record ids", async () => {
  const a = await ingestion.ingestPeriod({ period: "2026-05", allowDemo: true, now: NOW });
  const b = await ingestion.ingestPeriod({ period: "2026-05", allowDemo: true, now: NOW });
  assert.deepEqual(a.data.transactions, b.data.transactions);
  a.data.transactions.forEach((t) => {
    assert.ok(t.sourceRecordId, "every record is addressable");
    assert.equal(t.sourceSystem, "demo");
    assert.ok(t.currency, "currency is explicit");
  });
});

// ── Failure is visible ───────────────────────────────────────────
test("[I8] a source failure yields FAILED, not an empty dataset", async () => {
  // WAS: `.catch(() => [])` turned an outage into "nothing to report".
  const res = await ingestion.ingestPeriod({
    period: "2026-05",
    zoho: { fetch: async () => { throw new Error("Zoho 503 Service Unavailable"); } },
    now: NOW
  });
  assert.equal(res.data, null, "no fabricated empty dataset");
  assert.equal(res.quality.level, LEVEL.FAILED);
  assert.match(res.quality.summary, /Could not retrieve/);
  assert.equal(res.failures.length, 1);
  assert.match(res.failures[0].message, /503/);
});

test("[I9] an empty-but-successful fetch is INSUFFICIENT_EVIDENCE, not a quiet month", async () => {
  const res = await ingestion.ingestPeriod({
    period: "2026-05",
    zoho: { fetch: async () => ({ transactions: [], journalEntries: [], reconciliations: [], statements: {} }) },
    now: NOW
  });
  assert.equal(res.quality.level, LEVEL.INSUFFICIENT_EVIDENCE);
  assert.equal(res.quality.scoringReliable, false);
  assert.ok(res.warnings.some((w) => w.code === "insufficient_evidence"));
});

test("[I10] a partial fetch reports WHICH datasets are missing", async () => {
  const res = await ingestion.ingestPeriod({
    period: "2026-05",
    zoho: { fetch: async () => ({
      transactions: [{ date: "2026-05-01", amount: 100, counterparty: "A", currency: "KES" }],
      journalEntries: [],
      reconciliations: [],
      statements: { cashFlow: { inflow: 100, outflow: 50 } }
    }) },
    now: NOW
  });
  assert.equal(res.quality.level, LEVEL.PARTIAL);
  assert.ok(res.quality.missing.includes("reconciliations"));
  assert.ok(res.quality.missing.includes("statements.balanceSheet"));
  assert.ok(res.quality.completeness > 0 && res.quality.completeness < 100);
});

// ── Provenance ───────────────────────────────────────────────────
test("[I11] every ingested dataset declares its source", async () => {
  const uploaded = { transactions: [], journalEntries: [], reconciliations: [], statements: {}, meta: { source: "csv-upload" } };
  const res = await ingestion.ingestPeriod({ period: "2026-05", uploaded, now: NOW });
  assert.equal(res.source, "csv-upload");
  assert.equal(res.data.meta.source, "csv-upload");
  assert.ok(res.fetchedAt, "retrieval time is recorded");
});

test("[I12] the period on the data always matches the requested period", async () => {
  const res = await ingestion.ingestPeriod({ period: "2026-03", allowDemo: true, now: NOW });
  assert.equal(res.period, "2026-03");
  assert.equal(res.data.period, "2026-03");
  res.data.transactions.forEach((t) => assert.match(t.date, /^2026-03-/));
});
