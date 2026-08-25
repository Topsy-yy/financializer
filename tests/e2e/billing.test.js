// JOB P6 — PLANS, CHECKOUT AND BILLING, against the real application.
//
// THE AUDIT FINDINGS THESE TESTS EXIST TO KEEP CLOSED:
//
//   SELF-GRANT      `POST /api/plan {"plan":"workspace"}` awarded the top tier
//                   free, and `/api/what-if` then returned ok:true. Guarded only
//                   by NODE_ENV !== production.
//   NO BILLING      No payment table, no provider, no price. The "Upgrade"
//                   button called that same endpoint, which 403s in production —
//                   so production had no route to becoming a customer.
//   PERISHABLE PLAN The plan lived in profile.json on local disk.
//
// A subscription now activates ONLY when an independently verified payment is
// applied atomically. Everything below drives the real HTTP surface.

const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { startServer } = require("../helpers/server");

const TEST_DB = process.env.TEST_DATABASE_URL || "";
const ADMIN_DB = process.env.TEST_ADMIN_DATABASE_URL || TEST_DB;
const SKIP = !TEST_DB;

if (SKIP) console.warn("\n*** SKIPPING BILLING TESTS: TEST_DATABASE_URL is not set. ***\n");

async function admin(fn) {
  const c = new Client({ connectionString: ADMIN_DB });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

const ENV = {
  DATABASE_URL: TEST_DB,
  ALLOW_DEMO_DATA: "true",
  AI_TEST_PROVIDER: "1",
  NVIDIA_API_KEY: "billing-test-key",
  // The deterministic adapter. It refuses to configure itself outside
  // test/development, so this cannot make a production server payable.
  PAYMENT_PROVIDER: "test"
};

let server;
let payer;      // the tenant who buys
let other;      // an unrelated tenant, for isolation attacks

test.before(async () => {
  if (SKIP) return;
  await admin((c) => c.query(
    `TRUNCATE subscription, payment, credit_transaction, credit_balance,
              ai_interaction, financial_transaction, membership, tenant, app_user
     RESTART IDENTITY CASCADE`));
  server = await startServer(ENV);
  payer = server.client();
  other = server.client();
  // Give each a tenant.
  await payer.get("/api/health/live");
  await other.get("/api/health/live");
  await payer.get("/api/account/entitlements");
  await other.get("/api/account/entitlements");
});

test.after(async () => { if (server) await server.stop(); });

/** Drive a full successful purchase, returning the payment id. */
async function buy(client, plan = "growth") {
  const checkout = await client.post("/api/billing/checkout",
    { plan, phone: "0712345678" });
  assert.equal(checkout.status, 202, JSON.stringify(checkout.json));
  const ref = await admin(async (c) =>
    (await c.query("SELECT provider_ref FROM payment WHERE id = $1",
      [checkout.json.payment_id])).rows[0].provider_ref);
  return { paymentId: checkout.json.payment_id, providerRef: ref, checkout };
}

/**
 * Deliver a provider callback exactly as the provider would — SIGNED.
 *
 * The signature is computed over the exact bytes sent, as Paystack does with
 * HMAC-SHA512. The harness JSON-encodes the body itself so the digest is taken
 * over the same bytes the server will see.
 */
const testAdapter = require("../../src/services/payments/testAdapter");

async function webhook(client, providerRef, status = "successful", extra = {}) {
  const payload = Object.assign({ providerRef, status }, extra);
  const raw = JSON.stringify(payload);
  return client.post("/api/billing/webhook/test", payload,
    { "x-test-signature": testAdapter.sign(raw) });
}

// ══════════════════════════════════════════════════════════════════
// PLAN ENFORCEMENT
// ══════════════════════════════════════════════════════════════════

test("[B1] a free user is DENIED a paid capability at the API", { skip: SKIP }, async () => {
  const res = await payer.post("/api/what-if",
    { month: "2026-05", type: "reduce_revenue", params: { pct: 20 } });
  assert.equal(res.status, 403, JSON.stringify(res.json).slice(0, 200));
  assert.equal(res.json.error, "upgrade_required");
  assert.ok(res.json.required_plan, "and is told which plan is required");
});

test("[B2] the capability map reports the free floor", { skip: SKIP }, async () => {
  const res = await payer.get("/api/account/entitlements");
  assert.equal(res.status, 200);
  assert.equal(res.json.account.plan, "starter");
  assert.equal(res.json.account.source, "default",
    "no subscription means the free floor, not a stored claim");
  assert.equal(res.json.account.features.what_if_simulator, false,
    "and the client is told the capability is locked");
  assert.ok(res.json.account.upgrade_options.length > 0,
    "with real, purchasable upgrade options");
});

test("[B3] deterministic financial truth is NOT paywalled", { skip: SKIP }, async () => {
  /* THE PRODUCT RULE. Monetize intelligence, automation and AI volume — never
     access to the user's own computed financial position. */
  const res = await payer.get("/api/account/entitlements");
  const f = res.json.account.features;
  ["deterministic_analysis", "dashboard", "reports", "pdf_reports",
    "forecast_numbers", "manual_analysis"].forEach((cap) => {
    assert.equal(f[cap], true, `${cap} is available on the free plan`);
  });
});

// ══════════════════════════════════════════════════════════════════
// CHECKOUT — the server decides the price
// ══════════════════════════════════════════════════════════════════

test("[B4] the client CANNOT choose its own price", { skip: SKIP }, async () => {
  /* The most obvious attack: send an amount. The catalog is the only source of
     price, so whatever the body claims is ignored. */
  const res = await payer.post("/api/billing/checkout", {
    plan: "growth", phone: "0712345678",
    amount: 1, price: 1, currency: "USD", periodDays: 3650
  });
  assert.equal(res.status, 202);
  assert.equal(res.json.amount, 2500, "the SERVER's price was used");
  assert.equal(res.json.currency, "KES", "and the server's currency");

  const stored = await admin(async (c) =>
    (await c.query("SELECT amount, currency FROM payment WHERE id = $1",
      [res.json.payment_id])).rows[0]);
  assert.equal(Number(stored.amount), 2500, "and that is what was stored");
  assert.equal(stored.currency.trim(), "KES");
});

test("[B5] an unsellable plan cannot be purchased", { skip: SKIP }, async () => {
  /* Accountant Workspace adds four capabilities beyond Growth and all four are
     unbuilt, so it is not sellable. Charging for it would be charging for
     nothing. */
  for (const plan of ["workspace", "starter", "enterprise", ""]) {
    const res = await payer.post("/api/billing/checkout", { plan, phone: "0712345678" });
    assert.equal(res.status, 400, `${plan || "(empty)"} is refused`);
    assert.equal(res.json.error, "plan_not_purchasable");
  }
});

test("[B6] checkout alone does NOT activate anything", { skip: SKIP }, async () => {
  /* A provider accepting the request means a prompt was sent, not that money
     moved. Treating initiation as payment is the classic checkout fraud. */
  const fresh = server.client();
  await fresh.get("/api/health/live");
  const { checkout } = await buy(fresh);
  assert.equal(checkout.json.status, "pending");

  const account = await fresh.get("/api/account/entitlements");
  assert.equal(account.json.account.plan, "starter",
    "still on the free plan after initiating a checkout");

  const denied = await fresh.post("/api/what-if",
    { month: "2026-05", type: "reduce_revenue", params: { pct: 20 } });
  assert.equal(denied.status, 403, "and the paid feature is still denied");
});

// ══════════════════════════════════════════════════════════════════
// PAYMENT → ACTIVATION
// ══════════════════════════════════════════════════════════════════

test("[B7] a verified payment activates the plan exactly once", { skip: SKIP }, async () => {
  const { paymentId, providerRef } = await buy(payer, "growth");

  const cb = await webhook(payer, providerRef, "successful");
  assert.equal(cb.status, 200);
  assert.equal(cb.json.outcome, "activated");

  const account = await payer.get("/api/account/entitlements");
  assert.equal(account.json.account.plan, "growth", "the plan changed");
  assert.equal(account.json.account.source, "subscription",
    "and it comes from a subscription row, not a file");
  assert.equal(account.json.account.status, "active");
  assert.ok(account.json.account.expires_at, "with an expiry — not a perpetual grant");

  // Exactly ONE active subscription, anchored to the payment.
  const subs = await admin(async (c) =>
    (await c.query("SELECT status, plan, payment_id FROM subscription WHERE payment_id = $1",
      [paymentId])).rows);
  assert.equal(subs.length, 1);
  assert.equal(subs[0].status, "active");
});

test("[B8] entitlement becomes REAL immediately — the paid feature works",
  { skip: SKIP }, async () => {
    const res = await payer.post("/api/what-if",
      { month: "2026-05", type: "reduce_revenue", params: { pct: 20 } });
    assert.notEqual(res.status, 403,
      "the capability denied in [B1] is now permitted");
  });

test("[B9] a DUPLICATE callback does not activate twice", { skip: SKIP }, async () => {
  /* Providers retry. A second delivery of the same reference must be an
     idempotent no-op, not a second subscription. */
  const ref = await admin(async (c) =>
    (await c.query(
      `SELECT provider_ref FROM payment WHERE status='successful'
        ORDER BY created_at DESC LIMIT 1`)).rows[0].provider_ref);

  const before = await admin(async (c) =>
    (await c.query("SELECT count(*)::int n FROM subscription")).rows[0].n);

  const again = await webhook(payer, ref, "successful");
  assert.equal(again.status, 200);
  assert.equal(again.json.outcome, "duplicate", "reported as a duplicate");

  const after = await admin(async (c) =>
    (await c.query("SELECT count(*)::int n FROM subscription")).rows[0].n);
  assert.equal(after, before, "and NO new subscription was created");
});

test("[B10] CONCURRENT callbacks activate exactly once", { skip: SKIP }, async () => {
  /* The real race: a provider fires several deliveries at once. The row lock
     plus the status guard must let exactly one through. */
  const fresh = server.client();
  await fresh.get("/api/health/live");
  const { providerRef } = await buy(fresh, "growth");

  const results = await Promise.all(
    Array.from({ length: 8 }, () => webhook(fresh, providerRef, "successful")));

  const outcomes = results.map((r) => r.json.outcome);
  const activated = outcomes.filter((o) => o === "activated").length;
  assert.equal(activated, 1,
    `exactly one activation, got ${activated} of ${outcomes.length}: ${outcomes.join(",")}`);
  assert.ok(outcomes.every((o) => ["activated", "duplicate"].includes(o)),
    "and every other delivery was an idempotent duplicate");

  const subs = await admin(async (c) =>
    (await c.query(
      `SELECT count(*)::int n FROM subscription s
         JOIN payment p ON p.id = s.payment_id
        WHERE p.provider_ref = $1`, [providerRef])).rows[0].n);
  assert.equal(subs, 1, "one subscription row in the database");
});

// ══════════════════════════════════════════════════════════════════
// PAYMENT SECURITY
// ══════════════════════════════════════════════════════════════════

test("[B11] a FAILED payment activates nothing", { skip: SKIP }, async () => {
  const fresh = server.client();
  await fresh.get("/api/health/live");
  const { providerRef } = await buy(fresh, "growth");

  const cb = await webhook(fresh, providerRef, "failed");
  assert.equal(cb.json.outcome, "failed_payment");

  const account = await fresh.get("/api/account/entitlements");
  assert.equal(account.json.account.plan, "starter", "still free");

  // The record SURVIVES — a failure is the audit trail, not something to delete.
  const row = await admin(async (c) =>
    (await c.query("SELECT status FROM payment WHERE provider_ref = $1",
      [providerRef])).rows[0]);
  assert.equal(row.status, "failed", "and the failed payment is retained");
});

test("[B12] an EXPIRED checkout cannot be activated", { skip: SKIP }, async () => {
  const fresh = server.client();
  await fresh.get("/api/health/live");
  const { paymentId, providerRef } = await buy(fresh, "growth");

  // Age the checkout past its window.
  await admin((c) => c.query(
    "UPDATE payment SET expires_at = now() - interval '1 hour' WHERE id = $1", [paymentId]));

  const cb = await webhook(fresh, providerRef, "successful");
  assert.equal(cb.json.outcome, "expired",
    "a callback after the window does not activate");

  const account = await fresh.get("/api/account/entitlements");
  assert.equal(account.json.account.plan, "starter");

  const row = await admin(async (c) =>
    (await c.query("SELECT status FROM payment WHERE id = $1", [paymentId])).rows[0]);
  assert.equal(row.status, "expired", "recorded, not deleted — the money may be real");
});

test("[B13] a payment reference cannot be claimed by another tenant",
  { skip: SKIP }, async () => {
    /* User A must not be able to activate their own plan with User B's
       payment. The tenant comes from the STORED payment, never the callback. */
    const fresh = server.client();
    await fresh.get("/api/health/live");
    const { providerRef } = await buy(fresh, "growth");

    // `other` delivers a callback for a reference that is not theirs.
    const stolen = await webhook(other, providerRef, "successful");
    assert.equal(stolen.status, 200);

    const otherAccount = await other.get("/api/account/entitlements");
    assert.equal(otherAccount.json.account.plan, "starter",
      "the thief gained nothing — the payment settles against ITS OWN tenant");

    const victim = await fresh.get("/api/account/entitlements");
    assert.equal(victim.json.account.plan, "growth",
      "and the rightful payer got what they paid for");
  });

test("[B14] a checkout belonging to another tenant is not readable", { skip: SKIP }, async () => {
  const fresh = server.client();
  await fresh.get("/api/health/live");
  const { paymentId } = await buy(fresh, "growth");

  const peek = await other.get(`/api/billing/checkout/${paymentId}`);
  assert.equal(peek.status, 404, "RLS hides another tenant's payment");
  assert.equal(peek.json.error, "no_such_payment");
});

test("[B15] an unmatched or malformed callback is refused safely", { skip: SKIP }, async () => {
  /* These bodies are SIGNED. The signature check runs before parsing — which
     is the correct order — so an unsigned body would be rejected as
     `invalid_signature` and would prove nothing about how a genuine but
     unusable callback is handled. */
  const invented = await webhook(payer, "test_does_not_exist", "successful");
  assert.equal(invented.status, 200, "providers get 200 so they stop retrying");
  assert.equal(invented.json.outcome, "not_found");

  const junkBody = { nonsense: true };
  const junk = await payer.post("/api/billing/webhook/test", junkBody,
    { "x-test-signature": testAdapter.sign(JSON.stringify(junkBody)) });
  assert.equal(junk.json.outcome, "unparseable",
    "authentic but unrecognisable is distinct from unauthentic");

  // An unknown provider is rejected before any signature can be checked —
  // there is no adapter to check it with.
  const unknown = await payer.post("/api/billing/webhook/notaprovider", { providerRef: "x" });
  assert.equal(unknown.json.outcome, "unknown_provider");
});

// ══════════════════════════════════════════════════════════════════
// PLAN TRANSITIONS
// ══════════════════════════════════════════════════════════════════

test("[B16] an EXPIRED subscription downgrades immediately", { skip: SKIP }, async () => {
  const fresh = server.client();
  await fresh.get("/api/health/live");
  const { providerRef } = await buy(fresh, "growth");
  await webhook(fresh, providerRef, "successful");

  assert.equal((await fresh.get("/api/account/entitlements")).json.account.plan, "growth");

  // Age the subscription past its expiry.
  await admin((c) => c.query(
    `UPDATE subscription SET expires_at = now() - interval '1 day'
      WHERE status = 'active' AND payment_id IN
        (SELECT id FROM payment WHERE provider_ref = $1)`, [providerRef]));

  const after = await fresh.get("/api/account/entitlements");
  assert.equal(after.json.account.plan, "starter",
    "entitlement lapses on the next request — no scheduled job required");

  const denied = await fresh.post("/api/what-if",
    { month: "2026-05", type: "reduce_revenue", params: { pct: 20 } });
  assert.equal(denied.status, 403, "and the paid feature is denied again");
});

test("[B17] cancelling downgrades but KEEPS the payment history", { skip: SKIP }, async () => {
  const fresh = server.client();
  await fresh.get("/api/health/live");
  const { providerRef } = await buy(fresh, "growth");
  await webhook(fresh, providerRef, "successful");

  const cancelled = await fresh.post("/api/billing/cancel", {});
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.account.plan, "starter", "downgraded at once");

  const history = await fresh.get("/api/billing/payments");
  assert.ok(history.json.payments.some((p) => p.status === "successful"),
    "the payment that was made is still on record");
});

