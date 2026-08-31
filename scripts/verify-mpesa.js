#!/usr/bin/env node
// REAL M-PESA (DARAJA) SANDBOX VERIFICATION.
//
// The M-Pesa path is proven end to end against mocked HTTP in
// tests/ops/mpesaAdapter.test.js and tests/http/mpesaSecurity.test.js. That
// proves the ARCHITECTURE — request shaping, correlation, independent
// verification, idempotency, atomic activation. It does NOT prove that
// Safaricom accepts our requests. Only a real sandbox transaction does that,
// and this is how it is run.
//
//   npm run verify:mpesa
//
// WHAT IS MOCKED AND WHAT IS REAL. This script draws that line explicitly and
// prints it, because a harness that blurs it is worse than no harness:
//
//   REAL     OAuth, STK Push, STK Push Query — actual calls to Safaricom
//   REAL     the amount, taken from the server's own plan catalog
//   LOCAL    duplicate/idempotency behaviour, which is OUR guarantee and is
//            asserted here against the adapter, not against Daraja
//   MANUAL   the callback reaching this server, which needs a publicly
//            reachable URL and a human approving the prompt on a handset
//
// SAFETY. It refuses to run against production: MPESA_ENV=production would put
// a real prompt on a real phone and move real money.

const path = require("path");
require("dotenv").config();

const REQUIRED = [
  "MPESA_CONSUMER_KEY",
  "MPESA_CONSUMER_SECRET",
  "MPESA_SHORTCODE",
  "MPESA_PASSKEY",
  "MPESA_CALLBACK_URL"
];

function fail(msg) {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}
const ok = (msg) => console.log(`  ✓ ${msg}`);
const info = (msg) => console.log(`    ${msg}`);
const manual = (msg) => console.log(`  · ${msg}`);

/** Never print a secret. Length only, so an operator can spot a truncated paste. */
const shape = (v) => (v ? `set (${String(v).length} chars)` : "MISSING");

