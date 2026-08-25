// DETERMINISTIC TEST PROVIDER.
//
// The payment flow has to be exercised end to end — checkout, callback,
// activation, idempotency, concurrency — without Safaricom credentials. This
// adapter makes the outcome a deliberate choice of the test rather than a
// network round trip.
//
// IT CANNOT RUN IN PRODUCTION. `isConfigured()` refuses unless NODE_ENV is
// `test` or `development`, so selecting `PAYMENT_PROVIDER=test` on a production
// deployment yields no provider at all and checkout reports itself unavailable.
// That is the point: the one thing worse than having no payments is a
// production system that believes it was paid.
//
// It also never SELF-completes. Like the real adapter, `initiatePayment`
// returns `pending`; a test drives the outcome by delivering a webhook, exactly
// as Safaricom would.

const crypto = require("crypto");
const { PAYMENT_STATUS } = require("./provider");

function isConfigured() {
  const env = process.env.NODE_ENV;
  // Never outside a test or development process.
  return env === "test" || env === "development";
}

function missingConfig() {
  return isConfigured() ? [] : ["NODE_ENV must be test or development"];
}

/** Outcomes queued by a test, keyed by provider reference. */
const outcomes = new Map();

/** A test declares what the provider will report for a reference. */
function queueOutcome(providerRef, status, extra = {}) {
  outcomes.set(providerRef, Object.assign({ status }, extra));
}

function reset() { outcomes.clear(); }

/**
 * The test provider signs too, using the same scheme as Paystack, so the
 * signature path is exercised in CI rather than only in production. The secret
 * is a fixed test value — this adapter cannot run outside test/development.
 */
const TEST_SIGNING_SECRET = "test-webhook-secret";

function sign(rawBody) {
  return crypto.createHmac("sha512", TEST_SIGNING_SECRET)
    .update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), "utf8"))
    .digest("hex");
}

function verifySignature({ rawBody, headers }) {
  const provided = String((headers && headers["x-test-signature"]) || "");
  if (!provided) return { valid: false, reason: "missing_signature" };
  const expected = sign(rawBody);
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return { valid: false, reason: "signature_mismatch" };
  return crypto.timingSafeEqual(a, b)
    ? { valid: true }
    : { valid: false, reason: "signature_mismatch" };
}

async function initiatePayment({ amount, reference, payerReference }) {
  if (!Number.isInteger(amount) || amount <= 0) {
    return { ok: false, status: PAYMENT_STATUS.FAILED, detail: "invalid amount" };
  }
  if (!payerReference) {
    return { ok: false, status: PAYMENT_STATUS.FAILED, detail: "no payer reference" };
  }
  const providerRef = `test_${crypto.randomBytes(8).toString("hex")}`;
  return {
    ok: true,
    // PENDING, like the real thing. Nothing is paid until a callback says so.
    status: PAYMENT_STATUS.PENDING,
    providerRef,
    detail: `Test provider: awaiting simulated approval for ${reference}.`
  };
}

/**
 * Independent verification (R5).
 *
 * A test may queue a CONTRADICTING outcome to prove that the second check is
 * real — that a signed callback claiming success is refused when the provider
 * itself says otherwise. With nothing queued the default is `successful`, so
 * the ordinary webhook path behaves like a provider that confirms.
 */
async function verifyPayment({ providerRef }) {
  const queued = outcomes.get(providerRef);
  /* The adapter runs inside the SERVER process, so a queue set by a test
     process cannot reach it. `TEST_VERIFY_STATUS` lets a test start a server
     whose provider contradicts its own callbacks — which is the only way to
     exercise the independent-verification path end to end. Test-only, like
     everything else in this adapter. */
  const forced = process.env.TEST_VERIFY_STATUS || "";
  if (forced) {
    return { status: forced, raw: { provider: "test", providerRef, forced: true } };
  }
  return {
    status: queued ? queued.status : PAYMENT_STATUS.SUCCESSFUL,
    raw: { provider: "test", providerRef, queued: Boolean(queued) }
  };
}

/** A test delivers this shape to the webhook route. */
function handleWebhook({ body }) {
  const b = body || {};
  if (!b.providerRef) return { ok: false, detail: "no providerRef" };
  const status = b.status || PAYMENT_STATUS.SUCCESSFUL;
  return {
    ok: true,
    providerRef: b.providerRef,
    status,
    detail: b.detail || null,
    reportedAmount: b.amount == null ? null : Number(b.amount),
    receipt: b.receipt || `TESTRCPT${String(b.providerRef).slice(-6)}`,
    raw: { provider: "test", ...b }
  };
}

module.exports = {
  initiatePayment, verifyPayment, handleWebhook, verifySignature,
  isConfigured, missingConfig, queueOutcome, reset,
  // Exported so tests can sign a body exactly as a provider would.
  sign, TEST_SIGNING_SECRET
};
