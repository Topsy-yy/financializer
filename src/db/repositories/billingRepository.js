// SUBSCRIPTIONS AND PAYMENTS — the only place billing state is written.
//
// THE PROPERTY THIS FILE EXISTS TO GUARANTEE:
//
//     verified payment + subscription activation + entitlement change
//
// happen atomically, exactly once, or not at all. A payment recorded without an
// activation is a customer who paid and got nothing; an activation without a
// payment is a free plan; two activations from one payment is a duplicate
// grant. All three are one transaction away from each other.
//
// Every write goes through `withTenant`, so RLS confines it to the paying
// tenant. Amounts and plans are read from the SERVER's catalog by the caller and
// stored here; nothing in this file trusts a request body.

const { withTenant, withAdmin } = require("../pool");
const { logger } = require("../../services/logger");

const log = logger.child({ component: "billing-repo" });

/** How long a checkout stays payable. Longer than an STK prompt survives. */
const CHECKOUT_TTL_MINUTES = 10;

/**
 * Open a checkout.
 *
 * The amount and plan are whatever the CALLER read from the plan catalog. This
 * is the row every later step is checked against, which is what makes a client
 * unable to change the price after the fact.
 */
async function createPayment(tenantId, { provider, plan, amount, currency, payerReference }) {
  return withTenant(tenantId, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO payment
         (tenant_id, provider, plan, amount, currency, status, payer_reference, expires_at)
       VALUES ($1,$2,$3,$4,$5,'pending',$6, now() + ($7 || ' minutes')::interval)
       RETURNING id, plan, amount, currency, status, expires_at, created_at`,
      [tenantId, provider, plan, amount, currency, payerReference || null,
        String(CHECKOUT_TTL_MINUTES)]
    );
    return rows[0];
  });
}

/** Attach the provider's reference once initiation succeeds. */
async function attachProviderRef(tenantId, paymentId, providerRef) {
  return withTenant(tenantId, async (c) => {
    const { rows } = await c.query(
      `UPDATE payment SET provider_ref = $2, updated_at = now()
        WHERE id = $1 AND status = 'pending'
        RETURNING id, provider_ref`,
      [paymentId, providerRef]
    );
    return rows[0] || null;
  });
}

/** Mark a checkout that never got off the ground. */
async function failPayment(tenantId, paymentId, reason) {
  return withTenant(tenantId, async (c) => {
    await c.query(
      `UPDATE payment
          SET status = 'failed', failure_reason = $2, completed_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'pending'`,
      [paymentId, String(reason || "").slice(0, 300)]
    );
  });
}

/** A tenant's own payment history. Failures included — they are the audit trail. */
async function paymentsFor(tenantId, { limit = 20 } = {}) {
  return withTenant(tenantId, async (c) => {
    const { rows } = await c.query(
      `SELECT id, provider, plan, amount, currency, status, failure_reason,
              created_at, completed_at
         FROM payment WHERE tenant_id = $1
        ORDER BY created_at DESC LIMIT $2`,
      [tenantId, limit]
    );
    return rows;
  });
}

/**
 * Which tenant does this provider reference belong to?
 *
 * A webhook arrives with no session, so the tenant is not yet known — and RLS
 * would hide the very row needed to find it. The SECURITY DEFINER function
 * added by migration 009 resolves a reference to a tenant id and NOTHING else,
 * so this cannot be used to read another tenant's payment data.
 */
async function tenantForProviderRef(provider, providerRef) {
  return withAdmin(async (c) => {
    const { rows } = await c.query(
      "SELECT payment_tenant_for_ref($1, $2) AS tenant_id", [provider, providerRef]);
    return rows[0] && rows[0].tenant_id ? rows[0].tenant_id : null;
  });
}

/**
 * THE CRITICAL OPERATION. Settle a verified payment and activate its
 * subscription, atomically and at most once.
 *
 * Every guard below is deliberate:
 *
 *   ROW LOCK          `FOR UPDATE` serialises concurrent callbacks, so two
 *                     simultaneous deliveries cannot both see a pending row.
 *   STATUS GUARD      only a `pending` payment can be settled. A second
 *                     callback finds it already `successful` and returns
 *                     `duplicate` — an idempotent no-op, not an error.
 *   EXPIRY GUARD      a callback arriving after the checkout window does not
 *                     activate; the user has moved on and a stale activation is
 *                     indistinguishable from a replay.
 *   TENANT GUARD      the payment is loaded under the tenant's own RLS scope,
 *                     so a reference belonging to another tenant is simply not
 *                     found.
 *   AMOUNT            taken from OUR row, never from the callback.
 *
 * @returns {object} { ok, outcome, subscription } where outcome is one of
 *   activated | duplicate | expired | not_found | not_pending | failed_payment
 */
async function settlePaymentAndActivate(tenantId, {
  provider, providerRef, status, providerResult, receipt
}) {
  return withTenant(tenantId, async (c) => {
    const { rows: found } = await c.query(
      `SELECT id, plan, amount, currency, status, expires_at
         FROM payment
        WHERE provider = $1 AND provider_ref = $2
        FOR UPDATE`,
      [provider, providerRef]
    );
    if (!found.length) return { ok: false, outcome: "not_found" };
    const payment = found[0];

    /* ALREADY SETTLED. The defining idempotency case: a provider that retries
       its webhook must not produce a second subscription. */
    if (payment.status === "successful") {
      const { rows: existing } = await c.query(
        `SELECT id, plan, status, activated_at, expires_at
           FROM subscription WHERE payment_id = $1 LIMIT 1`, [payment.id]);
      return { ok: true, outcome: "duplicate", subscription: existing[0] || null };
    }
    if (payment.status !== "pending") {
      return { ok: false, outcome: "not_pending", status: payment.status };
    }

    // The provider says it did not succeed: record that and activate nothing.
    if (status !== "successful") {
      await c.query(
        `UPDATE payment
            SET status = $2, provider_result = $3, completed_at = now(), updated_at = now()
          WHERE id = $1`,
        [payment.id, status, JSON.stringify(providerResult || {})]
      );
      return { ok: false, outcome: "failed_payment", status };
    }

    /* EXPIRED. Recorded as expired rather than deleted — a customer whose money
       moved after the window has a real claim, and support needs the row. */
    if (new Date(payment.expires_at).getTime() < Date.now()) {
      await c.query(
        `UPDATE payment
            SET status = 'expired', failure_reason = 'callback arrived after checkout expiry',
                provider_result = $2, completed_at = now(), updated_at = now()
          WHERE id = $1`,
        [payment.id, JSON.stringify(providerResult || {})]
      );
      return { ok: false, outcome: "expired" };
    }

    // ── Settle.
    await c.query(
      `UPDATE payment
          SET status = 'successful', provider_result = $2, completed_at = now(),
              updated_at = now()
        WHERE id = $1`,
      [payment.id, JSON.stringify(
        Object.assign({}, providerResult || {}, receipt ? { receipt } : {}))]
    );

    /* SUPERSEDE THE CURRENT SUBSCRIPTION. The partial unique index allows only
       one active row per tenant, so the old one is closed in the same
       transaction rather than left to collide. */
    await c.query(
      `UPDATE subscription
          SET status = 'cancelled', cancelled_at = now(), updated_at = now()
        WHERE tenant_id = $1 AND status = 'active'`,
      [tenantId]
    );

    const { rows: planRow } = await c.query(
      `SELECT $1::text AS plan`, [payment.plan]);

    const { rows: sub } = await c.query(
      `INSERT INTO subscription
         (tenant_id, plan, status, activated_at, expires_at, amount, currency, payment_id)
       VALUES ($1,$2,'active', now(),
               now() + ($3 || ' days')::interval, $4, $5, $6)
       RETURNING id, plan, status, activated_at, expires_at`,
      [tenantId, planRow[0].plan, String(periodDaysFor(payment.plan)),
        payment.amount, payment.currency, payment.id]
    );

    log.info("billing.subscription_activated", {
      tenantId, plan: payment.plan, paymentId: payment.id
    });

    return { ok: true, outcome: "activated", subscription: sub[0] };
  });
}

/* The catalog is the authority on duration. Required here rather than at the
   top of the file to avoid a require cycle (entitlements does not depend on
   this module, but keeping the edge local makes that impossible to break). */
function periodDaysFor(plan) {
  const entitlements = require("../../services/entitlements");
  const price = entitlements.priceFor(plan);
  return (price && price.periodDays) || 30;
}

/**
 * The tenant's CURRENT subscription, or null.
 *
 * An `active` row whose expiry has passed is reported as expired rather than
 * honoured — the entitlement resolver must never grant a lapsed plan just
 * because no scheduled job has run.
 */
async function currentSubscription(tenantId) {
  return withTenant(tenantId, async (c) => {
    const { rows } = await c.query(
      `SELECT id, plan, status, activated_at, expires_at, amount, currency, payment_id
         FROM subscription
        WHERE tenant_id = $1 AND status = 'active'
        ORDER BY activated_at DESC LIMIT 1`,
      [tenantId]
    );
    if (!rows.length) return null;
    const sub = rows[0];
    if (sub.expires_at && new Date(sub.expires_at).getTime() < Date.now()) {
      return Object.assign({}, sub, { status: "expired", lapsed: true });
    }
    return sub;
  });
}

/**
 * The most recent subscription of ANY status.
 *
 * `currentSubscription` deliberately returns only an `active` row, because
 * that is what entitlement depends on. Renewal MESSAGING needs more: once a
 * lapse is recorded the row is `expired`, so the active-only query returns
 * null and the user is told nothing at all — they simply lose features in
 * silence. This is for reporting only; it never grants anything.
 */
async function latestSubscription(tenantId) {
  return withTenant(tenantId, async (c) => {
    const { rows } = await c.query(
      `SELECT id, plan, status, activated_at, expires_at, amount, currency, payment_id
         FROM subscription
        WHERE tenant_id = $1
        ORDER BY COALESCE(activated_at, created_at) DESC
        LIMIT 1`,
      [tenantId]
    );
    return rows[0] || null;
  });
}

/** Mark lapsed subscriptions expired. Safe to run repeatedly. */
async function expireLapsed(tenantId) {
  return withTenant(tenantId, async (c) => {
    const { rows } = await c.query(
      `UPDATE subscription SET status = 'expired', updated_at = now()
        WHERE tenant_id = $1 AND status = 'active'
          AND expires_at IS NOT NULL AND expires_at < now()
        RETURNING id, plan`,
      [tenantId]
    );
    return rows;
  });
}

/** Voluntary downgrade. The row is closed, not deleted. */
async function cancelSubscription(tenantId) {
  return withTenant(tenantId, async (c) => {
    const { rows } = await c.query(
      `UPDATE subscription
          SET status = 'cancelled', cancelled_at = now(), updated_at = now()
        WHERE tenant_id = $1 AND status = 'active'
        RETURNING id, plan`,
      [tenantId]
    );
    return rows[0] || null;
  });
}

/** A pending checkout the user can be shown, if one is still payable. */
async function pendingPayment(tenantId) {
  return withTenant(tenantId, async (c) => {
    const { rows } = await c.query(
      `SELECT id, provider, plan, amount, currency, status, expires_at, provider_ref
         FROM payment
        WHERE tenant_id = $1 AND status = 'pending' AND expires_at > now()
        ORDER BY created_at DESC LIMIT 1`,
      [tenantId]
    );
    return rows[0] || null;
  });
}

/** One payment, by id, for status polling. Tenant-scoped by RLS. */
async function paymentById(tenantId, paymentId) {
  return withTenant(tenantId, async (c) => {
    const { rows } = await c.query(
      `SELECT id, provider, plan, amount, currency, status, failure_reason,
              expires_at, completed_at
         FROM payment WHERE id = $1`,
      [paymentId]
    );
    return rows[0] || null;
  });
}

module.exports = {
  CHECKOUT_TTL_MINUTES,
  createPayment, attachProviderRef, failPayment, paymentsFor, paymentById,
  pendingPayment, tenantForProviderRef, settlePaymentAndActivate,
  currentSubscription, latestSubscription, expireLapsed, cancelSubscription
};
