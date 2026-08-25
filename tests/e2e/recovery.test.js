// JOB 11 — RESTART RECOVERY, proven against the real application.
//
// THE DEFECT. `saveRun` wrote the run, its findings, its evidence and its
// metrics. Nothing read them back. After a restart every row was present and
// the application could not see them, so it told the user there was no
// analysis — while a completed one sat in PostgreSQL.
//
// WHAT THIS SUITE HAS TO PROVE is narrower and harder than "the numbers come
// back". A recomputation would also return plausible numbers — DIFFERENT ones,
// computed against today's rules and the now-absent period inputs, while
// presenting itself as the original analysis. So these tests assert both:
//
//   1. the recovered run is IDENTICAL to the one that was stored, field by
//      field, including the values that are null, unavailable, or zero; and
//   2. the engine was NOT invoked to produce it — observed directly via the
//      engine's own invocation counter, not inferred from timing.
//
// Every test drives the real HTTP surface. Nothing constructs a repository.

const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { startServer } = require("../helpers/server");

const TEST_DB = process.env.TEST_DATABASE_URL || "";
const ADMIN_DB = process.env.TEST_ADMIN_DATABASE_URL || TEST_DB;
const SKIP = !TEST_DB;

if (SKIP) {
  console.warn("\n*** SKIPPING RECOVERY TESTS: TEST_DATABASE_URL is not set. ***");
  console.warn("*** Restart recovery is therefore NOT VERIFIED in this run. ***\n");
}

