// PAYSTACK — the primary payment provider.
//
// WHY THIS AND NOT DIRECT DARAJA (which this repository already has an adapter
// for). Three reasons, in order of weight:
//
//   1. IT SIGNS ITS WEBHOOKS. Paystack sends `x-paystack-signature`, an
//      HMAC-SHA512 of the RAW request body keyed with the secret key. Daraja
//      sends no signature at all — with it, a callback can only be
//      authenticated by IP allowlisting plus a re-query, which is slower,
//      rate-limited and easy to get subtly wrong. A payment webhook that
//      cannot be cryptographically verified is the weakest link in a billing
//      system, and this is a billing system.
//   2. REGULATORY SAFETY. Paystack has held a CBK Payment Service Provider
//      licence since November 2022. Flutterwave's Kenyan licensing history
//      includes a CBK order to banks to cease dealings — unacceptable
//      counterparty risk for an SME's revenue rail.
//   3. ONE INTEGRATION, BOTH RAILS. M-Pesa for the majority, and genuine card
//      auto-renewal for anyone who wants it, without a second adapter.
//
// Direct Daraja is cheaper (0.55% vs 1.5%) and its adapter stays in the tree
// for a future volume-driven switch. At this stage the fee difference does not
// pay for the reconciliation and authenticity work it would require.
//
// ON "SUBSCRIPTIONS": M-PESA HAS NO MERCHANT-INITIATED AUTO-DEBIT. Not through
// Paystack, not through Pesapal, not through Flutterwave — it is a limitation
// of M-Pesa itself. Paystack's Plans & Subscriptions are card-only. So a paid
// period here is exactly what it looks like: one payment buys one month, and
// the customer is prompted to renew. Calling that a "subscription" in the UI
// would be a lie, and the model in billingRepository reflects the truth.
//
//   PAYSTACK_SECRET_KEY    sk_test_… / sk_live_… (server-side only, never sent)
//   PAYSTACK_PUBLIC_KEY    optional, for a future inline checkout
//   PAYSTACK_CALLBACK_URL  where the customer is returned after paying

const crypto = require("crypto");
const { PAYMENT_STATUS } = require("./provider");
const { logger } = require("../logger");

const log = logger.child({ component: "paystack" });

const API = "https://api.paystack.co";

function config() {
  return {
    secretKey: process.env.PAYSTACK_SECRET_KEY || "",
    callbackUrl: process.env.PAYSTACK_CALLBACK_URL || ""
  };
}

function isConfigured() {
  return Boolean(config().secretKey);
}

function missingConfig() {
  return config().secretKey ? [] : ["PAYSTACK_SECRET_KEY"];
}

/** Never let the secret key reach a log line or an API response. */
function redact(value) {
  const { secretKey } = config();
  let text = typeof value === "string" ? value : JSON.stringify(value || {});
  if (secretKey) text = text.split(secretKey).join("[redacted]");
  return text.slice(0, 400);
}

/**
 * VERIFY A WEBHOOK.
 *
 * HMAC-SHA512 of the RAW body, keyed with the secret key, compared against
 * `x-paystack-signature` in constant time.
 *
 * THE RAW BODY MATTERS. Re-serialising a parsed object changes key order and
 * whitespace, so the digest would never match; the route captures the exact
 * bytes for this reason. Verifying a re-encoded body is a classic way to end up
 * with a signature check that silently always fails — or worse, one that is
 * quietly skipped because "it never matched anyway".
 */
function verifySignature({ rawBody, headers }) {
  const { secretKey } = config();
  if (!secretKey) return { valid: false, reason: "not_configured" };

  const provided = String(
    (headers && (headers["x-paystack-signature"] || headers["X-Paystack-Signature"])) || "");
  if (!provided) return { valid: false, reason: "missing_signature" };

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ""), "utf8");
  const expected = crypto.createHmac("sha512", secretKey).update(body).digest("hex");

  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  // Length check first: timingSafeEqual throws on a mismatch.
  if (a.length !== b.length) return { valid: false, reason: "signature_mismatch" };
  if (!crypto.timingSafeEqual(a, b)) return { valid: false, reason: "signature_mismatch" };
  return { valid: true };
}

