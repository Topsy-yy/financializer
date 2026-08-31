// M-PESA (Safaricom Daraja) ADAPTER.
//
// The adapter shipped with no tests at all. Everything below runs with mocked
// HTTP and a frozen clock, so it needs no Daraja credentials and makes no
// network call — but it holds the adapter to the shape Safaricom actually
// requires, and to the promises this codebase makes about money.
//
// THE TWO PROPERTIES WORTH MOST:
//
//   `initiatePayment` NEVER returns `successful`. Daraja's synchronous reply
//   only means the prompt was queued. A checkout that treats "accepted" as
//   "paid" is how a subscription is given away.
//
//   CREDENTIALS NEVER ESCAPE. Daraja echoes the shortcode and, on some errors,
//   the passkey. Anything returned to a caller or handed to the logger is
//   redacted first.
//
// The module caches an OAuth token in module scope, so it is reloaded per test
// rather than shared — otherwise a token minted under one set of credentials
// leaks into a test using another.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const MODULE = path.join(__dirname, "../../src/services/payments/mpesa.js");

const GOOD_ENV = {
  MPESA_CONSUMER_KEY: "ck_live_looking_but_fake",
  MPESA_CONSUMER_SECRET: "cs_super_secret_value",
  MPESA_SHORTCODE: "174379",
  MPESA_PASSKEY: "pk_passkey_secret_value",
  MPESA_CALLBACK_URL: "https://finguard.example/api/billing/webhook/mpesa",
  MPESA_ENV: "sandbox"
};

/** Frozen clock: Daraja timestamps and passwords must be reproducible. */
const FROZEN = new Date(2026, 6, 9, 14, 5, 3);   // local time, 2026-07-09 14:05:03

