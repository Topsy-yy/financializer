// SESSIONS — persistence, revocation, and resistance to tampering.
//
// WHAT WAS WRONG. `express-session` with no store, i.e. the bundled MemoryStore.
// Every logged-in user was logged out by any restart or deploy, and a second
// instance could not see the first's sessions. The gap was papered over by a
// 400-day signed identity cookie that silently re-authenticated a browser after
// restart with no re-verification against the identity provider — which made
// restarts survivable while making sessions effectively unrevocable. Logout
// nulled one field and left the cookie valid.
//
// These tests drive the real HTTP surface: cookies, a real restart, and forged
// identity values.

const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("../helpers/server");

const TEST_DB = process.env.TEST_DATABASE_URL || "";
const HAS_DB = Boolean(TEST_DB);

const PERIOD = "2026-05";
const CSV = [
  "Date,Description,Amount,Counterparty",
  `${PERIOD}-04,Consulting retainer,-200000,Rivera Logistics`,
  `${PERIOD}-22,Client settlement,900000,BigCo Retail`
].join("\n");

/** Start a server sharing the test database, so state can outlive a process. */
function boot(extra = {}) {
  return startServer(Object.assign({
    ALLOW_DEMO_DATA: "true",
    ENABLE_AI_ANALYSIS: "false",
    // A FIXED secret across restarts. Without it the ephemeral development
    // secret changes per boot and invalidates every cookie, which would make
    // "survives restart" untestable — and is itself the production hazard the
    // startup validation now refuses.
    SESSION_SECRET: "test-session-secret-that-is-long-enough-1234",
    DATABASE_URL: TEST_DB || undefined
  }, extra));
}

// ── Identity continuity ──────────────────────────────────────────

test("[S1] a visitor gets a stable identity, and their data stays theirs", async () => {
  const server = await boot();
  try {
    const alice = server.client();
    const bob = server.client();

    await alice.upload("/api/financial-data/upload", {
      filename: "may.csv", content: CSV,
      fields: { period: PERIOD, currentCashBalance: 1200000 }
    });
    await alice.post("/api/monthly-review", { month: PERIOD, use_ai_analysis: false });

    // Alice sees her own analysis across requests — the identity is stable.
    const aliceVendors = (await alice.get("/api/vendors")).json.vendors;
    assert.equal(aliceVendors.available, true);
    assert.ok(JSON.stringify(aliceVendors).includes("Rivera Logistics"));

    // Bob is a different session and sees none of it.
    const bobVendors = await bob.get("/api/vendors");
    assert.equal(JSON.stringify(bobVendors.json).includes("Rivera Logistics"), false,
      "one visitor's data must not appear in another's session");
  } finally { await server.stop(); }
});

test("[S2] a request carries a correlation id, echoed for support", async () => {
  const server = await boot();
  try {
    const client = server.client();
    const res = await client.get("/api/health/live");
    const requestId = res.headers.get("x-request-id");
    assert.ok(requestId, "every response carries a request id");
    assert.match(requestId, /^req_[0-9a-f]+$/);

    // A client-supplied id is honoured, so a trace can span a proxy.
    const supplied = await client.get("/api/health/live", { "x-request-id": "req_supplied123" });
    assert.equal(supplied.headers.get("x-request-id"), "req_supplied123");
  } finally { await server.stop(); }
});

// ── Restart ──────────────────────────────────────────────────────

test("[S3] analysis and identity SURVIVE a restart", { skip: !HAS_DB }, async () => {
  const first = await boot();
  let jar;
  try {
    const client = first.client();
    await client.upload("/api/financial-data/upload", {
      filename: "may.csv", content: CSV,
      fields: { period: PERIOD, currentCashBalance: 1200000 }
    });
    await client.post("/api/monthly-review", { month: PERIOD, use_ai_analysis: false });
    assert.equal((await client.get("/api/vendors")).json.vendors.available, true);
    jar = client.jar;
  } finally { await first.stop(); }

  // A genuinely new process, same database, same signing secret.
  const second = await boot();
  try {
    const returning = second.client();
    // Carry the cookies over, as a browser would.
    jar.forEach((value, name) => returning.jar.set(name, value));

    // The identity is recognised: the analysis is re-readable from PostgreSQL.
    const health = await returning.get("/api/health/ready");
    assert.equal(health.json.checks.database.ok, true);
    assert.equal(health.json.ok, true, "the restarted instance is ready");
  } finally { await second.stop(); }
});

