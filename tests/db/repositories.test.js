// DATABASE — migrations, repositories, tenant isolation.
//
// These tests require a real PostgreSQL. If TEST_DATABASE_URL is not set they
// SKIP LOUDLY rather than passing vacuously — a green suite must never imply
// the database layer was verified when it was not.
//
//   TEST_DATABASE_URL=postgres://user@host:5432/db npm run test:db

const test = require("node:test");
const assert = require("node:assert/strict");

// Runtime uses a RESTRICTED role (no DDL, RLS applies). Migrations and fixture
// teardown use an ADMIN role. Separating them is the point: if the app role
// could bypass RLS or run DDL, the isolation tests below would prove nothing.
const TEST_DB = process.env.TEST_DATABASE_URL || "";
const ADMIN_DB = process.env.TEST_ADMIN_DATABASE_URL || TEST_DB;
const SKIP = !TEST_DB;
if (SKIP) {
  console.warn("\n*** SKIPPING DATABASE TESTS: TEST_DATABASE_URL is not set. ***");
  console.warn("*** The persistence layer is therefore NOT VERIFIED in this run. ***\n");
}

process.env.DATABASE_URL = TEST_DB;

const { Client } = require("pg");

/** Run privileged SQL on a throwaway admin connection. */
async function admin(fn) {
  const c = new Client({ connectionString: ADMIN_DB });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

const { migrate } = require("../../src/db/migrate");
const pool = require("../../src/db/pool");
const tenants = require("../../src/db/repositories/tenantRepository");
const txns = require("../../src/db/repositories/transactionRepository");
const runs = require("../../src/db/repositories/analysisRunRepository");
const engine = require("../../src/domain/analysis/engine");
const { scenarios } = require("../helpers/fixtures");

let A = null; // tenant A
let B = null; // tenant B

test.before(async () => {
  if (SKIP) return;
  // Migrations run with elevated privileges, as they would in a deploy step.
  const savedUrl = process.env.DATABASE_URL;
  const savedRole = process.env.APP_DB_ROLE;
  process.env.DATABASE_URL = ADMIN_DB;
  /* THE APPLICATION ROLE MUST BE NAMED, exactly as a real deploy names it.
     Migration 008 revokes every PUBLIC privilege, so after it the role that the
     application connects as has to be granted explicitly or nothing can reach
     the data. The role is taken from the URL these tests actually connect with,
     so the grants land on the role the assertions below exercise. */
  process.env.APP_DB_ROLE = process.env.APP_DB_ROLE
    || decodeURIComponent(new URL(TEST_DB).username || "") || "finguard_app";
  await pool.close();
  await migrate({ silent: true });
  await pool.close();
  process.env.DATABASE_URL = savedUrl;
  if (savedRole === undefined) delete process.env.APP_DB_ROLE;
  else process.env.APP_DB_ROLE = savedRole;

  // Clean slate (privileged: TRUNCATE requires table ownership).
  await admin((c) => c.query(
    "TRUNCATE finding_evidence, finding, metric_value, analysis_run, financial_transaction, membership, tenant, app_user RESTART IDENTITY CASCADE"));
  A = await tenants.createTenant({ name: "Alpha Traders", baseCurrency: "KES" });
  B = await tenants.createTenant({ name: "Beta Holdings", baseCurrency: "KES" });
});

test.after(async () => { if (!SKIP) await pool.close(); });

const tx = (i, over = {}) => Object.assign({
  period: "2026-05",
  sourceSystem: "zoho-books",
  sourceRecordId: `inv-${i}`,
  txnType: "invoice",
  txnDate: "2026-05-11",
  amount: 48500,
  currency: "KES",
  direction: "outflow",
  counterpartyName: "Rivera Logistics"
}, over);

test("[DB1] migrations run from a clean database and are idempotent", { skip: SKIP }, async () => {
  const tables = await admin(async (c) => {
    const { rows } = await c.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
    return rows.map((r) => r.tablename);
  });
  assert.ok(tables.includes("schema_migration"), "migration ledger exists");
  ["analysis_run", "finding", "finding_evidence", "financial_transaction", "tenant", "membership"]
    .forEach((t) => assert.ok(tables.includes(t), `missing table ${t}`));
});

test("[DB2] transactions round-trip with source provenance preserved", { skip: SKIP }, async () => {
  const res = await txns.upsertMany(A.id, [tx(1), tx(2, { sourceRecordId: "inv-2", amount: 6200 })]);
  assert.deepEqual(res, { inserted: 2, updated: 0 });

  const rows = await txns.findByPeriod(A.id, "2026-05");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].source_system, "zoho-books");
  assert.ok(rows[0].source_record_id, "source record id survives persistence");
  assert.equal(rows[0].currency, "KES", "currency is explicit");
  assert.equal(String(rows[0].amount), "48500.0000", "money is numeric, not float");
});

test("[DB3] re-ingesting the same period UPDATES rather than duplicating", { skip: SKIP }, async () => {
  const before = await txns.countByPeriod(A.id, "2026-05");
  const res = await txns.upsertMany(A.id, [tx(1, { amount: 49000 })]);
  assert.deepEqual(res, { inserted: 0, updated: 1 });
  const after = await txns.countByPeriod(A.id, "2026-05");
  assert.equal(after, before, "duplicate ingestion protection holds");
  const rows = await txns.findByPeriod(A.id, "2026-05");
  assert.equal(String(rows.find((r) => r.source_record_id === "inv-1").amount), "49000.0000");
});

test("[DB4] multi-currency rows retain their own currency", { skip: SKIP }, async () => {
  await txns.upsertMany(A.id, [
    tx(90, { sourceRecordId: "usd-1", currency: "USD", amount: 1000 }),
    tx(91, { sourceRecordId: "eur-1", currency: "EUR", amount: 900 })
  ]);
  const currencies = await txns.currenciesInPeriod(A.id, "2026-05");
  assert.deepEqual(currencies, ["EUR", "KES", "USD"], "currencies are preserved, not flattened");
});

// ── Tenant isolation ─────────────────────────────────────────────
test("[DB5] tenant B cannot see tenant A's transactions", { skip: SKIP }, async () => {
  await txns.upsertMany(B.id, [tx(1, { counterpartyName: "Beta Vendor" })]);
  const aRows = await txns.findByPeriod(A.id, "2026-05");
  const bRows = await txns.findByPeriod(B.id, "2026-05");
  assert.ok(aRows.length >= 2);
  assert.equal(bRows.length, 1, "B sees only its own row");
  assert.equal(bRows[0].counterparty_name, "Beta Vendor");
  const aIds = new Set(aRows.map((r) => r.id));
  bRows.forEach((r) => assert.equal(aIds.has(r.id), false, "no row appears in both tenants"));
});

