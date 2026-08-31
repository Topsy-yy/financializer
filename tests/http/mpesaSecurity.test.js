// M-PESA CALLBACK SECURITY CONTRACT.
//
// Daraja does not sign its callbacks. Anyone who can reach the webhook URL can
// POST a body claiming a payment succeeded, and there is no signature to reject
// it with. That is a real property of the provider, not an oversight, and it
// makes this file the place where the M-Pesa path either holds or does not.
//
// WHAT ACTUALLY STANDS BETWEEN A FORGED CALLBACK AND A FREE SUBSCRIPTION:
//
//   CORRELATION       the reference must be one WE issued at checkout
//   PENDING ONLY      only a pending payment can settle; a replay is a no-op
//   R5 VERIFICATION   Safaricom is re-queried over a connection we open
//   OUR OWN AMOUNT    the charge comes from our row, never from the callback
//   ATOMIC + UNIQUE   one transaction, one activation, under a row lock
//
// These run IN PROCESS rather than against a spawned server, because the point
// is to control what Safaricom says. `global.fetch` is stubbed, so the adapter
// talks to this file instead of to Daraja — which is the only way to test "the
// provider contradicts the callback" without a Daraja account.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { Client } = require("pg");

const TEST_DB = process.env.TEST_DATABASE_URL || "";
const ADMIN_DB = process.env.TEST_ADMIN_DATABASE_URL || TEST_DB;
const SKIP = !TEST_DB;

if (SKIP) console.warn("\n*** SKIPPING M-PESA SECURITY TESTS: TEST_DATABASE_URL not set ***\n");

const MPESA_ENV = {
  MPESA_CONSUMER_KEY: "ck_test_value",
  MPESA_CONSUMER_SECRET: "cs_test_secret_value",
  MPESA_SHORTCODE: "174379",
  MPESA_PASSKEY: "pk_test_passkey_secret",
  MPESA_CALLBACK_URL: "https://finguard.test/api/billing/webhook/mpesa",
  MPESA_ENV: "sandbox",
  PAYMENT_PROVIDER: "mpesa"
};

/* Applied BEFORE the app is required: config.js reads the environment at
   require time, and the provider registry resolves adapters on first use. */
if (!SKIP) {
  Object.assign(process.env, MPESA_ENV, {
    DATABASE_URL: TEST_DB,
    NODE_ENV: "test",
    SESSION_SECRET: "mpesa-security-test-secret",
    SECRETS_KEY: "mpesa-secrets-key-0123456789abcdef",
    ALLOW_DEMO_DATA: "true"
  });
}

async function admin(fn) {
  const c = new Client({ connectionString: ADMIN_DB });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

// ── The Daraja stub ───────────────────────────────────────────────
//
// `daraja.stkPush` / `daraja.query` are what Safaricom "says". A test sets them
// to make the provider agree with, contradict, or fail to answer a callback.

const daraja = {
  calls: [],
  stkPush: () => ({ ResponseCode: "0", CheckoutRequestID: null }),   // filled per checkout
  query: () => ({ ResultCode: "0", ResultDesc: "The service request is processed successfully." }),
  reset() {
    this.calls = [];
    this.stkPush = () => ({ ResponseCode: "0", CheckoutRequestID: `ws_CO_${Date.now()}_${Math.random().toString(16).slice(2, 8)}` });
    this.query = () => ({ ResultCode: "0", ResultDesc: "ok" });
  }
};
daraja.reset();

let realFetch;
function installDarajaStub() {
  realFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!u.includes("safaricom.co.ke")) return realFetch(url, init);
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch { /* ignore */ }
    daraja.calls.push({ url: u, body });

    let out;
    if (u.includes("/oauth/")) out = { access_token: "tok_test", expires_in: 3599 };
    else if (u.includes("/stkpush/")) out = await daraja.stkPush(body);
    else if (u.includes("/stkpushquery/")) out = await daraja.query(body);
    else out = {};

    if (out && out.__throw) throw out.__throw;
    return { ok: true, status: 200, json: async () => out };
  };
}

// ── A minimal cookie-jar client against the in-process app ────────

