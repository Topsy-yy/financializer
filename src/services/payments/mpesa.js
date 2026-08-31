// M-PESA (Safaricom Daraja) — STK Push.
//
// The first real provider, chosen because the target customers are Kenyan SMEs
// who pay by phone. Everything Safaricom-specific is confined to this file; the
// rest of the application sees only the four states in provider.js.
//
// CREDENTIALS come from the environment, are never logged, and never leave the
// server. Daraja error payloads routinely echo the shortcode and occasionally
// the passkey, so responses are redacted before they are recorded.
//
//   MPESA_CONSUMER_KEY / MPESA_CONSUMER_SECRET   API credentials
//   MPESA_SHORTCODE                              paybill / till
//   MPESA_PASSKEY                                STK password seed
//   MPESA_CALLBACK_URL                           HTTPS, publicly reachable
//   MPESA_ENV                                    "sandbox" | "production"
//
// WHAT THIS ADAPTER WILL NOT DO. `initiatePayment` never returns `successful`.
// Daraja's synchronous response only means the prompt was queued; the money is
// confirmed by the callback, or by an explicit status query. Anything else is
// how a checkout gets defrauded.

const crypto = require("crypto");
const { PAYMENT_STATUS } = require("./provider");
const { logger } = require("../logger");

const log = logger.child({ component: "mpesa" });

const HOSTS = {
  sandbox: "https://sandbox.safaricom.co.ke",
  production: "https://api.safaricom.co.ke"
};

function config() {
  return {
    consumerKey: process.env.MPESA_CONSUMER_KEY || "",
    consumerSecret: process.env.MPESA_CONSUMER_SECRET || "",
    shortcode: process.env.MPESA_SHORTCODE || "",
    passkey: process.env.MPESA_PASSKEY || "",
    callbackUrl: process.env.MPESA_CALLBACK_URL || "",
    host: HOSTS[String(process.env.MPESA_ENV || "sandbox").toLowerCase()] || HOSTS.sandbox
  };
}

function isConfigured() {
  const c = config();
  return Boolean(c.consumerKey && c.consumerSecret && c.shortcode
    && c.passkey && c.callbackUrl);
}

function missingConfig() {
  const c = config();
  return [
    !c.consumerKey && "MPESA_CONSUMER_KEY",
    !c.consumerSecret && "MPESA_CONSUMER_SECRET",
    !c.shortcode && "MPESA_SHORTCODE",
    !c.passkey && "MPESA_PASSKEY",
    !c.callbackUrl && "MPESA_CALLBACK_URL"
  ].filter(Boolean);
}

/** Strip credential material out of anything before it is logged or stored. */
function redact(value) {
  const c = config();
  let text = typeof value === "string" ? value : JSON.stringify(value || {});
  [c.consumerSecret, c.passkey, c.consumerKey].forEach((secret) => {
    if (secret) text = text.split(secret).join("[redacted]");
  });
  return text.slice(0, 500);
}

/**
 * Normalise a Kenyan number to Daraja's 2547XXXXXXXX form.
 * Returns null for anything that is not a plausible Safaricom mobile number.
 */
function normalizePhone(input) {
  const digits = String(input || "").replace(/[^0-9]/g, "");
  if (!digits) return null;
  let n = digits;
  if (n.startsWith("0")) n = `254${n.slice(1)}`;
  else if (n.startsWith("7") || n.startsWith("1")) n = `254${n}`;
  else if (n.startsWith("254")) { /* already */ }
  else return null;
  // 254 + 9 digits, second segment starting 7 or 1.
  return /^254[17]\d{8}$/.test(n) ? n : null;
}

let cachedToken = null;

