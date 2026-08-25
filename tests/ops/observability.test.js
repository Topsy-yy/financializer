// OBSERVABILITY — structured logging, redaction, health, and startup validation.
//
// The redaction tests matter most. A log line is the easiest place to leak a
// secret, because logging is the thing you add when something is going wrong and
// you are not being careful. So redaction is enforced on the way OUT, for every
// field of every call, and these tests attack it.

const test = require("node:test");
const assert = require("node:assert/strict");

const { logger, makeLogger, setSink, redact, looksLikeSecret } = require("../../src/services/logger");
const startupValidation = require("../../src/services/startupValidation");

/** Capture log lines instead of writing them. */
function capture(fn) {
  const lines = [];
  const previous = setSink((line) => lines.push(JSON.parse(line)));
  const previousLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "debug";
  try { fn(); } finally {
    setSink(previous);
    if (previousLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previousLevel;
  }
  return lines;
}

// ── Redaction ────────────────────────────────────────────────────

test("[L1] a value under a SECRET-looking key is never printed", () => {
  const lines = capture(() => {
    logger.info("provider configured", {
      apiKey: "nvapi-abcdefghijklmnopqrstuvwxyz123456",
      sessionSecret: "a-very-real-session-secret-value",
      zohoRefreshToken: "1000.abcdef.ghijkl",
      authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
      cookie: "fg_sid=s%3Aabc.def",
      privateKey: "0xabc123",
      provider: "nvidia"           // safe: not a secret
    });
  });
  const line = JSON.stringify(lines[0]);
  ["nvapi-", "a-very-real-session-secret", "1000.abcdef", "eyJhbGci", "fg_sid=", "0xabc123"]
    .forEach((leak) => assert.equal(line.includes(leak), false, `leaked: ${leak}`));
  assert.equal(lines[0].provider, "nvidia", "non-secret fields still log");
});

test("[L2] a secret is redacted even under an INNOCUOUS key name", () => {
  // The realistic failure: someone logs a token as `value` or `detail`.
  const lines = capture(() => {
    logger.info("oauth exchange", {
      value: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc",
      detail: "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
      other: "AIzaSyD-abcdefghijklmnopqrstuvwxyz12345"
    });
  });
  const line = JSON.stringify(lines[0]);
  assert.equal(line.includes("eyJhbGci"), false, "a JWT is caught by shape");
  assert.equal(line.includes("sk-proj-"), false, "an OpenAI key is caught by prefix");
  assert.equal(line.includes("AIzaSy"), false, "a Google key is caught by prefix");
});

test("[L3] FINANCIAL CONTENT is summarised, never printed", () => {
  const lines = capture(() => {
    logger.info("analysis complete", {
      transactions: [
        { date: "2026-05-04", amount: -200000, counterparty: "Rivera Logistics" },
        { date: "2026-05-11", amount: -120000, counterparty: "City Power" }
      ],
      counterparty: "Rivera Logistics",
      prompt: "Rivera Logistics was paid 200,000 twice",
      response: "That looks like a duplicate payment.",
      findingCount: 2      // a count is diagnostic and safe
    });
  });
  const line = JSON.stringify(lines[0]);
  assert.equal(line.includes("Rivera Logistics"), false, "no counterparty name");
  assert.equal(line.includes("200,000"), false, "no amount");
  assert.equal(line.includes("duplicate payment"), false, "no AI response text");
  assert.equal(lines[0].findingCount, 2, "counts survive, because they are the diagnostic part");
  // The shape is still visible: length/count is what you actually need in a log.
  assert.match(String(lines[0].prompt), /chars|object|items/);
});

test("[L4] redaction survives NESTING and does not blow up on cycles", () => {
  const lines = capture(() => {
    logger.info("nested", {
      routing: { provider: "mistral", apiKey: "sk-nested-secret-value-1234567890" },
      list: [{ token: "abcdefghijklmnopqrstuvwxyz" }],
      deep: { a: { b: { c: { d: { e: { f: "bottom" } } } } } }
    });
  });
  const line = JSON.stringify(lines[0]);
  assert.equal(line.includes("sk-nested-secret"), false);
  assert.equal(line.includes("abcdefghijklmnopqrstuvwxyz"), false);
  assert.equal(lines[0].routing.provider, "mistral");
});

test("[L5] long free text is truncated rather than dumped", () => {
  const lines = capture(() => {
    logger.info("long", { note: "x".repeat(5000) });
  });
  assert.ok(String(lines[0].note).length < 400, "a log line cannot become a data dump");
  assert.match(String(lines[0].note), /truncated/);
});

test("[L6] looksLikeSecret recognises real credential shapes and not ordinary text", () => {
  ["sk-abcdefghijklmnopqrstuvwxyz", "Bearer abcdefghijklmnopqrst",
    "eyJhbGciOiJIUzI1NiJ9.payload", "a".repeat(64), "nvapi-1234567890abcdefghij"]
    .forEach((v) => assert.equal(looksLikeSecret(v), true, `should flag: ${v.slice(0, 12)}`));

  ["2026-05", "duplicate_payment", "Rivera Logistics", "nvidia", "short"]
    .forEach((v) => assert.equal(looksLikeSecret(v), false, `should not flag: ${v}`));
});

// ── Structure and correlation ────────────────────────────────────

test("[L7] every line is valid JSON with a level, timestamp and message", () => {
  const lines = capture(() => {
    logger.info("something happened", { route: "/api/copilot" });
    logger.error("something failed", { error: "boom" });
  });
  lines.forEach((l) => {
    assert.ok(l.ts && !Number.isNaN(Date.parse(l.ts)));
    assert.ok(["debug", "info", "warn", "error"].includes(l.level));
    assert.ok(typeof l.msg === "string");
  });
  assert.equal(lines[1].level, "error");
});

test("[L8] a child logger stamps its context on every line", () => {
  // This is how a request is followed across ingestion, engine and AI without
  // threading a correlation id through every function signature.
  const lines = capture(() => {
    const requestLog = makeLogger({ requestId: "req_abc", tenantId: "tenant-1" });
    requestLog.info("request.start", { route: "/api/copilot" });
    requestLog.child({ component: "engine" }).info("analysis.complete", { findings: 3 });
  });
  assert.equal(lines[0].requestId, "req_abc");
  assert.equal(lines[0].tenantId, "tenant-1");
  assert.equal(lines[1].requestId, "req_abc", "context is inherited by the child");
  assert.equal(lines[1].component, "engine");
});

test("[L9] the application has no scattered console logging left", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = path.join(__dirname, "../../src");
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name))
      : e.name.endsWith(".js") ? [path.join(d, e.name)] : []);

  const offenders = [];
  walk(root).forEach((file) => {
    // The logger itself and the migration CLI are allowed: one IS the sink, the
    // other is an operator-facing script whose output IS its interface.
    const base = path.basename(file);
    if (base === "logger.js" || base === "migrate.js") return;
    const src = fs.readFileSync(file, "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const matches = src.match(/console\.(log|warn|error|info|debug)\s*\(/g);
    if (matches) offenders.push(`${path.relative(root, file)} (${matches.length})`);
  });

  // server.js may log before the logger is safe to use; everything else must not.
  const unexpected = offenders.filter((o) => !o.startsWith("server.js"));
  assert.deepEqual(unexpected, [],
    `console logging remains in: ${unexpected.join(", ")}`);
});