function makeClient(base) {
  const jar = new Map();
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const capture = (res) => (res.headers.getSetCookie ? res.headers.getSetCookie() : [])
    .forEach((line) => {
      const [pair] = line.split(";");
      const i = pair.indexOf("=");
      if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    });
  const csrf = () => (jar.has("fg_csrf") ? decodeURIComponent(jar.get("fg_csrf")) : "");

  async function request(method, p, body, extra = {}) {
    const headers = Object.assign({}, extra);
    if (["POST", "PUT", "DELETE"].includes(method) && !csrf()) {
      const primed = await fetch(`${base}/api/health/live`,
        { headers: cookieHeader() ? { cookie: cookieHeader() } : {} });
      capture(primed); await primed.text();
    }
    const cookies = cookieHeader();
    if (cookies) headers.cookie = cookies;
    if (body !== undefined) headers["content-type"] = "application/json";
    if (["POST", "PUT", "DELETE"].includes(method) && csrf()) headers["x-csrf-token"] = csrf();

    const res = await fetch(`${base}${p}`, {
      method, headers, redirect: "manual",
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    capture(res);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text };
  }

  return {
    get: (p) => request("GET", p),
    post: (p, b) => request("POST", p, b === undefined ? {} : b),
    /* A callback arrives with NO session and no CSRF token — exactly as
       Safaricom would send it, and exactly as an attacker would. */
    raw: (p, b) => fetch(`${base}${p}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(b)
    }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }))
  };
}

let httpServer, base, payer;

test.before(async () => {
  if (SKIP) return;
  await admin((c) => c.query(
    `TRUNCATE subscription, payment, credit_transaction, credit_balance,
              ai_interaction, financial_transaction, membership, tenant, app_user
     RESTART IDENTITY CASCADE`));

  installDarajaStub();
  const { app } = require("../../src/server");
  httpServer = http.createServer(app);
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${httpServer.address().port}`;
  payer = makeClient(base);
  await payer.get("/api/health/live");
  await payer.get("/api/account/entitlements");
});

test.after(async () => {
  if (global.fetch !== realFetch && realFetch) global.fetch = realFetch;
  if (httpServer) await new Promise((r) => httpServer.close(r));
});

/** Open a real checkout and return the reference Daraja was told to echo. */
async function checkout(client = payer, plan = "growth") {
  const ref = `ws_CO_${Math.random().toString(16).slice(2, 10)}`;
  daraja.stkPush = () => ({ ResponseCode: "0", CheckoutRequestID: ref });
  const res = await client.post("/api/billing/checkout", { plan, phone: "0712345678" });
  assert.equal(res.status, 202, `checkout failed: ${JSON.stringify(res.json)}`);
  return { paymentId: res.json.payment_id, providerRef: ref, res };
}

/** A Daraja callback body, shaped exactly as Safaricom sends one. */
function callbackBody(providerRef, resultCode = 0, amount = 2500) {
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: "29115-34620561-1",
        CheckoutRequestID: providerRef,
        ResultCode: resultCode,
        ResultDesc: resultCode === 0 ? "The service request is processed successfully." : "Failed",
        CallbackMetadata: resultCode === 0 ? {
          Item: [
            { Name: "Amount", Value: amount },
            { Name: "MpesaReceiptNumber", Value: "TGH4K9L2MN" },
            { Name: "PhoneNumber", Value: 254712345678 }
          ]
        } : undefined
      }
    }
  };
}

const deliver = (body) => payer.raw("/api/billing/webhook/mpesa", body);

const subscriptionsFor = (paymentId) => admin(async (c) =>
  (await c.query("SELECT id, plan, status FROM subscription WHERE payment_id = $1", [paymentId])).rows);
const paymentRow = (paymentId) => admin(async (c) =>
  (await c.query("SELECT status, amount, plan FROM payment WHERE id = $1", [paymentId])).rows[0]);

// ══════════════════════════════════════════════════════════════════

test("[MS1] the adapter in play is M-Pesa, and it cannot verify a signature",
  { skip: SKIP }, async () => {
    const plans = await payer.get("/api/billing/plans");
    assert.equal(plans.json.payment.available, true, "M-Pesa is the active provider");
    assert.equal(plans.json.payment.provider, "mpesa");

    /* The premise of every test below. Daraja sends no signature, so the route
       skips the signature branch entirely — everything else has to hold. */
    const adapter = require("../../src/services/payments/mpesa");
    assert.equal(typeof adapter.verifySignature, "undefined");
  });