test("[DB6] a tenant-scoped query cannot be tricked into cross-tenant reads", { skip: SKIP }, async () => {
  // Even asking explicitly for the other tenant's id returns nothing, because
  // RLS filters on the transaction-local app.tenant_id.
  const leaked = await pool.withTenant(B.id, async (c) => {
    const { rows } = await c.query("SELECT * FROM financial_transaction WHERE tenant_id = $1", [A.id]);
    return rows;
  });
  assert.deepEqual(leaked, [], "explicit cross-tenant SELECT returns zero rows");
});

test("[DB7] writing another tenant's id is rejected by RLS", { skip: SKIP }, async () => {
  await assert.rejects(
    () => pool.withTenant(B.id, async (c) => {
      await c.query(
        `INSERT INTO financial_transaction (tenant_id, period, source_system, source_record_id,
           txn_type, txn_date, amount, currency, direction)
         VALUES ($1,'2026-05','zoho-books','evil-1','invoice','2026-05-01',1,'KES','outflow')`,
        [A.id]
      );
    }),
    /row-level security|violates/i,
    "cross-tenant INSERT must be refused by the database itself"
  );
});

test("[DB8] transaction rollback leaves no partial state", { skip: SKIP }, async () => {
  const before = await txns.countByPeriod(A.id, "2026-05");
  await assert.rejects(() => pool.withTenant(A.id, async (c) => {
    await c.query(
      `INSERT INTO financial_transaction (tenant_id, period, source_system, source_record_id,
         txn_type, txn_date, amount, currency, direction)
       VALUES ($1,'2026-05','zoho-books','rollback-1','invoice','2026-05-01',1,'KES','outflow')`,
      [A.id]
    );
    throw new Error("boom");
  }), /boom/);
  const after = await txns.countByPeriod(A.id, "2026-05");
  assert.equal(after, before, "the failed insert was rolled back");
});

// ── Analysis runs and findings ───────────────────────────────────
test("[DB9] an analysis run persists with findings, evidence and versions", { skip: SKIP }, async () => {
  const analysis = engine.analyze(scenarios.duplicatePayment, {
    tenantId: A.id, period: "2026-05", now: Date.parse("2026-06-15T00:00:00Z")
  });
  const saved = await runs.saveRun(A.id, analysis);
  assert.ok(saved.runId);
  assert.ok(saved.findings > 0, "findings were stored");
  assert.ok(saved.evidence > 0, "evidence was stored");

  const stored = await runs.latestRun(A.id, "2026-05");
  assert.equal(stored.engine_version, analysis.engineVersion);
  assert.equal(stored.input_hash, analysis.inputHash);
  assert.ok(stored.rule_versions.duplicate_payment, "rule versions recorded");
  assert.equal(stored.data_quality_level, analysis.dataQuality.level);
});

test("[DB10] a finding can be traced to its source records — 'why did you flag this?'", { skip: SKIP }, async () => {
  const analysis = engine.analyze(scenarios.duplicatePayment, {
    tenantId: A.id, period: "2026-05", now: Date.parse("2026-06-15T00:00:00Z")
  });
  const dup = analysis.findings.find((f) => f.ruleId === "duplicate_payment");
  const stored = await runs.findingWithEvidence(A.id, dup.findingId);

  assert.ok(stored, "finding is retrievable by its stable key");
  assert.equal(stored.rule_id, "duplicate_payment");
  assert.ok(stored.rule_version, "the rule version that produced it");
  assert.ok(stored.calculation, "the arithmetic is stored, not regenerated by an LLM");
  assert.equal(stored.evidence.length, 2, "both source records are recoverable");
  stored.evidence.forEach((e) => {
    assert.ok(e.fields.amount, "evidence carries the amount");
    assert.ok(e.fields.date, "evidence carries the date");
  });
});

test("[DB11] findings are tenant-scoped", { skip: SKIP }, async () => {
  const analysis = engine.analyze(scenarios.duplicatePayment, {
    tenantId: A.id, period: "2026-05", now: Date.parse("2026-06-15T00:00:00Z")
  });
  const dup = analysis.findings.find((f) => f.ruleId === "duplicate_payment");
  const fromB = await runs.findingWithEvidence(B.id, dup.findingId);
  assert.equal(fromB, null, "tenant B cannot read tenant A's finding");
});

test("[DB12] headline metrics are queryable without JSON traversal", { skip: SKIP }, async () => {
  const analysis = engine.analyze(scenarios.cashflowStress, {
    tenantId: A.id, period: "2026-04", now: Date.parse("2026-06-15T00:00:00Z")
  });
  await runs.saveRun(A.id, analysis);
  const metrics = await pool.withTenant(A.id, async (c) => {
    const { rows } = await c.query(
      "SELECT metric_key, numeric_value FROM metric_value WHERE period = $1 ORDER BY metric_key", ["2026-04"]);
    return rows;
  });
  const keys = metrics.map((m) => m.metric_key);
  assert.ok(keys.includes("cashflow.risk_score"));
  assert.ok(keys.includes("health.overall_score"));
});

// ───────────────────────────────────────────────────────────────────────────
// JOB 5 — Finding / Evidence / AnalysisRun persistence and the legacy contract.
// ───────────────────────────────────────────────────────────────────────────

const { parseFinancialCsv } = require("../../src/services/csvFinancialImporter");
const { persistIngestion } = require("../../src/ingestion/persist");
const { toLegacyContext } = require("../../src/domain/adapters/legacyContext");
const { CATEGORY, SEVERITY } = require("../../src/domain/model/finding");

const FIXED_NOW = Date.parse("2026-06-15T00:00:00Z");
const runFor = (scenario, tenantId, period) =>
  engine.analyze(scenario, { tenantId, period, now: FIXED_NOW });

// ── Category 10: finding persistence ──

test("[DB13] every field of the authoritative Finding shape survives a round-trip",
  { skip: SKIP }, async () => {
    const analysis = runFor(scenarios.duplicatePayment, A.id, "2026-07");
    await runs.saveRun(A.id, analysis);
    const dup = analysis.findings.find((f) => f.ruleId === "duplicate_payment");
    const stored = await runs.findingWithEvidence(A.id, dup.findingId);

    // The mandate's Finding contract, field by field — not a spot check.
    assert.equal(stored.finding_key, dup.findingId);
    assert.equal(stored.period, dup.period);
    assert.equal(stored.rule_id, dup.ruleId);
    assert.equal(stored.rule_version, dup.ruleVersion);
    assert.equal(stored.category, dup.category);
    assert.equal(stored.severity, dup.severity);
    assert.equal(stored.title, dup.title);
    assert.equal(stored.description, dup.description);
    assert.equal(stored.metric, dup.metric);
    assert.equal(stored.value, String(dup.observedValue));
    assert.equal(stored.calculation, dup.calculation);
    assert.equal(stored.is_data_quality, Boolean(dup.isDataQuality));
    assert.equal(Number(stored.confidence), dup.confidence);
    assert.ok(stored.created_at, "createdAt is recorded by the database");
    // matchCriteria is machine-readable, not a sentence.
    assert.deepEqual(stored.match_criteria, dup.matchCriteria);
  });

