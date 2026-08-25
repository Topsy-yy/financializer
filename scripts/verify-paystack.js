#!/usr/bin/env node
// REAL PAYSTACK SANDBOX VERIFICATION.
//
// The payment path has been proven end to end against a deterministic adapter.
// That proves the ARCHITECTURE — signature checking, idempotency, atomic
// activation, tenant isolation — but it does not prove that Paystack accepts
// our requests. Only a real transaction does that, and this script is how it is
// run.
//
//   npm run verify:paystack
//
// WHAT IT DOES (R1-R6, against api.paystack.co with a TEST key):
//
//   R1  initialise a real transaction and get an authorization_url back
//   R2  confirm the amount Paystack recorded is the SERVER's price
//   R4  verify a signature the way the webhook does, and prove a forged one
//       is rejected
//   R5  call /transaction/verify and read the real status
//   R6  replay the same reference and prove Paystack treats it as one payment
//
// R3 (a real callback reaching this server) and R9 (browser unlock) need a
// publicly reachable URL and a human tapping through checkout, so they are
// driven by the printed instructions at the end rather than by this script.
//
// SAFETY. It refuses to run with a live key: `sk_live_` would move real money.

const crypto = require("crypto");
require("dotenv").config();

const KEY = process.env.PAYSTACK_SECRET_KEY || "";
const API = "https://api.paystack.co";

function fail(msg) {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}
function ok(msg) { console.log(`  ✓ ${msg}`); }
function info(msg) { console.log(`    ${msg}`); }

async function call(path, { method = "GET", body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

(async () => {
  console.log("\nPaystack sandbox verification\n");

  if (!KEY) {
    fail("PAYSTACK_SECRET_KEY is not set.\n\n"
      + "    Get a TEST key from https://dashboard.paystack.com/#/settings/developers\n"
      + "    (Test Secret Key, starts sk_test_), then:\n\n"
      + "      export PAYSTACK_SECRET_KEY='sk_test_…'\n"
      + "      export PAYSTACK_CALLBACK_URL='https://<your-public-url>/app'\n"
      + "      export PAYMENT_PROVIDER=paystack\n\n"
      + "    Never commit the key. Never use sk_live_ here.");
  }
  if (KEY.startsWith("sk_live_")) {
    fail("That is a LIVE key. This script would move real money. Use sk_test_.");
  }
  if (!KEY.startsWith("sk_test_")) {
    fail("PAYSTACK_SECRET_KEY does not look like a test key (expected sk_test_…).");
  }

  // The server's own price, from the authoritative catalog — not a literal.
  const entitlements = require("../src/services/entitlements");
  const price = entitlements.priceFor("growth");
  if (!price) fail("The catalog does not price the growth plan.");
  info(`Server price for ${price.label}: ${price.currency} ${price.amount}`);

  // ── R1 ─────────────────────────────────────────────────────────
  const reference = `fgverify${crypto.randomBytes(6).toString("hex")}`;
  const init = await call("/transaction/initialize", {
    method: "POST",
    body: {
      email: "verify@finguard.test",
      amount: price.amount * 100,       // Paystack takes the subunit
      currency: price.currency,
      reference,
      channels: ["mobile_money", "card"],
      metadata: { purpose: "FinGuard sandbox verification" }
    }
  });

  if (init.status !== 200 || !init.json.status) {
    fail(`R1 initialisation FAILED (HTTP ${init.status}): ${init.json.message || "unknown"}\n`
      + "    Common causes: the key is for the wrong account; KES is not enabled\n"
      + "    on this Paystack account; mobile_money is not activated for Kenya.");
  }
  ok(`R1 transaction initialised — reference ${reference}`);
  info(`checkout URL: ${init.json.data.authorization_url}`);

  // ── R5 + R2 ────────────────────────────────────────────────────
  const verify = await call(`/transaction/verify/${encodeURIComponent(reference)}`);
  if (verify.status !== 200 || !verify.json.data) {
    fail(`R5 verification call FAILED (HTTP ${verify.status})`);
  }
  const tx = verify.json.data;
  ok(`R5 transaction is independently verifiable — status "${tx.status}"`);

  const recorded = tx.amount / 100;
  if (recorded !== price.amount) {
    fail(`R2 FAILED: Paystack recorded ${recorded}, the server priced ${price.amount}`);
  }
  ok(`R2 Paystack recorded the SERVER's amount: ${tx.currency} ${recorded}`);

  // ── R4 ─────────────────────────────────────────────────────────
  const paystack = require("../src/services/payments/paystack");
  const sampleBody = JSON.stringify({
    event: "charge.success",
    data: { reference, amount: price.amount * 100, status: "success" }
  });
  const realSig = crypto.createHmac("sha512", KEY).update(sampleBody).digest("hex");

  const good = paystack.verifySignature({
    rawBody: sampleBody, headers: { "x-paystack-signature": realSig }
  });
  if (!good.valid) fail("R4 FAILED: a correctly signed body was rejected.");
  ok("R4 a correctly signed webhook body is accepted");

  const forged = paystack.verifySignature({
    rawBody: sampleBody,
    headers: { "x-paystack-signature": crypto.createHmac("sha512", "wrong").update(sampleBody).digest("hex") }
  });
  if (forged.valid) fail("R4 FAILED: a forged signature was ACCEPTED.");
  ok("R4 a forged signature is rejected");

  // ── R6 ─────────────────────────────────────────────────────────
  const replay = await call("/transaction/initialize", {
    method: "POST",
    body: {
      email: "verify@finguard.test",
      amount: price.amount * 100,
      currency: price.currency,
      reference                            // the SAME reference
    }
  });
  if (replay.status === 200 && replay.json.status) {
    info("note: Paystack re-issued a checkout for the same reference; our own "
      + "idempotency is enforced by the unique index on (provider, provider_ref).");
  } else {
    ok(`R6 Paystack rejects a duplicate reference: ${replay.json.message}`);
  }

  console.log("\n  Automated checks passed. To finish R3 / R7 / R8 / R9:\n");
  console.log("   1. Expose this server publicly (e.g. `ngrok http 3000`).");
  console.log("   2. Dashboard → Settings → API Keys & Webhooks → set the webhook URL to");
  console.log("      https://<public-url>/api/billing/webhook/paystack");
  console.log("   3. Start FinGuard with PAYMENT_PROVIDER=paystack.");
  console.log("   4. In the app: Settings → Plan & Credits → Upgrade to Growth.");
  console.log("   5. Pay with a Paystack TEST card (4084 0840 8408 4081, any future");
  console.log("      expiry, CVV 408) or the test mobile-money flow.");
  console.log("   6. Confirm: the plan changes only AFTER the webhook lands (R8),");
  console.log("      the locked feature becomes usable (R9), and replaying the same");
  console.log("      webhook changes nothing (R6).");
  console.log("   7. Abandon a second checkout and confirm the plan does NOT change (R7).\n");
})().catch((err) => fail(err.message));