test("[MS2] a callback for an UNKNOWN reference activates nothing", { skip: SKIP }, async () => {
  /* CORRELATION. A forged callback with a real-looking reference we never
     issued must resolve to no tenant and settle nothing. */
  const before = await admin(async (c) =>
    (await c.query("SELECT count(*)::int n FROM subscription")).rows[0].n);

  const res = await deliver(callbackBody("ws_CO_totally_invented_reference"));
  assert.notEqual(res.status, 500);

  const after = await admin(async (c) =>
    (await c.query("SELECT count(*)::int n FROM subscription")).rows[0].n);
  assert.equal(after, before, "no subscription was created");
});

test("[MS3] a callback alone cannot activate — Safaricom must confirm it",
  { skip: SKIP }, async () => {
    const { paymentId, providerRef } = await checkout();

    /* THE FORGERY. A correctly shaped callback, carrying a REAL reference,
       claiming success. Safaricom is asked and says the payment failed. */
    daraja.query = () => ({ ResultCode: "1032", ResultDesc: "Request cancelled by user" });

    const res = await deliver(callbackBody(providerRef, 0));
    assert.notEqual(res.status, 500);

    assert.deepEqual(await subscriptionsFor(paymentId), [],
      "the provider contradicted the callback, so nothing was activated");
    const p = await paymentRow(paymentId);
    assert.notEqual(p.status, "successful", "and the payment was not marked paid");
  });

test("[MS4] a confirmed payment activates exactly one subscription", { skip: SKIP }, async () => {
  const { paymentId, providerRef } = await checkout();
  daraja.query = () => ({ ResultCode: "0", ResultDesc: "ok" });

  const res = await deliver(callbackBody(providerRef, 0));
  assert.equal(res.status, 200, JSON.stringify(res.json));

  const subs = await subscriptionsFor(paymentId);
  assert.equal(subs.length, 1, "exactly one subscription");
  assert.equal(subs[0].status, "active");
  assert.equal(subs[0].plan, "growth");
  assert.equal((await paymentRow(paymentId)).status, "successful");

  /* R5 actually ran: Safaricom was queried over a connection WE opened. */
  assert.ok(daraja.calls.some((c) => c.url.includes("/stkpushquery/")),
    "the callback was independently verified, not taken at its word");
});

test("[MS5] the verification queries OUR reference, not one from the body",
  { skip: SKIP }, async () => {
    const { providerRef } = await checkout();
    daraja.calls = [];
    daraja.query = () => ({ ResultCode: "0" });

    await deliver(callbackBody(providerRef, 0));
    const q = daraja.calls.find((c) => c.url.includes("/stkpushquery/"));
    assert.ok(q, "a query was made");
    assert.equal(q.body.CheckoutRequestID, providerRef,
      "the reference verified is the one correlated to our payment row");
  });

test("[MS6] a duplicate callback causes exactly one activation", { skip: SKIP }, async () => {
  const { paymentId, providerRef } = await checkout();
  daraja.query = () => ({ ResultCode: "0" });

  const first = await deliver(callbackBody(providerRef, 0));
  assert.equal(first.status, 200);
  const second = await deliver(callbackBody(providerRef, 0));
  /* A replay is acknowledged, not errored — a provider retrying a delivery it
     believes failed must not be met with a 500 forever. */
  assert.equal(second.status, 200);

  assert.equal((await subscriptionsFor(paymentId)).length, 1,
    "the second delivery created no second subscription");
});

test("[MS7] CONCURRENT duplicate callbacks cause exactly one activation",
  { skip: SKIP }, async () => {
    const { paymentId, providerRef } = await checkout();
    daraja.query = () => ({ ResultCode: "0" });

    /* Safaricom retries aggressively, and a retry can overlap the original.
       The row lock plus the pending-only guard is what makes this one grant. */
    const results = await Promise.all(
      Array.from({ length: 8 }, () => deliver(callbackBody(providerRef, 0))));
    results.forEach((r) => assert.notEqual(r.status, 500));

    const subs = await subscriptionsFor(paymentId);
    assert.equal(subs.length, 1,
      `8 concurrent callbacks produced ${subs.length} subscriptions`);

    const active = await admin(async (c) =>
      (await c.query(
        `SELECT count(*)::int n FROM subscription s
          JOIN payment p ON p.id = s.payment_id
         WHERE s.payment_id = $1 AND s.status = 'active'`, [paymentId])).rows[0].n);
    assert.equal(active, 1);
  });

