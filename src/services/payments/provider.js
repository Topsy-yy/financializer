// THE PAYMENT PROVIDER BOUNDARY.
//
// Everything above this line understands exactly four states:
//
//     pending · successful · failed · expired
//
// Nothing outside this directory knows what an STK Push is, what a
// CheckoutRequestID looks like, or that Safaricom exists. Adding Stripe later
// is a new adapter implementing this interface, not a billing rewrite — which
// is the whole reason the boundary is here rather than M-Pesa calls scattered
// through routes and entitlement logic.
//
// THE CONTRACT
//
//   initiatePayment({ amount, currency, reference, payerReference, description })
//     -> { ok, providerRef, detail }        starts a charge; NEVER confirms one
//
//   verifyPayment({ providerRef })
//     -> { status, raw, detail }            asks the provider what happened
//
//   handleWebhook({ body, headers })
//     -> { ok, providerRef, status, raw }   normalises a callback
//
// WHY `initiatePayment` CANNOT CONFIRM. A provider accepting a request means a
// prompt was sent to a phone, nothing more. Treating that response as payment
// is the single most common way a checkout gets defrauded, so no adapter is
// permitted to return `successful` from it.

/** The only payment states the rest of the application knows. */
const PAYMENT_STATUS = Object.freeze({
  PENDING: "pending",
  SUCCESSFUL: "successful",
  FAILED: "failed",
  EXPIRED: "expired",
  CANCELLED: "cancelled"
});

/** Registered adapters, by name. */
const adapters = new Map();

function register(name, adapter) {
  ["initiatePayment", "verifyPayment", "handleWebhook", "isConfigured"].forEach((fn) => {
    if (typeof adapter[fn] !== "function") {
      throw new Error(`payment adapter "${name}" is missing ${fn}()`);
    }
  });
  adapters.set(name, adapter);
}

/**
 * The adapter this deployment uses.
 *
 * `PAYMENT_PROVIDER` selects it. Unset, there is NO provider — checkout reports
 * itself unavailable rather than falling back to something that pretends to
 * work. A development fallback that "succeeds" is how fake payments reach
 * production.
 */
function active() {
  const name = String(process.env.PAYMENT_PROVIDER || "").toLowerCase();
  if (!name) return null;
  const adapter = adapters.get(name);
  if (!adapter) return null;
  return adapter.isConfigured() ? adapter : null;
}

/** Which provider is configured, and is it usable? */
function status() {
  const name = String(process.env.PAYMENT_PROVIDER || "").toLowerCase();
  if (!name) {
    return { configured: false, provider: null, reason: "no_provider_selected" };
  }
  const adapter = adapters.get(name);
  if (!adapter) {
    return { configured: false, provider: name, reason: "unknown_provider" };
  }
  if (!adapter.isConfigured()) {
    return {
      configured: false, provider: name, reason: "provider_not_configured",
      missing: typeof adapter.missingConfig === "function" ? adapter.missingConfig() : []
    };
  }
  return { configured: true, provider: name };
}

module.exports = { PAYMENT_STATUS, register, active, status, adapters };
