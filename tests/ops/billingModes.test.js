// BILLING MODES — production fails closed.
//
// THE PROPERTY UNDER TEST, and why it is worth its own file:
//
//   In production, if the credit ledger is unavailable, the AI provider is
//   NEVER CALLED.
//
// JOB 9 left billing falling back to an in-process path whenever PostgreSQL was
// unavailable. On one instance that is harmless. On two it is not: both fall
// back, both hold their own copy of the balance, and a tenant spends credits
// they do not have — on a provider account we are billed for.
//
// The test that matters is not "does the charge fail" but "was the provider
// spared". A charge that fails AFTER the model has answered has already cost us
// the tokens.

const test = require("node:test");
const assert = require("node:assert/strict");

const billing = require("../../src/ai/billing");
const orchestrator = require("../../src/ai/orchestrator");
const copilot = require("../../src/ai/copilot/copilot");
const copilotStore = require("../../src/ai/copilot/store");
const legacy = require("../../src/services/aiAnalysisClient");
const engine = require("../../src/domain/analysis/engine");
const { scenarios } = require("../helpers/fixtures");

const NOW = Date.parse("2026-06-15T00:00:00Z");
const CONFIG = { enableAiAnalysis: true, nvidiaApiKey: "managed-key" };

function currentPeriod() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
const profile = (extra = {}) => Object.assign(
  { plan: "starter", credits: 1000, creditsPeriod: currentPeriod(), aiAssistant: "controller-core" },
  extra);

const run = () => engine.analyze(scenarios.duplicatePayment,
  { tenantId: "t1", period: "2026-05", now: NOW });