test("[DB14] findingId is deterministic — the same data yields the same id, so a "
  + "finding can be acknowledged once and stay acknowledged", { skip: SKIP }, async () => {
  const first = runFor(scenarios.duplicatePayment, A.id, "2026-08");
  const second = runFor(scenarios.duplicatePayment, A.id, "2026-08");
  const idsA = first.findings.map((f) => f.findingId).sort();
  const idsB = second.findings.map((f) => f.findingId).sort();
  assert.deepEqual(idsB, idsA, "re-analysing identical data produces identical finding ids");

  // And a DIFFERENT period must not collide, or acknowledgements would leak
  // across months.
  const other = runFor(scenarios.duplicatePayment, A.id, "2026-09");
  const overlap = other.findings.map((f) => f.findingId).filter((id) => idsA.includes(id));
  assert.deepEqual(overlap, [], "finding ids are period-scoped");
});

test("[DB15] the category vocabulary written to the database is the closed JOB 5 set",
  { skip: SKIP }, async () => {
    const allowed = new Set(Object.values(CATEGORY));
    // Guard against a rule inventing a seventh category that the CHECK
    // constraint would reject only at runtime, in production.
    for (const key of ["duplicatePayment", "cashflowStress", "missingData", "roundNumber"]) {
      runFor(scenarios[key], A.id, "2026-05").findings.forEach((f) => {
        assert.ok(allowed.has(f.category), `unknown category ${f.category} from ${f.ruleId}`);
        assert.ok(Object.values(SEVERITY).includes(f.severity), `unknown severity ${f.severity}`);
      });
    }
    const stored = await pool.withTenant(A.id, async (c) => {
      const { rows } = await c.query("SELECT DISTINCT category FROM finding");
      return rows.map((r) => r.category);
    });
    stored.forEach((c) => assert.ok(allowed.has(c), `database holds unknown category ${c}`));
    assert.ok(!stored.includes("possible_duplicate"), "migration 002 renamed the legacy category");
  });

// ── Category 11: evidence persistence ──

test("[DB16] evidence is machine-readable — record type, relationship and the "
  + "specific field that triggered the rule", { skip: SKIP }, async () => {
  const analysis = runFor(scenarios.duplicatePayment, A.id, "2026-10");
  await runs.saveRun(A.id, analysis);
  const dup = analysis.findings.find((f) => f.ruleId === "duplicate_payment");
  const stored = await runs.findingWithEvidence(A.id, dup.findingId);

  assert.ok(stored.evidence.length >= 2, "each side of the duplicate is cited");
  stored.evidence.forEach((e) => {
    assert.ok(e.sourceRecordId, "evidence points at a source record, not an array index");
    assert.ok(e.recordType, "evidence records WHAT kind of record this is");
    assert.equal(e.relationship, "matched", "evidence records WHY the record is cited");
    assert.equal(typeof e.fields, "object", "fields are structured, not prose");
    assert.ok(!/because|appears|suspicious/i.test(e.label || ""),
      "evidence labels are identifiers, not narration");
  });
});

test("[DB17] a source record can be traced forward to every finding that cites it",
  { skip: SKIP }, async () => {
    // Provenance-bearing records, i.e. what ingestion produces after JOB 5.
    const provenanced = Object.assign({}, scenarios.duplicatePayment, {
      transactions: scenarios.duplicatePayment.transactions.map((t, i) =>
        Object.assign({}, t, {
          sourceSystem: "zoho-books",
          sourceRecordId: `zb-${i + 1}`,
          recordType: "payment"
        }))
    });
    const analysis = runFor(provenanced, A.id, "2026-11");
    await runs.saveRun(A.id, analysis);
    const dup = analysis.findings.find((f) => f.ruleId === "duplicate_payment");
    const cited = dup.evidence.find((e) => e.sourceRecordId);
    assert.equal(cited.sourceSystem, "zoho-books", "evidence carries the originating system");

    const causes = await runs.findingsCitingRecord(A.id, cited.sourceSystem, cited.sourceRecordId);
    assert.ok(causes.some((f) => f.finding_key === dup.findingId),
      "the reverse lookup finds the duplicate finding");

    // ...and the reverse lookup is tenant-scoped too.
    const fromB = await runs.findingsCitingRecord(B.id, cited.sourceSystem, cited.sourceRecordId);
    assert.deepEqual(fromB, [], "tenant B cannot see what tenant A's records caused");
  });

test("[LIMITATION] records ingested WITHOUT provenance are not reverse-lookupable",
  { skip: SKIP }, async () => {
    // The engine falls back to a positional `row:N` id when a source omits
    // provenance. That id is NOT stable across uploads, so it is deliberately
    // not usable as a lookup key — recording the limitation rather than
    // pretending the trace works. Every first-party ingestion path (CSV, Zoho)
    // now supplies provenance; this covers third-party data that does not.
    const analysis = runFor(scenarios.duplicatePayment, A.id, "2026-06");
    await runs.saveRun(A.id, analysis);
    const dup = analysis.findings.find((f) => f.ruleId === "duplicate_payment");
    const cited = dup.evidence[0];

    assert.match(cited.sourceRecordId, /^row:\d+$/, "positional fallback id");
    assert.equal(cited.sourceSystem, null, "no originating system to record");
    const causes = await runs.findingsCitingRecord(A.id, cited.sourceSystem, cited.sourceRecordId);
    assert.deepEqual(causes, [],
      "a record with no provenance cannot be traced forward — by design, not by accident");
  });

// ── Category 12: analysis-run association ──

test("[DB18] every finding is bound to the analysis run that produced it",
  { skip: SKIP }, async () => {
    const analysis = runFor(scenarios.cashflowStress, A.id, "2026-12");
    const saved = await runs.saveRun(A.id, analysis);
    const rows = await runs.findingsForRun(A.id, saved.runId);

    assert.equal(rows.length, saved.findings, "all findings belong to this run");
    rows.forEach((r) => assert.equal(r.analysis_run_id, saved.runId));

    // Re-running the SAME period creates a NEW run: history is append-only, so
    // a past result stays explainable after thresholds change.
    const second = await runs.saveRun(A.id, runFor(scenarios.cashflowStress, A.id, "2026-12"));
    assert.notEqual(second.runId, saved.runId, "a re-run is a new run, not an overwrite");
    const firstStill = await runs.findingsForRun(A.id, saved.runId);
    assert.equal(firstStill.length, rows.length, "the earlier run is untouched");
  });