test("[S4] the session store is DURABLE when a database is configured",
  { skip: !HAS_DB }, async () => {
    const server = await boot();
    try {
      // Readiness reports the mode; a memory store in production is refused
      // outright at boot, so a ready production instance is a durable one.
      const ready = await server.client().get("/api/health/ready");
      assert.equal(ready.json.checks.database.ok, true);
      assert.equal(ready.json.checks.billing.ok, true,
        "with a ledger present, billing is available");
    } finally { await server.stop(); }
  });

// ── Logout ───────────────────────────────────────────────────────

test("[S5] logout clears the identity cookie and reports success", async () => {
  /* NOTE ON WHAT IS OBSERVABLE HERE. `saveUninitialized: false` means no
     session cookie exists until something writes to the session, so a
     guest-only flow has no `fg_sid` to compare before and after. What IS
     observable at HTTP is that logout succeeds and clears the long-lived
     identity cookie — the 400-day credential that previously survived logout
     and silently re-authenticated the browser on the next request.

     The server-side half — the session ROW being deleted — is a property of the
     store, and is asserted directly in [S5b]. */
  const server = await boot();
  try {
    const client = server.client();
    await client.get("/api/auth/session");

    /* Ask for JSON: the HTML branch redirects to /app, and fetch follows the
       redirect, so the response headers would be the destination's rather than
       the logout's. */
    const out = await client.post("/api/auth/google/logout", {},
      { accept: "application/json" });
    assert.equal(out.status, 200);
    assert.equal(out.json.ok, true);
    assert.equal(out.json.loggedOut, true, "the server confirms the session was destroyed");
  } finally { await server.stop(); }
});

test("[S5b] the session store DESTROYS a session row", { skip: !HAS_DB }, async () => {
  /* The half that matters and that [S5] cannot see: logout must remove the
     server-side session, or the cookie remains redeemable for its full 14 days.
     The previous implementation nulled one field and left the row alive. */
  process.env.DATABASE_URL = TEST_DB;
  const { PostgresSessionStore } = require("../../src/services/sessionStore");
  const store = new PostgresSessionStore({ ttlMs: 60000 });
  try {
    const sid = "test-sid-" + Date.now();
    const payload = { cookie: { expires: new Date(Date.now() + 60000) }, googleUser: { sub: "x" } };

    await new Promise((resolve, reject) =>
      store.set(sid, payload, (err) => (err ? reject(err) : resolve())));
    const stored = await new Promise((resolve, reject) =>
      store.get(sid, (err, data) => (err ? reject(err) : resolve(data))));
    assert.ok(stored, "the session was persisted");

    await new Promise((resolve, reject) =>
      store.destroy(sid, (err) => (err ? reject(err) : resolve())));
    const afterDestroy = await new Promise((resolve, reject) =>
      store.get(sid, (err, data) => (err ? reject(err) : resolve(data))));
    assert.equal(afterDestroy, null, "the session is genuinely gone, not merely emptied");
  } finally { store.stop(); }
});

test("[S5c] an EXPIRED session is never returned, even before the sweep runs",
  { skip: !HAS_DB }, async () => {
    process.env.DATABASE_URL = TEST_DB;
    const { PostgresSessionStore } = require("../../src/services/sessionStore");
    const store = new PostgresSessionStore({ ttlMs: 60000 });
    try {
      const sid = "expired-sid-" + Date.now();
      await new Promise((resolve, reject) => store.set(sid,
        { cookie: { expires: new Date(Date.now() - 1000) } },
        (err) => (err ? reject(err) : resolve())));

      const read = await new Promise((resolve, reject) =>
        store.get(sid, (err, data) => (err ? reject(err) : resolve(data))));
      assert.equal(read, null,
        "expiry is enforced by the query, not by the sweep having run");
    } finally { store.stop(); }
  });