test("[MS8] when Safaricom is UNREACHABLE the payment stays pending",
  { skip: SKIP }, async () => {
    /* The money may well have moved. Marking it failed would strand a customer
       who has paid; activating it would grant on no evidence. Pending is the
       only honest state, and a retry settles it. */
    const { paymentId, providerRef } = await checkout();
    daraja.query = () => ({ __throw: new Error("ETIMEDOUT") });

    const res = await deliver(callbackBody(providerRef, 0));
    assert.notEqual(res.status, 500);

    const p = await paymentRow(paymentId);
    assert.equal(p.status, "pending", "not failed, and not successful");
    assert.deepEqual(await subscriptionsFor(paymentId), [], "nothing granted");

    // And it can still be settled once Safaricom answers again.
    daraja.query = () => ({ ResultCode: "0" });
    const retry = await deliver(callbackBody(providerRef, 0));
    assert.equal(retry.status, 200);
    assert.equal((await paymentRow(paymentId)).status, "successful",
      "the retry settles what the outage left pending");
    assert.equal((await subscriptionsFor(paymentId)).length, 1);
  });

test("[MS9] a cancelled or timed-out callback never activates", { skip: SKIP }, async () => {
  for (const code of [1032, 1037, 2001]) {
    const { paymentId, providerRef } = await checkout();
    daraja.query = () => ({ ResultCode: String(code) });
    await deliver(callbackBody(providerRef, code));
    assert.deepEqual(await subscriptionsFor(paymentId), [],
      `ResultCode ${code} must not activate`);
    assert.notEqual((await paymentRow(paymentId)).status, "successful");
  }
});

test("[MS10] a client cannot influence the price it is charged", { skip: SKIP }, async () => {
  /* The catalog is the authority. Everything below is ignored.
     A fresh reference, because `provider_ref` is UNIQUE — Daraja never reuses a
     CheckoutRequestID, and neither may this test. */
  daraja.stkPush = () => ({ ResponseCode: "0", CheckoutRequestID: `ws_CO_price_${Date.now()}` });
  const res = await payer.post("/api/billing/checkout", {
    plan: "growth", phone: "0712345678",
    amount: 1, price: 1, currency: "USD", periodDays: 3650, Amount: 1
  });
  assert.equal(res.status, 202);
  assert.equal(res.json.amount, 2500, "the SERVER's price was used");

  const p = await paymentRow(res.json.payment_id);
  assert.equal(Number(p.amount), 2500, "and stored");

  /* And the STK push actually sent to Safaricom asks for the server's figure. */
  const stk = daraja.calls.filter((c) => c.url.includes("/stkpush/")).pop();
  assert.equal(stk.body.Amount, 2500, "the customer is prompted for 2,500");
});

test("[MS11] a callback claiming a different amount changes nothing", { skip: SKIP }, async () => {
  const { paymentId, providerRef } = await checkout();
  daraja.query = () => ({ ResultCode: "0" });

  // The callback claims 1 shilling was paid for a 2,500 plan.
  await deliver(callbackBody(providerRef, 0, 1));

  const p = await paymentRow(paymentId);
  assert.equal(Number(p.amount), 2500,
    "the charge is the figure written at checkout, not the one the callback claims");
  assert.equal(p.plan, "growth");
});

test("[MS12] no credential material reaches an HTTP response", { skip: SKIP }, async () => {
  const secrets = [
    MPESA_ENV.MPESA_CONSUMER_KEY, MPESA_ENV.MPESA_CONSUMER_SECRET, MPESA_ENV.MPESA_PASSKEY
  ];

  /* The paths most likely to echo a provider error back to the user. */
  const bodies = [
    await payer.get("/api/billing/plans"),
    await payer.get("/api/billing/payments"),
    await deliver(callbackBody("ws_CO_unknown")),
    await deliver({ nonsense: true })
  ];

  // A Daraja failure that echoes the passkey, surfaced through checkout.
  daraja.stkPush = () => ({
    ResponseCode: "1",
    errorMessage: `Bad Request - Invalid Passkey ${MPESA_ENV.MPESA_PASSKEY}`
  });
  bodies.push(await payer.post("/api/billing/checkout", { plan: "growth", phone: "0712345678" }));
  daraja.reset();

  bodies.forEach((res, i) => {
    const blob = JSON.stringify(res.json || res.text || "");
    secrets.forEach((secret) => assert.equal(blob.includes(secret), false,
      `response ${i} leaked a credential`));
  });
});