test("[DB19] the AnalysisRun contract derived from a stored run is complete",
  { skip: SKIP }, async () => {
    const analysis = runFor(scenarios.cashflowStress, A.id, "2027-01");
    await runs.saveRun(A.id, analysis);
    const stored = await runs.latestRun(A.id, "2027-01");
    const domain = analysis;

    assert.equal(domain.analysisRun.analysisRunId, analysis.analysisRunId);
    assert.equal(domain.analysisRun.engineVersion, stored.engine_version);
    assert.equal(domain.analysisRun.inputHash, stored.input_hash);
    assert.equal(domain.analysisRun.status, "completed");
    assert.ok(domain.analysisRun.startedAt && domain.analysisRun.completedAt);
    // Every metric names what computed it, so an AI-sourced number could never
    // be mistaken for an authoritative one.
    domain.metrics.forEach((m) => {
      assert.ok(/^engine@/.test(m.computedBy), `metric ${m.key} not attributed to the engine`);
      if (!m.available) assert.equal(m.value, null, `${m.key} is unavailable but carries a value`);
    });
  });

// ── Category 13: legacy API contract ──

test("[DB20] the legacy response contract the frontend depends on is preserved",
  { skip: SKIP }, async () => {
    const analysis = runFor(scenarios.duplicatePayment, A.id, "2027-02");
    const ctx = toLegacyContext(analysis, {});

    ["period", "health", "cashflow", "revenue", "anomalies", "vendors", "customers",
      "onchain", "actions", "reports", "overview"].forEach((k) =>
      assert.ok(k in ctx, `legacy key ${k} disappeared`));
    ["overall_score", "risk_category", "summary", "component_scores"].forEach((k) =>
      assert.ok(k in ctx.health, `legacy health.${k} disappeared`));
    ["cash_runway", "risk_level", "net_cash_flow", "monthly_burn"].forEach((k) =>
      assert.ok(k in ctx.cashflow, `legacy cashflow.${k} disappeared`));

    assert.ok(ctx.anomalies.items.length > 0);
    ctx.anomalies.items.forEach((i) => {
      // The old triple still works...
      assert.ok(i.type && i.severity && i.description, "legacy anomaly triple intact");
      // ...and every item now carries its provenance additively.
      assert.ok(i.finding_id, "each item exposes its stable finding id");
      assert.ok(i.rule_id && i.rule_version, "each item exposes the rule that produced it");
      assert.ok(Array.isArray(i.evidence), "each item exposes machine-readable evidence");
    });
  });

// ── End-to-end ──

test("[DB21] END-TO-END: uploaded CSV -> provenance -> PostgreSQL -> deterministic "
  + "finding -> evidence -> API response", { skip: SKIP }, async () => {
  const period = "2027-03";
  // The same retainer paid twice on the same day: the duplicate rule matches on
  // (date, amount, counterparty), so same-day is what makes this a duplicate
  // rather than a legitimate recurring payment.
  const csvText = [
    "Date,Description,Amount,Counterparty",
    `${period}-04,Retainer payment,-185000,Halden Consulting`,
    `${period}-04,Retainer payment,-185000,Halden Consulting`,
    `${period}-08,Client settlement,420000,Rivera Logistics`,
    `${period}-19,Utilities,-12400,City Power`
  ].join("\n");

  // 1. Ingest — every row gets deterministic provenance, not an array index.
  const parsed = parseFinancialCsv({ csvText, period, businessName: "Alpha Traders" });
  assert.equal(parsed.transactions.length, 4);
  const ids = parsed.transactions.map((t) => t.sourceRecordId);
  assert.equal(new Set(ids).size, 4, "each row has a distinct source record id");
  ids.forEach((id) => assert.match(id, /^csv:[0-9a-f]{16}(:\d+)?$/));
  // Re-parsing the same upload must yield the SAME ids, or every re-upload
  // would duplicate the period.
  assert.deepEqual(
    parseFinancialCsv({ csvText, period }).transactions.map((t) => t.sourceRecordId), ids,
    "source record ids are content-derived, not position-derived");

  // 2. Persist — ingestion -> repository -> PostgreSQL.
  const persisted = await persistIngestion(A.id, { period, source: "csv-upload", data: parsed });
  assert.equal(persisted.persisted, true, persisted.reason || "persist failed");
  assert.equal(persisted.inserted, 4);
  assert.equal(persisted.invalid, 0);

  // Re-ingesting updates rather than duplicating.
  const again = await persistIngestion(A.id, { period, source: "csv-upload", data: parsed });
  assert.equal(again.inserted, 0);
  assert.equal(again.updated, 4);

  // 3. Read back through the repository — the engine never touches SQL.
  const stored = await txns.findByPeriod(A.id, period);
  assert.equal(stored.length, 4, "exactly four rows, no duplication");

  // 4. Analyse deterministically.
  const analysis = runFor(parsed, A.id, period);
  const dup = analysis.findings.find((f) => f.ruleId === "duplicate_payment");
  assert.ok(dup, "the duplicated retainer is detected");
  assert.equal(dup.category, CATEGORY.DUPLICATE);
  // Cautious language: a duplicate is not an accusation.
  assert.ok(!/fraud|stole|theft|embezzl/i.test(`${dup.title} ${dup.description}`),
    "duplicate findings do not allege fraud");

  // 5. The finding cites the ACTUAL ingested records.
  const citedIds = dup.evidence.map((e) => e.sourceRecordId).filter(Boolean);
  assert.ok(citedIds.length >= 2, "both payments are cited");
  citedIds.forEach((id) => assert.ok(ids.includes(id),
    `evidence cites ${id}, which is not an ingested record`));

  // 6. Persist the run, then recover the whole chain from the database alone.
  const saved = await runs.saveRun(A.id, analysis);
  const fromDb = await runs.findingWithEvidence(A.id, dup.findingId);
  assert.ok(fromDb, "the finding is retrievable by its stable id");
  assert.equal(fromDb.rule_id, "duplicate_payment");
  assert.ok(fromDb.calculation, "the arithmetic is stored, not regenerated by an LLM");
  const dbCited = fromDb.evidence.map((e) => e.sourceRecordId);
  citedIds.forEach((id) => assert.ok(dbCited.includes(id), `${id} lost in persistence`));

  // 7. Reverse: from a raw CSV row to the finding it caused.
  const causes = await runs.findingsCitingRecord(A.id, "csv-upload", citedIds[0]);
  assert.ok(causes.some((f) => f.finding_key === dup.findingId));

  // 8. The API response the frontend receives.
  const ctx = toLegacyContext(analysis, {});
  const item = ctx.anomalies.items.find((i) => i.finding_id === dup.findingId);
  assert.ok(item, "the finding reaches the API response");
  assert.equal(item.type, "duplicate_payment");
  assert.ok(item.description, "legacy consumers still get a description");
  assert.deepEqual(item.source_record_ids.slice().sort(), citedIds.slice().sort(),
    "the response carries the same provenance that is in the database");
  assert.equal(saved.findings > 0 && saved.evidence > 0, true);
});

// ───────────────────────────────────────────────────────────────────────────
// JOB 7 — rule methodology persistence and tenant scoping of rule data.
// ───────────────────────────────────────────────────────────────────────────

const domainCustomRules = require("../../src/domain/rules/customRules");
const ruleRegistry = require("../../src/domain/rules/registry");