async function call(path, { method = "GET", body } = {}) {
  const { secretKey } = config();
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${secretKey}`,
      "content-type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, json };
}

/**
 * Start a charge.
 *
 * Returns PENDING. A transaction being initialised means a checkout page
 * exists, not that anyone has paid — the same rule the M-Pesa adapter follows.
 */
async function initiatePayment({ amount, currency, reference, payerReference, description }) {
  if (!Number.isInteger(amount) || amount <= 0) {
    return { ok: false, status: PAYMENT_STATUS.FAILED, detail: "Amount must be a whole number." };
  }

  try {
    /* Paystack takes the SUBUNIT — cents for KES. Getting this wrong charges
       100x or 1/100x, so the conversion is explicit and in one place. */
    const subunit = amount * 100;

    const { ok, json } = await call("/transaction/initialize", {
      method: "POST",
      body: {
        // Paystack requires an email; the phone number is carried as metadata
        // so an M-Pesa payer does not have to supply one they may not have.
        email: payerReference && payerReference.includes("@")
          ? payerReference
          : `${String(reference).toLowerCase()}@finguard.invalid`,
        amount: subunit,
        currency: currency || "KES",
        reference: String(reference),
        callback_url: config().callbackUrl || undefined,
        // M-Pesa first for this market; card remains available.
        channels: ["mobile_money", "card"],
        metadata: {
          description: description || "FinGuard subscription",
          phone: payerReference || null
        }
      }
    });

    if (!ok || !json.status || !json.data) {
      log.warn("paystack.initiate_rejected", { detail: redact(json) });
      return {
        ok: false, status: PAYMENT_STATUS.FAILED,
        detail: json.message || "The payment could not be started."
      };
    }

    log.info("paystack.initiated", { reference: json.data.reference });
    return {
      ok: true,
      status: PAYMENT_STATUS.PENDING,
      // Paystack echoes our own reference; correlation uses it directly.
      providerRef: json.data.reference,
      // Where the customer completes payment (M-Pesa prompt or card).
      redirectUrl: json.data.authorization_url,
      detail: "Complete the payment to activate your plan."
    };
  } catch (err) {
    log.error("paystack.initiate_failed", { detail: redact(err.message) });
    return { ok: false, status: PAYMENT_STATUS.FAILED, detail: "Could not reach Paystack." };
  }
}

/** Ask Paystack directly. Used to settle anything a webhook did not. */
async function verifyPayment({ providerRef }) {
  try {
    const { ok, json } = await call(`/transaction/verify/${encodeURIComponent(providerRef)}`);
    if (!ok || !json.data) return { status: PAYMENT_STATUS.PENDING, raw: {} };
    return {
      status: statusFrom(json.data.status),
      // The amount is reported for reconciliation only; the authoritative
      // figure is the one written at checkout.
      reportedAmount: json.data.amount != null ? json.data.amount / 100 : null,
      raw: JSON.parse(redact(json.data))
    };
  } catch (err) {
    // Unreachable is NOT failed — the payment may well have gone through.
    return { status: PAYMENT_STATUS.PENDING, detail: redact(err.message) };
  }
}

function statusFrom(paystackStatus) {
  switch (String(paystackStatus || "").toLowerCase()) {
    case "success": return PAYMENT_STATUS.SUCCESSFUL;
    case "failed": return PAYMENT_STATUS.FAILED;
    case "abandoned": return PAYMENT_STATUS.EXPIRED;
    case "reversed": return PAYMENT_STATUS.FAILED;
    default: return PAYMENT_STATUS.PENDING;
  }
}

/**
 * Normalise a verified callback.
 *
 * Called ONLY after `verifySignature` has passed — this function assumes
 * authenticity and does not re-establish it.
 */
function handleWebhook({ body }) {
  const event = body && body.event;
  const data = (body && body.data) || null;
  if (!event || !data || !data.reference) {
    return { ok: false, detail: "unrecognised event shape" };
  }

  /* Only charge outcomes move a subscription. Paystack emits many other events
     (transfers, disputes, customer updates) and they must not be mistaken for
     payment. Anything unrecognised leaves the payment pending. */
  let status = PAYMENT_STATUS.PENDING;
  if (event === "charge.success") status = PAYMENT_STATUS.SUCCESSFUL;
  else if (event === "charge.failed") status = PAYMENT_STATUS.FAILED;

  return {
    ok: true,
    providerRef: data.reference,
    status,
    detail: data.gateway_response || event,
    reportedAmount: data.amount != null ? data.amount / 100 : null,
    receipt: data.reference,
    raw: JSON.parse(redact(data))
  };
}

module.exports = {
  initiatePayment, verifyPayment, handleWebhook, verifySignature,
  isConfigured, missingConfig, statusFrom, redact
};