/** Run a block with NODE_ENV / DATABASE_URL set, restoring them afterwards. */
async function withEnv(env, fn) {
  const saved = {};
  Object.keys(env).forEach((k) => { saved[k] = process.env[k]; });
  Object.entries(env).forEach(([k, v]) => {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
  try { return await fn(); } finally {
    Object.entries(saved).forEach(([k, v]) => {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    });
  }
}

/** Count provider calls, so "was the provider spared?" is directly observable. */
function countingProvider(response) {
  const original = legacy.callProvider;
  const state = { calls: 0 };
  legacy.callProvider = async (args) => {
    state.calls += 1;
    return response || { ok: true, provider: args.provider, model: "stub", text: "{}" };
  };
  state.restore = () => { legacy.callProvider = original; };
  return state;
}

// ── Mode detection ───────────────────────────────────────────────

test("[B1] the mode is explicit, and derived from NODE_ENV", async () => {
  await withEnv({ NODE_ENV: "production" }, () => {
    assert.equal(billing.mode(), "production");
    assert.equal(billing.isProduction(), true);
  });
  await withEnv({ NODE_ENV: "development" }, () => {
    assert.equal(billing.mode(), "development");
    assert.equal(billing.isProduction(), false);
  });
});

// ── PRODUCTION: fail closed ──────────────────────────────────────

test("[B2] PRODUCTION with no ledger refuses the charge before any work", async () => {
  await withEnv({ NODE_ENV: "production", DATABASE_URL: undefined }, () => {
    const check = billing.preflight({
      tenantId: "t1", profile: profile(), operation: "chat"
    });
    assert.equal(check.ok, false);
    assert.equal(check.reason, billing.REASON.BILLING_UNAVAILABLE);
    assert.equal(check.mode, "production");
    // The user-facing message is honest about scope: analysis is unaffected.
    assert.match(check.message, /billing is temporarily unavailable/i);
    assert.match(check.message, /analysis is unaffected/i);
  });
});

test("[B3] PRODUCTION + no ledger: the AI PROVIDER IS NEVER CALLED", async () => {
  // The assertion this whole file exists for.
  await withEnv({ NODE_ENV: "production", DATABASE_URL: undefined }, async () => {
    const provider = countingProvider();
    try {
      const result = await orchestrator.ask({
        run: run(), tenantId: "t1", profile: profile(), config: CONFIG,
        message: "how is my cash flow?", operation: "chat"
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, billing.REASON.BILLING_UNAVAILABLE);
      assert.equal(provider.calls, 0,
        "a billing outage must not cost provider tokens to discover");
    } finally { provider.restore(); }
  });
});

test("[B4] PRODUCTION + no ledger: the COPILOT also spares the provider", async () => {
  await withEnv({ NODE_ENV: "production", DATABASE_URL: undefined }, async () => {
    const provider = countingProvider();
    try {
      const result = await copilot.ask({
        run: run(), tenantId: "t1", profile: profile(), config: CONFIG,
        message: "what needs attention?", store: copilotStore.createStore(null),
        operation: "chat"
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, billing.REASON.BILLING_UNAVAILABLE);
      assert.equal(provider.calls, 0, "both AI entry points fail closed");
    } finally { provider.restore(); }
  });
});

test("[B5] PRODUCTION with no TENANT refuses too — an unattributable charge is "
  + "not a charge", async () => {
  await withEnv({ NODE_ENV: "production", DATABASE_URL: "postgres://unused" }, () => {
    const check = billing.preflight({
      tenantId: null, profile: profile(), operation: "chat"
    });
    assert.equal(check.ok, false);
    assert.equal(check.reason, billing.REASON.NO_TENANT);
  });
});

test("[B6] charge() itself refuses in production even if preflight were bypassed", async () => {
  // A hard stop, so a future caller cannot reach the in-process path directly.
  await withEnv({ NODE_ENV: "production", DATABASE_URL: undefined }, async () => {
    const result = await billing.charge({
      tenantId: "t1", profile: profile(), operation: "chat"
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, billing.REASON.BILLING_UNAVAILABLE);
  });
});

// ── DEVELOPMENT: permitted, and honest about itself ──────────────

test("[B7] DEVELOPMENT may operate without a ledger, and says it is NOT atomic",
  async () => {
    await withEnv({ NODE_ENV: "development", DATABASE_URL: undefined }, async () => {
      const check = billing.preflight({
        tenantId: "t1", profile: profile(), operation: "chat"
      });
      assert.equal(check.ok, true, "development stays convenient");
      assert.equal(check.atomic, false, "but never claims atomicity it does not have");
      assert.match(check.note, /NOT atomic across instances/i);

      const p = profile();
      const before = p.credits;
      const charged = await billing.charge({
        tenantId: "t1", profile: p, operation: "chat"
      });
      assert.equal(charged.ok, true);
      assert.equal(charged.atomic, false, "the caller can see which path ran");
      assert.ok(p.credits < before, "and it does deduct");
    });
  });

test("[B8] DEVELOPMENT still calls the provider, so local work is unblocked", async () => {
  await withEnv({ NODE_ENV: "development", DATABASE_URL: undefined }, async () => {
    const provider = countingProvider({
      ok: true, provider: "nvidia", model: "stub",
      text: "Two payments of 48,500 were flagged as a possible duplicate."
    });
    try {
      const result = await orchestrator.ask({
        run: run(), tenantId: "t1", profile: profile(), config: CONFIG,
        message: "what was flagged?", operation: "chat"
      });
      assert.equal(provider.calls, 1, "development is not blocked by the absent ledger");
      assert.equal(result.ok, true, JSON.stringify(result.validation || result.reason));
    } finally { provider.restore(); }
  });
});

// ── BYOK is unaffected by a billing outage ──────────────────────

test("[B9] BYOK is unmetered, so a ledger outage does not stop it", async () => {
  await withEnv({ NODE_ENV: "production", DATABASE_URL: undefined }, async () => {
    const byok = profile({ plan: "custom", aiProvider: "anthropic", aiApiKey: "tenant-key" });
    const check = billing.preflight({ tenantId: "t1", profile: byok, operation: "chat" });
    // A BYOK tenant is billed by their own provider, so our ledger is
    // irrelevant to them and must not gate their access.
    assert.equal(check.ok, true);
    assert.equal(check.reason, billing.REASON.BYOK_UNMETERED);

    const charged = await billing.charge({ tenantId: "t1", profile: byok, operation: "chat" });
    assert.equal(charged.ok, true);
    assert.equal(charged.cost, 0, "never metered");
  });
});

// ── Exactly one production charging path ────────────────────────

test("[B10] there is exactly ONE production charging path, and nothing bypasses it", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = path.join(__dirname, "../../src");
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name))
      : e.name.endsWith(".js") ? [path.join(d, e.name)] : []);

  const offenders = [];
  walk(root).forEach((file) => {
    const rel = path.relative(root, file);
    // billing.js IS the path; creditRepository is the ledger it drives.
    if (rel === "ai/billing.js" || rel === "db/repositories/creditRepository.js") return;
    const src = fs.readFileSync(file, "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    if (/entitlements\.charge\s*\(/.test(src)) offenders.push(rel);
    if (/creditRepository\.consume\s*\(/.test(src)) offenders.push(rel);
  });

  assert.deepEqual(offenders, [],
    `these modules charge credits outside src/ai/billing.js: ${offenders.join(", ")}`);
});

test("[B11] every AI route reaches the provider only through the orchestrator "
  + "or the copilot", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const api = fs.readFileSync(path.join(__dirname, "../../src/routes/api.js"), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  // A route calling a provider directly would skip preflight, validation and audit.
  assert.equal(/callProvider\s*\(/.test(api), false, "a route calls a provider directly");
  assert.equal(/adapter\.complete\s*\(/.test(api), false, "a route calls the adapter directly");
  // And the two sanctioned entry points are present.
  assert.match(api, /aiOrchestrator\.(ask|interpret)\s*\(/);
  assert.match(api, /copilot\.ask\s*\(/);
});

// ─────────────────────────────────────────────────────────────────
// FINAL CLOSURE PHASE 4 — a charge failure must say WHICH failure.
// ─────────────────────────────────────────────────────────────────

test("[B-MSG] each charge-failure reason gets its own honest sentence", () => {
  /* THE DEFECT. Every failure from billing.charge() produced the one sentence
     "This action costs more credits than the balance allows." A billing OUTAGE
     on our side therefore told the user they were out of credits -- sending
     them to buy something they did not need, and hiding our own outage from us.
     A workspace that was simply not provisioned got the same wrong story. */
  // fs/path are required per-test in this file, matching its existing style.
  const fs = require("node:fs");
  const path = require("node:path");
  const copilotSource = fs.readFileSync(
    path.join(__dirname, "../../src/ai/copilot/copilot.js"), "utf-8");

  assert.match(copilotSource, /function chargeFailureText/,
    "the message is chosen per reason, not hardcoded at the call site");

  // Each reason must be handled distinctly.
  ["INSUFFICIENT_CREDITS", "BILLING_UNAVAILABLE", "NO_TENANT"].forEach((reason) => {
    assert.match(copilotSource, new RegExp(`REASON\\.${reason}`),
      `${reason} has its own branch`);
  });

  // The out-of-credits path must name a way forward -- on a metered product a
  // dead end is a defect, not a neutral outcome.
  assert.match(copilotSource, /upgrade_path/,
    "the exhaustion response carries an upgrade path");

  /* And it must NOT still be reporting insufficient credits for an outage.
     Comments are stripped first: the comment explaining this defect quotes the
     old wording, and a guard that reads its own documentation as code reports
     the opposite of the truth. */
  const code = copilotSource
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  const badPattern = /failure\(result\.reason,\s*\n?\s*"This action costs more credits/;
  assert.equal(badPattern.test(code), false,
    "the one-size-fits-all message is gone from the code path");
});