test("[DB22] a stored finding keeps WHY it has its severity and confidence",
  { skip: SKIP }, async () => {
    const analysis = runFor(scenarios.duplicatePayment, A.id, "2027-04");
    await runs.saveRun(A.id, analysis);
    const dup = analysis.findings.find((f) => f.ruleId === "duplicate_payment");
    const stored = await runs.findingWithEvidence(A.id, dup.findingId);

    assert.equal(stored.severity_basis, dup.severityBasis);
    assert.equal(stored.confidence_basis, dup.confidenceBasis);
    assert.ok(stored.severity_reason, "the reasoning survives storage");
    assert.ok(stored.confidence_reason);
    assert.equal(stored.authority_scope, "engine");
    // The rule the stored version names must still resolve, at that version.
    assert.equal(ruleRegistry.getRule(stored.rule_id).version, stored.rule_version);
  });

test("[DB23] a run records the methodology configuration it was executed under",
  { skip: SKIP }, async () => {
    const analysis = runFor(scenarios.cashflowStress, A.id, "2027-05");
    await runs.saveRun(A.id, analysis);
    const stored = await runs.latestRun(A.id, "2027-05");

    assert.equal(stored.engine_version, ruleRegistry.ENGINE_VERSION);
    assert.ok(stored.methodology, "the applied methodology is persisted");
    assert.equal(stored.coverage_policy_version, analysis.methodology.coveragePolicy.version);
    assert.equal(stored.materiality_version, analysis.methodology.materiality.version);
    // Enough to re-explain the run without re-reading today's registry.
    assert.equal(stored.methodology.materiality.significant,
      analysis.methodology.materiality.significant);
    assert.ok(Array.isArray(stored.methodology.rulesNotApplicable),
      "which rules could NOT run is part of the record");
  });

test("[DB24] a tenant-authored finding is stored, marked, and stays tenant-scoped",
  { skip: SKIP }, async () => {
    const period = "2027-06";
    const rule = domainCustomRules.validateRule({
      name: "Large expense", severity: "high",
      condition: { type: "expense_over", amount: 1000 }, action: "flag"
    }).rule;
    rule.id = "tenant-rule-1";

    const data = {
      period,
      transactions: [{
        date: `${period}-04`, amount: 90000, counterparty: "Rivera Logistics",
        description: "Retainer", currency: "KES",
        sourceSystem: "zoho-books", sourceRecordId: "zb-cr-1"
      }],
      journalEntries: [], reconciliations: [],
      statements: { cashFlow: { inflow: 200000, outflow: 90000 },
        profitAndLoss: { revenue: 200000 }, balanceSheet: { cashAndEquivalents: 500000 } }
    };

    const analysis = runFor(data, A.id, period);
    const custom = domainCustomRules.evaluateCustomRules([rule], data, {},
      { tenantId: A.id, period }).findings;
    assert.equal(custom.length, 1);

    // Persist the run WITH the tenant-authored finding alongside engine ones.
    const merged = Object.assign({}, analysis, {
      findings: analysis.findings.concat(custom)
    });
    const saved = await runs.saveRun(A.id, merged);
    assert.ok(saved.findings > 0);

    const stored = await runs.findingWithEvidence(A.id, custom[0].findingId);
    assert.ok(stored, "the tenant's own finding is persisted like any other");
    assert.equal(stored.authority_scope, "tenant",
      "and is MARKED as tenant-authored, so it can never be counted as engine evidence");
    assert.equal(stored.rule_id, "custom:tenant-rule-1", "namespaced away from engine rule ids");
    assert.equal(stored.currency, "KES");
    assert.equal(stored.evidence.length, 1, "it cites the record that matched");

    // TENANT ISOLATION: tenant B cannot read tenant A's custom-rule finding.
    const fromB = await runs.findingWithEvidence(B.id, custom[0].findingId);
    assert.equal(fromB, null, "a custom rule's output is as tenant-scoped as any other finding");

    // ...nor can B reach it through the reverse lookup.
    const causes = await runs.findingsCitingRecord(B.id, "zoho-books", "zb-cr-1");
    assert.deepEqual(causes, []);
  });

test("[DB25] engine and tenant findings are separable in storage", { skip: SKIP }, async () => {
  const rows = await pool.withTenant(A.id, async (c) => {
    const { rows } = await c.query(
      "SELECT authority_scope, count(*)::int AS n FROM finding GROUP BY authority_scope ORDER BY 1");
    return rows;
  });
  const byScope = Object.fromEntries(rows.map((r) => [r.authority_scope, r.n]));
  assert.ok(byScope.engine > 0, "engine findings are present");
  assert.ok(byScope.tenant > 0, "and the tenant's own are distinguishable from them");
});

// ───────────────────────────────────────────────────────────────────────────
// JOB 9 — atomic credit accounting, and the AI interaction audit trail.
// ───────────────────────────────────────────────────────────────────────────

const credits = require("../../src/db/repositories/creditRepository");
const aiAudit = require("../../src/db/repositories/aiAuditRepository");

test("[DB26] credits cannot be OVERSPENT by concurrent requests", { skip: SKIP }, async () => {
  /* THE RACE THIS PROVES IS CLOSED. The old charge() read the balance, compared
     it, then decremented — three steps against an in-memory profile. Two
     instances could both read 10, both see 10 >= 4, and both deduct.

     Here 20 requests costing 4 each are fired at a balance of 10. Exactly two
     can succeed (8 of 10 spent); the rest must be refused. */
  const period = "2027-07";
  await credits.ensureBalance(A.id, { period, allowance: 10, plan: "starter" });

  const attempts = Array.from({ length: 20 }, () =>
    credits.consume(A.id, { period, cost: 4, operation: "chat" }));
  const results = await Promise.all(attempts);

  const succeeded = results.filter((r) => r.ok);
  const refused = results.filter((r) => !r.ok);

  assert.equal(succeeded.length, 2, `expected exactly 2 successes, got ${succeeded.length}`);
  assert.equal(refused.length, 18);
  refused.forEach((r) => assert.equal(r.reason, "insufficient_credits"));

  const balance = await credits.getBalance(A.id, period);
  assert.equal(balance.credits, 2, "10 - (2 x 4) = 2");
  assert.ok(balance.credits >= 0, "credits can never go negative");
});

test("[DB27] every successful charge is recorded, and the log reconciles",
  { skip: SKIP }, async () => {
    const period = "2027-08";
    await credits.ensureBalance(A.id, { period, allowance: 100, plan: "starter" });
    await credits.consume(A.id, { period, cost: 15, operation: "monthly-review", interactionId: "ai_x1" });
    await credits.consume(A.id, { period, cost: 2, operation: "chat", interactionId: "ai_x2" });

    const log = await credits.history(A.id, { limit: 10 });
    const forPeriod = log.filter((row) => row.period === period);
    assert.equal(forPeriod.length, 2);
    // The ledger reconciles: allowance minus the sum of costs is the balance.
    const spent = forPeriod.reduce((sum, row) => sum + row.cost, 0);
    const balance = await credits.getBalance(A.id, period);
    assert.equal(balance.credits, 100 - spent);
    // Each movement ties to the interaction that caused it.
    assert.ok(forPeriod.every((row) => row.interaction_id));
  });

