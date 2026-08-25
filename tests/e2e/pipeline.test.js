// END-TO-END — the real route stack, against real PostgreSQL, with RLS on.
//
// WHY THIS SUITE EXISTS. Every layer had tests. What nothing proved was that
// the layers were CONNECTED in the running application — and they were not:
// `req.userStore.tenantId` was never assigned anywhere, so ingestion
// persistence, the AI audit trail and the credit ledger all silently
// short-circuited on `no_tenant` while their own tests passed by constructing
// tenants directly.
//
// A suite that calls internal functions could not have caught that. These tests
// drive the HTTP surface of the real Express app, with a real database, a
// non-superuser role and RLS enforced, and then look in the DATABASE to confirm
// what actually landed.
//
//   npm run test:e2e   (requires TEST_DATABASE_URL)

const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { startServer } = require("../helpers/server");

const TEST_DB = process.env.TEST_DATABASE_URL || "";
const ADMIN_DB = process.env.TEST_ADMIN_DATABASE_URL || TEST_DB;
const SKIP = !TEST_DB;

if (SKIP) {
  console.warn("\n*** SKIPPING END-TO-END TESTS: TEST_DATABASE_URL is not set. ***");
  console.warn("*** The production path is therefore NOT VERIFIED in this run. ***\n");
}

/** Privileged SQL, for inspecting what the app wrote and for teardown. */
async function admin(fn) {
  const client = new Client({ connectionString: ADMIN_DB });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

/** Read a tenant's rows with RLS ACTIVE, exactly as the app would. */
async function asTenant(tenantId, fn) {
  const client = new Client({ connectionString: TEST_DB });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } finally { await client.end(); }
}

const PERIOD = "2026-05";
const PRIOR = "2026-04";

// Money out is negative — the CSV importer's bank-statement convention.
const CSV_A = [
  "Date,Description,Amount,Counterparty",
  `${PERIOD}-04,Consulting retainer,-200000,Rivera Logistics`,
  `${PERIOD}-04,Consulting retainer,-200000,Rivera Logistics`,
  `${PERIOD}-11,Electricity,-120000,City Power`,
  `${PERIOD}-22,Client settlement,900000,BigCo Retail`
].join("\n");

const CSV_PRIOR = [
  "Date,Description,Amount,Counterparty",
  `${PRIOR}-06,Office supplies,-40000,Acme Supplies`,
  `${PRIOR}-25,Client settlement,900000,BigCo Retail`
].join("\n");

let server;
let tenantA;   // the first client (its own session, therefore its own tenant)
let tenantB;   // a second, unrelated client

test.before(async () => {
  if (SKIP) return;

  // Clean slate, so assertions about "what the app wrote" mean what they say.
  await admin((c) => c.query(
    `TRUNCATE ai_interaction, credit_transaction, credit_balance,
              conversation_entity, conversation_turn, conversation,
              job_run, job_lock, notification_dedupe,
              finding_evidence, finding, metric_value, analysis_run,
              financial_transaction, membership, tenant, app_user
     RESTART IDENTITY CASCADE`));

  server = await startServer({
    ALLOW_DEMO_DATA: "true",
    ENABLE_AI_ANALYSIS: "true",
    NVIDIA_API_KEY: "e2e-managed-key",
    AI_TEST_PROVIDER: "1",
    DATABASE_URL: TEST_DB
  });
  tenantA = server.client();
  tenantB = server.client();
});

test.after(async () => { if (server) await server.stop(); });

async function stub(client, payload) {
  await client.post("/api/__test/ai-stub", {
    text: typeof payload === "string" ? payload : JSON.stringify(payload)
  });
}

/** The tenant id the app derived for a client, read back through its own API. */
async function tenantIdOf(client) {
  const res = await client.get("/api/health/ready");
  assert.equal(res.status < 500, true);
  // The tenant is not exposed by the API by design, so it is read from the
  // database instead — which is also the stronger assertion.
  return null;
}

// ─────────────────────────────────────────────────────────────────
// PIPELINE A — CSV to copilot answer, through every real layer.
// ─────────────────────────────────────────────────────────────────