// ══════════════════════════════════════════════════════════════════
// SELF-GRANT — the audit's headline defect
// ══════════════════════════════════════════════════════════════════

test("[B18] a client cannot change its own plan by editing state", { skip: SKIP }, async () => {
  /* The plan is derived from a subscription row on every request, so nothing a
     client sends — and nothing written into the profile file — can grant it. */
  const fresh = server.client();
  await fresh.get("/api/health/live");

  // Try the shapes a client would attempt.
  for (const body of [
    { plan: "workspace" }, { plan: "growth" },
    { entitlement: { plan: "growth" } }, { profile: { plan: "growth" } }
  ]) {
    await fresh.post("/api/profile", body);
  }

  const account = await fresh.get("/api/account/entitlements");
  assert.equal(account.json.account.plan, "starter",
    "no request body can grant a plan");

  const denied = await fresh.post("/api/what-if",
    { month: "2026-05", type: "reduce_revenue", params: { pct: 20 } });
  assert.equal(denied.status, 403);
});

// ══════════════════════════════════════════════════════════════════
// PROVIDER AVAILABILITY
// ══════════════════════════════════════════════════════════════════

test("[B19] an unconfigured provider does NOT fake success", { skip: SKIP }, async () => {
  /* A development fallback that "succeeds" is how a fake payment reaches
     production. With no provider selected, checkout reports unavailable. */
  const bare = await startServer(
    Object.assign({}, ENV, { PAYMENT_PROVIDER: "" }));
  try {
    const c = bare.client();
    await c.get("/api/health/live");

    const plans = await c.get("/api/billing/plans");
    assert.equal(plans.json.payment.available, false,
      "the UI is told payment is unavailable");
    assert.ok(plans.json.plans.length > 0, "but the catalog is still shown");

    const res = await c.post("/api/billing/checkout", { plan: "growth", phone: "0712345678" });
    assert.equal(res.status, 503);
    assert.equal(res.json.error, "payment_unavailable");

    const account = await c.get("/api/account/entitlements");
    assert.equal(account.json.account.plan, "starter", "and nothing was activated");
  } finally {
    await bare.stop();
  }
});