test("[DB28] a charge against a balance that does not exist is refused, not created",
  { skip: SKIP }, async () => {
    const result = await credits.consume(A.id, { period: "2099-01", cost: 5, operation: "chat" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "no_balance", "a missing period is not an unlimited one");
  });

test("[DB29] credit balances are tenant-scoped", { skip: SKIP }, async () => {
  const period = "2027-09";
  await credits.ensureBalance(A.id, { period, allowance: 50, plan: "starter" });
  // B has no balance for this period, and cannot see or spend A's.
  assert.equal(await credits.getBalance(B.id, period), null);
  const stolen = await credits.consume(B.id, { period, cost: 5, operation: "chat" });
  assert.equal(stolen.ok, false);
  assert.equal(stolen.reason, "no_balance");
  // A's balance is untouched by B's attempt.
  assert.equal((await credits.getBalance(A.id, period)).credits, 50);
});

test("[DB30] a refund is bounded by the allowance and is logged", { skip: SKIP }, async () => {
  const period = "2027-10";
  await credits.ensureBalance(A.id, { period, allowance: 20, plan: "starter" });
  await credits.consume(A.id, { period, cost: 10, operation: "chat" });
  const refunded = await credits.refund(A.id, { period, cost: 10, operation: "chat" });
  assert.equal(refunded.remaining, 20);
  // A refund cannot mint credits beyond the allowance.
  const again = await credits.refund(A.id, { period, cost: 50, operation: "chat" });
  assert.equal(again.remaining, 20, "capped at the allowance");
});

// ── AI audit ─────────────────────────────────────────────────────

test("[DB31] a delivered interaction is recorded with everything needed to "
  + "investigate it", { skip: SKIP }, async () => {
  const analysis = runFor(scenarios.duplicatePayment, A.id, "2027-11");
  const interactionId = "ai_deliver_1";

  const result = await aiAudit.record(A.id, {
    id: interactionId,
    conversationId: "cnv_abc", turnIndex: 0,
    analysisRunId: analysis.analysisRunId, period: "2027-11",
    engineVersion: analysis.engineVersion,
    findingIds: analysis.findings.map((f) => f.findingId),
    metricKeys: analysis.metrics.map((m) => m.key),
    knowledgeChunks: ["rule:duplicate_payment#0"],
    capabilitiesUsed: ["explain_finding", "get_finding_evidence"],
    redactionLevel: "redacted",
    provider: "nvidia", model: "test-model", routingMode: "managed",
    outcome: aiAudit.OUTCOME.DELIVERED,
    validationVerdict: "ok",
    creditsCharged: 2, latencyMs: 431,
    prompt: "why was this flagged?", response: "It matched the duplicate rule."
  });
  assert.equal(result.recorded, true);

  const stored = await aiAudit.findById(A.id, interactionId);
  assert.ok(stored, "the interaction is retrievable");
  // "What authoritative context was available to the model?"
  assert.equal(stored.analysis_run_id, analysis.analysisRunId);
  assert.deepEqual(stored.finding_ids.sort(), analysis.findings.map((f) => f.findingId).sort());
  assert.deepEqual(stored.knowledge_chunks, ["rule:duplicate_payment#0"]);
  assert.deepEqual(stored.capabilities_used, ["explain_finding", "get_finding_evidence"]);
  // "Who served it, and what did it cost?"
  assert.equal(stored.provider, "nvidia");
  assert.equal(stored.routing_mode, "managed");
  assert.equal(stored.credits_charged, 2);
  assert.equal(stored.latency_ms, 431);
  assert.equal(stored.outcome, "delivered");
});

test("[DB32] raw prompts and responses are NOT stored; their hashes are",
  { skip: SKIP }, async () => {
    /* The privacy posture, asserted rather than merely documented. A prompt
       contains this tenant's transactions and counterparties; a second copy in
       an audit table is a disclosure surface the audit purpose does not need. */
    const prompt = "Rivera Logistics was paid 48,500 twice on 2026-05-11.";
    const response = "That looks like a duplicate payment.";
    await aiAudit.record(A.id, {
      id: "ai_privacy_1", outcome: aiAudit.OUTCOME.DELIVERED,
      analysisRunId: "run_x", prompt, response
    });

    const stored = await aiAudit.findById(A.id, "ai_privacy_1");
    const serialized = JSON.stringify(stored);
    assert.equal(serialized.includes("Rivera Logistics"), false,
      "the counterparty name is not in the audit row");
    assert.equal(serialized.includes("48,500"), false, "nor is the amount");
    // But integrity is preserved: a supplied copy can be proven to be the same text.
    assert.equal(stored.prompt_sha256, aiAudit.sha256(prompt));
    assert.equal(stored.response_sha256, aiAudit.sha256(response));
    assert.equal(stored.prompt_chars, prompt.length);
    assert.equal(stored.redacted_excerpt, null, "no excerpt unless explicitly retained");
  });

test("[DB33] a BLOCKED answer records WHY it was blocked", { skip: SKIP }, async () => {
  await aiAudit.record(A.id, {
    id: "ai_blocked_1", outcome: aiAudit.OUTCOME.BLOCKED,
    analysisRunId: "run_y", validationVerdict: "unsupported_numbers",
    validationIssues: [{ type: "fact", reason: "fact_without_citation", claim: "Revenue grew 40%." }],
    provider: "nvidia", creditsCharged: 0
  });
  const blocked = await aiAudit.findBlocked(A.id);
  const row = blocked.find((r) => r.id === "ai_blocked_1");
  assert.ok(row, "blocked answers are queryable — where an investigation starts");
  assert.equal(row.validation_verdict, "unsupported_numbers");
  assert.equal(row.validation_issues[0].reason, "fact_without_citation");
});

test("[DB34] a PROVIDER FAILURE is recorded with its classification", { skip: SKIP }, async () => {
  await aiAudit.record(A.id, {
    id: "ai_failed_1", outcome: aiAudit.OUTCOME.FAILED,
    failureReason: "provider_unavailable", provider: "mistral",
    latencyMs: 60001, creditsCharged: 0
  });
  const stored = await aiAudit.findById(A.id, "ai_failed_1");
  assert.equal(stored.outcome, "failed");
  assert.equal(stored.failure_reason, "provider_unavailable");
  assert.equal(stored.credits_charged, 0, "a failure is never billed");
});

test("[DB35] audit rows are TENANT-SCOPED and cannot be read across tenants",
  { skip: SKIP }, async () => {
    await aiAudit.record(A.id, {
      id: "ai_tenant_a", outcome: aiAudit.OUTCOME.DELIVERED, analysisRunId: "run_a"
    });
    assert.ok(await aiAudit.findById(A.id, "ai_tenant_a"));
    assert.equal(await aiAudit.findById(B.id, "ai_tenant_a"), null,
      "tenant B cannot read tenant A's AI interactions");

    const bConversations = await aiAudit.findByConversation(B.id, "cnv_abc");
    assert.deepEqual(bConversations, []);
  });

test("[DB36] an audit write with NO tenant is refused", { skip: SKIP }, async () => {
  // An unscoped row would be unattributable, and unreadable under RLS.
  const result = await aiAudit.record(null, {
    id: "ai_no_tenant", outcome: aiAudit.OUTCOME.DELIVERED
  });
  assert.equal(result.recorded, false);
  assert.equal(result.reason, "no_tenant");
});

test("[DB37] a conversation's interactions are retrievable in order", { skip: SKIP }, async () => {
  for (let i = 0; i < 3; i++) {
    await aiAudit.record(A.id, {
      id: `ai_conv_${i}`, conversationId: "cnv_ordered", turnIndex: i,
      outcome: aiAudit.OUTCOME.DELIVERED, analysisRunId: "run_z"
    });
  }
  const turns = await aiAudit.findByConversation(A.id, "cnv_ordered");
  assert.equal(turns.length, 3);
  assert.deepEqual(turns.map((t) => t.turn_index), [0, 1, 2]);
});

test("[DB38] every interaction grounded in a run can be found from that run",
  { skip: SKIP }, async () => {
    await aiAudit.record(A.id, {
      id: "ai_run_1", analysisRunId: "run_traceable", outcome: aiAudit.OUTCOME.DELIVERED
    });
    const found = await aiAudit.findByAnalysisRun(A.id, "run_traceable");
    assert.ok(found.some((r) => r.id === "ai_run_1"),
      "'which answers were based on this analysis?' is answerable");
  });

// ───────────────────────────────────────────────────────────────────────────
// JOB 10 — durable conversations, job locking, and the run lifecycle.
// ───────────────────────────────────────────────────────────────────────────

const conversations = require("../../src/db/repositories/conversationRepository");
const jobs = require("../../src/db/repositories/jobRepository");

test("[DB39] a conversation survives being re-read from a fresh repository handle",
  { skip: SKIP }, async () => {
    const opened = await conversations.open(A.id, { period: "2028-01", analysisRunId: "run_c1" });
    await conversations.appendTurn(A.id, opened.id, { role: "user", text: "what needs attention?" });
    await conversations.appendTurn(A.id, opened.id, { role: "assistant", text: "One duplicate." });
    await conversations.rememberEntity(A.id, opened.id, {
      kind: "finding", entityId: "fnd_abc", label: "Possible duplicate payment"
    });

    // Re-reading through the repository is what a restarted process does: there
    // is no in-process state to carry the conversation.
    const recovered = await conversations.snapshot(A.id, opened.id);
    assert.ok(recovered, "the conversation is recoverable");
    assert.equal(recovered.turnCount, 2);
    assert.equal(recovered.recentTurns[0].role, "user");
    assert.equal(recovered.recentTurns[1].text, "One duplicate.");
    assert.equal(recovered.entities.length, 1);
    assert.equal(recovered.entities[0].id, "fnd_abc",
      "the reference is an ID, resolved against the analysis when needed");
  });

test("[DB40] a conversation stores what was SAID, never a financial value",
  { skip: SKIP }, async () => {
    const c = await conversations.open(A.id, { period: "2028-02" });
    await conversations.appendTurn(A.id, c.id, { role: "assistant", text: "Two payments flagged." });
    await conversations.rememberEntity(A.id, c.id, { kind: "finding", entityId: "fnd_xyz" });

    const stored = await pool.withTenant(A.id, async (client) => {
      const turns = (await client.query(
        "SELECT * FROM conversation_turn WHERE conversation_id = $1", [c.id])).rows;
      const entities = (await client.query(
        "SELECT * FROM conversation_entity WHERE conversation_id = $1", [c.id])).rows;
      return { turns, entities };
    });
    // The entity table has no column that could hold a figure — the schema
    // itself enforces that a reference is a reference.
    const entityColumns = Object.keys(stored.entities[0]);
    assert.equal(entityColumns.includes("value"), false);
    assert.equal(entityColumns.includes("amount"), false);
    assert.ok(entityColumns.includes("entity_id"));
  });

test("[DB41] a conversation is TENANT-SCOPED at the database", { skip: SKIP }, async () => {
  const mine = await conversations.open(A.id, { period: "2028-03" });
  await conversations.appendTurn(A.id, mine.id, { role: "user", text: "private question" });

  // Tenant B cannot read it, cannot snapshot it, and cannot see its turns.
  assert.equal(await conversations.get(B.id, mine.id), null);
  assert.equal(await conversations.snapshot(B.id, mine.id), null);
  const bTurns = await pool.withTenant(B.id, async (client) =>
    (await client.query("SELECT count(*)::int AS n FROM conversation_turn WHERE conversation_id = $1",
      [mine.id])).rows[0].n);
  assert.equal(bTurns, 0, "row-level security hides the turns");
});

test("[DB42] a conversation opened with ANOTHER tenant's id creates a new one "
  + "rather than leaking", { skip: SKIP }, async () => {
  const mine = await conversations.open(A.id, { period: "2028-04" });
  await conversations.appendTurn(A.id, mine.id, { role: "user", text: "A's question" });

  // B asks to resume A's conversation id. RLS makes it invisible, so B gets a
  // NEW conversation — and learns nothing about whether that id exists.
  const bAttempt = await conversations.open(B.id, { conversationId: mine.id, period: "2028-04" });
  const bSnapshot = await conversations.snapshot(B.id, bAttempt.id);
  assert.equal(bSnapshot.turnCount, 0, "B sees an empty conversation, not A's turns");
});

test("[DB43] turns are BOUNDED — the oldest are dropped, and the count stays honest",
  { skip: SKIP }, async () => {
    const c = await conversations.open(A.id, { period: "2028-05" });
    const total = conversations.LIMITS.maxTurnsStored + 8;
    for (let i = 0; i < total; i++) {
      await conversations.appendTurn(A.id, c.id, { role: "user", text: `turn ${i}` });
    }
    const snap = await conversations.snapshot(A.id, c.id);
    assert.ok(snap.droppedTurns >= 8, "older turns were dropped, not summarised");
    assert.equal(snap.turnCount, total, "but the true count is preserved");
    assert.ok(snap.recentTurns.length <= conversations.LIMITS.turnsInPrompt);
  });

test("[DB44] retention: a conversation can be deleted, and expiry can be purged",
  { skip: SKIP }, async () => {
    const c = await conversations.open(A.id, { period: "2028-06" });
    await conversations.appendTurn(A.id, c.id, { role: "user", text: "delete me" });

    const removed = await conversations.remove(A.id, c.id);
    assert.equal(removed.deleted, true);
    assert.equal(await conversations.get(A.id, c.id), null);
    // Cascade: the turns go with it.
    const orphans = await pool.withTenant(A.id, async (client) =>
      (await client.query(
        "SELECT count(*)::int AS n FROM conversation_turn WHERE conversation_id = $1",
        [c.id])).rows[0].n);
    assert.equal(orphans, 0);

    // An expired conversation is purgeable.
    const stale = await conversations.open(A.id, { period: "2028-07" });
    await pool.withTenant(A.id, async (client) =>
      client.query("UPDATE conversation SET expires_at = now() - interval '1 day' WHERE id = $1",
        [stale.id]));
    const purged = await conversations.purgeExpired(A.id);
    assert.ok(purged.purged >= 1);
    assert.equal(await conversations.get(A.id, stale.id), null);
  });

// ── Job locking ──────────────────────────────────────────────────

test("[DB45] two workers cannot run the same tenant/period job", { skip: SKIP }, async () => {
  /* The defect this closes: the only guard was a process-local boolean, which
     guarded one of three call paths and nothing at all across instances. */
  const key = "analysis:test:2028-08";
  const first = await jobs.acquireLock(A.id, key, { owner: "worker-1" });
  const second = await jobs.acquireLock(A.id, key, { owner: "worker-2" });

  assert.equal(first.acquired, true);
  assert.equal(second.acquired, false, "the second worker is refused");
  assert.equal(second.reason, "held_by_another_worker");

  // Only the owner may release.
  assert.equal((await jobs.releaseLock(A.id, key, { owner: "worker-2" })).released, false);
  assert.equal((await jobs.releaseLock(A.id, key, { owner: "worker-1" })).released, true);
  // Now it is free.
  assert.equal((await jobs.acquireLock(A.id, key, { owner: "worker-2" })).acquired, true);
  await jobs.releaseLock(A.id, key, { owner: "worker-2" });
});

test("[DB46] concurrent lock attempts admit exactly ONE winner", { skip: SKIP }, async () => {
  const key = "analysis:concurrent:2028-09";
  const attempts = Array.from({ length: 10 }, (_, i) =>
    jobs.acquireLock(A.id, key, { owner: `worker-${i}` }));
  const results = await Promise.all(attempts);
  const winners = results.filter((r) => r.acquired);
  assert.equal(winners.length, 1, `expected exactly one winner, got ${winners.length}`);
});

test("[DB47] an EXPIRED lock is reclaimable, so a dead worker cannot block forever",
  { skip: SKIP }, async () => {
    const key = "analysis:expired:2028-10";
    await jobs.acquireLock(A.id, key, { owner: "dead-worker", leaseMs: 1 });
    await new Promise((r) => setTimeout(r, 30));
    const taken = await jobs.acquireLock(A.id, key, { owner: "live-worker" });
    assert.equal(taken.acquired, true, "the expired lease was taken over");
    await jobs.releaseLock(A.id, key, { owner: "live-worker" });
  });

test("[DB48] withLock releases even when the job THROWS", { skip: SKIP }, async () => {
  const key = "analysis:throws:2028-11";
  await assert.rejects(() => jobs.withLock(A.id, key, { owner: "w1" }, async () => {
    throw new Error("job blew up");
  }), /job blew up/);
  // The lock is not stranded.
  const after = await jobs.acquireLock(A.id, key, { owner: "w2" });
  assert.equal(after.acquired, true);
  await jobs.releaseLock(A.id, key, { owner: "w2" });
});

test("[DB49] a repeated tick cannot send a duplicate notification", { skip: SKIP }, async () => {
  const key = "notify:A:2028-12:duplicate_payment:fnd_1";
  const first = await jobs.claimNotification(A.id, key, { period: "2028-12" });
  const second = await jobs.claimNotification(A.id, key, { period: "2028-12" });
  assert.equal(first.claimed, true, "the first tick sends it");
  assert.equal(second.claimed, false, "a repeated tick does not");

  // Another tenant's identical-looking notification is a separate claim.
  const otherTenant = await jobs.claimNotification(B.id, `notify:B:2028-12:x`, {});
  assert.equal(otherTenant.claimed, true);
});

test("[DB50] a job FAILURE is recorded, not swallowed", { skip: SKIP }, async () => {
  const jobId = await jobs.startJob(A.id, { jobType: "monitoring", period: "2029-01" });
  await jobs.finishJob(A.id, jobId, { status: "failed", reason: "ingest source unreachable" });

  const history = await jobs.recentJobs(A.id, { limit: 5 });
  const failed = history.find((j) => j.period === "2029-01");
  assert.ok(failed, "the attempt is on record");
  assert.equal(failed.status, "failed");
  assert.match(failed.reason, /unreachable/);
  assert.ok(failed.finished_at, "and it is closed out, not left running");
});

// ── Analysis-run lifecycle ───────────────────────────────────────

test("[DB51] a FAILED run is a stored fact, not an absence", { skip: SKIP }, async () => {
  /* WAS: saveRun wrote `status || "completed"` and was only called after
     success, so a failure was indistinguishable from "never analysed". */
  const begun = await runs.beginRun(A.id, { period: "2029-02", source: "zoho-books" });
  assert.ok(begun.runId);

  await runs.markStatus(A.id, begun.runId, runs.LIFECYCLE.INGESTING);
  await runs.failRun(A.id, begun.runId, {
    stage: runs.STAGE.INGESTION,
    reason: "source_unavailable",
    detail: "The accounting source did not respond."
  });

  const stored = await runs.latestRunAnyStatus(A.id, "2029-02");
  assert.equal(stored.status, "failed");
  assert.equal(stored.failure_stage, "ingestion");
  assert.equal(stored.failure_reason, "source_unavailable");
  assert.ok(stored.failure_detail, "explainable without looking successful");
  assert.equal(stored.ingest_source, "zoho-books");

  // Crucially: it cannot be mistaken for a successful run that found nothing.
  const findings = await runs.findingsForRun(A.id, begun.runId);
  assert.equal(findings.length, 0);
  assert.notEqual(stored.status, "completed");

  const failures = await runs.failedRuns(A.id);
  assert.ok(failures.some((f) => f.id === begun.runId), "failed runs are queryable");
});

test("[DB52] the lifecycle advances through explicit states", { skip: SKIP }, async () => {
  const begun = await runs.beginRun(A.id, { period: "2029-03", source: "csv-upload" });
  let row = await runs.latestRunAnyStatus(A.id, "2029-03");
  assert.equal(row.status, "pending");

  await runs.markStatus(A.id, begun.runId, runs.LIFECYCLE.INGESTING);
  row = await runs.latestRunAnyStatus(A.id, "2029-03");
  assert.equal(row.status, "ingesting");

  await runs.markStatus(A.id, begun.runId, runs.LIFECYCLE.ANALYZING);
  row = await runs.latestRunAnyStatus(A.id, "2029-03");
  assert.equal(row.status, "analyzing");

  // An unknown status is refused rather than written.
  await assert.rejects(
    () => runs.markStatus(A.id, begun.runId, "finished-ish"), /unknown analysis run status/);
});