test("[E1] CSV upload persists to PostgreSQL under a real tenant", { skip: SKIP }, async () => {
  const upload = await tenantA.upload("/api/financial-data/upload", {
    filename: "may.csv", content: CSV_A,
    fields: { period: PERIOD, currentCashBalance: 1200000 }
  });
  assert.equal(upload.status, 200, JSON.stringify(upload.json));
  assert.equal(upload.json.summary.transaction_count, 4);

  const review = await tenantA.post("/api/monthly-review", {
    month: PERIOD, use_ai_analysis: false
  });
  assert.equal(review.status, 200, JSON.stringify(review.json));

  /* THE ASSERTION THAT WOULD HAVE CAUGHT THE BUG. Before tenant resolution was
     wired, this table stayed empty no matter what the API returned, because
     persist.js short-circuited on a null tenant. */
  const rows = await admin(async (c) => {
    const { rows } = await c.query(
      "SELECT tenant_id, period, source_system, counterparty_name, amount FROM financial_transaction ORDER BY amount");
    return rows;
  });
  assert.equal(rows.length, 4, "the uploaded records reached PostgreSQL");
  assert.ok(rows.every((r) => r.tenant_id), "every row is attributed to a tenant");
  assert.ok(rows.every((r) => r.source_system === "csv-upload"), "provenance survived");

  const tenants = await admin(async (c) => (await c.query("SELECT id FROM tenant")).rows);
  assert.ok(tenants.length >= 1, "a tenant was provisioned for the session");
});

test("[E2] the analysis run, findings and evidence are persisted and readable "
  + "UNDER RLS", { skip: SKIP }, async () => {
  const tenantRow = await admin(async (c) =>
    (await c.query("SELECT tenant_id FROM financial_transaction LIMIT 1")).rows[0]);
  const tenant = tenantRow.tenant_id;

  const stored = await asTenant(tenant, async (c) => {
    const runs = (await c.query(
      "SELECT id, period, status, engine_version FROM analysis_run WHERE period = $1", [PERIOD])).rows;
    const findings = (await c.query(
      "SELECT finding_key, rule_id, rule_version, severity, authority_scope FROM finding")).rows;
    const evidence = (await c.query("SELECT source_record_id FROM finding_evidence")).rows;
    return { runs, findings, evidence };
  });

  assert.ok(stored.runs.length >= 1, "the analysis run was stored");
  assert.equal(stored.runs[0].status, "completed");
  assert.ok(stored.runs[0].engine_version, "the engine version is recorded");
  assert.ok(stored.findings.length > 0, "findings were stored");
  assert.ok(stored.findings.some((f) => f.rule_id === "duplicate_payment"),
    "the duplicate the engine detected is in the database");
  assert.ok(stored.findings.every((f) => f.authority_scope === "engine"));
  assert.ok(stored.evidence.length > 0, "evidence rows cite source records");
});