function withEnv(vars, fn) {
  const saved = {};
  Object.keys(vars).forEach((k) => { saved[k] = process.env[k]; });
  Object.entries(vars).forEach(([k, v]) => {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
  const restore = () => Object.entries(saved).forEach(([k, v]) => {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });

  /* AWAIT BEFORE RESTORING. A plain try/finally puts the environment back the
     instant the promise is RETURNED, not when it settles — so the adapter ran
     with the variables already gone, `redact()` had no secret to match, and a
     passkey sailed through a test written to catch exactly that. The bug was
     in this helper, and it made the code under test look broken. */
  let out;
  try { out = fn(); } catch (err) { restore(); throw err; }
  if (out && typeof out.then === "function") {
    return out.then(
      (v) => { restore(); return v; },
      (e) => { restore(); throw e; }
    );
  }
  restore();
  return out;
}

/**
 * A fresh adapter with a fresh token cache, a stubbed `fetch` and a frozen
 * clock. Returns the calls the adapter made, which is how request SHAPE is
 * asserted rather than assumed.
 */
function load({ env = GOOD_ENV, routes = {}, now = FROZEN } = {}) {
  delete require.cache[require.resolve(MODULE)];

  const calls = [];
  const realFetch = global.fetch;
  const realDate = global.Date;

  class FrozenDate extends realDate {
    constructor(...args) { super(...(args.length ? args : [now.getTime()])); }
    static now() { return now.getTime(); }
  }
  global.Date = FrozenDate;

  global.fetch = async (url, init = {}) => {
    const u = String(url);
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch { body = init.body; }
    calls.push({ url: u, method: init.method || "GET", headers: init.headers || {}, body });

    const key = Object.keys(routes).sort((a, b) => b.length - a.length)
      .find((k) => u.includes(k));
    if (!key) return { ok: true, status: 200, json: async () => ({}) };
    const out = await routes[key]({ url: u, init, body, calls });
    if (out && out.__throw) throw out.__throw;
    return {
      ok: out.ok !== false,
      status: out.status || (out.ok === false ? 500 : 200),
      json: async () => (out.json === undefined ? out : out.json)
    };
  };

  const restore = () => { global.fetch = realFetch; global.Date = realDate; };
  const mpesa = withEnv(env, () => require(MODULE));
  return { mpesa, calls, restore, env };
}

/** Run `fn` with a loaded adapter, with the environment applied throughout. */
async function run(opts, fn) {
  const ctx = load(opts);
  try {
    return await withEnv(ctx.env, () => fn(ctx));
  } finally { ctx.restore(); }
}

const OAUTH = "/oauth/v1/generate";
const STK = "/mpesa/stkpush/v1/processrequest";
const QUERY = "/mpesa/stkpushquery/v1/query";

const tokenRoute = () => ({ access_token: "tok_abc123", expires_in: 3599 });

// ══════════════════════════════════════════════════════════════════
// 1. CONFIGURATION
// ══════════════════════════════════════════════════════════════════

test("[MP1] isConfigured requires every Daraja variable", async () => {
  await run({}, ({ mpesa }) => {
    assert.equal(mpesa.isConfigured(), true, "a complete environment is configured");
    assert.deepEqual(mpesa.missingConfig(), []);
  });

  /* Each variable is load-bearing. Dropping any ONE must make the adapter
     report itself unusable — a half-configured payment provider that reports
     ready is how a checkout dies at the last step. */
  for (const key of Object.keys(GOOD_ENV)) {
    if (key === "MPESA_ENV") continue;          // optional; defaults to sandbox
    const env = Object.assign({}, GOOD_ENV, { [key]: undefined });
    await run({ env }, ({ mpesa }) => {
      assert.equal(mpesa.isConfigured(), false, `${key} missing must not be configured`);
      assert.deepEqual(mpesa.missingConfig(), [key],
        `${key} is named, so an operator knows exactly what to set`);
    });
  }
});

test("[MP2] an empty environment names every missing variable", async () => {
  const env = Object.fromEntries(Object.keys(GOOD_ENV).map((k) => [k, undefined]));
  await run({ env }, ({ mpesa }) => {
    assert.equal(mpesa.isConfigured(), false);
    assert.deepEqual(mpesa.missingConfig(), [
      "MPESA_CONSUMER_KEY", "MPESA_CONSUMER_SECRET", "MPESA_SHORTCODE",
      "MPESA_PASSKEY", "MPESA_CALLBACK_URL"
    ]);
  });
});

test("[MP3] MPESA_ENV selects the base host, and defaults to sandbox", async () => {
  const cases = [
    ["sandbox", "https://sandbox.safaricom.co.ke"],
    ["production", "https://api.safaricom.co.ke"],
    ["PRODUCTION", "https://api.safaricom.co.ke"],
    [undefined, "https://sandbox.safaricom.co.ke"],
    /* An unrecognised value must NOT fall through to production. Defaulting a
       typo to the live host would move real money. */
    ["staging", "https://sandbox.safaricom.co.ke"]
  ];
  for (const [value, expected] of cases) {
    const env = Object.assign({}, GOOD_ENV, { MPESA_ENV: value });
    await run({
      env,
      routes: { [OAUTH]: tokenRoute, [STK]: () => ({ ResponseCode: "0", CheckoutRequestID: "ws_CO_1" }) }
    }, async ({ mpesa, calls }) => {
      await mpesa.initiatePayment({ amount: 2500, reference: "pay_1", payerReference: "0712345678" });
      calls.forEach((c) => assert.ok(c.url.startsWith(expected),
        `MPESA_ENV=${value} must call ${expected}, got ${c.url}`));
    });
  }
});

// ══════════════════════════════════════════════════════════════════
// 2. OAUTH
// ══════════════════════════════════════════════════════════════════

test("[MP4] the token request uses Basic auth over key:secret", async () => {
  await run({
    routes: { [OAUTH]: tokenRoute, [STK]: () => ({ ResponseCode: "0", CheckoutRequestID: "ws_CO_1" }) }
  }, async ({ mpesa, calls }) => {
    await mpesa.initiatePayment({ amount: 2500, reference: "pay_1", payerReference: "254712345678" });

    const auth = calls.find((c) => c.url.includes(OAUTH));
    assert.ok(auth, "a token was requested");
    assert.match(auth.url, /grant_type=client_credentials/);

    const expected = "Basic " + Buffer.from(
      `${GOOD_ENV.MPESA_CONSUMER_KEY}:${GOOD_ENV.MPESA_CONSUMER_SECRET}`).toString("base64");
    assert.equal(auth.headers.authorization, expected);

    // The STK call carries the bearer token the OAuth step returned.
    const stk = calls.find((c) => c.url.includes(STK));
    assert.equal(stk.headers.authorization, "Bearer tok_abc123");
  });
});

test("[MP5] the token is cached, not re-fetched for every call", async () => {
  await run({
    routes: { [OAUTH]: tokenRoute, [STK]: () => ({ ResponseCode: "0", CheckoutRequestID: "ws_CO_1" }) }
  }, async ({ mpesa, calls }) => {
    await mpesa.initiatePayment({ amount: 2500, reference: "a", payerReference: "254712345678" });
    await mpesa.initiatePayment({ amount: 2500, reference: "b", payerReference: "254712345678" });
    const tokenCalls = calls.filter((c) => c.url.includes(OAUTH)).length;
    assert.equal(tokenCalls, 1, "the second payment reuses the cached token");
  });
});

test("[MP6] a rejected token request fails the payment WITHOUT leaking the secret",
  async () => {
    await run({
      routes: {
        // Daraja echoes credential material back on auth errors.
        [OAUTH]: () => ({
          ok: false, status: 400,
          json: { errorMessage: `Invalid credentials for ${GOOD_ENV.MPESA_CONSUMER_KEY}` }
        })
      }
    }, async ({ mpesa }) => {
      const out = await mpesa.initiatePayment({
        amount: 2500, reference: "pay_1", payerReference: "254712345678"
      });
      assert.equal(out.ok, false);
      assert.equal(out.status, "failed");
      const blob = JSON.stringify(out);
      assert.equal(blob.includes(GOOD_ENV.MPESA_CONSUMER_KEY), false,
        "the consumer key must not reach the caller");
      assert.equal(blob.includes(GOOD_ENV.MPESA_CONSUMER_SECRET), false);
      assert.equal(blob.includes(GOOD_ENV.MPESA_PASSKEY), false);
    });
  });

// ══════════════════════════════════════════════════════════════════
// 3. STK PUSH
// ══════════════════════════════════════════════════════════════════

test("[MP7] the STK push carries exactly what Daraja requires", async () => {
  await run({
    routes: {
      [OAUTH]: tokenRoute,
      [STK]: () => ({ ResponseCode: "0", CheckoutRequestID: "ws_CO_09072026140503" })
    }
  }, async ({ mpesa, calls }) => {
    const out = await mpesa.initiatePayment({
      amount: 2500, reference: "pay_abc123", payerReference: "0712345678",
      description: "Growth plan"
    });

    const stk = calls.find((c) => c.url.includes(STK));
    assert.equal(stk.method, "POST");
    assert.equal(stk.url, `https://sandbox.safaricom.co.ke${STK}`);
    assert.equal(stk.headers["content-type"], "application/json");

    const b = stk.body;
    assert.equal(b.BusinessShortCode, "174379");
    assert.equal(b.PartyB, "174379", "the payee is our shortcode");
    assert.equal(b.TransactionType, "CustomerPayBillOnline");
    assert.equal(b.Amount, 2500, "the amount is passed through untouched");
    assert.equal(b.PartyA, "254712345678", "the payer's number, normalised");
    assert.equal(b.PhoneNumber, "254712345678");
    assert.equal(b.CallBackURL, GOOD_ENV.MPESA_CALLBACK_URL,
      "our own callback URL, from configuration — never from a request");

    /* OUR reference travels to Daraja and comes back on the callback. It is the
       only thing that ties a callback to a payment row. */
    assert.equal(b.AccountReference, "pay_abc123");

    // Frozen clock: yyyyMMddHHmmss in LOCAL time, as Daraja expects.
    assert.equal(b.Timestamp, "20260709140503");
    assert.equal(b.Password, Buffer.from(
      `174379${GOOD_ENV.MPESA_PASSKEY}20260709140503`).toString("base64"),
      "password is base64(shortcode + passkey + timestamp)");

    // And the result: queued, never paid.
    assert.equal(out.ok, true);
    assert.equal(out.status, "pending", "an accepted prompt is NOT a payment");
    assert.equal(out.providerRef, "ws_CO_09072026140503");
  });
});

test("[MP8] Daraja's length limits are respected", async () => {
  await run({
    routes: { [OAUTH]: tokenRoute, [STK]: () => ({ ResponseCode: "0", CheckoutRequestID: "ws_CO_1" }) }
  }, async ({ mpesa, calls }) => {
    await mpesa.initiatePayment({
      amount: 100,
      reference: "pay_this_reference_is_far_too_long_for_daraja",
      payerReference: "254712345678",
      description: "A description well beyond the limit Daraja accepts"
    });
    const b = calls.find((c) => c.url.includes(STK)).body;
    assert.ok(b.AccountReference.length <= 12, `AccountReference ${b.AccountReference}`);
    assert.ok(b.TransactionDesc.length <= 13, `TransactionDesc ${b.TransactionDesc}`);
  });
});

test("[MP9] phone numbers are normalised, and rubbish is refused before any call",
  async () => {
    const accepted = [
      ["0712345678", "254712345678"],
      ["0112345678", "254112345678"],
      ["254712345678", "254712345678"],
      ["+254 712 345 678", "254712345678"],
      ["712345678", "254712345678"],
      ["0722 000 111", "254722000111"]
    ];
    const refused = [
      "", null, undefined, "12345", "0812345678",        // 08 is not Safaricom-shaped
      "2547123456789", "254712345", "not a phone", "07123456789"
    ];

    await run({}, ({ mpesa }) => {
      accepted.forEach(([input, expected]) =>
        assert.equal(mpesa.normalizePhone(input), expected, `normalise ${input}`));
      refused.forEach((input) =>
        assert.equal(mpesa.normalizePhone(input), null, `refuse ${JSON.stringify(input)}`));
    });

    /* A bad number must fail BEFORE a token is requested. Spending an OAuth
       round trip to discover the input was never valid is wasteful, and worse,
       it puts a request on Daraja's rate limit for nothing. */
    await run({ routes: { [OAUTH]: tokenRoute } }, async ({ mpesa, calls }) => {
      const out = await mpesa.initiatePayment({
        amount: 2500, reference: "pay_1", payerReference: "not a phone"
      });
      assert.equal(out.ok, false);
      assert.equal(out.status, "failed");
      assert.match(out.detail, /phone number/i);
      assert.equal(calls.length, 0, "no HTTP call was made at all");
    });
  });

test("[MP10] a non-integer or non-positive amount is refused, never rounded", async () => {
  /* Daraja rejects fractional amounts. Rounding UP would overcharge the
     customer and rounding DOWN would undercharge us; either is a silent change
     to a price the server is supposed to be authoritative about. */
  for (const amount of [2500.5, 0, -100, NaN, null, undefined, "2500"]) {
    await run({ routes: { [OAUTH]: tokenRoute } }, async ({ mpesa, calls }) => {
      const out = await mpesa.initiatePayment({
        amount, reference: "pay_1", payerReference: "254712345678"
      });
      assert.equal(out.ok, false, `amount ${amount} must be refused`);
      assert.match(out.detail, /whole number/i);
      assert.equal(calls.length, 0, "and refused before any HTTP call");
    });
  }
});

test("[MP11] a Daraja rejection is reported as failed, with credentials stripped",
  async () => {
    await run({
      routes: {
        [OAUTH]: tokenRoute,
        [STK]: () => ({
          ResponseCode: "1",
          errorMessage: `Bad Request - Invalid Passkey ${GOOD_ENV.MPESA_PASSKEY}`,
          ResponseDescription: "rejected"
        })
      }
    }, async ({ mpesa }) => {
      const out = await mpesa.initiatePayment({
        amount: 2500, reference: "pay_1", payerReference: "254712345678"
      });
      assert.equal(out.ok, false);
      assert.equal(out.status, "failed");
      assert.equal(JSON.stringify(out.raw).includes(GOOD_ENV.MPESA_PASSKEY), false,
        "the passkey Daraja echoed back is redacted out of the stored payload");

      /* AND OUT OF `detail`, which is the field the UI renders. `raw` was
         redacted and this was not, so the passkey left the server through the
         one string a user actually sees. */
      assert.equal(String(out.detail).includes(GOOD_ENV.MPESA_PASSKEY), false,
        "the passkey must not reach the caller through `detail` either");
      assert.equal(JSON.stringify(out).includes(GOOD_ENV.MPESA_PASSKEY), false,
        "nor anywhere else in the response");
    });
  });

test("[MP12] an unreachable Daraja fails the INITIATION cleanly", async () => {
  await run({
    routes: { [OAUTH]: () => ({ __throw: new Error("ECONNREFUSED 196.201.214.200") }) }
  }, async ({ mpesa }) => {
    const out = await mpesa.initiatePayment({
      amount: 2500, reference: "pay_1", payerReference: "254712345678"
    });
    /* Failing an INITIATION is safe: no prompt was sent, so no money moved.
       This is the opposite of verifyPayment, where unreachable must stay
       pending — see [MP16]. */
    assert.equal(out.ok, false);
    assert.equal(out.status, "failed");
    assert.match(out.detail, /Could not reach M-Pesa/);
  });
});

// ══════════════════════════════════════════════════════════════════
// 4. STK PUSH QUERY  (the R5 verification channel)
// ══════════════════════════════════════════════════════════════════

test("[MP13] the query is shaped correctly and addresses OUR checkout", async () => {
  await run({
    routes: { [OAUTH]: tokenRoute, [QUERY]: () => ({ ResultCode: "0", ResultDesc: "Accepted" }) }
  }, async ({ mpesa, calls }) => {
    await mpesa.verifyPayment({ providerRef: "ws_CO_09072026140503" });

    const q = calls.find((c) => c.url.includes(QUERY));
    assert.equal(q.method, "POST");
    assert.equal(q.url, `https://sandbox.safaricom.co.ke${QUERY}`);
    assert.equal(q.headers.authorization, "Bearer tok_abc123");
    assert.equal(q.body.BusinessShortCode, "174379");
    assert.equal(q.body.CheckoutRequestID, "ws_CO_09072026140503",
      "the reference queried is the one we were given, not one from a callback body");
    assert.equal(q.body.Timestamp, "20260709140503");
    assert.equal(q.body.Password, Buffer.from(
      `174379${GOOD_ENV.MPESA_PASSKEY}20260709140503`).toString("base64"));
  });
});

test("[MP14] verifyPayment maps every Daraja result code", async () => {
  const cases = [
    ["0", "successful"],
    [0, "successful"],
    ["1032", "cancelled"],
    ["1037", "expired"],
    ["1", "failed"],
    ["1001", "failed"],
    ["2001", "failed"]
  ];
  for (const [code, expected] of cases) {
    await run({
      routes: { [OAUTH]: tokenRoute, [QUERY]: () => ({ ResultCode: code }) }
    }, async ({ mpesa }) => {
      const out = await mpesa.verifyPayment({ providerRef: "ws_CO_1" });
      assert.equal(out.status, expected, `ResultCode ${code}`);
    });
  }
});

test("[MP15] an ABSENT result code is pending, not failed", async () => {
  /* Daraja returns no ResultCode while a prompt is still on the handset.
     Reading that as `failed` would abandon a payment the customer is in the
     middle of approving. */
  await run({
    routes: { [OAUTH]: tokenRoute, [QUERY]: () => ({ ResponseDescription: "processing" }) }
  }, async ({ mpesa }) => {
    const out = await mpesa.verifyPayment({ providerRef: "ws_CO_1" });
    assert.equal(out.status, "pending");
  });

  /* EVERY SHAPE `Number()` SILENTLY TURNS INTO ZERO. `Number(null)`,
     `Number("")` and `Number(false)` are all 0, and 0 is Daraja's code for
     PAID. A callback carrying `ResultCode: null` therefore reported a
     completed payment, and the R5 re-query could not catch it because the
     query response was mis-read exactly the same way. */
  await run({}, ({ mpesa }) => {
    ["pending"].forEach(() => {});
    [undefined, null, "", "   ", false, true, [], {}, "not-a-number", NaN]
      .forEach((v) => assert.equal(mpesa.statusFromResultCode(v), "pending",
        `ResultCode ${JSON.stringify(v)} is absent, not a paid zero`));

    // A genuine zero, in either form, is still a completed payment.
    assert.equal(mpesa.statusFromResultCode(0), "successful");
    assert.equal(mpesa.statusFromResultCode("0"), "successful");
  });

  /* And through the callback path, which is where it would have cost money. */
  await run({}, ({ mpesa }) => {
    const out = mpesa.handleWebhook({
      body: { Body: { stkCallback: { CheckoutRequestID: "ws_CO_1", ResultCode: null } } }
    });
    assert.equal(out.status, "pending",
      "a null result code must never present as a paid callback");
  });
});

test("[MP16] an UNREACHABLE Safaricom leaves the payment pending, never failed",
  async () => {
    /* The single most consequential mapping in the adapter. If verification is
       unreachable the money may well have moved; marking it failed strands a
       customer who has paid. The route relies on this to hold. */
    await run({
      routes: { [OAUTH]: tokenRoute, [QUERY]: () => ({ __throw: new Error("socket hang up") }) }
    }, async ({ mpesa }) => {
      const out = await mpesa.verifyPayment({ providerRef: "ws_CO_1" });
      assert.equal(out.status, "pending", "unreachable is NOT failure");
    });

    // ...and the same when authentication itself cannot be obtained.
    await run({
      routes: { [OAUTH]: () => ({ __throw: new Error("ETIMEDOUT") }) }
    }, async ({ mpesa }) => {
      const out = await mpesa.verifyPayment({ providerRef: "ws_CO_1" });
      assert.equal(out.status, "pending");
    });
  });

test("[MP17] a query response never returns credential material", async () => {
  await run({
    routes: {
      [OAUTH]: tokenRoute,
      [QUERY]: () => ({
        ResultCode: "1",
        ResultDesc: `Failed for shortcode 174379 passkey ${GOOD_ENV.MPESA_PASSKEY}`
      })
    }
  }, async ({ mpesa }) => {
    const out = await mpesa.verifyPayment({ providerRef: "ws_CO_1" });
    assert.equal(JSON.stringify(out).includes(GOOD_ENV.MPESA_PASSKEY), false);
  });
});

// ══════════════════════════════════════════════════════════════════
// 5. CALLBACK PARSING
// ══════════════════════════════════════════════════════════════════

function callback(resultCode, items, over = {}) {
  return {
    Body: {
      stkCallback: Object.assign({
        MerchantRequestID: "29115-34620561-1",
        CheckoutRequestID: "ws_CO_09072026140503",
        ResultCode: resultCode,
        ResultDesc: "The service request is processed successfully.",
        CallbackMetadata: items ? { Item: items } : undefined
      }, over)
    }
  };
}

test("[MP18] a successful callback yields reference, receipt and outcome", async () => {
  await run({}, ({ mpesa }) => {
    const out = mpesa.handleWebhook({
      body: callback(0, [
        { Name: "Amount", Value: 2500 },
        { Name: "MpesaReceiptNumber", Value: "TGH4K9L2MN" },
        { Name: "TransactionDate", Value: 20260709140530 },
        { Name: "PhoneNumber", Value: 254712345678 }
      ])
    });
    assert.equal(out.ok, true);
    assert.equal(out.providerRef, "ws_CO_09072026140503");
    assert.equal(out.status, "successful");
    assert.equal(out.receipt, "TGH4K9L2MN");
    /* The amount is REPORTED for reconciliation and is deliberately not
       authoritative — settlement uses the figure written at checkout. */
    assert.equal(out.reportedAmount, 2500);
  });
});

test("[MP19] cancellation and timeout callbacks are not failures", async () => {
  await run({}, ({ mpesa }) => {
    const cancelled = mpesa.handleWebhook({ body: callback(1032, null) });
    assert.equal(cancelled.status, "cancelled", "the user declined the prompt");

    const timedOut = mpesa.handleWebhook({ body: callback(1037, null) });
    assert.equal(timedOut.status, "expired", "no response on the handset");

    const failed = mpesa.handleWebhook({ body: callback(2001, null) });
    assert.equal(failed.status, "failed", "a genuine failure");
  });
});

test("[MP20] a malformed callback is refused, never half-parsed", async () => {
  const malformed = [
    undefined, null, {}, { Body: {} }, { Body: { stkCallback: {} } },
    { Body: { stkCallback: { ResultCode: 0 } } },        // no CheckoutRequestID
    { stkCallback: { CheckoutRequestID: "x" } },          // wrong nesting
    "not an object", 42, []
  ];
  await run({}, ({ mpesa }) => {
    malformed.forEach((body) => {
      const out = mpesa.handleWebhook({ body });
      assert.equal(out.ok, false, `must refuse: ${JSON.stringify(body)}`);
      assert.equal(out.providerRef, undefined,
        "a refused callback carries no reference to correlate on");
    });
  });
});

test("[MP21] missing callback metadata does not invent values", async () => {
  await run({}, ({ mpesa }) => {
    const out = mpesa.handleWebhook({ body: callback(0, []) });
    assert.equal(out.ok, true);
    assert.equal(out.receipt, null, "an absent receipt stays null, never ''");
    assert.equal(out.reportedAmount, null, "and an absent amount is not zero");
  });
});

test("[MP22] a callback echoing credential material is redacted", async () => {
  await run({}, ({ mpesa }) => {
    const out = mpesa.handleWebhook({
      body: callback(0, [{ Name: "Amount", Value: 2500 }],
        { ResultDesc: `ok passkey=${GOOD_ENV.MPESA_PASSKEY}` })
    });
    assert.equal(JSON.stringify(out.raw).includes(GOOD_ENV.MPESA_PASSKEY), false,
      "the raw payload kept for audit is redacted");
  });
});

// ══════════════════════════════════════════════════════════════════
// 6. REDACTION
// ══════════════════════════════════════════════════════════════════

test("[MP23] redact removes every secret, from strings and objects alike", async () => {
  await run({}, ({ mpesa }) => {
    const secrets = [
      GOOD_ENV.MPESA_CONSUMER_KEY, GOOD_ENV.MPESA_CONSUMER_SECRET, GOOD_ENV.MPESA_PASSKEY
    ];
    secrets.forEach((secret) => {
      assert.equal(mpesa.redact(`leaked ${secret} here`).includes(secret), false);
      assert.equal(mpesa.redact({ nested: { deep: secret } }).includes(secret), false);
    });
    assert.match(mpesa.redact(`x ${GOOD_ENV.MPESA_PASSKEY} y`), /\[redacted\]/);

    // Bounded, so a hostile payload cannot fill the log.
    assert.ok(mpesa.redact("z".repeat(5000)).length <= 500);

    // And it does not throw on the awkward inputs a failing provider produces.
    [null, undefined, "", 0, [], {}].forEach((v) =>
      assert.equal(typeof mpesa.redact(v), "string"));
  });
});

test("[MP24] the adapter satisfies the provider boundary", async () => {
  await run({}, ({ mpesa }) => {
    ["initiatePayment", "verifyPayment", "handleWebhook", "isConfigured"]
      .forEach((fn) => assert.equal(typeof mpesa[fn], "function", `${fn} is required`));

    /* Deliberately ABSENT: Daraja does not sign its callbacks, so the adapter
       must not pretend to verify a signature. The webhook route branches on
       this exact absence — see tests/http/mpesaSecurity.test.js. */
    assert.equal(typeof mpesa.verifySignature, "undefined",
      "an adapter that cannot verify authenticity must not claim it can");
  });
});

// ══════════════════════════════════════════════════════════════════
// 7. WHAT THE CUSTOMER READS
// ══════════════════════════════════════════════════════════════════

test("[MP25] the account reference shown to the payer is readable, not our uuid",
  async () => {
    /* This lands on the STK prompt as "Account" and on the payer's M-Pesa
       statement weeks later. It used to be the payment id — "26d006b05d96" —
       which tells them nothing at either moment. */
    await run({
      routes: { [OAUTH]: tokenRoute, [STK]: () => ({ ResponseCode: "0", CheckoutRequestID: "ws_CO_1" }) }
    }, async ({ mpesa, calls }) => {
      await mpesa.initiatePayment({
        amount: 2500,
        reference: "26d006b05d96",
        accountReference: "Growth",
        description: "Growth plan",
        payerReference: "254712345678"
      });
      const b = calls.find((c) => c.url.includes(STK)).body;
      assert.equal(b.AccountReference, "Growth");
      assert.equal(b.TransactionDesc, "Growth plan");
    });
  });

test("[MP26] without a label it still sends something unique", async () => {
  /* The fallback matters: an adapter call that supplies no display label must
     not send an empty account reference, which Daraja rejects. */
  await run({
    routes: { [OAUTH]: tokenRoute, [STK]: () => ({ ResponseCode: "0", CheckoutRequestID: "ws_CO_1" }) }
  }, async ({ mpesa, calls }) => {
    await mpesa.initiatePayment({
      amount: 2500, reference: "26d006b05d96", payerReference: "254712345678"
    });
    const b = calls.find((c) => c.url.includes(STK)).body;
    assert.equal(b.AccountReference, "26d006b05d96", "falls back to the reference");
    assert.equal(b.TransactionDesc, "Subscription", "and to a generic description");
  });
});

test("[MP27] every sellable plan fits Daraja's limits without truncation", () => {
  /* THE BUG THIS REPLACES: the adapter sliced blindly, so "Custom AI plan"
     reached the handset as "Custom AI pla". A label that does not fit now
     falls back to a generic rather than being cut mid-word — and this test
     fails if any SELLABLE plan is relying on that fallback, so the mistake is
     caught here rather than on a customer's phone. */
  const entitlements = require("../../src/services/entitlements");
  const fallback = entitlements.CHECKOUT_FALLBACK;

  Object.entries(entitlements.PLANS)
    .filter(([, plan]) => plan.sellable)
    .forEach(([key, plan]) => {
      const labels = entitlements.checkoutLabelsFor(key);
      assert.notDeepEqual(labels, fallback,
        `${key} ("${plan.label}") has no checkout label that fits — it would be `
        + "shown to customers as the generic fallback");
      assert.ok(labels.account.length <= entitlements.DARAJA_ACCOUNT_MAX,
        `${key} account "${labels.account}" exceeds ${entitlements.DARAJA_ACCOUNT_MAX}`);
      assert.ok(labels.description.length <= entitlements.DARAJA_DESC_MAX,
        `${key} description "${labels.description}" exceeds ${entitlements.DARAJA_DESC_MAX}`);
    });
});

test("[MP28] an over-long label degrades to a generic, never to a cut-off word", () => {
  const entitlements = require("../../src/services/entitlements");
  // "Accountant Workspace" is 20 characters and is NOT sellable today.
  const labels = entitlements.checkoutLabelsFor("workspace");
  assert.ok(labels.account.length <= entitlements.DARAJA_ACCOUNT_MAX);
  assert.equal(/^Accountant W/.test(labels.account), false,
    "a long plan name is never shown half-printed");

  const unknown = entitlements.checkoutLabelsFor("no-such-plan");
  assert.deepEqual(unknown, entitlements.CHECKOUT_FALLBACK);
});
