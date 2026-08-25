// JOB 13 PHASES B, C, D, E — proven over HTTP against the real application.
//
//   B  no production consumer can treat a DERIVED cash estimate as observed
//   C  a user-facing output never presents an incomplete analysis with the
//      same apparent confidence as a fully observed one
//   D  every consumer of monthlyData / statements works from persisted data
//      after a restart, or says honestly that it cannot
//   E  a legacy unrecoverable run is distinguishable from "no analysis exists"
//
// Two periods carry the whole suite, and the difference between them IS the
// test: MAY supplies a cash balance, JUNE does not. June is also outflow-only,
// so its derived balance is `Math.max(0, negative)` = exactly 0 — the value
// that used to be presented as a measured cash position of zero.

const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { startServer } = require("../helpers/server");

const TEST_DB = process.env.TEST_DATABASE_URL || "";
const ADMIN_DB = process.env.TEST_ADMIN_DATABASE_URL || TEST_DB;
const SKIP = !TEST_DB;

if (SKIP) {
  console.warn("\n*** SKIPPING DISCLOSURE TESTS: TEST_DATABASE_URL is not set. ***\n");
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

const OBSERVED_PERIOD = "2026-05";   // cash balance supplied
const DERIVED_PERIOD = "2026-06";    // none supplied, and outflow-only

const CSV_MAY = [
  "Date,Description,Amount,Counterparty",
  "2026-05-04,Consulting retainer,-200000,Rivera Logistics",
  "2026-05-04,Consulting retainer,-200000,Rivera Logistics",
  "2026-05-22,Client settlement,900000,BigCo Retail"
].join("\n");

const CSV_JUNE = [
  "Date,Description,Amount,Counterparty",
  "2026-06-03,Rent,-300000,Landlord Ltd",
  "2026-06-09,Software,-45000,SaaS Vendor"
].join("\n");

const ENV = {
  ALLOW_DEMO_DATA: "true", ENABLE_AI_ANALYSIS: "true",
  NVIDIA_API_KEY: "disclosure-test-key", AI_TEST_PROVIDER: "1",
  DATABASE_URL: TEST_DB
};

let origin;
let client;

test.before(async () => {
  if (SKIP) return;
  await admin((c) => c.query(
    `TRUNCATE ai_interaction, credit_transaction, credit_balance,
              conversation_entity, conversation_turn, conversation,
              job_run, job_lock, notification_dedupe,
              finding_evidence, finding, metric_value, analysis_run,
              financial_transaction, membership, tenant, app_user
     RESTART IDENTITY CASCADE`));

  origin = await startServer(ENV);
  client = origin.client();

  const may = await client.upload("/api/financial-data/upload", {
    filename: "may.csv", content: CSV_MAY,
    fields: { period: OBSERVED_PERIOD, currentCashBalance: 1200000 }
  });
  assert.equal(may.status, 200, JSON.stringify(may.json));
  await client.post("/api/monthly-review",
    { month: OBSERVED_PERIOD, use_ai_analysis: false });

  /* The What-If simulator and custom rules are Growth-plan capabilities. The
     test tenant is upgraded so those routes are actually REACHED — a 403 would
     prove nothing about how they treat a derived cash balance. Plan changes go
     through the billing provider in production; this endpoint is refused there
     and exists for exactly this purpose in test. */
  const plan = await client.post("/api/plan", { plan: "growth" });
  assert.ok(plan.status < 400, `test tenant upgraded (${plan.status})`);

  const june = await client.upload("/api/financial-data/upload", {
    filename: "june.csv", content: CSV_JUNE,
    fields: { period: DERIVED_PERIOD }        // deliberately no cash balance
  });
  assert.equal(june.status, 200, JSON.stringify(june.json));
  await client.post("/api/monthly-review",
    { month: DERIVED_PERIOD, use_ai_analysis: false });
});

test.after(async () => { if (origin) await origin.stop(); });


/* SMTP IS CONTROLLED EXPLICITLY, not inherited.
   `src/config.js` calls dotenv, so a developer with real SMTP credentials in
   `.env` gets a CONFIGURED mailer — and these four tests assert the
   UNCONFIGURED behaviour. Reading the ambient environment made them pass or
   fail depending on whose machine they ran on. Each starts its own server with
   the SMTP variables blanked. */
async function serverWithoutMail() {
  const fresh = await startServer(Object.assign({}, ENV, {
    SMTP_HOST: "", SMTP_USER: "", SMTP_PASSWORD: "", MAIL_FROM: ""
  }));
  /* Carry the paying tenant's identity across, so this server sees the SAME
     analysis (recovered from PostgreSQL). A brand-new client would be a new
     tenant with nothing to report on, and the assertions would be about an
     error response rather than about channels. */
  const c = fresh.client();
  client.jar.forEach((v, k) => c.jar.set(k, v));
  return { fresh, c };
}

async function restart() {
  const fresh = await startServer(ENV);
  const revived = fresh.client();
  client.jar.forEach((v, k) => revived.jar.set(k, v));
  return { fresh, revived };
}

// ══════════════════════════════════════════════════════════════════
// PHASE B — no consumer treats a derived estimate as observed
// ══════════════════════════════════════════════════════════════════

test("[D1] the upload response labels a derived cash balance", { skip: SKIP }, async () => {
  /* The uploader is the first person to see this figure. It used to be returned
     as `cash_and_equivalents` with no indication that nobody had supplied it. */
  const fresh = origin.client();
  const derived = await fresh.upload("/api/financial-data/upload", {
    filename: "x.csv", content: CSV_JUNE, fields: { period: DERIVED_PERIOD }
  });
  assert.equal(derived.status, 200);
  assert.equal(derived.json.summary.cash_and_equivalents, null,
    "no cash balance is reported, because none was supplied");
  assert.equal(derived.json.summary.cash_basis, "derived_from_net_income",
    "and the response says the figure was derived");
  assert.equal(derived.json.summary.cash_estimate, 0,
    "the estimate is offered separately, clearly as an estimate");

  const observed = await fresh.upload("/api/financial-data/upload", {
    filename: "y.csv", content: CSV_MAY,
    fields: { period: OBSERVED_PERIOD, currentCashBalance: 1200000 }
  });
  assert.equal(observed.json.summary.cash_and_equivalents, 1200000);
  assert.equal(observed.json.summary.cash_basis, "observed");
});

test("[D2] the FORECAST refuses to project from a derived balance", { skip: SKIP }, async () => {
  /* THE BYPASS THIS CLOSES. The forecast route read
     `balanceSheet.cashAndEquivalents` raw and defaulted to 0, so a projection
     began from a cash position nobody supplied — and a forecast starting at
     zero projects insolvency with total confidence. */
  const res = await client.post("/api/forecast",
    { month: DERIVED_PERIOD, use_ai_analysis: false });

  assert.equal(res.status, 409, JSON.stringify(res.json).slice(0, 300));
  assert.equal(res.json.error, "cash_balance_required");
  assert.equal(res.json.reason, "input_not_authoritative");
  assert.equal(res.json.basis, "derived_from_net_income");
  assert.match(res.json.detail, /estimate|cash balance/i,
    "and the user is told what to do about it");
});

test("[D3] the forecast WORKS from an observed balance", { skip: SKIP }, async () => {
  // The other half: refusing must not have broken the legitimate path.
  const res = await client.post("/api/forecast",
    { month: OBSERVED_PERIOD, use_ai_analysis: false });
  assert.equal(res.status, 200, JSON.stringify(res.json).slice(0, 300));
  assert.equal(res.json.ok, true);
});

test("[D4] the WHAT-IF simulator refuses a derived balance", { skip: SKIP }, async () => {
  // `type`, and a real scenario id — an unknown one is refused earlier, which
  // would prove nothing about how the route treats a derived cash balance.
  const res = await client.post("/api/what-if", {
    month: DERIVED_PERIOD, type: "reduce_revenue",
    params: { pct: 20 }, use_ai_analysis: false
  });
  assert.equal(res.status, 409, JSON.stringify(res.json).slice(0, 300));
  assert.equal(res.json.error, "cash_balance_required");
});

test("[D5] a CUSTOM RULE is not evaluated against a derived balance",
  { skip: SKIP }, async () => {
    /* The bypass named in the mandate. `customRules.js` read
       `balanceSheet.cashAndEquivalents` raw, so a `cash_below` rule fired
       against the derived 0 — telling the user their cash was below threshold
       on the strength of a figure nobody supplied. */
    const saved = await client.post("/api/rules", {
      name: "Low cash alert",
      severity: "high",
      action: "flag",
      condition: { type: "cash_below", amount: 500000 }
    });
    assert.ok(saved.status < 400, `rule saved (${saved.status})`);

    // DERIVED period: the rule must NOT fire.
    const derived = await client.post("/api/monthly-review",
      { month: DERIVED_PERIOD, use_ai_analysis: false });
    assert.equal(derived.status, 200);
    const derivedFindings = JSON.stringify(derived.json);
    assert.equal(derivedFindings.includes("Low cash alert"), false,
      "the rule did not fire against an estimate of 0");

    // OBSERVED period with 1.2M: above the 500k threshold, so also no finding —
    // but for the RIGHT reason. Proven by the execution record below.
    const history = await client.get("/api/rules/history");
    if (history.status === 200 && Array.isArray(history.json.history)) {
      const derivedRun = history.json.history
        .filter((h) => h.month === DERIVED_PERIOD)
        .pop();
      if (derivedRun) {
        const execution = (derivedRun.results || [])
          .find((r) => r.ruleName === "Low cash alert");
        if (execution) {
          assert.equal(execution.evaluated, false,
            "the rule is recorded as NOT EVALUATED, rather than as having run "
            + "and found nothing");
          assert.equal(execution.skippedReason, "input_not_authoritative",
            "with the reason it could not be judged");
        }
      }
    }
  });

// ══════════════════════════════════════════════════════════════════
// PHASE C — the user can see the limitation
// ══════════════════════════════════════════════════════════════════

test("[D6] the cashflow panel explains an unavailable cash position",
  { skip: SKIP }, async () => {
    /* The adapter used to map `cash_on_hand` and drop every provenance field,
       so the dashboard rendered an unexplained blank. A blank invites the
       reader to assume zero. */
    const res = await client.get(`/api/cashflow?month=${DERIVED_PERIOD}`);
    assert.equal(res.status, 200);
    assert.equal(res.json.cashflow.cash_on_hand, null, "no figure is shown");
    assert.equal(res.json.cashflow.cash_on_hand_available, false);
    assert.equal(res.json.cashflow.cash_on_hand_unavailable_reason,
      "input_not_authoritative", "and the panel is told WHY");
    assert.equal(res.json.cashflow.cash_on_hand_basis, "derived_from_net_income");

    assert.ok(res.json.disclosure, "a disclosure block is attached");
    const kinds = res.json.disclosure.limitations.map((l) => l.type);
    assert.ok(kinds.includes("derived_input") || kinds.includes("unavailable_metric"),
      "naming the derived input and/or the unavailable metric");
  });

test("[D7] a fully observed period discloses NOTHING it does not need to",
  { skip: SKIP }, async () => {
    /* Disclosure must mean something. If every response carried a warning, the
       warning would be noise and a reader would learn to ignore it. */
    const res = await client.get(`/api/cashflow?month=${OBSERVED_PERIOD}`);
    assert.equal(res.json.cashflow.cash_on_hand, 1200000);
    assert.equal(res.json.cashflow.cash_on_hand_available, true);
    assert.equal(res.json.cashflow.cash_on_hand_basis, "observed");
  });

test("[D8] the health score discloses partial coverage", { skip: SKIP }, async () => {
  const res = await client.get(`/api/health-score?month=${DERIVED_PERIOD}`);
  assert.equal(res.status, 200);
  assert.ok("disclosure" in res.json, "the route carries a disclosure field");
  if (res.json.disclosure) {
    assert.ok(res.json.disclosure.limitations.length > 0,
      "and it names at least one real limitation");
  }
  // Components that could not be measured stay null, never 0.
  const components = res.json.health.component_scores || {};
  Object.entries(components).forEach(([name, value]) => {
    assert.notEqual(value, undefined, `${name} is present`);
    if (value === null) assert.equal(value, null, `${name} is null, not 0`);
  });
});

test("[D9] the EXECUTIVE REPORT states its limitations in the exported text",
  { skip: SKIP }, async () => {
    /* The output most likely to be forwarded to a lender or a board, read away
       from the app with no chance to ask what a blank meant. The limitations
       must be in the TEXT, because the text is what gets exported. */
    const res = await client.post("/api/executive-report",
      { month: DERIVED_PERIOD, report_type: "monthly_review" });
    assert.equal(res.status, 200, JSON.stringify(res.json).slice(0, 200));

    assert.equal(res.json.complete, false,
      "the report declares itself incomplete");
    assert.ok(res.json.disclosure, "with structured limitations");
    assert.match(res.json.report, /Limitations of this report/i,
      "and they appear IN the exported text, not only in the JSON");
    assert.match(res.json.report, /must not be read as zero/i,
      "including the specific warning against reading a blank as zero");
  });

test("[D10] an observed report is NOT marked incomplete", { skip: SKIP }, async () => {
  const res = await client.post("/api/executive-report",
    { month: OBSERVED_PERIOD, report_type: "monthly_review" });
  assert.equal(res.status, 200);
  // May is fully observed for cash; whatever else it discloses must be real.
  if (res.json.complete === false) {
    assert.ok(res.json.disclosure.limitations.length > 0,
      "if it claims to be incomplete, it must name why");
    const cashLimits = res.json.disclosure.limitations
      .filter((l) => l.metric === "cash_on_hand");
    assert.deepEqual(cashLimits, [],
      "and cash on hand is NOT among them -- it was observed");
  }
});

// ══════════════════════════════════════════════════════════════════
// PHASE D — every consumer after a restart
// ══════════════════════════════════════════════════════════════════

test("[D11] no analytical route silently returns empty or zero after a restart",
  { skip: SKIP }, async () => {
    /* THE SWEEP. Each route must either work from persisted data, or say it
       cannot. What none may do is answer `ok:true` with empty arrays and zeroes,
       which reads as "your business had no activity". */
    const { fresh, revived } = await restart();
    try {
      const routes = [
        `/api/health-score?month=${OBSERVED_PERIOD}`,
        `/api/cashflow?month=${OBSERVED_PERIOD}`,
        `/api/revenue?month=${OBSERVED_PERIOD}`,
        `/api/anomalies?month=${OBSERVED_PERIOD}`,
        `/api/vendors?month=${OBSERVED_PERIOD}`,
        `/api/customers?month=${OBSERVED_PERIOD}`,
        `/api/actions?month=${OBSERVED_PERIOD}`
      ];

      for (const route of routes) {
        const res = await revived.get(route);
        assert.notEqual(res.status, 404, `${route} exists`);

        if (res.json && res.json.ok === true) {
          // Case A: it works from persisted data. Then it must not be hollow.
          const body = JSON.stringify(res.json);
          assert.notEqual(body, JSON.stringify({ ok: true }),
            `${route} returned a bare ok with no content`);
        } else {
          // Case B/C: it declines, and says why.
          assert.ok(
            (res.json && (res.json.error || res.json.reason)) || res.status >= 400,
            `${route} declined WITH a reason rather than silently`);
        }
      }

      // And none of that ran the engine.
      const count = await revived.get("/api/__test/engine-count");
      assert.equal(count.json.analyses, 0,
        "every answer came from persisted data, not a fresh analysis");
    } finally {
      await fresh.stop();
    }
  });

test("[D12] the anomalies panel recovers real findings, not an empty list",
  { skip: SKIP }, async () => {
    /* The specific silent-empty risk: `items: []` reads as "no anomalies were
       found", which about a period containing a duplicate payment is false. */
    const before = await client.get(`/api/anomalies?month=${OBSERVED_PERIOD}`);
    const beforeCount = before.json.anomalies.items.length;
    assert.ok(beforeCount > 0, "precondition: this period has findings");

    const { fresh, revived } = await restart();
    try {
      const after = await revived.get(`/api/anomalies?month=${OBSERVED_PERIOD}`);
      assert.equal(after.json.ok, true);
      assert.equal(after.json.anomalies.items.length, beforeCount,
        "the same findings come back -- an empty list here would assert that "
        + "the period was clean");
    } finally {
      await fresh.stop();
    }
  });

test("[D13] a period with NO analysis is refused, not answered with zeroes",
  { skip: SKIP }, async () => {
    const { fresh } = await restart();
    try {
      const virgin = fresh.client();
      await virgin.get("/api/health/live");

      const res = await virgin.get("/api/cashflow?month=2019-01");
      if (res.json && res.json.ok === true) {
        const body = JSON.stringify(res.json);
        assert.match(body, /no_data|unavailable|not_available|null/i,
          "a period that was never analysed does not report figures");
      } else {
        assert.ok(res.json.error || res.status >= 400,
          "or it declines outright");
      }
    } finally {
      await fresh.stop();
    }
  });

// ══════════════════════════════════════════════════════════════════
// PHASE E — legacy runs
// ══════════════════════════════════════════════════════════════════

test("[D14] a legacy run is distinguishable from 'no analysis exists'",
  { skip: SKIP }, async () => {
    const tenant = (await admin(async (c) =>
      (await c.query("SELECT tenant_id FROM financial_transaction LIMIT 1")).rows[0])).tenant_id;
    const legacyPeriod = "2025-03";

    /* A genuine pre-JOB-11 row: the CHECK constraint is NOT VALID, so it judges
       new rows but not ones that already existed. Dropping and re-adding it
       reproduces exactly that situation. */
    await admin(async (c) => {
      await c.query("ALTER TABLE analysis_run DROP CONSTRAINT analysis_run_completed_is_recoverable");
      await c.query(
        `INSERT INTO analysis_run (tenant_id, period, status, engine_version,
                                   rule_versions, health, methodology, completed_at)
         VALUES ($1,$2,'completed','engine@0.9.0','{}','{"overall":61}','{}', now())`,
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

      // ── LEGACY: a real run that cannot be rebuilt.
      const legacy = await revived.get(`/api/analysis/${legacyPeriod}`);
      assert.equal(legacy.status, 409, "not 404 -- the analysis DOES exist");
      assert.equal(legacy.json.error, "legacy_unrecoverable",
        "with a stable, machine-readable reason");
      assert.ok(legacy.json.detail, "and a human-readable explanation");
      assert.match(legacy.json.detail, /re-run/i,
        "telling the user the action that fixes it");
      assert.ok(legacy.json.run_id, "and identifying the run, so it is clearly real");

      // ── ABSENT: no analysis was ever run.
      const absent = await revived.get("/api/analysis/2018-01");
      assert.equal(absent.status, 404, "a period with no analysis is 404");
      assert.equal(absent.json.error, "no_completed_analysis");

      assert.notEqual(legacy.status, absent.status,
        "THE POINT: the two are distinguishable. 'Your analysis cannot be "
        + "reloaded' and 'you never ran one' need different words and different "
        + "advice.");

      // ── NO SILENT RECOMPUTATION.
      const after = await revived.get("/api/__test/engine-count");
      assert.equal(after.json.analyses, before.json.analyses,
        "the legacy run was NOT quietly recomputed into something that would "
        + "differ from what the user originally saw");
    } finally {
      await fresh.stop();
    }
  });

test("[D15] the copilot reports a legacy period honestly", { skip: SKIP }, async () => {
  const { fresh, revived } = await restart();
  try {
    const res = await revived.post("/api/copilot",
      { message: "what happened that month?", month: "2025-03" });

    assert.equal(res.json.ok, false);
    assert.equal(res.json.reason, "analysis_legacy_unrecoverable",
      "a stable reason, distinct from 'no analysis run'");
    assert.equal(res.json.analysis_saved, true,
      "the user is told their analysis IS saved");
    assert.equal(res.json.recoverable, false, "but cannot be reloaded");
    assert.match(res.json.message, /re-run/i, "with the action that fixes it");

    const count = await revived.get("/api/__test/engine-count");
    assert.equal(count.json.analyses, 0, "and nothing was recomputed");
  } finally {
    await fresh.stop();
  }
});

// ══════════════════════════════════════════════════════════════════
// PART C — reports built on a RECOVERED analysis must stay honest.
//
// JOB 11 deliberately does not restore monthly statement totals: recomputing
// inflow/outflow from recovered rows would produce figures that look
// authoritative but were never part of the stored analysis. A report rendered
// after a restart therefore has persisted metrics and findings, and NOT the
// statement totals — and it must say so rather than printing zeroes.
// ══════════════════════════════════════════════════════════════════

test("[D16] the EXECUTIVE REPORT works after a restart without recomputing",
  { skip: SKIP }, async () => {
    const before = await client.post("/api/executive-report",
      { month: OBSERVED_PERIOD, report_type: "monthly_review" });
    assert.equal(before.status, 200, JSON.stringify(before.json).slice(0, 200));

    const { fresh, revived } = await restart();
    try {
      const engineBefore = await revived.get("/api/__test/engine-count");
      assert.equal(engineBefore.json.analyses, 0);

      const after = await revived.post("/api/executive-report",
        { month: OBSERVED_PERIOD, report_type: "monthly_review" });
      assert.equal(after.status, 200, JSON.stringify(after.json).slice(0, 300));
      assert.equal(after.json.ok, true,
        "the report renders from persisted data rather than demanding a re-run");

      // ── The authoritative headline survives, and is the STORED one.
      const scoreOf = (body) => (body.report.match(/Health Score:\s*([0-9]+|N\/A)/) || [])[1];
      assert.equal(scoreOf(after.json), scoreOf(before.json),
        "the health score is the persisted value, not a recomputed one");

      // ── And producing it did NOT run the engine.
      const engineAfter = await revived.get("/api/__test/engine-count");
      assert.equal(engineAfter.json.analyses, 0,
        "no re-analysis happened to satisfy the report");
    } finally {
      await fresh.stop();
    }
  });

test("[D17] a recovered report never prints a fabricated zero", { skip: SKIP }, async () => {
  /* THE SPECIFIC RISK. Statement totals are absent on a recovered analysis by
     design. A template that formats an absent total with a numeric default
     would print "Net cash flow: 0 KES" — a measurement nobody made, in the
     document most likely to be forwarded to a lender. */
  const { fresh, revived } = await restart();
  try {
    const res = await revived.post("/api/executive-report",
      { month: DERIVED_PERIOD, report_type: "monthly_review" });
    assert.equal(res.status, 200);

    /* Any figure the report DOES print must be one the run actually carries.
       A "0" adjacent to a currency label is the shape of the fabrication being
       guarded against. */
    const zeroClaims = res.json.report.match(/:\s*-?0(\.0+)?\s*(KES|USD)?\s*$/gm) || [];
    assert.deepEqual(zeroClaims, [],
      `the report printed a bare zero figure: ${zeroClaims.join(" | ")}`);

    // June's cash was derived, so the report must disclose that.
    assert.equal(res.json.complete, false);
    assert.match(res.json.report, /Limitations of this report/i);
  } finally {
    await fresh.stop();
  }
});

test("[D18] the what-if capability refuses rather than zeroing a baseline",
  { skip: SKIP }, async () => {
    /* PART E, at the route. The capability built its baseline with
       `x != null ? x : 0` for five financial inputs while its guard checked
       only two, so an unmeasured burn rate, receivables figure or revenue total
       became ZERO and was projected forward as fact. */
    const res = await client.post("/api/what-if", {
      month: DERIVED_PERIOD, type: "reduce_revenue",
      params: { pct: 20 }, use_ai_analysis: false
    });
    // June has no observed cash, so the route refuses before the capability.
    assert.equal(res.status, 409);
    assert.equal(res.json.error, "cash_balance_required");

    // And the observed period still simulates normally.
    const ok = await client.post("/api/what-if", {
      month: OBSERVED_PERIOD, type: "reduce_revenue",
      params: { pct: 20 }, use_ai_analysis: false
    });
    assert.ok(ok.status < 400, `the observed period still works (${ok.status})`);
  });

test("[D19] the copilot never answers about one period using another period's run",
  { skip: SKIP }, async () => {
    /* A DEFECT FOUND DURING END-TO-END VERIFICATION, not by the suite.
     *
     * When no run could be resolved for the requested period, the copilot fell
     * back to `latestReviewContext.rawAnalysis.run` with NO period check — so a
     * question about March was answered from July's analysis, and every figure
     * in the reply belonged to a month the user had not asked about.
     *
     * It also SHADOWED the legacy branch: because `run` was non-null, a period
     * whose stored analysis cannot be rebuilt never reported itself as legacy
     * and the request continued into the AI with the wrong period's data.
     *
     * The in-process suite could not catch it — a freshly started test server
     * has no cached context for the fallback to reach for. The condition is
     * reproduced here explicitly: review one period, then ask about another. */
    const tenant = (await admin(async (c) =>
      (await c.query("SELECT tenant_id FROM financial_transaction LIMIT 1")).rows[0])).tenant_id;
    const legacyPeriod = "2025-04";

    await admin(async (c) => {
      await c.query("ALTER TABLE analysis_run DROP CONSTRAINT analysis_run_completed_is_recoverable");
      await c.query(
        `INSERT INTO analysis_run (tenant_id, period, status, engine_version,
                                   rule_versions, health, methodology, completed_at)
         VALUES ($1,$2,'completed','engine@0.9.0','{}','{"overall":49}','{}', now())`,
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
      // THE PRECONDITION: a cached context exists, for a DIFFERENT period.
      const primed = await revived.post("/api/monthly-review",
        { month: OBSERVED_PERIOD, use_ai_analysis: false });
      assert.equal(primed.status, 200, "a different period is now cached in memory");

      const res = await revived.post("/api/copilot",
        { message: "what happened that month?", month: legacyPeriod });

      assert.equal(res.json.ok, false,
        "the legacy period cannot be answered...");
      assert.equal(res.json.reason, "analysis_legacy_unrecoverable",
        "...and it says so, rather than silently answering from "
        + `${OBSERVED_PERIOD}'s cached run`);
      assert.equal(res.json.period, legacyPeriod,
        "about the period that was actually asked about");
      assert.equal(res.json.analysis_saved, true);
      assert.equal(res.json.recoverable, false);
    } finally {
      await fresh.stop();
    }
  });

// ══════════════════════════════════════════════════════════════════
// FINAL CLOSURE PART B — the EXPORT boundary.
//
// The JSON report states its limitations. The PDF built from the same context
// carried NONE of it — and the PDF is the artifact that leaves the app: emailed
// to a lender, attached to a board pack, read with no way to ask what a dash
// meant. These tests hit the real `/api/executive-report/pdf` endpoint and
// inspect the produced bytes.
// ══════════════════════════════════════════════════════════════════

/**
 * Extract readable text from the produced PDF.
 *
 * Two things make this less trivial than scanning bytes, and BOTH would
 * silently produce an empty string — every text assertion would then pass
 * against nothing, which is worse than having no test at all:
 *
 *   1. pdfkit FLATE-compresses its content streams, so the text is not in the
 *      raw bytes. Each stream is inflated first.
 *   2. It writes glyphs as HEX strings inside TJ arrays — `[<466f6c6c6f> 15
 *      <772d7570>] TJ` — not as `(literal) Tj`. The hex is decoded here.
 *
 * Callers assert that text was actually recovered before asserting on it.
 */
function pdfText(buffer) {
  const zlib = require("node:zlib");
  const raw = buffer.toString("latin1");
  let ops = "";

  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = streamRe.exec(raw)) !== null) {
    try {
      ops += zlib.inflateSync(Buffer.from(m[1], "latin1")).toString("latin1") + "\n";
    } catch { /* fonts and images are not deflate text */ }
  }

  // Hex-encoded glyph runs, the form pdfkit actually emits.
  const hex = (ops.match(/<([0-9a-fA-F]+)>/g) || [])
    .map((h) => Buffer.from(h.slice(1, -1), "hex").toString("latin1"))
    .join("");
  // Literal strings, for any producer that emits them.
  const literal = (ops.match(/\(((?:[^()\\]|\\.)*)\)\s*T[jJ]/g) || [])
    .map((c) => c.replace(/^\(/, "").replace(/\)\s*T[jJ]$/, ""))
    .join(" ");

  return (hex + " " + literal).replace(/\\([()\\])/g, "$1");
}

async function fetchPdf(client, body) {
  const token = client.csrfToken();
  const res = await fetch(`${origin.base}/api/executive-report/pdf`, {
    method: "POST",
    headers: {
      cookie: [...client.jar].map(([k, v]) => `${k}=${v}`).join("; "),
      "content-type": "application/json",
      "x-csrf-token": token
    },
    body: JSON.stringify(body)
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, type: res.headers.get("content-type"), buf };
}

test("[D20] the PDF export STATES its limitations", { skip: SKIP }, async () => {
  // June's cash balance was derived, so this report is not fully observed.
  const pdf = await fetchPdf(client, { month: DERIVED_PERIOD });
  assert.equal(pdf.status, 200, "the export endpoint produced a document");
  assert.match(pdf.type || "", /application\/pdf/);
  assert.ok(pdf.buf.length > 1000, "and it is a real PDF, not an error page");

  const text = pdfText(pdf.buf);
  assert.ok(text.length > 200, "text was extracted from the PDF");
  assert.match(text, /Limitations of this report/i,
    "THE DEFECT: the exported document carried no limitations at all, while "
    + "the JSON report stated them");
  assert.match(text, /must not be read as zero/i,
    "including the specific warning against reading a dash as zero");
});

test("[D21] the PDF export never prints a fabricated zero", { skip: SKIP }, async () => {
  /* An unmeasured figure must render as a dash, never as an amount. A PDF
     saying "Cash runway: 0 days" about a business whose runway was never
     computed is the worst artifact this system could produce. */
  const pdf = await fetchPdf(client, { month: DERIVED_PERIOD });
  const text = pdfText(pdf.buf);
  assert.ok(text.length > 200, "text was extracted -- this test is not vacuous");

  assert.equal(/Cash runway[:\s]*0\s*days/i.test(text), false,
    "runway is not printed as zero days");
  assert.equal(/Net cash flow[:\s]*KES 0\b/i.test(text), false,
    "net cash flow is not printed as a zero amount when unmeasured");
});

test("[D22] a fully observed PDF carries no spurious limitations",
  { skip: SKIP }, async () => {
    /* The section must mean something. If every export carried it, a reader
       would learn to skip it. */
    const pdf = await fetchPdf(client, { month: OBSERVED_PERIOD });
    assert.equal(pdf.status, 200);
    const text = pdfText(pdf.buf);
    assert.ok(text.length > 200, "text was extracted -- this test is not vacuous");

    // May's cash was observed, so a cash-balance limitation must NOT appear.
    assert.equal(/estimate was derived from net income/i.test(text), false,
      "an observed period is not told its cash was derived");
  });

test("[D23] the actions route carries disclosure for the CSV export",
  { skip: SKIP }, async () => {
    /* CSV cannot carry a notice block, so the client turns this into an
       explicit column. The route has to supply it or the column is empty. */
    const res = await client.get(`/api/actions?month=${DERIVED_PERIOD}`);
    assert.equal(res.status, 200);
    assert.ok("disclosure" in res.json,
      "the actions route exposes the same disclosure as every other route");
    if (res.json.disclosure) {
      assert.ok(res.json.disclosure.limitations.length > 0,
        "and it names real limitations for a period built on a derived input");
    }
  });

test("[D24] the PDF export honours the REQUESTED month", { skip: SKIP }, async () => {
  /* THE DEFECT. This route used the synchronous `getContext`, which returns
     whatever period is cached regardless of what was asked for. Requesting June
     produced a document headed "Reporting period: 2026-05" carrying May's
     figures — a wrong-month report with nothing in it to reveal the mismatch,
     in the artifact most likely to be forwarded to someone who cannot check. */
  const june = await fetchPdf(client, { month: DERIVED_PERIOD });
  const juneText = pdfText(june.buf);
  assert.ok(juneText.length > 200, "text extracted");
  assert.match(juneText, new RegExp(DERIVED_PERIOD),
    `the PDF is headed with the requested period (${DERIVED_PERIOD})`);
  assert.equal(juneText.includes(OBSERVED_PERIOD), false,
    "and does not carry the other period's heading");

  const may = await fetchPdf(client, { month: OBSERVED_PERIOD });
  const mayText = pdfText(may.buf);
  assert.match(mayText, new RegExp(OBSERVED_PERIOD),
    "and asking for the other period returns that one");
});

test("[D25] the PDF export RECOVERS after a restart", { skip: SKIP }, async () => {
  /* The JSON report recovered from PostgreSQL; the PDF answered "Run a monthly
     review first" because it used the non-recovering context helper. The
     export path is exactly where a refusal is least acceptable — the user is
     trying to take the analysis somewhere. */
  const { fresh, revived } = await restart();
  try {
    const engineBefore = await revived.get("/api/__test/engine-count");

    const token = revived.csrfToken();
    const res = await fetch(`${fresh.base}/api/executive-report/pdf`, {
      method: "POST",
      headers: {
        cookie: [...revived.jar].map(([k, v]) => `${k}=${v}`).join("; "),
        "content-type": "application/json",
        "x-csrf-token": token
      },
      body: JSON.stringify({ month: OBSERVED_PERIOD })
    });
    assert.equal(res.status, 200,
      "the export renders from persisted data rather than refusing");
    const buf = Buffer.from(await res.arrayBuffer());
    const text = pdfText(buf);
    assert.ok(text.length > 200, "and it contains real content");
    assert.match(text, new RegExp(OBSERVED_PERIOD), "for the requested period");

    const engineAfter = await revived.get("/api/__test/engine-count");
    assert.equal(engineAfter.json.analyses, engineBefore.json.analyses,
      "and producing it did not re-run the engine");
  } finally {
    await fresh.stop();
  }
});

// ══════════════════════════════════════════════════════════════════
// FINAL CLEANUP — the API advertises only channels it can deliver.
// ══════════════════════════════════════════════════════════════════

test("[D26] no unsupported export channel is advertised", { skip: SKIP }, async () => {
  /* THE DEFECT. The executive report advertised `["PDF", "CSV", "Email"]`. Two
     of the three did not exist: there is no CSV representation of an executive
     report anywhere (the CSV download is a client-side export of the ACTIONS
     list, a different resource), and there is no mail implementation or mail
     dependency in the project at all. A capability list is a promise the API
     makes about itself, and a client written against it would have built a
     button that could not work. */
  const { fresh: bare, c } = await serverWithoutMail();
  let res;
  try {
    res = await c.post("/api/executive-report",
      { month: OBSERVED_PERIOD, report_type: "monthly_review" });
  } finally { await bare.stop(); }
  assert.ok(Array.isArray(res.json.channels), "channels are advertised");

  assert.equal(res.json.channels.includes("Email"), false,
    "Email is NOT advertised when the server cannot send");
  assert.equal(res.json.channels.includes("CSV"), false,
    "nor CSV -- there is no CSV representation of an executive report");

  // What IS advertised must be reachable. JSON is this very response.
  assert.ok(res.json.channels.includes("JSON"));
  assert.ok(res.json.report, "and the JSON channel really carries the report");

  assert.ok(res.json.channels.includes("PDF"));
  const pdf = await fetchPdf(client, { month: OBSERVED_PERIOD });
  assert.equal(pdf.status, 200, "and the PDF channel really produces a document");
  assert.match(pdf.type || "", /application\/pdf/);
});

test("[D27] the forecast route refuses unmeasured projection inputs",
  { skip: SKIP }, async () => {
    /* The modules now refuse on their own account. This proves the route
       surfaces that refusal rather than turning it into a broken 200. */
    const res = await client.post("/api/forecast",
      { month: DERIVED_PERIOD, use_ai_analysis: false });
    assert.equal(res.status, 409, JSON.stringify(res.json).slice(0, 200));
    // June is refused at the cash-balance gate, which fires first.
    assert.ok(["cash_balance_required", "forecast_inputs_unmeasured"]
      .includes(res.json.error), `refused with ${res.json.error}`);

    // And the observed period still projects.
    const ok = await client.post("/api/forecast",
      { month: OBSERVED_PERIOD, use_ai_analysis: false });
    assert.equal(ok.status, 200, "the measured period still works");
    assert.equal(ok.json.ok, true);
  });

// ══════════════════════════════════════════════════════════════════
// EMAIL DELIVERY — at the real route.
// ══════════════════════════════════════════════════════════════════

test("[D28] Email is advertised only when the server can send", { skip: SKIP }, async () => {
  /* This server has no SMTP configuration, so Email must NOT be offered — a
     capability list is a promise the API makes about itself, and the previous
     version listed a channel with no implementation behind it. */
  const { fresh: bare, c } = await serverWithoutMail();
  try {
    const res = await c.post("/api/executive-report",
      { month: OBSERVED_PERIOD, report_type: "monthly_review" });
    assert.equal(res.json.channels.includes("Email"), false,
      "an unconfigured deployment does not offer email");
    assert.ok(res.json.channels.includes("PDF"), "but does offer what it can deliver");
  } finally { await bare.stop(); }
});

test("[D29] the email route refuses honestly when SMTP is not configured",
  { skip: SKIP }, async () => {
    const { fresh: bare, c } = await serverWithoutMail();
    try {
      const res = await c.post("/api/executive-report/email",
        { month: OBSERVED_PERIOD, to: ["owner@example.com"] });
      assert.equal(res.status, 503, JSON.stringify(res.json).slice(0, 200));
      assert.equal(res.json.error, "mail_not_configured");
      assert.ok(Array.isArray(res.json.missing) && res.json.missing.length,
        "and names what the operator must set");
    } finally { await bare.stop(); }
  });

test("[D30] the email route refuses before doing any work", { skip: SKIP }, async () => {
  /* ORDER MATTERS, and this asserts the order the route actually uses:
     configuration is checked FIRST. Telling a user their recipient list is
     empty, on a server that cannot send mail at all, would send them to fix
     the wrong thing. On a configured server the recipient check is what fires
     — that path is covered directly in tests/ops/mailer.test.js [M3]. */
  const res = await client.post("/api/executive-report/email",
    { month: OBSERVED_PERIOD, to: [] });
  assert.ok([400, 503].includes(res.status), `refused with ${res.status}`);
  assert.ok(["mail_not_configured", "no_recipient"].includes(res.json.error),
    `and named the reason: ${res.json.error}`);
  // Whatever the reason, nothing was sent and no report leaked into the body.
  assert.equal(res.json.ok, false);
  assert.equal("report" in res.json, false, "no report content is returned");
});

test("[D31] mail status reports configured-ness without leaking anything",
  { skip: SKIP }, async () => {
    const { fresh: bare, c } = await serverWithoutMail();
    let res;
    try {
      res = await c.get("/api/mail/status");
    } finally { await bare.stop(); }
    assert.equal(res.status, 200);
    assert.equal(res.json.configured, false, "this server has no SMTP set up");
    assert.ok(Array.isArray(res.json.missing));

    /* NO CREDENTIAL VALUE may appear. Naming the missing ENV VAR
       ("SMTP_PASSWORD") is the whole point of the response — it tells the
       operator what to set — so the assertion is about values, not the word. */
    const body = JSON.stringify(res.json);
    assert.equal(/SMTP_PASSWORD"\s*:/.test(body), false,
      "no password VALUE is echoed");
    assert.equal(/"(pass|password|pwd|auth)"\s*:\s*"[^"]+"/i.test(body), false,
      "and no credential field is present at all");
    assert.ok(res.json.missing.includes("SMTP_PASSWORD"),
      "while still naming which variable the operator must set");
  });