test("[B20] the catalog exposes server-side prices only", { skip: SKIP }, async () => {
  const res = await payer.get("/api/billing/plans");
  assert.equal(res.status, 200);
  const growth = res.json.plans.find((p) => p.key === "growth");
  assert.ok(growth, "Growth is purchasable");
  assert.equal(growth.price, 2500);
  assert.equal(growth.currency, "KES");
  assert.equal(growth.period_days, 30);
  assert.equal(res.json.plans.some((p) => p.key === "workspace"), false,
    "and an unbuilt tier is not offered for sale");
});

// ══════════════════════════════════════════════════════════════════
// P4 — WEBHOOK SIGNATURE VERIFICATION
//
// The reason Paystack was chosen over direct Daraja. A payment webhook that
// cannot be cryptographically verified is the weakest link in a billing
// system, and Daraja does not sign its callbacks at all.
// ══════════════════════════════════════════════════════════════════

test("[B21] an UNSIGNED webhook is rejected", { skip: SKIP }, async () => {
  const fresh = server.client();
  await fresh.get("/api/health/live");
  const { providerRef } = await buy(fresh, "growth");

  // No signature header at all — the shape an attacker would send.
  const res = await fresh.post("/api/billing/webhook/test",
    { providerRef, status: "successful" });

  assert.equal(res.status, 401, "refused, not acknowledged");
  assert.equal(res.json.outcome, "invalid_signature");

  const account = await fresh.get("/api/account/entitlements");
  assert.equal(account.json.account.plan, "starter",
    "and nothing was activated");
});