test("[MS13] a malformed callback is refused without touching billing state",
  { skip: SKIP }, async () => {
    const before = await admin(async (c) =>
      (await c.query("SELECT count(*)::int n FROM subscription")).rows[0].n);

    for (const body of [{}, { Body: {} }, { Body: { stkCallback: {} } }, { junk: 1 }]) {
      const res = await deliver(body);
      assert.notEqual(res.status, 500, `a malformed body must not 500: ${JSON.stringify(body)}`);
    }

    const after = await admin(async (c) =>
      (await c.query("SELECT count(*)::int n FROM subscription")).rows[0].n);
    assert.equal(after, before);
  });

test("[MS14] a callback cannot activate another tenant's payment", { skip: SKIP }, async () => {
  /* The reference resolves to the tenant that opened the checkout. A second
     tenant delivering the same callback changes nothing about their own plan. */
  const stranger = makeClient(base);
  await stranger.get("/api/health/live");
  await stranger.get("/api/account/entitlements");

  const { paymentId, providerRef } = await checkout();
  daraja.query = () => ({ ResultCode: "0" });
  await stranger.raw("/api/billing/webhook/mpesa", callbackBody(providerRef, 0));

  const subs = await subscriptionsFor(paymentId);
  assert.equal(subs.length, 1, "it settled the payer's own payment");

  const strangerPlan = (await stranger.get("/api/account/entitlements")).json;
  assert.equal(strangerPlan.account.plan, "starter",
    "delivering someone else's callback grants the deliverer nothing");
  assert.equal(strangerPlan.account.status, "none", "and opens no subscription for them");
});

test("[MS15] the prompt the CUSTOMER sees carries the plan, not our payment id",
  { skip: SKIP }, async () => {
    /* End to end through the real route: what Safaricom is actually told to
       put on the handset, and what the client is told to expect. */
    daraja.calls = [];
    daraja.stkPush = () => ({ ResponseCode: "0", CheckoutRequestID: `ws_CO_lbl_${Date.now()}` });
    const res = await payer.post("/api/billing/checkout", { plan: "growth", phone: "0712345678" });
    assert.equal(res.status, 202);

    const stk = daraja.calls.filter((c) => c.url.includes("/stkpush/")).pop();
    /* The payer reads "Pay KES 2,500 to <registered paybill name>" followed by
       this account. The business name is set during paybill onboarding, not by
       the API, so the plan is what we can put here. */
    assert.equal(stk.body.AccountReference, "Growth Plan",
      "the payer sees the plan, not a payment uuid");
    assert.equal(stk.body.TransactionDesc, "Financializer");
    assert.equal(/^[0-9a-f]{12}$/.test(stk.body.AccountReference), false,
      "specifically NOT the hex payment id it used to be");

    /* The client is told what to look for, so the UI can name it rather than
       leaving the payer guessing which prompt is ours. */
    assert.equal(res.json.prompt.account, "Growth Plan");
    assert.equal(res.json.prompt.description, "Financializer");
    assert.match(res.json.prompt.phone, /^0712\u2026678$/,
      "and the handset is echoed back masked");
  });

test("[MS16] the readable label did not become the correlation key",
  { skip: SKIP }, async () => {
    /* The danger of this change: if settlement ever matched on the account
       reference, two customers on the same plan would collide. Correlation
       must still run on Safaricom's own CheckoutRequestID. */
    const refA = `ws_CO_a_${Date.now()}`;
    daraja.stkPush = () => ({ ResponseCode: "0", CheckoutRequestID: refA });
    const a = await payer.post("/api/billing/checkout", { plan: "growth", phone: "0712345678" });
    assert.equal(a.status, 202);

    const other = makeClient(base);
    await other.get("/api/health/live");
    await other.get("/api/account/entitlements");
    const refB = `ws_CO_b_${Date.now()}`;
    daraja.stkPush = () => ({ ResponseCode: "0", CheckoutRequestID: refB });
    const b = await other.post("/api/billing/checkout", { plan: "growth", phone: "0722000111" });
    assert.equal(b.status, 202);

    // Same account reference on both prompts — different payments underneath.
    assert.notEqual(a.json.payment_id, b.json.payment_id);

    daraja.query = () => ({ ResultCode: "0" });
    await deliver(callbackBody(refA, 0));

    assert.equal((await subscriptionsFor(a.json.payment_id)).length, 1,
      "A settled");
    assert.deepEqual(await subscriptionsFor(b.json.payment_id), [],
      "B did NOT settle from a callback that shares its account reference");
  });