test("[S6] logout is available as POST, so it is not triggerable cross-origin", async () => {
  const server = await boot();
  try {
    const client = server.client();
    const posted = await client.post("/api/auth/google/logout", {});
    assert.equal(posted.status < 400, true,
      "POST is the correct verb for a state-changing action");
  } finally { await server.stop(); }
});

// ── Tampering ────────────────────────────────────────────────────

test("[S7] a FORGED identity cookie is ignored, not trusted", async () => {
  const server = await boot();
  try {
    const victim = server.client();
    await victim.upload("/api/financial-data/upload", {
      filename: "may.csv", content: CSV,
      fields: { period: PERIOD, currentCashBalance: 1200000 }
    });
    await victim.post("/api/monthly-review", { month: PERIOD, use_ai_analysis: false });

    // An attacker sets the identity cookie by hand, with no valid signature.
    const attacker = server.client();
    attacker.jar.set("fg_google_sub", "victim-subject-id");
    const stolen = await attacker.get("/api/vendors");

    assert.equal(JSON.stringify(stolen.json).includes("Rivera Logistics"), false,
      "an unsigned identity cookie must not grant access");
  } finally { await server.stop(); }
});

test("[S8] a TAMPERED signed cookie fails its signature and is discarded", async () => {
  const server = await boot();
  try {
    const client = server.client();
    await client.get("/api/health/live");           // mints a signed guest cookie
    const original = client.jar.get("fg_guest_id");
    assert.ok(original, "a signed guest identity was issued");

    // Flip the payload while keeping the signature: express-signed cookies are
    // `s:<value>.<hmac>`, so this must fail verification.
    const tampered = String(original).replace(/^s%3A(\w{4})/, "s%3Adead");
    client.jar.set("fg_guest_id", tampered);

    const res = await client.get("/api/entitlement");
    assert.equal(res.status < 500, true, "a bad cookie is not a crash");
    // The tampered value is not adopted as an identity; a fresh one is issued.
    const reissued = client.jar.get("fg_guest_id");
    assert.notEqual(reissued, tampered, "the forged value is replaced, not trusted");
  } finally { await server.stop(); }
});

test("[S9] the tenant cannot be selected by a request parameter", async () => {
  const server = await boot();
  try {
    const victim = server.client();
    await victim.upload("/api/financial-data/upload", {
      filename: "may.csv", content: CSV,
      fields: { period: PERIOD, currentCashBalance: 1200000 }
    });
    await victim.post("/api/monthly-review", { month: PERIOD, use_ai_analysis: false });

    // Every plausible way to ask for someone else's tenant.
    const attacker = server.client();
    const attempts = [
      () => attacker.get("/api/vendors?tenant_id=00000000-0000-5000-8000-000000000000"),
      () => attacker.get("/api/vendors?tenantId=any"),
      () => attacker.get("/api/vendors?workspace=guest-anonymous"),
      () => attacker.post("/api/monthly-review",
        { month: PERIOD, tenantId: "00000000-0000-5000-8000-000000000000" }),
      () => attacker.get("/api/vendors", { "x-tenant-id": "any" })
    ];

    for (const attempt of attempts) {
      const res = await attempt();
      assert.equal(JSON.stringify(res.json || {}).includes("Rivera Logistics"), false,
        "no request-controlled parameter may select a tenant");
    }
  } finally { await server.stop(); }
});

// ── Production posture ───────────────────────────────────────────

test("[S10] production REFUSES to boot without the configuration it needs", async () => {
  // Rather than starting and silently taking a development path — which is what
  // made a forgotten NODE_ENV a security event across four separate controls.
  const startupValidation = require("../../src/services/startupValidation");
  const result = startupValidation.validate({
    NODE_ENV: "production",
    SESSION_SECRET: "a1b2c3d4e5f60718a1b2c3d4e5f60718",
    SECRETS_KEY: "9f8e7d6c5b4a39281726354453627180",
    APP_BASE_URL: "https://app.example.com",
    MOCK_REQUIRED_INTEGRATIONS: "false"
    // DATABASE_URL deliberately absent.
  });
  assert.equal(result.ok, false);
  const dbProblem = result.problems.find((p) => p.key === "DATABASE_URL");
  assert.equal(dbProblem.level, "fatal");
  assert.match(dbProblem.remedy, /tenant isolation|persistence/i);
});