test("[B22] a FORGED signature is rejected", { skip: SKIP }, async () => {
  const fresh = server.client();
  await fresh.get("/api/health/live");
  const { providerRef } = await buy(fresh, "growth");

  const payload = { providerRef, status: "successful" };
  // Signed with the wrong secret — an attacker who knows the SCHEME but not
  // the key.
  const forged = require("node:crypto")
    .createHmac("sha512", "not-the-real-secret")
    .update(JSON.stringify(payload)).digest("hex");

  const res = await fresh.post("/api/billing/webhook/test", payload,
    { "x-test-signature": forged });

  assert.equal(res.status, 401);
  assert.equal(res.json.outcome, "invalid_signature");
  assert.equal((await fresh.get("/api/account/entitlements")).json.account.plan,
    "starter", "no activation from a forged callback");
});

test("[B23] a TAMPERED body invalidates a valid signature", { skip: SKIP }, async () => {
  /* The subtle attack: capture a real signed callback for a small payment and
     replay it with the plan or amount changed. The digest covers the whole
     body, so any edit breaks it. */
  const fresh = server.client();
  await fresh.get("/api/health/live");
  const { providerRef } = await buy(fresh, "growth");

  const original = { providerRef, status: "successful" };
  const signature = testAdapter.sign(JSON.stringify(original));

  // Same signature, different body.
  const res = await fresh.post("/api/billing/webhook/test",
    { providerRef, status: "successful", amount: 999999 },
    { "x-test-signature": signature });

  assert.equal(res.status, 401, "the signature no longer matches the body");
  assert.equal((await fresh.get("/api/account/entitlements")).json.account.plan,
    "starter");
});