(async () => {
  console.log("\nM-Pesa (Daraja) sandbox verification\n");

  // ── Credentials ────────────────────────────────────────────────
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    console.log("  Configuration:");
    REQUIRED.forEach((k) => info(`${k.padEnd(24)} ${shape(process.env[k])}`));
    fail(`Missing: ${missing.join(", ")}\n\n`
      + "    Create a SANDBOX app at https://developer.safaricom.co.ke\n"
      + "    (My Apps → Create App → tick Lipa Na M-Pesa Sandbox), then:\n\n"
      + "      export MPESA_CONSUMER_KEY='...'          # from the app page\n"
      + "      export MPESA_CONSUMER_SECRET='...'       # from the app page\n"
      + "      export MPESA_SHORTCODE='174379'          # sandbox paybill\n"
      + "      export MPESA_PASSKEY='...'               # sandbox Lipa Na M-Pesa passkey\n"
      + "      export MPESA_CALLBACK_URL='https://<public-url>/api/billing/webhook/mpesa'\n"
      + "      export MPESA_ENV=sandbox\n"
      + "      export PAYMENT_PROVIDER=mpesa\n\n"
      + "    Never commit these. Never point this script at production.");
  }

  // ── Refuse production ──────────────────────────────────────────
  const env = String(process.env.MPESA_ENV || "sandbox").toLowerCase();
  if (env === "production" || env === "live") {
    fail("MPESA_ENV is production. This script sends a real STK prompt and would\n"
      + "    move real money. Set MPESA_ENV=sandbox.");
  }
  if (env !== "sandbox") {
    fail(`MPESA_ENV="${process.env.MPESA_ENV}" is not recognised. Set MPESA_ENV=sandbox.`);
  }
  ok("MPESA_ENV=sandbox — no real money can move");

  /* The sandbox shortcode is 174379 for every developer account. A different
     value here usually means production credentials pasted by mistake. */
  if (process.env.MPESA_SHORTCODE !== "174379") {
    info(`note: MPESA_SHORTCODE is ${process.env.MPESA_SHORTCODE}, not the usual `
      + "sandbox 174379 — check these are sandbox credentials.");
  }

  // ── Provider selection ─────────────────────────────────────────
  if (String(process.env.PAYMENT_PROVIDER || "").toLowerCase() !== "mpesa") {
    fail(`PAYMENT_PROVIDER is "${process.env.PAYMENT_PROVIDER || "unset"}".\n`
      + "    Set PAYMENT_PROVIDER=mpesa, or the application will not use this adapter\n"
      + "    even though the credentials are present.");
  }
  ok("PAYMENT_PROVIDER=mpesa");

  const provider = require(path.join("..", "src", "services", "payments"));
  const status = provider.status();
  if (!status.configured) {
    fail(`The provider boundary reports it is not usable: ${status.reason}`
      + (status.missing && status.missing.length ? ` (${status.missing.join(", ")})` : ""));
  }
  ok("the provider boundary reports M-Pesa as configured and selected");

  /* THE CALLBACK URL IS CHECKED BEFORE ANY NETWORK CALL.
     Validating it after the STK push burns a real Daraja request and reports
     the failure as a credentials problem, which sends the operator hunting in
     the wrong place. */
  const callbackUrl = process.env.MPESA_CALLBACK_URL || "";
  if (!/^https:\/\//i.test(callbackUrl)) {
    fail(`MPESA_CALLBACK_URL is not HTTPS: ${callbackUrl}\n`
      + "    Safaricom will not deliver a callback to a plain-HTTP endpoint.");
  }
  if (/localhost|127\.0\.0\.1|0\.0\.0\.0|::1/i.test(callbackUrl)) {
    fail(`MPESA_CALLBACK_URL points at this machine: ${callbackUrl}\n\n`
      + "    Safaricom calls back from the public internet and cannot reach\n"
      + "    localhost. Expose the server first:\n\n"
      + "      ngrok http 3000\n\n"
      + "    then set MPESA_CALLBACK_URL to that HTTPS URL followed by\n"
      + "    /api/billing/webhook/mpesa");
  }
  if (!/\/api\/billing\/webhook\/mpesa$/.test(callbackUrl)) {
    fail(`MPESA_CALLBACK_URL does not end in /api/billing/webhook/mpesa:\n`
      + `    ${callbackUrl}\n`
      + "    Safaricom would deliver the callback to a route that cannot settle it.");
  }
  ok("callback URL is public HTTPS and points at the webhook route");

  const mpesa = require(path.join("..", "src", "services", "payments", "mpesa"));

  // ── The phone to prompt ────────────────────────────────────────
  const rawPhone = process.env.MPESA_TEST_PHONE || "";
  if (!rawPhone) {
    fail("MPESA_TEST_PHONE is not set.\n\n"
      + "    Daraja's sandbox sends the prompt to a real handset. Use YOUR OWN\n"
      + "    number — you have to approve the prompt for the flow to complete.\n\n"
      + "      export MPESA_TEST_PHONE='07XXXXXXXX'");
  }
  const phone = mpesa.normalizePhone(rawPhone);
  if (!phone) fail(`MPESA_TEST_PHONE="${rawPhone}" is not a valid Safaricom number.`);
  ok(`prompt will be sent to ${phone.slice(0, 6)}***${phone.slice(-2)}`);

  // ── R2: the amount comes from the SERVER's catalog ─────────────
  const entitlements = require(path.join("..", "src", "services", "entitlements"));
  const price = entitlements.priceFor("growth");
  if (!price) fail("The catalog does not price the growth plan.");
  ok(`server price for ${price.label}: ${price.currency} ${price.amount}`);

  if (!Number.isInteger(price.amount)) {
    fail(`The catalog price ${price.amount} is not a whole number of shillings; `
      + "Daraja rejects fractional amounts.");
  }

  /* SANDBOX CHARGES THE CATALOG PRICE, not a token amount. Substituting 1
     shilling here would test a different request than production sends. */
  const amount = price.amount;

  // ── R1: a real STK push ────────────────────────────────────────
  const reference = `fgv${Date.now().toString(36)}`.slice(0, 12);
  console.log("\n  Initiating a REAL sandbox STK push…");
  const initiated = await mpesa.initiatePayment({
    amount,
    reference,
    payerReference: phone,
    description: "FinGuard verify"
  });

  if (!initiated.ok) {
    fail(`R1 STK push FAILED: ${initiated.detail}\n`
      + "    Common causes: the credentials are for a different app; the Lipa Na\n"
      + "    M-Pesa product is not enabled on this sandbox app; the passkey does\n"
      + "    not match the shortcode.");
  }
  if (initiated.status !== "pending") {
    fail(`R1 returned status "${initiated.status}". An accepted prompt must be `
      + "PENDING — treating it as paid is how a subscription is given away.");
  }
  ok("R1 STK push accepted by Safaricom");
  info(`AccountReference (ours):  ${reference}`);
  info(`CheckoutRequestID (theirs): ${initiated.providerRef}`);
  info("^ quote these two when tracing this attempt in the Daraja portal");

  // ── R5: independent verification, for real ─────────────────────
  console.log("\n  Querying Safaricom about that checkout (the R5 channel)…");
  const verified = await mpesa.verifyPayment({ providerRef: initiated.providerRef });
  ok(`R5 STK Push Query answered: status "${verified.status}"`);

  if (verified.status === "pending") {
    info("pending is correct here — the prompt is still on the handset, or has");
    info("not been approved yet. That is the state the route relies on: nothing");
    info("is activated until Safaricom says the money moved.");
  } else if (verified.status === "successful") {
    ok("Safaricom reports the payment as COMPLETE");
  } else {
    info(`Safaricom reports "${verified.status}" — no activation would occur.`);
  }

  const verifiedBlob = JSON.stringify(verified);
  REQUIRED.forEach((k) => {
    if (process.env[k] && verifiedBlob.includes(process.env[k])) {
      fail(`A credential (${k}) appeared in the verification response. Redaction failed.`);
    }
  });
  ok("no credential material appears in the provider response");

  // ── Idempotency: OUR guarantee, asserted locally ───────────────
  console.log("\n  Duplicate handling (LOCAL assertion, not a Daraja behaviour)…");
  const cb = {
    Body: {
      stkCallback: {
        CheckoutRequestID: initiated.providerRef,
        ResultCode: 0,
        ResultDesc: "The service request is processed successfully.",
        CallbackMetadata: {
          Item: [
            { Name: "Amount", Value: amount },
            { Name: "MpesaReceiptNumber", Value: "VERIFY0000" }
          ]
        }
      }
    }
  };
  const first = mpesa.handleWebhook({ body: cb });
  const second = mpesa.handleWebhook({ body: cb });
  if (!first.ok || first.providerRef !== initiated.providerRef) {
    fail("The adapter did not correlate its own callback back to this checkout.");
  }
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    fail("Parsing the same callback twice produced two different results.");
  }
  ok("a repeated callback parses identically — settlement de-duplicates on");
  info("UNIQUE (provider, provider_ref) under a row lock; proven against a real");
  info("database in tests/http/mpesaSecurity.test.js [MS6] and [MS7].");

  /* HONESTY. Whether a duplicate DELIVERY produces one activation is a
     property of the route and the database, not of this script. It is not
     re-asserted here, because doing so against a mocked callback would look
     like a live result and is not one. */

  // ── What only a human can finish ───────────────────────────────
  console.log("\n  Automated sandbox checks passed. To complete the flow end to end:\n");
  manual("1. Approve the prompt on the handset (sandbox PIN is usually 1234,");
  manual("   or use the Daraja simulator for the test MSISDN).");
  /* The REAL port, not a guess. Telling an operator to tunnel 3000 when the
     app is on 8080 produces a tunnel to nothing and a callback that never
     arrives — which looks exactly like a broken integration. */
  const appPort = process.env.PORT || "3000";
  manual("2. Expose this server publicly so Safaricom can reach the callback:");
  manual(`      cloudflared tunnel --url http://localhost:${appPort}`);
  manual(`      (or: ngrok http ${appPort})`);
  manual("   MPESA_CALLBACK_URL must be that HTTPS URL + /api/billing/webhook/mpesa");
  manual(`   currently: ${process.env.MPESA_CALLBACK_URL}`);
  manual("3. Start the app with PAYMENT_PROVIDER=mpesa and watch for");
  manual("   `billing.subscription_activated` in the log.");
  manual("4. Confirm the plan changes ONLY after the callback lands, and that");
  manual("   replaying the same callback changes nothing.");
  manual("5. Abandon a second checkout and confirm the plan does NOT change.");
  console.log("");
  ok("R1 and R5 were REAL calls to Safaricom. The callback leg above is manual.");
  console.log("");
})().catch((err) => fail(err && err.message ? err.message : String(err)));