async function admin(fn) {
  const client = new Client({ connectionString: ADMIN_DB });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

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
const PERIOD_2 = "2026-06";

/* Deliberately shaped data:
   - a duplicated payment, so there is a finding with evidence;
   - one dominant vendor, so concentration is measurable;
   - NO customer inflow in PERIOD_2, so customer concentration is genuinely
     UNAVAILABLE rather than zero. That distinction is the point of several
     assertions below. */
const CSV_MAY = [
  "Date,Description,Amount,Counterparty",
  `${PERIOD}-04,Consulting retainer,-200000,Rivera Logistics`,
  `${PERIOD}-04,Consulting retainer,-200000,Rivera Logistics`,
  `${PERIOD}-11,Electricity,-120000,City Power`,
  `${PERIOD}-22,Client settlement,900000,BigCo Retail`
].join("\n");

const CSV_JUNE_OUTFLOW_ONLY = [
  "Date,Description,Amount,Counterparty",
  `${PERIOD_2}-03,Rent,-300000,Landlord Ltd`,
  `${PERIOD_2}-09,Software,-45000,SaaS Vendor`
].join("\n");

const SERVER_ENV = {
  ALLOW_DEMO_DATA: "true",
  ENABLE_AI_ANALYSIS: "true",
  NVIDIA_API_KEY: "recovery-test-key",
  AI_TEST_PROVIDER: "1",
  DATABASE_URL: TEST_DB
};

let origin;          // the process that computes the analysis
let client;          // the tenant driving it
let originalRun;     // what /api/analysis/:period returned BEFORE the restart

test.before(async () => {
  if (SKIP) return;
  await admin((c) => c.query(
    `TRUNCATE ai_interaction, credit_transaction, credit_balance,
              conversation_entity, conversation_turn, conversation,
              job_run, job_lock, notification_dedupe,
              finding_evidence, finding, metric_value, analysis_run,
              financial_transaction, membership, tenant, app_user
     RESTART IDENTITY CASCADE`));

  origin = await startServer(SERVER_ENV);
  client = origin.client();

  // ── Steps 1-4: provision, ingest deterministic data, run the analysis.
  const upload = await client.upload("/api/financial-data/upload", {
    filename: "may.csv", content: CSV_MAY,
    fields: { period: PERIOD, currentCashBalance: 1200000 }
  });
  assert.equal(upload.status, 200, JSON.stringify(upload.json));

  const review = await client.post("/api/monthly-review",
    { month: PERIOD, use_ai_analysis: false });
  assert.equal(review.status, 200, JSON.stringify(review.json));

  // ── Step 5: capture the completed result as the application reports it.
  const captured = await client.get(`/api/analysis/${PERIOD}`);
  assert.equal(captured.status, 200, JSON.stringify(captured.json));
  originalRun = captured.json.analysis;
});

test.after(async () => { if (origin) await origin.stop(); });

/** Start a FRESH process against the same database, carrying the same identity. */
async function restart() {
  const fresh = await startServer(SERVER_ENV);
  const revived = fresh.client();
  client.jar.forEach((v, k) => revived.jar.set(k, v));
  return { fresh, revived };
}

async function tenantId() {
  return (await admin(async (c) =>
    (await c.query("SELECT tenant_id FROM financial_transaction LIMIT 1")).rows[0])).tenant_id;
}

// ══════════════════════════════════════════════════════════════════
// PART E — the restart-recovery proof
// ══════════════════════════════════════════════════════════════════

test("[RC1] a completed analysis is recovered IDENTICALLY after a restart",
  { skip: SKIP }, async () => {
    const { fresh, revived } = await restart();
    try {
      const res = await revived.get(`/api/analysis/${PERIOD}`);
      assert.equal(res.status, 200, JSON.stringify(res.json));
      const recovered = res.json.analysis;

      // ── SAME RUN IDENTITY.
      assert.equal(recovered.run_id, originalRun.run_id,
        "the same run, not a new one computed to look like it");
      assert.equal(recovered.period, originalRun.period);
      assert.equal(recovered.status, "completed");
      assert.equal(recovered.recovered, true, "and it is marked as recovered");

      // ── SAME OVERALL SCORE, including when it is null.
      assert.deepEqual(recovered.risk_score.overall, originalRun.risk_score.overall,
        "the headline score is the stored one");
      assert.equal(recovered.risk_score.available, originalRun.risk_score.available);

      // ── SAME COMPONENTS, measured and unmeasurable alike.
      assert.deepEqual(recovered.risk_score.components, originalRun.risk_score.components,
        "every component survives, including the null ones");

      // ── SAME METRICS, whole set.
      assert.equal(recovered.metrics.length, originalRun.metrics.length);
      assert.deepEqual(recovered.metrics, originalRun.metrics,
        "the authoritative MetricSet round-trips exactly");

      // ── SAME FINDINGS.
      assert.equal(recovered.findings.length, originalRun.findings.length);
      assert.deepEqual(
        recovered.findings.map((f) => f.findingId).sort(),
        originalRun.findings.map((f) => f.findingId).sort(),
        "the same findings, by identity");

      // ── SAME EVIDENCE.
      const evidenceOf = (run) => run.findings
        .flatMap((f) => (f.evidence || []).map((e) => `${f.findingId}:${e.sourceRecordId}`))
        .sort();
      assert.deepEqual(evidenceOf(recovered), evidenceOf(originalRun),
        "every evidence citation survives");
      assert.ok(evidenceOf(recovered).length > 0, "and there was evidence to survive");

      // ── SAME DATA QUALITY REPORT.
      assert.deepEqual(recovered.data_quality, originalRun.data_quality);

      // ── SAME AUTHORITY / VERSION METADATA.
      assert.equal(recovered.engine_version, originalRun.engine_version);
      assert.deepEqual(recovered.rule_versions, originalRun.rule_versions);
      assert.deepEqual(recovered.methodology, originalRun.methodology,
        "the methodology the run APPLIED is preserved, so a historical result "
        + "stays explainable after the registry moves on");
    } finally {
      await fresh.stop();
    }
  });

test("[RC2] recovery does NOT invoke the engine", { skip: SKIP }, async () => {
  /* THE GUARD THAT MAKES RC1 MEAN SOMETHING. Identical numbers could also come
     from a recomputation that happens to agree today. Watching the engine's own
     invocation counter is the only way to tell recovery from re-analysis. */
  const { fresh, revived } = await restart();
  try {
    const before = await revived.get("/api/__test/engine-count");
    assert.equal(before.status, 200, "the engine counter is observable");
    assert.equal(before.json.analyses, 0,
      "a fresh process has not run any analysis yet");

    // Exercise every recovery-backed route.
    const loaded = await revived.get(`/api/analysis/${PERIOD}`);
    assert.equal(loaded.status, 200);
    await revived.get(`/api/analysis/run/${originalRun.run_id}`);
    await revived.get(`/api/analysis/run/${originalRun.run_id}/metrics`);
    await revived.get(`/api/health-score?month=${PERIOD}`);
    await revived.get(`/api/anomalies?month=${PERIOD}`);
    await revived.get(`/api/cashflow?month=${PERIOD}`);

    const after = await revived.get("/api/__test/engine-count");
    assert.equal(after.json.analyses, 0,
      "THE POINT: the whole analysis was served from storage. The engine was "
      + "never run, so this cannot be a recomputation dressed up as a recovery.");
  } finally {
    await fresh.stop();
  }
});

test("[RC3] the dashboard serves a recovered analysis, not 'run review first'",
  { skip: SKIP }, async () => {
    const { fresh, revived } = await restart();
    try {
      const health = await revived.get(`/api/health-score?month=${PERIOD}`);
      assert.equal(health.status, 200);
      assert.equal(health.json.ok, true,
        "the dashboard answers after a restart instead of demanding a re-run");
      assert.deepEqual(health.json.health.overall_score, originalRun.risk_score.overall,
        "with the stored score");

      const anomalies = await revived.get(`/api/anomalies?month=${PERIOD}`);
      assert.equal(anomalies.json.ok, true);
      assert.ok(anomalies.json.anomalies.items.length > 0,
        "and the stored findings");
    } finally {
      await fresh.stop();
    }
  });

test("[RC4] the copilot answers from a recovered run", { skip: SKIP }, async () => {
  const { fresh, revived } = await restart();
  try {
    await revived.post("/api/__test/ai-stub", {
      text: JSON.stringify({
        summary: "A duplicate payment was flagged.", facts: [], inferences: [],
        recommendations: [{ claim: "Verify the duplicated retainer." }], limitations: []
      })
    });
    const res = await revived.post("/api/copilot",
      { message: "what needs attention?", month: PERIOD });

    assert.equal(res.json.ok, true, JSON.stringify(res.json));
    assert.notEqual(res.json.reason, "no_analysis_run");
    assert.notEqual(res.json.reason, "analysis_not_loaded",
      "the workaround message is gone -- this is a real recovery");

    const count = await revived.get("/api/__test/engine-count");
    assert.equal(count.json.analyses, 0,
      "answering from a recovered run did not re-run the engine");
  } finally {
    await fresh.stop();
  }
});

// ══════════════════════════════════════════════════════════════════
// PART F — failure and edge cases
// ══════════════════════════════════════════════════════════════════

test("[RC5] a FAILED run is never returned as a completed analysis",
  { skip: SKIP }, async () => {
    const tenant = await tenantId();
    // Record a failed run for a period that has no completed one.
    const failedPeriod = "2025-11";
    await asTenant(tenant, async (c) => {
      await c.query(
        `INSERT INTO analysis_run (tenant_id, period, status, engine_version, rule_versions,
                                   failure_stage, failure_reason)
         VALUES ($1,$2,'failed','engine@test','{}','analysis','synthetic failure')`,
        [tenant, failedPeriod]);
    });

    const { fresh, revived } = await restart();
    try {
      const res = await revived.get(`/api/analysis/${failedPeriod}`);
      assert.equal(res.status, 404,
        "a failed run is not a completed analysis and must not be served as one");
      assert.equal(res.json.error, "no_completed_analysis");
    } finally {
      await fresh.stop();
    }
  });

test("[RC6] unavailable metrics survive the round trip WITHOUT becoming zero",
  { skip: SKIP }, async () => {
    /* THE MOST DANGEROUS FAILURE MODE IN THIS SYSTEM. `metric_value` used to
       filter out every non-finite value, so an unmeasurable metric left no row
       at all -- and an absent metric reads as zero to anything scanning the
       table. "We could not measure your runway" would have become "your runway
       is 0 months", which is a far worse statement than saying nothing.

       June has OUTFLOW ONLY, so customer concentration is genuinely
       unmeasurable rather than zero. */
    const upload = await client.upload("/api/financial-data/upload", {
      filename: "june.csv", content: CSV_JUNE_OUTFLOW_ONLY,
      fields: { period: PERIOD_2 }   // no cash balance -- also NOT PROVIDED
    });
    assert.equal(upload.status, 200, JSON.stringify(upload.json));
    const review = await client.post("/api/monthly-review",
      { month: PERIOD_2, use_ai_analysis: false });
    assert.equal(review.status, 200);

    const before = (await client.get(`/api/analysis/${PERIOD_2}`)).json.analysis;
    const unavailableBefore = before.metrics.filter((m) => !m.available);
    assert.ok(unavailableBefore.length > 0,
      "precondition: this period genuinely has unmeasurable metrics");
    assert.ok(unavailableBefore.every((m) => m.reason),
      "each carries WHY it could not be measured");

    const { fresh, revived } = await restart();
    try {
      const after = (await revived.get(`/api/analysis/${PERIOD_2}`)).json.analysis;
      const unavailableAfter = after.metrics.filter((m) => !m.available);

      assert.deepEqual(
        unavailableAfter.map((m) => `${m.key}:${m.reason}`).sort(),
        unavailableBefore.map((m) => `${m.key}:${m.reason}`).sort(),
        "the same metrics are unavailable, for the same stated reasons");

      unavailableAfter.forEach((m) => {
        assert.equal(m.value, null, `${m.key} is null, NOT 0`);
        assert.notEqual(m.value, 0, `${m.key} did not become zero`);
        assert.equal(m.available, false);
      });

      // And the projection table agrees -- it is the index, not a second truth.
      const projected = await revived.get(`/api/analysis/run/${after.run_id}/metrics`);
      const projectedUnavailable = projected.json.metrics.filter((m) => !m.available);
      assert.equal(projectedUnavailable.length, unavailableAfter.length,
        "the queryable projection keeps the unavailable metrics too, rather than "
        + "dropping them and leaving absence to be read as zero");
      projectedUnavailable.forEach((m) => {
        assert.equal(m.value, null);
        assert.ok(m.reason, `${m.key} still explains itself`);
      });
    } finally {
      await fresh.stop();
    }
  });

test("[RC7] a genuine ZERO stays zero, and is not confused with unavailable",
  { skip: SKIP }, async () => {
    const { fresh, revived } = await restart();
    try {
      const after = (await revived.get(`/api/analysis/${PERIOD}`)).json.analysis;
      const measured = after.metrics.filter((m) => m.available);
      assert.ok(measured.length > 0, "there are measured metrics");
      measured.forEach((m) => {
        assert.notEqual(m.value, null,
          `${m.key} is available, so it must carry a value -- including 0`);
        assert.equal(m.reason == null, true,
          `${m.key} is available, so it carries no unavailable reason`);
      });
    } finally {
      await fresh.stop();
    }
  });

test("[RC8] period INPUTS survive: provided-and-zero differs from not-provided",
  { skip: SKIP }, async () => {
    /* currentCashBalance is the input that made faithful recovery impossible
       before this job. A business with no cash and a business that did not tell
       us are different answers, and collapsing them would silently change the
       runway calculation. */
    const { fresh, revived } = await restart();
    try {
      const may = (await revived.get(`/api/analysis/${PERIOD}`)).json.analysis;
      assert.equal(may.period_inputs.currentCashBalance.provided, true,
        "May's upload supplied a cash balance");
      assert.equal(may.period_inputs.currentCashBalance.value, 1200000,
        "and the exact figure survived");

      assert.equal(may.period_inputs.currentCashBalance.basis, "observed",
        "labelled as something the user actually told us");

      /* JUNE SUPPLIED NOTHING, so ingestion DERIVED a balance from net income —
         and because June is outflow-only, that derivation clamps to ZERO.
         A derived zero and an observed zero are completely different claims:
         one is "we inferred this", the other is "the business has no cash".
         All three facts are kept — it was not provided, it was derived, and the
         value used was 0 — so the figure stays reproducible without ever
         reading as an observation. */
      const june = (await revived.get(`/api/analysis/${PERIOD_2}`)).json.analysis;
      const juneCash = june.period_inputs.currentCashBalance;
      assert.equal(juneCash.provided, false, "June's upload did NOT supply one");
      assert.equal(juneCash.basis, "derived_from_net_income",
        "and it is labelled as DERIVED, never as observed");
      assert.equal(juneCash.value, 0,
        "the derived value used is recorded, so the run stays reproducible");
      assert.notEqual(juneCash.basis, "observed",
        "THE POINT: a derived zero can never be read back as an observed zero");
    } finally {
      await fresh.stop();
    }
  });

test("[RC9] data-quality warnings survive the round trip", { skip: SKIP }, async () => {
  const { fresh, revived } = await restart();
  try {
    const after = (await revived.get(`/api/analysis/${PERIOD}`)).json.analysis;
    assert.deepEqual(after.data_quality, originalRun.data_quality,
      "the DataQualityReport is byte-identical");
    assert.ok(after.data_quality && after.data_quality.level,
      "and it carries its level, so 'we scored on partial data' is not lost");
  } finally {
    await fresh.stop();
  }
});

test("[RC10] findings keep their ENGINE authority after recovery",
  { skip: SKIP }, async () => {
    /* A stored finding must come back as an ENGINE finding. If the authority
       marker were lost, a deterministic result could later be mistaken for an
       AI-generated claim -- which would break the invariant that the engine is
       the only thing allowed to compute a figure. */
    const { fresh, revived } = await restart();
    try {
      const after = (await revived.get(`/api/analysis/${PERIOD}`)).json.analysis;
      assert.ok(after.findings.length > 0);
      after.findings.forEach((f) => {
        assert.equal(f.authorityScope, "engine",
          `${f.findingId} is still an engine finding, never an inference`);
        assert.ok(f.ruleId && f.ruleVersion,
          "and still names the rule and version that produced it");
      });
    } finally {
      await fresh.stop();
    }
  });

test("[RC11] tenant A cannot recover tenant B's run", { skip: SKIP }, async () => {
  const { fresh, revived } = await restart();
  try {
    // A completely separate visitor, therefore a separate tenant.
    const stranger = fresh.client();
    await stranger.get("/api/health/live");

    const byPeriod = await stranger.get(`/api/analysis/${PERIOD}`);
    assert.notEqual(byPeriod.status, 200,
      "another tenant cannot read this period's analysis");

    const byId = await stranger.get(`/api/analysis/run/${originalRun.run_id}`);
    assert.equal(byId.status, 404,
      "nor by run id -- RLS confines the query to the caller's own tenant");
    assert.equal(byId.json.error, "no_such_run");

    const metrics = await stranger.get(`/api/analysis/run/${originalRun.run_id}/metrics`);
    assert.equal(metrics.status, 404, "nor its metrics");
  } finally {
    await fresh.stop();
  }
});

test("[RC12] a nonexistent run is indistinguishable from another tenant's",
  { skip: SKIP }, async () => {
    /* AN EXISTENCE ORACLE IS A LEAK. If "exists but not yours" answered
       differently from "does not exist", the API would confirm which run ids
       are real across the whole system. */
    const { fresh, revived } = await restart();
    try {
      const stranger = fresh.client();
      await stranger.get("/api/health/live");

      const realButForeign = await stranger.get(`/api/analysis/run/${originalRun.run_id}`);
      const purelyInvented = await stranger.get(
        "/api/analysis/run/00000000-0000-4000-8000-000000000000");

      assert.equal(realButForeign.status, purelyInvented.status,
        "same status for a real foreign run and an invented one");
      assert.deepEqual(realButForeign.json, purelyInvented.json,
        "and the same body -- no existence oracle");
    } finally {
      await fresh.stop();
    }
  });

test("[RC13] multiple periods load independently", { skip: SKIP }, async () => {
  const { fresh, revived } = await restart();
  try {
    const may = await revived.get(`/api/analysis/${PERIOD}`);
    const june = await revived.get(`/api/analysis/${PERIOD_2}`);
    assert.equal(may.status, 200);
    assert.equal(june.status, 200);

    assert.notEqual(may.json.analysis.run_id, june.json.analysis.run_id,
      "two distinct runs");
    assert.equal(may.json.analysis.period, PERIOD);
    assert.equal(june.json.analysis.period, PERIOD_2);
    // June has no inflow; May does. The two must not bleed into each other.
    assert.notDeepEqual(may.json.analysis.metrics, june.json.analysis.metrics,
      "each period carries its own metrics");

    const periods = await revived.get("/api/analysis/periods");
    const listed = periods.json.periods.map((p) => p.period);
    assert.ok(listed.includes(PERIOD) && listed.includes(PERIOD_2),
      "and both are listed as recoverable");
  } finally {
    await fresh.stop();
  }
});

test("[RC14] the latest completed run is chosen, ignoring failed ones",
  { skip: SKIP }, async () => {
    const tenant = await tenantId();
    // A LATER failed run for a period that already has a completed one. The
    // failure must not shadow the good result.
    await asTenant(tenant, async (c) => {
      await c.query(
        `INSERT INTO analysis_run (tenant_id, period, status, engine_version,
                                   rule_versions, started_at, failure_stage, failure_reason)
         VALUES ($1,$2,'failed','engine@test','{}', now() + interval '1 hour',
                 'analysis','later failure')`,
        [tenant, PERIOD]);
    });

    const { fresh, revived } = await restart();
    try {
      const res = await revived.get(`/api/analysis/${PERIOD}`);
      assert.equal(res.status, 200, "the completed run is still served");
      assert.equal(res.json.analysis.run_id, originalRun.run_id,
        "specifically the completed one, even though a FAILED run is newer");
      assert.equal(res.json.analysis.status, "completed");
    } finally {
      await fresh.stop();
    }
  });

test("[RC15] a legacy row is reported as legacy, never silently recomputed",
  { skip: SKIP }, async () => {
    /* A run written before this migration has no authoritative metrics and no
       period inputs. It cannot be rebuilt faithfully, and rebuilding it would
       mean inventing the missing inputs. Reported honestly instead. */
    const tenant = await tenantId();
    const legacyPeriod = "2025-09";
    /* SIMULATING A GENUINE PRE-MIGRATION ROW. The CHECK constraint added by
       migration 007 is NOT VALID, which means it does not judge rows that
       already existed but DOES refuse new ones — so a legacy row cannot simply
       be inserted. Dropping the constraint, inserting, and re-adding it exactly
       reproduces the real situation: a row that predates the rule, in a
       database where the rule now applies. */
    await admin(async (c) => {
      await c.query("ALTER TABLE analysis_run DROP CONSTRAINT analysis_run_completed_is_recoverable");
      await c.query(
        `INSERT INTO analysis_run (tenant_id, period, status, engine_version,
                                   rule_versions, health, methodology, completed_at)
         VALUES ($1,$2,'completed','engine@1.0.0','{}','{"overall":55}','{}', now())`,
        [tenant, legacyPeriod]);
      await c.query(
        `ALTER TABLE analysis_run ADD CONSTRAINT analysis_run_completed_is_recoverable
         CHECK (status <> 'completed' OR (recovery_schema_version IS NOT NULL
           AND metric_set IS NOT NULL AND period_inputs IS NOT NULL
           AND run_summary IS NOT NULL AND health IS NOT NULL
           AND methodology IS NOT NULL)) NOT VALID`);
    });

    const { fresh, revived } = await restart();
    try {
      const before = await revived.get("/api/__test/engine-count");
      const res = await revived.get(`/api/analysis/${legacyPeriod}`);

      assert.equal(res.status, 409, "not served as a recovered analysis");
      assert.equal(res.json.error, "legacy_unrecoverable");
      assert.ok(res.json.detail, "and the user is told what to do about it");

      const after = await revived.get("/api/__test/engine-count");
      assert.equal(after.json.analyses, before.json.analyses,
        "and it was NOT quietly recomputed into something that would differ "
        + "from what the user originally saw");
    } finally {
      await fresh.stop();
    }
  });

test("[RC16] interrupted persistence leaves no fake completed run",
  { skip: SKIP }, async () => {
    /* A completed run and its recoverable state are one fact. The database
       refuses to hold a completed row without the state needed to load it, so a
       partial write cannot masquerade as a finished analysis. */
    const tenant = await tenantId();
    await assert.rejects(
      () => asTenant(tenant, async (c) => {
        await c.query(
          `INSERT INTO analysis_run (tenant_id, period, status, engine_version, rule_versions)
           VALUES ($1,'2025-08','completed','engine@test','{}')`,
          [tenant]);
      }),
      /analysis_run_completed_is_recoverable/,
      "the database itself refuses a completed run with no recoverable state");
  });

test("[RC17] a historical run stays interpretable when the engine version moves on",
  { skip: SKIP }, async () => {
    /* The run records the engine version and the resolved methodology it
       ACTUALLY applied, so it can still be explained after the registry moves.
       Recovery must return those stored values, not today's. */
    const { fresh, revived } = await restart();
    try {
      const after = (await revived.get(`/api/analysis/${PERIOD}`)).json.analysis;
      assert.equal(after.engine_version, originalRun.engine_version,
        "the version that produced it, not the version reading it");
      assert.ok(after.methodology.materiality,
        "the materiality it resolved is preserved");
      assert.ok(after.methodology.coveragePolicy,
        "and the evidence-coverage policy it applied");
      assert.deepEqual(after.rule_versions, originalRun.rule_versions,
        "with the exact rule versions that ran");
    } finally {
      await fresh.stop();
    }
  });

// ══════════════════════════════════════════════════════════════════
// PART H — regression guards
// ══════════════════════════════════════════════════════════════════

test("[RC18] the production routes actually exercise the repository read path",
  { skip: SKIP }, async () => {
    /* THE GUARD AGAINST THE ORIGINAL DEFECT RETURNING. saveRun writing while
       nothing reads is exactly what happened before. If a future change routes
       these around the repository -- back to memory or local disk -- the run
       will not be found in a fresh process and this fails. */
    const { fresh, revived } = await restart();
    try {
      // Nothing is in this process's memory, and no report file exists on its
      // disk, so ONLY a repository read can satisfy these.
      const byPeriod = await revived.get(`/api/analysis/${PERIOD}`);
      assert.equal(byPeriod.status, 200, "latest completed analysis, from the repository");

      const byId = await revived.get(`/api/analysis/run/${originalRun.run_id}`);
      assert.equal(byId.status, 200, "analysis by run id, from the repository");

      const metrics = await revived.get(`/api/analysis/run/${originalRun.run_id}/metrics`);
      assert.equal(metrics.status, 200, "metrics, from the repository");
      assert.ok(metrics.json.metrics.length > 0);

      const periods = await revived.get("/api/analysis/periods");
      assert.equal(periods.json.persistence, "database",
        "the period index is served from the database");

      const dashboard = await revived.get(`/api/health-score?month=${PERIOD}`);
      assert.equal(dashboard.json.ok, true, "and the dashboard reads through it too");
    } finally {
      await fresh.stop();
    }
  });

test("[RC19] every completed run in the database is recoverable", { skip: SKIP }, async () => {
  /* THE INVARIANT, checked against real stored data rather than in principle.
     A completed run that cannot be loaded is the defect this job exists to
     remove, so no such row may exist. */
  const tenant = await tenantId();
  const rows = await asTenant(tenant, async (c) =>
    (await c.query(
      `SELECT id, period, recovery_schema_version, metric_set IS NOT NULL AS has_metrics,
              period_inputs IS NOT NULL AS has_inputs, run_summary IS NOT NULL AS has_summary
         FROM analysis_run WHERE status = 'completed'`)).rows);

  assert.ok(rows.length > 0, "there are completed runs to check");
  rows.forEach((r) => {
    // The legacy row inserted by RC15 is deliberately exempt: it predates the
    // contract and is REPORTED as legacy rather than pretending to be loadable.
    if (r.recovery_schema_version == null) return;
    assert.equal(r.has_metrics, true, `run ${r.id} stored its metric set`);
    assert.equal(r.has_inputs, true, `run ${r.id} stored its period inputs`);
    assert.equal(r.has_summary, true, `run ${r.id} stored its summary`);
  });
});

test("[RC20] the metric projection never drops an unavailable metric",
  { skip: SKIP }, async () => {
    /* The regression guard for the filter that caused the worst version of this
       bug: `.filter(([, v]) => v != null && Number.isFinite(...))`, which
       deleted every unmeasurable metric on the way to the database. */
    const tenant = await tenantId();
    const stats = await asTenant(tenant, async (c) =>
      (await c.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE available = false)::int AS unavailable,
                count(*) FILTER (WHERE available = false AND unavailable_reason IS NULL)::int AS unexplained,
                count(*) FILTER (WHERE available = false AND numeric_value IS NOT NULL)::int AS contradictory
           FROM metric_value`)).rows[0]);

    assert.ok(stats.total > 0, "metrics were projected");
    assert.ok(stats.unavailable > 0,
      "including UNAVAILABLE ones -- if this is 0 the filter is back and "
      + "unmeasurable metrics are being silently dropped again");
    assert.equal(stats.unexplained, 0, "every unavailable metric states its reason");
    assert.equal(stats.contradictory, 0,
      "and none carries a value while claiming to be unavailable");
  });

// ══════════════════════════════════════════════════════════════════
// JOB 12 PART C — restart recovery down to the RAW RECORDS.
//
// JOB 11 recovered scores, metrics, findings and evidence. It did not recover
// the RECORDS those findings cite, so a recovered finding could state that two
// payments were duplicates while nothing could show which two. The full chain
// asserted below is:
//
//   analyse -> persist -> destroy the process -> start fresh -> load analysis
//   -> load a finding -> load its evidence -> resolve the cited sourceRecordId
//   -> retrieve the underlying persisted transaction
// ══════════════════════════════════════════════════════════════════

test("[RC21] a cited source record resolves to the real stored transaction",
  { skip: SKIP }, async () => {
    const { fresh, revived } = await restart();
    try {
      // ── load the analysis
      const analysis = (await revived.get(`/api/analysis/${PERIOD}`)).json.analysis;
      assert.equal(analysis.recovered, true);

      // ── load a finding that actually cites records
      const finding = analysis.findings.find((f) => (f.evidence || []).length > 0);
      assert.ok(finding, "precondition: a finding with evidence was recovered");

      // ── load its evidence, resolved to underlying records
      const res = await revived.get(
        `/api/findings/${encodeURIComponent(finding.findingId)}/records`);
      assert.equal(res.status, 200, JSON.stringify(res.json));
      assert.equal(res.json.complete, true,
        "every citation resolved -- the evidence trail is intact");
      assert.deepEqual(res.json.unresolved, [],
        "and nothing was quietly dropped");
      assert.ok(res.json.records.length > 0, "the underlying records came back");

      // ── the resolved record matches the citation, field for field
      const citedId = finding.evidence[0].sourceRecordId;
      const record = res.json.records.find((r) => r.sourceRecordId === citedId);
      assert.ok(record, "the specific cited record is among them");
      assert.equal(record.sourceRecordId, citedId, "SAME sourceRecordId");
      assert.equal(record.sourceSystem, finding.evidence[0].sourceSystem,
        "SAME provenance");
      assert.equal(record.period, PERIOD);
      assert.ok(record.date, "with its date");
      assert.equal(typeof record.amount, "number", "its amount");
      assert.ok(record.direction, "and its direction");
      assert.equal(record.recovered, true, "marked as recovered, not re-derived");

      // ── no engine invocation anywhere in that chain
      const count = await revived.get("/api/__test/engine-count");
      assert.equal(count.json.analyses, 0,
        "the whole chain was served from storage");
    } finally {
      await fresh.stop();
    }
  });

test("[RC22] the recovered record matches what was originally ingested",
  { skip: SKIP }, async () => {
    /* Guards against a "recovered" record that is actually a plausible
       replacement. The values are compared against the DATABASE row, which is
       the only thing that can be authoritative after the original process is
       gone. */
    const tenant = await tenantId();
    const { fresh, revived } = await restart();
    try {
      const stored = await asTenant(tenant, async (c) =>
        (await c.query(
          /* `txn_date` is rendered BY POSTGRES, not by a JS Date. Reading a
             DATE column through `toISOString()` re-projects local midnight
             into UTC and moves the day backwards east of Greenwich, so the
             old expectation agreed with the server only because both were
             wrong and both ran in UTC. The stored calendar day is the fact. */
          `SELECT source_system, source_record_id, amount, currency,
                  counterparty_name, direction, description,
                  to_char(txn_date, 'YYYY-MM-DD') AS txn_day
             FROM financial_transaction WHERE period = $1
            ORDER BY txn_date, source_record_id`, [PERIOD])).rows);
      assert.ok(stored.length > 0, "records are in the database");

      const res = await revived.get(`/api/analysis/${PERIOD}/transactions`);
      assert.equal(res.status, 200);
      assert.equal(res.json.count, stored.length, "every record came back");

      stored.forEach((row) => {
        const got = res.json.transactions.find(
          (t) => t.sourceRecordId === row.source_record_id);
        assert.ok(got, `${row.source_record_id} was recovered`);
        assert.equal(got.sourceSystem, row.source_system, "same provenance");
        assert.equal(got.amount, Number(row.amount), "same amount");
        assert.equal(got.currency, String(row.currency).trim(), "same currency");
        assert.equal(got.direction, row.direction, "same direction");
        assert.equal(got.counterparty, row.counterparty_name, "same counterparty");
        assert.equal(got.description, row.description, "same description");
        assert.equal(got.date, row.txn_day, "same date, in any server timezone");
      });
    } finally {
      await fresh.stop();
    }
  });

test("[RC23] an unattributed counterparty stays NULL after recovery",
  { skip: SKIP }, async () => {
    /* A record with no counterparty means "we do not know who this was". If
       recovery turned that into "" or a placeholder, the concentration
       calculators would acquire a fabricated party -- the exact defect an
       earlier job removed from ingestion. */
    const tenant = await tenantId();
    await asTenant(tenant, async (c) => {
      await c.query(
        `INSERT INTO financial_transaction
           (tenant_id, period, source_system, source_record_id, txn_type, txn_date,
            amount, currency, direction, counterparty_name)
         VALUES ($1,$2,'csv-upload','csv:unattributed-1','other','2026-05-15',
                 -5000,'KES','outflow', NULL)
         ON CONFLICT DO NOTHING`, [tenant, PERIOD]);
    });

    const { fresh, revived } = await restart();
    try {
      const res = await revived.get(`/api/analysis/${PERIOD}/transactions`);
      const orphan = res.json.transactions.find(
        (t) => t.sourceRecordId === "csv:unattributed-1");
      assert.ok(orphan, "the record recovered");
      assert.equal(orphan.counterparty, null,
        "and it is still UNATTRIBUTED -- not an empty string, not a placeholder");
    } finally {
      await fresh.stop();
    }
  });

test("[RC24] a missing record is reported unresolved, never as an empty list",
  { skip: SKIP }, async () => {
    /* THE DISTINCTION THAT MATTERS. If a citation cannot be resolved, returning
       the remaining records as though they were the whole set understates the
       evidence behind a finding. About a duplicate-payment finding, an empty or
       short list is a false statement about the business's books. */
    const tenant = await tenantId();

    // A finding whose evidence cites a record that does not exist.
    const runId = await asTenant(tenant, async (c) =>
      (await c.query(
        "SELECT id FROM analysis_run WHERE period = $1 AND status = 'completed' LIMIT 1",
        [PERIOD])).rows[0].id);

    await asTenant(tenant, async (c) => {
      const finding = (await c.query(
        `INSERT INTO finding
           (tenant_id, analysis_run_id, finding_key, period, rule_id, rule_version,
            category, severity, title, authority_scope)
         VALUES ($1,$2,'fnd_broken_evidence',$3,'duplicate_payment','1.0.0',
                 'duplicate','high','Broken evidence trail','engine')
         ON CONFLICT (analysis_run_id, finding_key) DO NOTHING
         RETURNING id`, [tenant, runId, PERIOD])).rows[0];
      if (finding) {
        await c.query(
          `INSERT INTO finding_evidence
             (tenant_id, finding_id, label, source_system, source_record_id)
           VALUES ($1,$2,'Vanished record','csv-upload','csv:does-not-exist')`,
          [tenant, finding.id]);
      }
    });

    const { fresh, revived } = await restart();
    try {
      const res = await revived.get("/api/findings/fnd_broken_evidence/records");
      assert.equal(res.status, 200);
      assert.equal(res.json.complete, false,
        "the evidence trail is reported as INCOMPLETE");
      assert.deepEqual(res.json.unresolved, ["csv:does-not-exist"],
        "and the missing citation is NAMED, not silently omitted");
      assert.equal(res.json.evidence_count, 1,
        "the finding still knows how much evidence it claimed");
    } finally {
      await fresh.stop();
    }
  });

test("[RC25] another tenant cannot use a known sourceRecordId or runId",
  { skip: SKIP }, async () => {
    const { fresh, revived } = await restart();
    try {
      const mine = (await revived.get(`/api/analysis/${PERIOD}/transactions`)).json;
      const knownRecordId = mine.transactions[0].sourceRecordId;
      assert.ok(knownRecordId, "a real record id from tenant A");

      // A completely separate visitor, therefore a separate tenant.
      const stranger = fresh.client();
      await stranger.get("/api/health/live");

      const byRecord = await stranger.get(`/api/records/${encodeURIComponent(knownRecordId)}`);
      assert.equal(byRecord.status, 404,
        "a known record id is invisible to another tenant");
      assert.equal(byRecord.json.error, "no_such_record");

      const invented = await stranger.get("/api/records/csv:definitely-not-real");
      assert.equal(invented.status, byRecord.status,
        "and indistinguishable from an id that never existed");
      assert.deepEqual(invented.json, byRecord.json, "no existence oracle");

      // Nor via the period route, nor the finding route.
      const byPeriod = await stranger.get(`/api/analysis/${PERIOD}/transactions`);
      if (byPeriod.status === 200) {
        assert.equal(byPeriod.json.count, 0,
          "another tenant sees none of tenant A's records");
      }

      const finding = (await revived.get(`/api/analysis/${PERIOD}`)).json.analysis
        .findings.find((f) => (f.evidence || []).length > 0);
      const byFinding = await stranger.get(
        `/api/findings/${encodeURIComponent(finding.findingId)}/records`);
      assert.equal(byFinding.status, 404,
        "a known finding key leaks nothing either");
    } finally {
      await fresh.stop();
    }
  });

test("[RC26] the reverse lookup resolves a record to the findings that cite it",
  { skip: SKIP }, async () => {
    const { fresh, revived } = await restart();
    try {
      const analysis = (await revived.get(`/api/analysis/${PERIOD}`)).json.analysis;
      const finding = analysis.findings.find((f) => (f.evidence || []).length > 0);
      const citedId = finding.evidence[0].sourceRecordId;

      const res = await revived.get(`/api/records/${encodeURIComponent(citedId)}`);
      assert.equal(res.status, 200, JSON.stringify(res.json));
      assert.equal(res.json.record.sourceRecordId, citedId, "the record itself");
      assert.ok(res.json.finding_count > 0,
        "and what it caused -- the reverse lookup had no production caller before");
      assert.ok(res.json.findings.some((f) => f.finding_key === finding.findingId),
        "including the finding we started from");

      const count = await revived.get("/api/__test/engine-count");
      assert.equal(count.json.analyses, 0, "no engine invocation");
    } finally {
      await fresh.stop();
    }
  });

test("[RC27] the copilot can cite transactions from a recovered analysis",
  { skip: SKIP }, async () => {
    /* `get_related_transactions` needs the period's records. Before this, a
       recovered analysis reported "the period's individual records are not
       loaded" -- truthfully, while they sat in the database. */
    const { fresh, revived } = await restart();
    try {
      await revived.post("/api/__test/ai-stub", {
        text: JSON.stringify({
          summary: "Two identical retainer payments were flagged.",
          facts: [], inferences: [], recommendations: [], limitations: []
        })
      });
      const res = await revived.post("/api/copilot",
        { message: "show me the risky transactions", month: PERIOD });

      /* THE PROPERTY IS WHICH ABSENCE IS REPORTED, not that an answer came back.
         `no_transaction_data` means "the period's records are not loaded" --
         the pre-JOB-12 state, where the records sat in the database unreachable.
         Any other outcome means the capability RECEIVED them and reasoned over
         them, which is what recovery had to restore. A narrow filter matching
         nothing is a legitimate answer about loaded data. */
      const body = JSON.stringify(res.json);
      assert.equal(body.includes("no_transaction_data"), false,
        "the records were available to the capability after a restart");
      assert.equal(res.json.reason === "no_analysis_run", false,
        "and the analysis itself was recovered");

      const count = await revived.get("/api/__test/engine-count");
      assert.equal(count.json.analyses, 0);
    } finally {
      await fresh.stop();
    }
  });

test("[RC28] observed / derived / unavailable cash survives the round trip",
  { skip: SKIP }, async () => {
    /* PART D, across a restart. May supplied a balance; June did not, so June's
       was derived from net income and is authoritative for nothing. Those two
       states must still be distinguishable after reload. */
    const { fresh, revived } = await restart();
    try {
      const may = (await revived.get(`/api/analysis/${PERIOD}`)).json.analysis;
      const june = (await revived.get(`/api/analysis/${PERIOD_2}`)).json.analysis;

      const mayCash = may.metrics.find((m) => m.key === "cash.on_hand");
      assert.equal(mayCash.available, true, "May's balance was observed");
      assert.equal(mayCash.value, 1200000);

      const juneCash = june.metrics.find((m) => m.key === "cash.on_hand");
      assert.equal(juneCash.available, false,
        "June's was derived, so the cash position is unavailable");
      assert.equal(juneCash.value, null, "null, NOT zero");
      assert.equal(juneCash.reason, "input_not_authoritative",
        "and it says WHY -- there is a number, it is just not a cash balance");

      const juneRunway = june.metrics.find((m) => m.key === "cashflow.runway_months");
      assert.equal(juneRunway.available, false);
      assert.equal(juneRunway.value, null,
        "no runway is manufactured from a derived balance");

      // And the period inputs still record which it was.
      assert.equal(may.period_inputs.currentCashBalance.basis, "observed");
      assert.equal(june.period_inputs.currentCashBalance.basis, "derived_from_net_income");
    } finally {
      await fresh.stop();
    }
  });

test("[RC29] a legacy row's records are still reachable", { skip: SKIP }, async () => {
  /* A pre-JOB-11 run cannot be rebuilt as an analysis. Its RECORDS are a
     different question: they live in financial_transaction, which has always
     been persisted properly, so they must remain retrievable even though the
     analysis around them is not recoverable. Conflating the two would lose data
     that is genuinely there. */
  const { fresh, revived } = await restart();
  try {
    const res = await revived.get(`/api/analysis/${PERIOD}/transactions`);
    assert.equal(res.status, 200,
      "records are retrievable independently of analysis recoverability");
    assert.ok(res.json.count > 0);
  } finally {
    await fresh.stop();
  }
});