test("[B24] Paystack signs with HMAC-SHA512 over the RAW body", { skip: SKIP }, () => {
  /* Verified directly against the adapter, because this is the property the
     provider choice was made on. */
  const paystack = require("../../src/services/payments/paystack");
  const saved = process.env.PAYSTACK_SECRET_KEY;
  process.env.PAYSTACK_SECRET_KEY = "sk_test_example";
  try {
    const body = JSON.stringify({ event: "charge.success", data: { reference: "r1" } });
    const good = require("node:crypto")
      .createHmac("sha512", "sk_test_example").update(body).digest("hex");

    assert.equal(
      paystack.verifySignature({ rawBody: body, headers: { "x-paystack-signature": good } }).valid,
      true, "a correctly signed body is accepted");

    assert.equal(
      paystack.verifySignature({ rawBody: body, headers: {} }).valid,
      false, "a missing signature is rejected");

    assert.equal(
      paystack.verifySignature({
        rawBody: body, headers: { "x-paystack-signature": "0".repeat(128) }
      }).valid, false, "a wrong signature is rejected");

    // The digest is over the RAW bytes: re-ordering keys must break it.
    const reordered = JSON.stringify({ data: { reference: "r1" }, event: "charge.success" });
    assert.equal(
      paystack.verifySignature({
        rawBody: reordered, headers: { "x-paystack-signature": good }
      }).valid, false, "re-serialised JSON does not match — raw bytes matter");
  } finally {
    if (saved === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = saved;
  }
});

test("[B25] a provider OUTAGE does not grant access", { skip: SKIP }, async () => {
  /* P5. If the provider never confirms, the checkout simply stays pending and
     expires. Silence is never success. */
  const fresh = server.client();
  await fresh.get("/api/health/live");
  const { paymentId } = await buy(fresh, "growth");

  // No callback ever arrives; the window passes.
  await admin((c) => c.query(
    "UPDATE payment SET expires_at = now() - interval '1 hour' WHERE id = $1", [paymentId]));

  const account = await fresh.get("/api/account/entitlements");
  assert.equal(account.json.account.plan, "starter", "still free");

  const status = await fresh.get(`/api/billing/checkout/${paymentId}`);
  assert.equal(status.json.status, "pending",
    "the attempt is still on record, unresolved — not silently succeeded");
});

test("[B26] upgrading does NOT destroy historical analyses", { skip: SKIP }, async () => {
  /* P8. A plan change must never touch financial data. */
  const fresh = server.client();
  await fresh.get("/api/health/live");

  await fresh.upload("/api/financial-data/upload", {
    filename: "hist.csv",
    content: "Date,Description,Amount,Counterparty\n2026-03-04,Rent,-100000,LL\n"
      + "2026-03-20,Sale,400000,BigCo\n",
    fields: { period: "2026-03", currentCashBalance: 500000 }
  });
  await fresh.post("/api/monthly-review", { month: "2026-03", use_ai_analysis: false });

  const before = await fresh.get("/api/analysis/2026-03");
  assert.equal(before.status, 200, "the analysis exists before upgrading");
  const runId = before.json.analysis.run_id;

  const { providerRef } = await buy(fresh, "growth");
  await webhook(fresh, providerRef, "successful");
  assert.equal((await fresh.get("/api/account/entitlements")).json.account.plan, "growth");

  const after = await fresh.get("/api/analysis/2026-03");
  assert.equal(after.status, 200, "and still exists after");
  assert.equal(after.json.analysis.run_id, runId, "the SAME run — nothing was recreated");
  assert.equal(after.json.analysis.findings.length, before.json.analysis.findings.length);
});

test("[B27] AI credits follow the plan after upgrade", { skip: SKIP }, async () => {
  /* P9. The allowance is the plan's, applied immediately — Starter 100,
     Growth 2000. */
  const fresh = server.client();
  await fresh.get("/api/health/live");

  const free = await fresh.get("/api/account/entitlements");
  assert.equal(free.json.account.allowance, 100, "Starter allowance");

  const { providerRef } = await buy(fresh, "growth");
  await webhook(fresh, providerRef, "successful");

  const paid = await fresh.get("/api/account/entitlements");
  assert.equal(paid.json.account.allowance, 2000, "Growth allowance, at once");
  assert.ok(paid.json.account.credits > 100, "and the credits were topped up to it");
});

// ══════════════════════════════════════════════════════════════════
// R5 — INDEPENDENT VERIFICATION, and renewal state
// ══════════════════════════════════════════════════════════════════

test("[B28] a signed callback is REFUSED when the provider contradicts it",
  { skip: SKIP }, async () => {
    /* R5. The signature proves the message is genuine; it does not prove the
       payment still is. A replayed body is authentically signed and may
       describe a transaction that has since been reversed. Activation asks the
       provider directly before granting anything. */
    /* A server whose provider reports FAILED however the callback is signed.
       The adapter lives in the server process, so the contradiction has to be
       configured there rather than queued from here. */
    const contradicting = await startServer(
      Object.assign({}, ENV, { TEST_VERIFY_STATUS: "failed" }));
    try {
      const fresh = contradicting.client();
      await fresh.get("/api/health/live");

      const checkout = await fresh.post("/api/billing/checkout",
        { plan: "growth", phone: "0712345678" });
      assert.equal(checkout.status, 202);
      const ref = await admin(async (c) =>
        (await c.query("SELECT provider_ref FROM payment WHERE id = $1",
          [checkout.json.payment_id])).rows[0].provider_ref);

      const payload = { providerRef: ref, status: "successful" };
      const res = await fresh.post("/api/billing/webhook/test", payload,
        { "x-test-signature": testAdapter.sign(JSON.stringify(payload)) });

      assert.equal(res.status, 200);
      assert.equal(res.json.outcome, "verification_failed",
        "the second check overrode a correctly signed claim");
      assert.equal(res.json.actual, "failed");

      const account = await fresh.get("/api/account/entitlements");
      assert.equal(account.json.account.plan, "starter", "nothing was activated");
    } finally {
      await contradicting.stop();
    }
  });

test("[B29] renewal state is reported from the server", { skip: SKIP }, async () => {
  const fresh = server.client();
  await fresh.get("/api/health/live");

  const none = await fresh.get("/api/account/entitlements");
  assert.equal(none.json.account.renewal.state, "none", "no subscription, nothing to renew");

  const { providerRef } = await buy(fresh, "growth");
  await webhook(fresh, providerRef, "successful");

  const active = await fresh.get("/api/account/entitlements");
  assert.equal(active.json.account.renewal.state, "active");
  assert.ok(active.json.account.renewal.days_remaining > 7,
    "a fresh 30-day period is not 'expiring soon'");

  /* Bring the expiry inside the reminder window. Deliberately 2.5 days, not
     3: `days_remaining` rounds UP, so an exact 3-day boundary lands on 3 or 2
     depending on how many milliseconds pass between the UPDATE and the read.
     Half a day inside the boundary makes the answer 3 every time. */
  await admin((c) => c.query(
    `UPDATE subscription SET expires_at = now() + interval '60 hours'
      WHERE status = 'active' AND payment_id IN
        (SELECT id FROM payment WHERE provider_ref = $1)`, [providerRef]));

  const soon = await fresh.get("/api/account/entitlements");
  assert.equal(soon.json.account.renewal.state, "expiring_soon");
  assert.equal(soon.json.account.renewal.days_remaining, 3,
    "60 hours rounds up to 3 days");
  assert.equal(soon.json.account.plan, "growth", "still entitled while it runs down");

  // And past it.
  await admin((c) => c.query(
    `UPDATE subscription SET expires_at = now() - interval '1 day'
      WHERE payment_id IN (SELECT id FROM payment WHERE provider_ref = $1)`, [providerRef]));

  const expired = await fresh.get("/api/account/entitlements");
  assert.equal(expired.json.account.renewal.state, "expired");
  assert.equal(expired.json.account.plan, "starter", "downgraded");
  assert.equal(expired.json.account.renewal.data_retained, true,
    "and the response says plainly that the data is still there");

  /* THE DEFECT THIS PINS. Detecting the lapse writes the row to `expired`, and
     `currentSubscription` only selects `active` — so on the NEXT request the
     subscription was null, `renewal.state` fell back to "none", and the user
     lost paid features in complete silence with no renew prompt. Verified in a
     browser: the expired banner rendered empty. */
  const later = await fresh.get("/api/account/entitlements");
  assert.equal(later.json.account.renewal.state, "expired",
    "expiry is STILL reported after the lapse has been recorded");
  assert.equal(later.json.account.renewal.plan, "growth",
    "and names the plan that lapsed, so the button says 'Renew Growth' "
    + "rather than 'Renew Starter'");
});

test("[B30] renewing after expiry restores access", { skip: SKIP }, async () => {
  /* Journey 4's tail: expiry is not terminal. */
  const fresh = server.client();
  await fresh.get("/api/health/live");

  const first = await buy(fresh, "growth");
  await webhook(fresh, first.providerRef, "successful");
  await admin((c) => c.query(
    `UPDATE subscription SET expires_at = now() - interval '1 day'
      WHERE payment_id IN (SELECT id FROM payment WHERE provider_ref = $1)`,
    [first.providerRef]));
  assert.equal((await fresh.get("/api/account/entitlements")).json.account.plan, "starter");

  // Renew: a second payment, the same flow.
  const second = await buy(fresh, "growth");
  await webhook(fresh, second.providerRef, "successful");

  const renewed = await fresh.get("/api/account/entitlements");
  assert.equal(renewed.json.account.plan, "growth", "access restored");
  assert.equal(renewed.json.account.renewal.state, "active");

  const history = await fresh.get("/api/billing/payments");
  assert.ok(history.json.payments.length >= 2, "both payments are on record");
});