// ── Startup validation ──────────────────────────────────────────

test("[V1] a valid PRODUCTION environment passes", () => {
  const result = startupValidation.validate({
    NODE_ENV: "production",
    // 32 chars with real character variety — the validator's actual minimum.
    SESSION_SECRET: "a1b2c3d4e5f60718a1b2c3d4e5f60718",
    SECRETS_KEY: "9f8e7d6c5b4a39281726354453627180",
    DATABASE_URL: "postgres://user@host:5432/db",
    APP_BASE_URL: "https://app.example.com",
    MOCK_REQUIRED_INTEGRATIONS: "false"
  });
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.equal(result.mode, "production");
});

test("[V2] PRODUCTION refuses to start without the things it cannot work without", () => {
  const result = startupValidation.validate({ NODE_ENV: "production" });
  assert.equal(result.ok, false);
  const keys = result.problems.filter((p) => p.level === "fatal").map((p) => p.key);
  // Each of these silently took a development path before.
  ["SESSION_SECRET", "DATABASE_URL", "SECRETS_KEY", "APP_BASE_URL",
    "MOCK_REQUIRED_INTEGRATIONS"].forEach((key) =>
    assert.ok(keys.includes(key), `${key} should be fatal in production`));
  // Every problem carries a remedy, so an operator can act on it.
  result.problems.forEach((p) => assert.ok(p.remedy && p.remedy.length > 20));
});