async function accessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30000) return cachedToken.value;
  const c = config();
  const basic = Buffer.from(`${c.consumerKey}:${c.consumerSecret}`).toString("base64");
  const res = await fetch(`${c.host}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { authorization: `Basic ${basic}` }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`mpesa auth failed: ${redact(body)}`);
  }
  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + (Number(body.expires_in || 3599) * 1000)
  };
  return cachedToken.value;
}

function stkPassword(shortcode, passkey, timestamp) {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64");
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Send an STK prompt to the payer's phone.
 *
 * Returns `pending` on success — never `successful`. The prompt has been
 * queued; nothing has been paid.
 */
async function initiatePayment({
  amount, reference, payerReference, description, accountReference
}) {
  const c = config();
  const phone = normalizePhone(payerReference);
  if (!phone) {
    return { ok: false, status: PAYMENT_STATUS.FAILED, detail: "That is not a valid M-Pesa phone number." };
  }
  /* Daraja rejects non-integer amounts. Rounding UP would overcharge, so a
     fractional price is a configuration error rather than something to paper
     over silently. */
  if (!Number.isInteger(amount) || amount <= 0) {
    return { ok: false, status: PAYMENT_STATUS.FAILED, detail: "Amount must be a whole number of shillings." };
  }

  const ts = timestamp();
  try {
    const token = await accessToken();
    const res = await fetch(`${c.host}/mpesa/stkpush/v1/processrequest`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: c.shortcode,
        Password: stkPassword(c.shortcode, c.passkey, ts),
        Timestamp: ts,
        TransactionType: "CustomerPayBillOnline",
        Amount: amount,
        PartyA: phone,
        PartyB: c.shortcode,
        PhoneNumber: phone,
        CallBackURL: c.callbackUrl,
        /* WHAT THE CUSTOMER READS ON THE PROMPT, and on their M-Pesa statement
           afterwards. Correlation does NOT depend on this — settlement matches
           on Safaricom's CheckoutRequestID — so it carries a readable label
           rather than our payment id. `reference` remains the fallback so an
           adapter call that supplies no label still sends something unique. */
        AccountReference: String(accountReference || reference).slice(0, 12),
        TransactionDesc: String(description || "Subscription").slice(0, 13)
      })
    });
    const body = await res.json().catch(() => ({}));

    if (!res.ok || body.ResponseCode !== "0") {
      log.warn("mpesa.initiate_rejected", { detail: redact(body) });
      return {
        ok: false,
        status: PAYMENT_STATUS.FAILED,
        /* REDACTED. Daraja echoes credential material in `errorMessage` —
           "Bad Request - Invalid Passkey <passkey>" is a real response — and
           this string is returned to the caller and rendered in the UI. The
           stored `raw` below was already redacted; this was not, so the
           passkey left the server through the one field a user actually
           reads. */
        detail: redact(body.errorMessage || body.ResponseDescription
          || "M-Pesa rejected the request."),
        raw: JSON.parse(redact(body))
      };
    }

    log.info("mpesa.initiated", { checkoutRequestId: body.CheckoutRequestID });
    return {
      ok: true,
      // PENDING. The customer has been prompted; they have not paid.
      status: PAYMENT_STATUS.PENDING,
      providerRef: body.CheckoutRequestID,
      detail: "Check your phone and enter your M-Pesa PIN to approve the payment."
    };
  } catch (err) {
    log.error("mpesa.initiate_failed", { detail: redact(err.message) });
    return { ok: false, status: PAYMENT_STATUS.FAILED, detail: "Could not reach M-Pesa. Try again." };
  }
}

/** Ask Daraja directly what happened to a checkout. */
async function verifyPayment({ providerRef }) {
  const c = config();
  const ts = timestamp();
  try {
    const token = await accessToken();
    const res = await fetch(`${c.host}/mpesa/stkpushquery/v1/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: c.shortcode,
        Password: stkPassword(c.shortcode, c.passkey, ts),
        Timestamp: ts,
        CheckoutRequestID: providerRef
      })
    });
    const body = await res.json().catch(() => ({}));
    return { status: statusFromResultCode(body.ResultCode), raw: JSON.parse(redact(body)) };
  } catch (err) {
    // Unreachable is NOT failed — the payment may well have succeeded.
    return { status: PAYMENT_STATUS.PENDING, detail: redact(err.message) };
  }
}

/**
 * Daraja result codes.
 *   0    paid
 *   1032 cancelled by the user
 *   1037 timed out (no response on the handset)
 * Anything else is a genuine failure.
 */
function statusFromResultCode(code) {
  /* AN ABSENT CODE IS NOT A ZERO.
     `Number(null)`, `Number("")` and `Number(false)` are all 0, so a payload
     carrying `ResultCode: null` — exactly what a JSON field explicitly set to
     null gives you — was read as ResultCode 0 and reported as a COMPLETED
     PAYMENT. Through the callback route that is an activation derived from no
     evidence at all, and the R5 re-query could not catch it because the query
     response would be mis-read the same way. Only a value that is genuinely a
     number, or a string that spells one, is a result code. */
  if (typeof code !== "number" && typeof code !== "string") return PAYMENT_STATUS.PENDING;
  if (typeof code === "string" && code.trim() === "") return PAYMENT_STATUS.PENDING;

  const n = Number(code);
  if (!Number.isFinite(n)) return PAYMENT_STATUS.PENDING;

  if (n === 0) return PAYMENT_STATUS.SUCCESSFUL;
  if (n === 1032) return PAYMENT_STATUS.CANCELLED;
  if (n === 1037) return PAYMENT_STATUS.EXPIRED;
  return PAYMENT_STATUS.FAILED;
}

/**
 * Normalise a Daraja callback.
 *
 * Extracts only the correlation id and the outcome. THIS DOES NOT AUTHORISE
 * ANYTHING — the caller still has to find a matching pending payment for the
 * right tenant, and the amount is checked against our own record, not against
 * whatever the callback claims.
 */
function handleWebhook({ body }) {
  const cb = (body && body.Body && body.Body.stkCallback) || null;
  if (!cb || !cb.CheckoutRequestID) {
    return { ok: false, detail: "unrecognised callback shape" };
  }
  const items = (cb.CallbackMetadata && cb.CallbackMetadata.Item) || [];
  const pick = (name) => {
    const found = items.find((i) => i && i.Name === name);
    return found ? found.Value : null;
  };

  return {
    ok: true,
    providerRef: cb.CheckoutRequestID,
    status: statusFromResultCode(cb.ResultCode),
    detail: cb.ResultDesc || null,
    // Reported for reconciliation. Deliberately NOT used to decide the amount —
    // the authoritative figure is the one we wrote at checkout.
    reportedAmount: pick("Amount"),
    receipt: pick("MpesaReceiptNumber"),
    raw: JSON.parse(redact(cb))
  };
}

module.exports = {
  initiatePayment, verifyPayment, handleWebhook,
  isConfigured, missingConfig, normalizePhone, statusFromResultCode, redact
};