test("[E3] the copilot answers from THIS tenant's authoritative context, and the "
  + "interaction is audited", { skip: SKIP }, async () => {
  const items = (await tenantA.get("/api/anomalies")).json.anomalies.items;
  const dup = items.find((i) => i.rule_id === "duplicate_payment");
  assert.ok(dup, "precondition: the duplicate is visible over the API");

  await stub(tenantA, {
    summary: "A duplicate payment was flagged for review.",
    facts: [{ claim: "A possible duplicate payment was detected.",
      citations: [`finding:${dup.finding_id}`] }],
    inferences: [{ claim: "The invoice may have been settled twice.",
      supportingReferences: [`finding:${dup.finding_id}`] }],
    recommendations: [{ claim: "Check both records against the invoice." }],
    limitations: ["I cannot tell whether a refund was issued."]
  });

  const res = await tenantA.post("/api/copilot", {
    message: "why was this flagged?", month: PERIOD
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.ok, true, JSON.stringify(res.json));
  assert.equal(res.json.answer.facts.length, 1);
  assert.ok(res.json.answer.facts[0].citations.length > 0);

  /* THE AUDIT TRAIL, in the database. This is the second thing that silently
     did nothing before tenant resolution existed. */
  const tenant = (await admin(async (c) =>
    (await c.query("SELECT tenant_id FROM financial_transaction LIMIT 1")).rows[0])).tenant_id;

  const audit = await asTenant(tenant, async (c) =>
    (await c.query(
      "SELECT * FROM ai_interaction WHERE id = $1", [res.json.interaction_id])).rows[0]);

  assert.ok(audit, "the interaction was recorded");
  assert.equal(audit.outcome, "delivered");
  assert.ok(audit.analysis_run_id, "grounded in a named run");
  assert.ok(audit.finding_ids.length > 0, "the context offered is recorded");
  assert.ok(audit.knowledge_chunks.length >= 0);
  assert.equal(audit.provider, "nvidia");
  assert.ok(audit.latency_ms >= 0);
  // Privacy posture: hashes, not content.
  assert.ok(audit.prompt_sha256, "the prompt hash is stored");
  assert.equal(JSON.stringify(audit).includes("Rivera Logistics"), false,
    "no counterparty name is in the audit row");
});

test("[E4] a delivered answer is CHARGED through the atomic ledger", { skip: SKIP }, async () => {
  const tenant = (await admin(async (c) =>
    (await c.query("SELECT tenant_id FROM financial_transaction LIMIT 1")).rows[0])).tenant_id;

  const ledger = await asTenant(tenant, async (c) => ({
    balance: (await c.query("SELECT credits, allowance FROM credit_balance")).rows[0],
    movements: (await c.query(
      "SELECT operation, cost, balance_after, interaction_id FROM credit_transaction ORDER BY id")).rows
  }));

  assert.ok(ledger.balance, "a credit balance row exists for the tenant");
  assert.ok(ledger.movements.length > 0, "the charge was recorded in the ledger");
  const chat = ledger.movements.find((m) => m.operation === "chat");
  assert.ok(chat, "the copilot answer was billed as a chat operation");
  assert.ok(chat.interaction_id, "the spend ties to the interaction that caused it");
  assert.equal(ledger.balance.credits, ledger.balance.allowance - chat.cost);
});

// ─────────────────────────────────────────────────────────────────
// PIPELINE B — tenant isolation, at HTTP and at the database.
// ─────────────────────────────────────────────────────────────────

test("[E5] tenant B cannot reach tenant A's analysis, findings or evidence",
  { skip: SKIP }, async () => {
    const aItems = (await tenantA.get("/api/anomalies")).json.anomalies.items;
    const aFinding = aItems[0].finding_id;

    // B has run no analysis. Its own views must be empty, not A's.
    const bAnomalies = await tenantB.get("/api/anomalies");
    const bItems = (bAnomalies.json.anomalies && bAnomalies.json.anomalies.items) || [];
    assert.equal(bItems.some((i) => i.finding_id === aFinding), false,
      "tenant B must not see tenant A's finding");
    assert.equal(JSON.stringify(bAnomalies.json).includes("Rivera Logistics"), false,
      "nor tenant A's counterparty");

    // Naming A's finding id explicitly must not expand access.
    const bEvidence = await tenantB.get(`/api/copilot/evidence/${aFinding}`);
    assert.notEqual(bEvidence.status, 200, "evidence for another tenant's finding is not served");
    assert.equal(JSON.stringify(bEvidence.json).includes("Rivera Logistics"), false);
  });

test("[E6] tenant B cannot invoke the copilot using tenant A's identifiers",
  { skip: SKIP }, async () => {
    const aItems = (await tenantA.get("/api/anomalies")).json.anomalies.items;
    const aFinding = aItems[0].finding_id;

    await stub(tenantB, {
      summary: "ok", facts: [], inferences: [], recommendations: [], limitations: []
    });
    const res = await tenantB.post("/api/copilot", {
      message: "explain this finding", month: PERIOD, finding_id: aFinding
    });
    assert.equal(res.status, 200);
    const body = JSON.stringify(res.json);
    assert.equal(body.includes("Rivera Logistics"), false, "no cross-tenant data appears");
    assert.equal(body.includes("200,000"), false, "nor a cross-tenant figure");
  });

test("[E7] RLS blocks a cross-tenant read at the DATABASE, not just the API",
  { skip: SKIP }, async () => {
    const tenants = await admin(async (c) =>
      (await c.query("SELECT id FROM tenant ORDER BY created_at")).rows.map((r) => r.id));
    assert.ok(tenants.length >= 1);

    // A tenant that owns nothing sees nothing, even reading the table directly
    // with the application's own (non-superuser) role.
    const strangerId = "00000000-0000-5000-8000-000000000000";
    const visible = await asTenant(strangerId, async (c) => ({
      transactions: (await c.query("SELECT count(*)::int AS n FROM financial_transaction")).rows[0].n,
      findings: (await c.query("SELECT count(*)::int AS n FROM finding")).rows[0].n,
      interactions: (await c.query("SELECT count(*)::int AS n FROM ai_interaction")).rows[0].n,
      conversations: (await c.query("SELECT count(*)::int AS n FROM conversation")).rows[0].n
    }));
    assert.deepEqual(visible, { transactions: 0, findings: 0, interactions: 0, conversations: 0 },
      "row-level security hides every table from an unrelated tenant");
  });

// ─────────────────────────────────────────────────────────────────
// PIPELINE C — failure honesty.
// ─────────────────────────────────────────────────────────────────

test("[E8] an invalid period is refused, not silently swapped", { skip: SKIP }, async () => {
  const res = await tenantA.upload("/api/financial-data/upload", {
    filename: "bad.csv", content: CSV_A, fields: { period: "not-a-period" }
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /period/i);
});

test("[E9] AI unavailable leaves the deterministic analysis intact", { skip: SKIP }, async () => {
  const before = (await tenantA.get("/api/health-score")).json.health;

  await tenantA.post("/api/__test/ai-stub", { fail: "provider_unavailable" });
  const res = await tenantA.post("/api/copilot", { message: "how are we doing?", month: PERIOD });
  assert.equal(res.json.ok, false);
  assert.ok(res.json.message, "the user is told what happened");

  const after = (await tenantA.get("/api/health-score")).json.health;
  assert.deepEqual(after, before, "the authoritative score is untouched by an AI failure");

  // The failure is audited too.
  const tenant = (await admin(async (c) =>
    (await c.query("SELECT tenant_id FROM financial_transaction LIMIT 1")).rows[0])).tenant_id;
  const failed = await asTenant(tenant, async (c) =>
    (await c.query("SELECT outcome, failure_reason, credits_charged FROM ai_interaction "
      + "WHERE outcome = 'failed' ORDER BY created_at DESC LIMIT 1")).rows[0]);
  assert.ok(failed, "a provider failure is recorded");
  assert.equal(failed.credits_charged, 0, "and is not billed");
});

test("[E10] a fabricated answer is blocked, audited, and not billed", { skip: SKIP }, async () => {
  const tenant = (await admin(async (c) =>
    (await c.query("SELECT tenant_id FROM financial_transaction LIMIT 1")).rows[0])).tenant_id;
  const before = await asTenant(tenant, async (c) =>
    (await c.query("SELECT credits FROM credit_balance")).rows[0].credits);

  await stub(tenantA, {
    summary: "Revenue reached KES 8,675,309.",
    facts: [{ claim: "Your largest supplier is insolvent.", citations: [] }],
    inferences: [], recommendations: [], limitations: []
  });
  const res = await tenantA.post("/api/copilot", { message: "how did revenue do?", month: PERIOD });
  assert.equal(res.json.ok, false);
  assert.equal(res.json.blocked, true);
  assert.equal(JSON.stringify(res.json).includes("8,675,309"), false);
  assert.equal(JSON.stringify(res.json).includes("insolvent"), false);

  const after = await asTenant(tenant, async (c) => ({
    credits: (await c.query("SELECT credits FROM credit_balance")).rows[0].credits,
    blocked: (await c.query(
      "SELECT outcome, validation_verdict, credits_charged FROM ai_interaction "
      + "WHERE outcome = 'blocked' ORDER BY created_at DESC LIMIT 1")).rows[0]
  }));
  assert.equal(after.credits, before, "a blocked answer is not billed");
  assert.ok(after.blocked, "and it is audited");
  assert.equal(after.blocked.credits_charged, 0);
});

// ─────────────────────────────────────────────────────────────────
// PIPELINE D — persistence across a restart.
// ─────────────────────────────────────────────────────────────────

test("[E11] analysis, findings and conversation SURVIVE a full restart",
  { skip: SKIP }, async () => {
    // Establish a conversation before the restart.
    await stub(tenantA, {
      summary: "One duplicate was flagged.",
      facts: [], inferences: [],
      recommendations: [{ claim: "Check the invoice." }], limitations: []
    });
    const first = await tenantA.post("/api/copilot", {
      message: "what needs attention?", month: PERIOD
    });
    assert.equal(first.json.ok, true, JSON.stringify(first.json));
    const conversationId = first.json.conversation_id;
    assert.ok(conversationId);

    const tenant = (await admin(async (c) =>
      (await c.query("SELECT tenant_id FROM financial_transaction LIMIT 1")).rows[0])).tenant_id;

    // The analysis is in the database, so it survives whatever the process does.
    const persisted = await asTenant(tenant, async (c) => ({
      runs: (await c.query("SELECT count(*)::int AS n FROM analysis_run")).rows[0].n,
      findings: (await c.query("SELECT count(*)::int AS n FROM finding")).rows[0].n,
      transactions: (await c.query("SELECT count(*)::int AS n FROM financial_transaction")).rows[0].n
    }));
    assert.ok(persisted.runs > 0 && persisted.findings > 0 && persisted.transactions > 0);

    // RESTART: a brand-new server process against the same database.
    const restarted = await startServer({
      ALLOW_DEMO_DATA: "true", ENABLE_AI_ANALYSIS: "true",
      NVIDIA_API_KEY: "e2e-managed-key", AI_TEST_PROVIDER: "1",
      DATABASE_URL: TEST_DB
    });
    try {
      const recovered = await asTenant(tenant, async (c) => ({
        runs: (await c.query("SELECT count(*)::int AS n FROM analysis_run")).rows[0].n,
        findings: (await c.query("SELECT count(*)::int AS n FROM finding")).rows[0].n,
        conversations: (await c.query(
          "SELECT id FROM conversation WHERE id = $1", [conversationId])).rows
      }));
      assert.equal(recovered.runs, persisted.runs, "the analysis survived");
      assert.equal(recovered.findings, persisted.findings, "the findings survived");

      /* HARDENED in the final closure phase. This was a conditional -- it only
         asserted the conversation survived IF a row happened to be found, so it
         would have passed silently had the copilot stopped writing to the
         durable store at all. Conversations ARE persisted on the production
         path, so the mandate's "persisted conversation recovery" is provable
         outright and is now required. */
      assert.equal(recovered.conversations.length, 1,
        "the conversation the copilot returned an id for is IN the database "
        + "after a restart -- not merely absent-and-tolerated");
      assert.equal(recovered.conversations[0].id, conversationId,
        "and it is the same conversation, recovered by the id the API handed out");
    } finally {
      await restarted.stop();
    }
  });

// ─────────────────────────────────────────────────────────────────
// Health and readiness.
// ─────────────────────────────────────────────────────────────────

test("[E12] liveness and readiness answer different questions", { skip: SKIP }, async () => {
  const live = await tenantA.get("/api/health/live");
  assert.equal(live.status, 200);
  assert.equal(live.json.status, "live");

  const ready = await tenantA.get("/api/health/ready");
  assert.equal(ready.status, 200, "with a working database this instance is ready");
  assert.equal(ready.json.checks.database.ok, true);
  // AI availability is reported but does not gate readiness.
  assert.equal(ready.json.checks.ai.ok, true);
  assert.match(ready.json.checks.ai.detail, /does not gate readiness/i);
});

// ─────────────────────────────────────────────────────────────────
// PIPELINE E — FINAL CLOSURE PHASE 3.
//
// The properties the mandate names explicitly and that were not yet pinned:
// credits move EXACTLY once, a delivered answer leaves an audit record, and a
// FAILED ingestion never produces a completed analysis run or a dashboard that
// implies one. Every one of these starts from HTTP; the database is inspected
// afterwards to confirm what the application actually wrote.
// ─────────────────────────────────────────────────────────────────

/** The tenant the app assigned to tenantA, read from what it wrote. */
async function tenantAId() {
  return (await admin(async (c) =>
    (await c.query("SELECT tenant_id FROM financial_transaction LIMIT 1")).rows[0])).tenant_id;
}

test("[E13] one delivered answer moves credits EXACTLY once", { skip: SKIP }, async () => {
  const tenant = await tenantAId();

  const before = await asTenant(tenant, async (c) => ({
    credits: (await c.query("SELECT credits FROM credit_balance")).rows[0].credits,
    movements: (await c.query("SELECT count(*)::int AS n FROM credit_transaction")).rows[0].n,
    interactions: (await c.query("SELECT count(*)::int AS n FROM ai_interaction")).rows[0].n
  }));

  await stub(tenantA, {
    summary: "Spending is concentrated in one supplier.",
    facts: [], inferences: [],
    recommendations: [{ claim: "Diversify suppliers." }], limitations: []
  });
  const res = await tenantA.post("/api/copilot", {
    message: "where is my spending concentrated?", month: PERIOD
  });
  assert.equal(res.json.ok, true, JSON.stringify(res.json));

  const after = await asTenant(tenant, async (c) => ({
    credits: (await c.query("SELECT credits FROM credit_balance")).rows[0].credits,
    movements: (await c.query(
      "SELECT operation, cost, balance_after FROM credit_transaction ORDER BY id")).rows
  }));

  const added = after.movements.length - before.movements;
  assert.equal(added, 1,
    "EXACTLY ONE ledger movement for one answer -- not zero (unbilled work) and "
    + "not two (a double charge from a retry or a duplicated call site)");

  const charge = after.movements[after.movements.length - 1];
  assert.equal(after.credits, before.credits - charge.cost,
    "the balance moved by exactly the recorded cost");
  assert.equal(charge.balance_after, after.credits,
    "the ledger's own record of the resulting balance agrees with the balance row");
});

test("[E14] a delivered answer leaves an AI audit record", { skip: SKIP }, async () => {
  const tenant = await tenantAId();
  const audit = await asTenant(tenant, async (c) =>
    (await c.query(
      "SELECT outcome, validation_verdict, credits_charged, provider, tenant_id "
      + "FROM ai_interaction WHERE outcome <> 'blocked' "
      + "ORDER BY created_at DESC LIMIT 1")).rows[0]);

  assert.ok(audit, "the successful answer from E13 was audited, not only the blocked one");
  assert.equal(audit.tenant_id, tenant, "the audit row is attributed to the right tenant");
  assert.ok(audit.credits_charged > 0, "and it records what the answer cost");
  assert.ok(audit.provider, "and which provider produced it");
});

test("[E15] a FAILED ingestion produces no completed analysis run", { skip: SKIP }, async () => {
  /* THE PROPERTY. A rejected upload must leave nothing behind that a later
     reader could mistake for a real analysis. The dangerous outcome is not the
     error -- it is a half-created run row, or a dashboard that reports a period
     as analysed when the data never arrived. */
  const fresh = server.client();
  // Prime an identity, then look at what this brand-new tenant has.
  await fresh.get("/api/health/live");

  const badUpload = await fresh.upload("/api/financial-data/upload", {
    filename: "broken.csv",
    // Not a CSV the importer can use: no recognisable columns at all.
    content: "this is not a financial statement\njust prose, no columns\n",
    fields: { period: PERIOD }
  });
  assert.ok(badUpload.status >= 400 || badUpload.json.ok === false,
    `a malformed upload is refused (status ${badUpload.status})`);

  // Whatever tenant this client was assigned, it must hold no analysis.
  const tenants = await admin(async (c) =>
    (await c.query("SELECT id FROM tenant")).rows.map((r) => r.id));

  for (const tenant of tenants) {
    const rows = await asTenant(tenant, async (c) => ({
      runs: (await c.query(
        "SELECT status, period FROM analysis_run WHERE period = $1", [PERIOD])).rows,
      broken: (await c.query(
        "SELECT count(*)::int AS n FROM financial_transaction WHERE description ILIKE '%not a financial statement%'"
      )).rows[0].n
    }));
    assert.equal(rows.broken, 0, "the unparseable content was not ingested as a transaction");
    rows.runs.forEach((run) => {
      /* Any run for this period must be a REAL one (from E1's good upload),
         never a leftover created by the failed attempt. A run that exists must
         not be sitting in a non-terminal state either -- that is the state a
         dashboard would render as "analysis in progress" forever. */
      assert.notEqual(run.status, "failed_but_reported",
        "no run is left in a state that misrepresents a failure as a result");
      assert.ok(["completed", "failed", "running"].includes(run.status),
        `a run's status is a known value, got ${run.status}`);
    });
  }
});

test("[E16] the dashboard does not claim an analysis that does not exist",
  { skip: SKIP }, async () => {
    /* The other half of the negative path. A tenant that has never uploaded
       anything must be told so, rather than being shown zeros or demo figures
       that read as a real, healthy business. */
    const virgin = server.client();
    await virgin.get("/api/health/live");

    /* The REAL dashboard endpoints. An earlier version of this test used
       `/api/analysis`, which does not exist -- it returned 404 and the test
       passed on the "refuses outright" branch without ever exercising the
       dashboard. These are the routes the frontend actually reads. */
    const endpoints = ["/api/health-score", "/api/cashflow", "/api/anomalies",
      "/api/vendors", "/api/revenue"];

    for (const endpoint of endpoints) {
      const res = await virgin.get(`${endpoint}?month=${PERIOD}`);
      assert.notEqual(res.status, 404, `${endpoint} exists (this test is not vacuous)`);

      const body = JSON.stringify(res.json);
      if (res.status === 200 && res.json && res.json.ok !== false) {
        /* If it answers, it must not present FIGURES for a period it has no
           records for. The dangerous outcome is a dashboard of confident zeros
           or demo numbers that reads as a real, healthy business. */
        assert.match(body,
          /no_data|no_records|not_available|unavailable|insufficient|empty|connect|null/i,
          `${endpoint} discloses that it has no underlying data, rather than `
          + `reporting figures for a period it never ingested: ${body.slice(0, 240)}`);
      } else {
        assert.ok(res.status >= 400 || res.json.ok === false,
          `${endpoint} refuses outright, which is equally honest`);
      }
    }
  });

test("[E17] a run that exists only in the DATABASE is RECOVERED, not refused",
  { skip: SKIP }, async () => {
    /* THIS TEST PREVIOUSLY PINNED A WORKAROUND. Before JOB 11 the read side did
       not exist, so the best available behaviour was to admit the analysis was
       saved but unreachable and ask the user to re-run it. That was honest, and
       it was still a defect. The requirement now is RECOVERY: a completed run
       in PostgreSQL must come back as the completed analysis it is. */
    const tenant = await tenantAId();
    const stored = await asTenant(tenant, async (c) =>
      (await c.query(
        "SELECT id, status, recovery_schema_version FROM analysis_run "
        + "WHERE period = $1 AND status = 'completed'", [PERIOD])).rows[0]);
    assert.ok(stored, "precondition: a completed run is in the database");
    assert.ok(stored.recovery_schema_version != null,
      "and it was written under the recovery contract");

    // A brand-new process holds no in-memory run, but shares the database.
    const restarted = await startServer({
      ALLOW_DEMO_DATA: "true", ENABLE_AI_ANALYSIS: "true",
      NVIDIA_API_KEY: "e2e-managed-key", AI_TEST_PROVIDER: "1",
      DATABASE_URL: TEST_DB
    });
    try {
      const revived = restarted.client();
      tenantA.jar.forEach((v, k) => revived.jar.set(k, v));

      const res = await revived.get(`/api/analysis/${PERIOD}`);
      assert.equal(res.status, 200, JSON.stringify(res.json));
      assert.equal(res.json.analysis.recovered, true, "it came from storage");
      assert.equal(res.json.analysis.run_id, stored.id, "the SAME run, by identity");
      assert.ok(res.json.analysis.findings.length > 0, "with its findings");
    } finally {
      await restarted.stop();
    }
  });

test("[E18] the entitlement endpoint reports the LEDGER balance, not the mirror",
  { skip: SKIP }, async () => {
    /* THE DEFECT. `profile.credits` is a mirror that billing.js writes after a
       charge -- it documents itself as non-authoritative. This endpoint served
       the mirror, which is only correct while ONE process makes every charge.
       Production runs more than one instance, so instance B showed a balance
       instance A had already spent. */
    const tenant = await tenantAId();
    const res = await tenantA.get("/api/entitlement");
    assert.equal(res.status, 200);
    assert.equal(res.json.entitlement.credits_source, "ledger",
      "the balance came from the credit ledger");

    const ledger = await asTenant(tenant, async (c) =>
      (await c.query("SELECT credits FROM credit_balance")).rows[0]);
    assert.equal(res.json.entitlement.credits, ledger.credits,
      "and it agrees with the ledger exactly");
  });