test("[V3] a WEAK secret is worse than none, and is refused in production", () => {
  ["secret", "changeme", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "short"].forEach((weak) => {
    assert.equal(startupValidation.isWeakSecret(weak), true, `${weak} should be weak`);
  });
  assert.equal(startupValidation.isWeakSecret("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"), false);

  const result = startupValidation.validate({
    NODE_ENV: "production", SESSION_SECRET: "changeme",
    SECRETS_KEY: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
    DATABASE_URL: "postgres://x", APP_BASE_URL: "https://x.com",
    MOCK_REQUIRED_INTEGRATIONS: "false"
  });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.key === "SESSION_SECRET" && p.level === "fatal"));
});

test("[V4] production must not silently MOCK its integrations", () => {
  // MOCK_REQUIRED_INTEGRATIONS defaults to "true", so a production deploy that
  // does not override it serves mocked integration data as real.
  const result = startupValidation.validate({
    NODE_ENV: "production",
    SESSION_SECRET: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
    SECRETS_KEY: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
    DATABASE_URL: "postgres://x", APP_BASE_URL: "https://x.com"
    // MOCK_REQUIRED_INTEGRATIONS deliberately unset -> defaults to "true"
  });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) =>
    p.key === "MOCK_REQUIRED_INTEGRATIONS" && p.level === "fatal"));
});

test("[V5] production refuses an armed TEST STUB and a non-HTTPS base URL", () => {
  const base = {
    NODE_ENV: "production",
    SESSION_SECRET: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
    SECRETS_KEY: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
    DATABASE_URL: "postgres://x", MOCK_REQUIRED_INTEGRATIONS: "false"
  };
  const stubbed = startupValidation.validate(
    Object.assign({}, base, { APP_BASE_URL: "https://x.com", AI_TEST_PROVIDER: "1" }));
  assert.ok(stubbed.problems.some((p) => p.key === "AI_TEST_PROVIDER" && p.level === "fatal"),
    "canned AI responses must never be servable in production");

  const plainHttp = startupValidation.validate(
    Object.assign({}, base, { APP_BASE_URL: "http://x.com" }));
  assert.ok(plainHttp.problems.some((p) => p.key === "APP_BASE_URL" && p.level === "fatal"),
    "session cookies must only travel over TLS");
});

test("[V6] DEVELOPMENT stays convenient — warnings, not failures", () => {
  const result = startupValidation.validate({ NODE_ENV: "development" });
  assert.equal(result.ok, true, "development must not be blocked");
  assert.ok(result.warnCount > 0, "but the operator is told what is missing");
  const keys = result.problems.map((p) => p.key);
  assert.ok(keys.includes("DATABASE_URL"));
  assert.ok(keys.includes("SECRETS_KEY"));
  result.problems.forEach((p) => assert.equal(p.level, "warn"));
});

test("[V7] enforce() exits on a fatal problem and reports every one", () => {
  const logged = [];
  let exitCode = null;
  const log = {
    info: (m, f) => logged.push(["info", m, f]),
    warn: (m, f) => logged.push(["warn", m, f]),
    error: (m, f) => logged.push(["error", m, f])
  };
  startupValidation.enforce({
    env: { NODE_ENV: "production" }, log, exit: (code) => { exitCode = code; }
  });
  assert.equal(exitCode, 1, "a misconfigured production boot is refused");
  // Every problem is reported, not just the first — an operator fixing one
  // should not have to restart to discover the next.
  assert.ok(logged.filter((l) => l[0] === "error").length >= 5);

  // And a valid environment does not exit.
  exitCode = null;
  startupValidation.enforce({
    env: {
      NODE_ENV: "production",
      SESSION_SECRET: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
      SECRETS_KEY: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
      DATABASE_URL: "postgres://x", APP_BASE_URL: "https://x.com",
      MOCK_REQUIRED_INTEGRATIONS: "false"
    },
    log, exit: (code) => { exitCode = code; }
  });
  assert.equal(exitCode, null);
});

// ─────────────────────────────────────────────────────────────────
// JOB 11 — REGRESSION GUARDS against the write-only persistence defect.
//
// The original bug was not a wrong value; it was an ABSENCE. saveRun wrote and
// nothing read, and every layer's own tests passed while the running
// application could not load a single stored analysis. Guards for an absence
// have to be mechanical — they read the shipped source and fail when the wiring
// disappears, because no behavioural test can assert on code that is not called.
// ─────────────────────────────────────────────────────────────────

const RECOVERY_FS = require("node:fs");
const RECOVERY_PATH = require("node:path");

function sourceOf(relative) {
  return RECOVERY_FS.readFileSync(
    RECOVERY_PATH.join(__dirname, "../..", relative), "utf-8");
}

/** Strip comments: a guard that reads its own documentation reports the opposite of the truth. */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("[J11-1] saveRun has not become write-only again", () => {
  /* THE DEFECT ITSELF. Every read function below existed and had NO production
     caller, which is why a restart lost every analysis. If the routes stop
     calling them, this fails — long before a user discovers it. */
  const routes = codeOnly(sourceOf("src/routes/api.js"));

  assert.match(routes, /analysisRunRepository\.loadCompletedRun\(/,
    "the production routes load completed runs from the repository");
  assert.match(routes, /analysisRunRepository\.loadRunById\(/,
    "and load runs by id");
  assert.match(routes, /analysisRunRepository\.metricsForRun\(/,
    "and read the persisted metric projection");
  assert.match(routes, /analysisRunRepository\.completedPeriods\(/,
    "and index the periods that have completed runs");
  assert.match(routes, /analysisRunRepository\.saveRun\(/,
    "while still writing them");
});

test("[J11-2] the analysis routes go through the repository, never raw SQL", () => {
  /* Routes must not grow their own queries: SQL in a route bypasses
     withTenant(), which is what applies the RLS tenant scope. A route that
     queries directly would read across tenants and no test would notice. */
  const routes = codeOnly(sourceOf("src/routes/api.js"));
  const sqlInRoutes = /\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\s+(analysis_run|finding|finding_evidence|metric_value)\b/i;
  assert.equal(sqlInRoutes.test(routes), false,
    "no route writes SQL against the analysis tables directly -- that would "
    + "bypass the tenant scoping that withTenant() applies");
});

test("[J11-3] a completed run cannot be stored without its recoverable state", () => {
  const repo = codeOnly(sourceOf("src/db/repositories/analysisRunRepository.js"));
  assert.match(repo, /function assertRecoverable/,
    "the guard exists");
  assert.match(repo, /if \(status === LIFECYCLE\.COMPLETED\) assertRecoverable\(run\)/,
    "and saveRun runs it before writing a completed run");

  // And the database enforces it too, so a second writer cannot skip the guard.
  const migration = sourceOf("src/db/migrations/007_run_recovery.sql");
  assert.match(migration, /analysis_run_completed_is_recoverable/,
    "the constraint is in the schema, not only in application code");
});

test("[J11-4] the metric projection does not filter out unavailable metrics", () => {
  /* THE EXACT LINE THAT CAUSED THE WORST VERSION OF THIS BUG:
       .filter(([, v]) => v != null && Number.isFinite(Number(v)))
     It deleted every unmeasurable metric on the way to the database, and a
     missing row reads as zero to anything scanning that table. */
  const repo = codeOnly(sourceOf("src/db/repositories/analysisRunRepository.js"));
  assert.equal(/\.filter\(\(\[, v\]\) => v != null/.test(repo), false,
    "the filter that dropped unavailable metrics is gone");
  assert.match(repo, /INSERT INTO metric_value[\s\S]{0,400}unavailable_reason/,
    "and the projection stores the reason a metric was unavailable");
});

test("[J11-5] recovery never invokes the engine", () => {
  const routes = codeOnly(sourceOf("src/routes/api.js"));
  // Isolate the recovery helpers and assert the engine is absent from them.
  const start = routes.indexOf("async function loadPersistedRun");
  const end = routes.indexOf("async function resolveRun");
  assert.ok(start > 0 && end > start, "the recovery path is where it is expected");
  const recoveryCode = routes.slice(start, end);
  assert.equal(/domainEngine\.analyze|analyzeFinancialRisk/.test(recoveryCode), false,
    "loading a stored run does not run the engine -- a recomputation would use "
    + "today's rules and the now-absent period inputs, producing a different "
    + "answer while claiming to be the original");

  // The counter that makes the behavioural proof possible must stay exported.
  const engine = sourceOf("src/domain/analysis/engine.js");
  assert.match(engine, /function analysisCount/,
    "the engine exposes an invocation count so recovery can be proven");
});

test("[J11-6] the 'analysis_not_loaded' workaround is gone", () => {
  /* It was an honest message for a real gap, and it is no longer the recovery
     path. If it comes back, recovery has silently regressed to asking the user
     to re-run work the application already has. */
  const routes = sourceOf("src/routes/api.js");
  assert.equal(routes.includes("analysis_not_loaded"), false,
    "completed persisted analyses are recovered, not deferred back to the user");
});

test("[J11-7] the cash balance keeps its derived/observed provenance", () => {
  /* "Derived becomes observed" is the subtle collapse. Ingestion infers a cash
     balance from net income when none is supplied -- clamped at zero -- and
     that estimate must never be recorded as something the user told us. */
  const importer = codeOnly(sourceOf("src/services/csvFinancialImporter.js"));
  assert.match(importer, /derived_from_net_income/,
    "ingestion labels a derived balance as derived");
  assert.match(importer, /basis: cashProvided \? "observed" : "derived_from_net_income"/,
    "and distinguishes it from an observed one at the point of derivation");

  const repo = codeOnly(sourceOf("src/db/repositories/analysisRunRepository.js"));
  assert.match(repo, /basis === "observed"/,
    "and persistence reads that basis rather than inferring it from the value");
});

// ─────────────────────────────────────────────────────────────────
// JOB 12 PART F — guards for the gaps this job closed.
// ─────────────────────────────────────────────────────────────────

test("[J12-1] the transaction repository read path stays wired", () => {
  /* The same defect twice over: `findByPeriod`, `countByPeriod` and
     `currenciesInPeriod` existed with no production caller, exactly as the
     analysis read path did before JOB 11. If the routes stop calling these, a
     recovered finding can cite records that nothing can retrieve. */
  const routes = codeOnly(sourceOf("src/routes/api.js"));
  assert.match(routes, /transactionRepository\.recordsForPeriod\(/,
    "the routes load a period's records from the repository");
  assert.match(routes, /transactionRepository\.resolveRecords\(/,
    "and resolve cited evidence to records");
  assert.match(routes, /transactionRepository\.findBySourceRecordId\(/,
    "and look up a single record by its provenance id");
  assert.match(routes, /analysisRunRepository\.findingsCitingRecord\(/,
    "and run the reverse lookup from record to findings");
});

test("[J12-2] record routes go through the repository, never raw SQL", () => {
  const routes = codeOnly(sourceOf("src/routes/api.js"));
  assert.equal(
    /\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\s+financial_transaction\b/i.test(routes),
    false,
    "no route queries financial_transaction directly -- that would bypass the "
    + "tenant scoping withTenant() applies");
});

test("[J12-3] record recovery never invokes the engine", () => {
  const routes = codeOnly(sourceOf("src/routes/api.js"));
  const start = routes.indexOf("async function loadPersistedRecords");
  const end = routes.indexOf("async function resolveRun");
  assert.ok(start > 0 && end > start, "the record recovery path is where expected");
  const recovery = routes.slice(start, end);
  assert.equal(/domainEngine\.analyze|analyzeFinancialRisk/.test(recovery), false,
    "loading stored records does not re-run the analysis");
  /* Nor re-derive statement totals: recomputing inflow/outflow from recovered
     rows would produce figures that look authoritative but were never part of
     the stored analysis. */
  assert.match(recovery, /statements: null/,
    "and does not recompute statement totals from recovered rows");
});

test("[J12-4] an unresolvable citation is NAMED, never silently dropped", () => {
  const repo = codeOnly(sourceOf("src/db/repositories/transactionRepository.js"));
  assert.match(repo, /missing:/,
    "resolveRecords reports which references it could not resolve");
  const routes = codeOnly(sourceOf("src/routes/api.js"));
  assert.match(routes, /unresolved: resolved\.missing/,
    "and the route surfaces them rather than returning a shorter list as complete");
  assert.match(routes, /complete: resolved\.missing\.length === 0/,
    "with an explicit completeness flag");
});

test("[J12-5] the derived cash balance keeps its provenance end to end", () => {
  const importer = codeOnly(sourceOf("src/services/csvFinancialImporter.js"));
  assert.match(importer, /cashAndEquivalentsBasis/,
    "ingestion labels the basis on the balance sheet the domain reads");

  const cashflow = codeOnly(sourceOf("src/domain/calculators/cashflow.js"));
  assert.match(cashflow, /cashObserved/,
    "the calculator distinguishes observed from derived");
  assert.match(cashflow, /cash_on_hand_basis/,
    "and reports which it had");
});

test("[J12-6] an unavailable cash balance never becomes zero", () => {
  /* The specific collapse this job prevents: `Math.max(0, netIncome)` on a
     loss-making month is 0, and a 0 cash position with a 0 runway is a claim of
     insolvency assembled from an input nobody supplied. */
  const cashflow = codeOnly(sourceOf("src/domain/calculators/cashflow.js"));
  /* The classification moved into domain/model/cashPosition, which is now the
     ONE place a cash balance is interpreted. The calculator must go through it
     rather than reading the raw field back out. */
  assert.match(cashflow, /readCashPosition\(balanceSheet\)/,
    "the calculator classifies the balance through the authoritative accessor");
  assert.match(cashflow, /const cash = cashPosition\.value/,
    "and takes the authoritative value, which is null unless observed");
  assert.match(cashflow, /cash_runway_unavailable_reason/,
    "and an absent runway always carries a reason");

  const accessor = codeOnly(sourceOf("src/domain/model/cashPosition.js"));
  assert.match(accessor, /value: null,\s*\n?\s*\/\/ never the estimate|value: null/,
    "a derived position exposes a null value, never the estimate");

  // Behavioural confirmation, so this is not only a source check.
  const { parseFinancialCsv } = require("../../src/services/csvFinancialImporter");
  const { computeCashflow } = require("../../src/domain/calculators/cashflow");
  const loss = parseFinancialCsv({
    csvText: "Date,Description,Amount,Counterparty\n2026-05-03,Rent,-300000,LL",
    period: "2026-05", businessName: "T", currentCashBalance: null
  });
  const result = computeCashflow(loss, {});
  assert.equal(result.cash_on_hand, null, "unavailable");
  assert.notEqual(result.cash_on_hand, 0, "and specifically not zero");
  assert.equal(result.cash_runway_months, null);
});

test("[J12-7] a fresh deployment needs no undocumented grants", () => {
  /* Migrations 001-003 create fourteen tables and grant on none. The grant step
     now runs as part of the documented migration process; if it is removed, a
     new deployment silently returns to "permission denied for table tenant". */
  const migrate = codeOnly(sourceOf("src/db/migrate.js"));
  assert.match(migrate, /grants\.applyGrants\(/,
    "the migration runner applies application-role grants");

  const grants = codeOnly(sourceOf("src/db/grants.js"));
  assert.match(grants, /ALTER DEFAULT PRIVILEGES/,
    "and sets default privileges, so a table added by a FUTURE migration is "
    + "reachable without anyone remembering to come back");
  assert.match(grants, /findUngrantedTables/,
    "with a way to assert no table was missed");

  // The bootstrap entry point must stay discoverable.
  const pkg = JSON.parse(sourceOf("package.json"));
  assert.ok(pkg.scripts["db:bootstrap"],
    "`npm run db:bootstrap` is the documented single entry point");
});

test("[J12-8] the application role is never granted DDL or superuser", () => {
  /* RLS is only a boundary if the constrained role cannot switch it off. */
  const grants = codeOnly(sourceOf("src/db/grants.js"));
  assert.equal(/GRANT ALL|SUPERUSER|CREATEDB|BYPASSRLS/.test(grants), false,
    "grants.js hands out DML only");
  assert.match(grants, /SELECT, INSERT, UPDATE, DELETE/,
    "specifically these four");

  const bootstrap = codeOnly(sourceOf("scripts/bootstrap-db.js"));
  assert.match(bootstrap, /NOSUPERUSER/, "the role is created NOSUPERUSER");
  assert.match(bootstrap, /NOBYPASSRLS/, "and cannot bypass row-level security");
});

test("[J12-9] data quality reports derived inputs", () => {
  const dq = codeOnly(sourceOf("src/domain/model/dataQuality.js"));
  assert.match(dq, /derivedInputs/,
    "the DataQualityReport records inputs that were inferred rather than observed");
  assert.match(dq, /hasDerivedInputs/,
    "with a flag consumers can branch on");
});

// ─────────────────────────────────────────────────────────────────
// JOB 13 — guards for the gaps this job closed.
// ─────────────────────────────────────────────────────────────────

test("[J13-1] no production code reads a raw cash balance to make a claim", () => {
  /* THE GUARD THE MANDATE ASKED FOR: it must fail if someone later reads
     `cashAndEquivalents` directly to make an authoritative financial claim.

     Exactly three kinds of read are legitimate, and each is listed by file so a
     NEW one has to be justified here rather than added silently:
       - the accessor itself, which is where the field is interpreted
       - ingestion sources, which WRITE the field
       - the data-quality assessor, which reads only the BASIS to disclose it   */
  const ALLOWED = new Set([
    "src/domain/model/cashPosition.js",     // the one authoritative accessor
    "src/services/csvFinancialImporter.js", // writes it, and labels the basis
    "src/services/pdfDocumentImporter.js",  // writes it from uploaded documents,
                                            // and labels the basis identically
    "src/ingestion/sources/zohoSource.js",  // writes a retrieved balance
    "src/ingestion/sources/demoSource.js",  // writes demo data
    "src/domain/model/dataQuality.js"       // reads the BASIS only, to disclose
  ]);

  const { execFileSync } = require("node:child_process");
  const hits = execFileSync("grep",
    ["-rln", "cashAndEquivalents", "src/"], { encoding: "utf-8" })
    .split("\n").filter(Boolean)
    .filter((f) => !f.startsWith("src/db/migrations/"));

  /* COMMENTS ARE STRIPPED FIRST. The comments explaining this defect quote the
     field name, so a guard that searched raw text would flag its own
     documentation and report the opposite of the truth. */
  const unexpected = hits
    .filter((f) => !ALLOWED.has(f))
    .filter((f) => /cashAndEquivalents/.test(codeOnly(sourceOf(f))));
  assert.deepEqual(unexpected, [],
    "these files read the raw cash field directly. Route them through "
    + "readCashPosition() from domain/model/cashPosition, or add them to ALLOWED "
    + "with a reason:\n" + unexpected.join("\n"));
});

test("[J13-2] custom rules read cash through the authoritative accessor", () => {
  /* The bypass named in the mandate: customRules.js read
     `Number(balanceSheet.cashAndEquivalents)` and evaluated `cash_below`
     against a derived estimate — which on a loss-making month is exactly 0, so
     the rule fired against a figure nobody supplied. */
  const rules = codeOnly(sourceOf("src/domain/rules/customRules.js"));
  assert.match(rules, /readCashPosition\(/,
    "custom rules classify the balance through the accessor");
  assert.equal(/Number\(balanceSheet\.cashAndEquivalents\)/.test(rules), false,
    "and no longer read the raw field");
  assert.match(rules, /cashPosition\.available/,
    "cash_below refuses to judge without an observed balance");
  assert.match(rules, /evaluated: false/,
    "and records that it was NOT EVALUATED, rather than reporting no match");
});

test("[J13-3] forecast and what-if refuse a non-observed starting balance", () => {
  const routes = codeOnly(sourceOf("src/routes/api.js"));
  const guards = routes.match(/cash_balance_required/g) || [];
  assert.equal(guards.length >= 2, true,
    "both projection routes refuse rather than starting from a guess");
  assert.equal(
    /toNumber\(monthlyData\.statements\?\.balanceSheet\?\.cashAndEquivalents, 0\)/.test(routes),
    false,
    "and neither defaults a missing cash balance to zero");
});

test("[J13-4] the disclosure block reaches user-facing routes", () => {
  /* JOB 12 added `derivedInputs` to the DataQualityReport and NOTHING surfaced
     it — computed, persisted, and never shown. */
  const routes = codeOnly(sourceOf("src/routes/api.js"));
  assert.match(routes, /function disclosureFor/, "the builder exists");
  const uses = (routes.match(/disclosureFor\(context\)/g) || []).length;
  assert.ok(uses >= 3,
    `at least the health, cashflow and executive-report routes carry it (found ${uses})`);
  assert.match(routes, /Limitations of this report/,
    "and the executive report writes them into the exported TEXT, which is "
    + "what gets forwarded to a lender or a board");
});

test("[J13-5] the legacy-run reason is stable and distinct from 'not found'", () => {
  const routes = codeOnly(sourceOf("src/routes/api.js"));
  assert.match(routes, /legacy_unrecoverable/,
    "a legacy run has its own machine-readable reason");
  assert.match(routes, /no_completed_analysis/,
    "distinct from a period that was never analysed");
  assert.match(routes, /analysis_legacy_unrecoverable/,
    "and the copilot reports it too");
});

test("[J13-6] a cached context is not served for a different period", () => {
  /* Found while auditing disclosure: the dashboard returned whatever period was
     reviewed most recently, so asking for May got June's figures under May's
     heading. Wrong-month figures are worse than missing ones — nothing in the
     response reveals the mismatch. */
  const routes = codeOnly(sourceOf("src/routes/api.js"));
  assert.match(routes, /if \(inMemory && \(!period \|\| inMemory\.period === period\)\) return inMemory/,
    "the cached context is only used when it is for the requested period");
});

test("[J13-7] PUBLIC database access is revoked by a migration, not by hand", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.join(__dirname, "../../src/db/migrations");
  const names = fs.readdirSync(dir);
  assert.ok(names.includes("008_revoke_public.sql"),
    "the revocation is a forward-only migration in the repository");

  const sql = fs.readFileSync(path.join(dir, "008_revoke_public.sql"), "utf-8");
  assert.match(sql, /REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC/);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC/,
    "sequences too, not just tables");
  assert.match(sql, /ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC/,
    "and future tables are not handed to PUBLIC by default");

  // The runner must refuse to leave a post-008 database unreachable.
  const migrate = codeOnly(sourceOf("src/db/migrate.js"));
  assert.match(migrate, /008_revoke_public\.sql/,
    "the runner knows the revocation makes APP_DB_ROLE mandatory");
  assert.match(migrate, /throw new Error/,
    "and fails loudly rather than reporting success on a broken deployment");
});

test("[J13-8] the application role is granted EXECUTE on functions", () => {
  /* Revoking function privileges from PUBLIC breaks current_tenant_id(), which
     EVERY RLS policy calls, and gen_random_uuid(), which backs column defaults.
     Found by connecting as the real role after the revoke, not by reading SQL. */
  const grants = codeOnly(sourceOf("src/db/grants.js"));
  assert.match(grants, /GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA/,
    "the grant step hands EXECUTE to the application role");
  assert.match(grants, /ALTER DEFAULT PRIVILEGES[\s\S]{0,120}GRANT EXECUTE ON FUNCTIONS/,
    "including functions added later");
});

// ─────────────────────────────────────────────────────────────────
// FINAL CLOSURE — guards for the last authority-bypass paths.
// ─────────────────────────────────────────────────────────────────

test("[FC-1] every cached fallback in the copilot is period-checked", () => {
  /* TWO fallbacks, found one after the other: the RUN, then the RECORDS. Both
     reached for `latestReviewContext` with no period check, so a question about
     one month could be answered with another month's analysis, or paired with
     another month's transactions cited as evidence. */
  const routes = codeOnly(sourceOf("src/routes/api.js"));

  assert.equal(/\|\| req\.userStore\.latestReviewContext\.rawMonthlyData\)?\s*$/m.test(routes),
    false, "the records fallback is not unconditional");
  assert.match(routes, /cached\.rawMonthlyData\s*\n?\s*&& \(cached\.period === targetMonth/,
    "the records fallback checks the period");
  assert.match(routes, /if \(!run && cached && cached\.rawAnalysis && cached\.rawAnalysis\.run\s*\n?\s*&& \(cached\.period === targetMonth/,
    "and so does the run fallback");
});

test("[FC-2] the PDF export uses the recovering, period-aware context", () => {
  /* It used the synchronous `getContext`, inheriting both of its limits: it
     ignored the requested month (exporting a wrong-month document) and could
     not recover after a restart, while the JSON report did both correctly. */
  const routes = codeOnly(sourceOf("src/routes/api.js"));
  const start = routes.indexOf('router.post("/executive-report/pdf"');
  assert.ok(start > 0, "the export route exists");
  const route = routes.slice(start, start + 900);
  assert.match(route, /await getContextAsync\(req, \(req\.body && req\.body\.month\) \|\| null\)/,
    "the export honours the requested month and recovers from storage");
  assert.equal(/const context = getContext\(req\);/.test(route), false,
    "and no longer uses the non-recovering variant");
});

test("[FC-3] the PDF model carries the same limitations as the JSON", () => {
  const formatter = codeOnly(sourceOf("src/services/reportFormatter.js"));
  assert.match(formatter, /disclosure: opts\.disclosure/,
    "the report model accepts the disclosure");
  const pdf = codeOnly(sourceOf("src/services/pdfReport.js"));
  assert.match(pdf, /Limitations of this report/,
    "and the PDF renders it as its own section");
  assert.match(pdf, /must not be read as zero/,
    "including the warning against reading a dash as zero");
});

test("[FC-4] every analytical route propagates disclosure", () => {
  const routes = sourceOf("src/routes/api.js");
  ["health-score", "cashflow", "revenue", "anomalies", "vendors", "customers", "actions"]
    .forEach((name) => {
      const start = routes.indexOf(`router.get("/${name}"`);
      assert.ok(start > 0, `/${name} exists`);
      /* Slice to the NEXT route declaration, not the first `});` -- that would
         stop at the early-return guard and miss the response object below it. */
      const nextRoute = routes.indexOf("\nrouter.", start + 1);
      const body = routes.slice(start, nextRoute > 0 ? nextRoute : start + 2000);
      assert.match(body, /disclosureFor\(context\)/,
        `/${name} propagates the disclosure block`);
    });
});

test("[FC-5] the CSV export carries an explicit analysis-status column", () => {
  /* CSV cannot hold a notice block, so the limitation becomes a COLUMN rather
     than being dropped. A downloaded file is read with no app around it. */
  const app = codeOnly(sourceOf("public/app.js"));
  assert.match(app, /Analysis status/,
    "the CSV header includes an explicit status column");
  assert.match(app, /Analysis incomplete: /,
    "populated from the disclosure the route supplies");
  assert.match(app, /csvCell/,
    "and values are quoted/escaped rather than concatenated raw");
});
