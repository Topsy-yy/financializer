// ATOMIC CREDIT ACCOUNTING.
//
// The property required, stated once:
//
//     if remaining >= cost:  deduct
//     else:                  reject
//
// ...with no window between the test and the deduction, under any amount of
// concurrency, across any number of application instances.
//
// This is not achievable in application code holding a balance in memory, which
// is what `entitlements.charge()` did: read, compare, decrement, and eventually
// write a JSON file. Two instances read 10, both see 10 >= 8, both deduct, and
// the tenant has spent 16 credits they did not have.
//
// It IS achievable in one SQL statement, because the WHERE clause and the SET
// clause are evaluated inside the same row lock:
//
//     UPDATE credit_balance SET credits = credits - $cost
//      WHERE tenant_id = $1 AND period = $2 AND credits >= $cost
//
// A concurrent UPDATE against the same row blocks until the first commits, then
// re-evaluates its WHERE against the NEW value. It either succeeds or affects
// zero rows, and zero rows is the rejection. The CHECK (credits >= 0) on the
// column is a second, independent guarantee: even a bug in a future caller
// cannot drive a balance negative.

const { withTenant, isConfigured } = require("../pool");

/**
 * Ensure the tenant has a balance row for the current period.
 *
 * The monthly refill is an INSERT for a new period rather than a mutation, so
 * last month's spend history stays intact. ON CONFLICT DO NOTHING makes it safe
 * to race: whichever request arrives first creates the row, the rest proceed.
 */
async function ensureBalance(tenantId, { period, allowance, plan }) {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO credit_balance (tenant_id, period, credits, allowance, plan)
       VALUES ($1, $2, $3, $3, $4)
       ON CONFLICT (tenant_id, period) DO UPDATE
         SET plan = EXCLUDED.plan, updated_at = now()
       RETURNING credits, allowance, plan, period`,
      [tenantId, period, allowance, plan]
    );
    return rows[0];
  });
}

/**
 * Spend credits, atomically.
 *
 * @returns {object} { ok, remaining, cost, reason }
 *   ok:false with reason "insufficient_credits" when the balance was too low.
 *   The caller MUST treat ok:false as "the work must not proceed" — the point of
 *   the design is that this is decided here, not by a prior check.
 */
async function consume(tenantId, { period, cost, operation, interactionId = null }) {
  if (!Number.isInteger(cost) || cost < 0) {
    throw new Error(`credit cost must be a non-negative integer, got ${cost}`);
  }
  if (cost === 0) return { ok: true, remaining: null, cost: 0, reason: null };

  return withTenant(tenantId, async (client) => {
    // THE ATOMIC OPERATION. Test and deduction in one statement, one row lock.
    const { rows } = await client.query(
      `UPDATE credit_balance
          SET credits = credits - $3, updated_at = now()
        WHERE tenant_id = $1 AND period = $2 AND credits >= $3
        RETURNING credits`,
      [tenantId, period, cost]
    );

    if (!rows.length) {
      // Either no row for the period, or the balance was too low. Distinguish
      // them so the caller can report honestly rather than guessing.
      const { rows: existing } = await client.query(
        "SELECT credits FROM credit_balance WHERE tenant_id = $1 AND period = $2",
        [tenantId, period]);
      return {
        ok: false,
        reason: existing.length ? "insufficient_credits" : "no_balance",
        remaining: existing.length ? existing[0].credits : 0,
        cost
      };
    }

    const remaining = rows[0].credits;
    await client.query(
      `INSERT INTO credit_transaction
         (tenant_id, period, operation, cost, balance_after, interaction_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [tenantId, period, operation || "unknown", cost, remaining, interactionId]);

    return { ok: true, remaining, cost, reason: null };
  });
}

/**
 * Return credits to a tenant.
 *
 * Used when a charge was taken but the work then failed in a way the tenant
 * should not pay for. Charging AFTER success is preferred and is what the
 * orchestrator does; this exists for the paths where that is not possible.
 */
async function refund(tenantId, { period, cost, operation, interactionId = null }) {
  if (!cost) return { ok: true, remaining: null, cost: 0 };
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `UPDATE credit_balance
          SET credits = LEAST(credits + $3, allowance), updated_at = now()
        WHERE tenant_id = $1 AND period = $2
        RETURNING credits`,
      [tenantId, period, cost]);
    if (!rows.length) return { ok: false, reason: "no_balance", remaining: 0, cost };
    await client.query(
      `INSERT INTO credit_transaction
         (tenant_id, period, operation, cost, balance_after, interaction_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [tenantId, period, `refund:${operation || "unknown"}`, -cost, rows[0].credits, interactionId]);
    return { ok: true, remaining: rows[0].credits, cost };
  });
}

/**
 * Grant additional credits in the active period.
 *
 * A grant increases both `credits` and `allowance` so the top-up is not later
 * clamped away by a refund path that caps to allowance.
 */
async function grant(tenantId, {
  period,
  amount,
  operation = "manual_grant",
  interactionId = null
}) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`grant amount must be a positive integer, got ${amount}`);
  }
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `UPDATE credit_balance
          SET credits = credits + $3,
              allowance = allowance + $3,
              updated_at = now()
        WHERE tenant_id = $1 AND period = $2
        RETURNING credits, allowance`,
      [tenantId, period, amount]
    );
    if (!rows.length) return { ok: false, reason: "no_balance", amount, remaining: 0 };

    await client.query(
      `INSERT INTO credit_transaction
         (tenant_id, period, operation, cost, balance_after, interaction_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [tenantId, period, operation, -amount, rows[0].credits, interactionId]
    );

    return {
      ok: true,
      amount,
      remaining: rows[0].credits,
      allowance: rows[0].allowance,
      reason: null
    };
  });
}

/**
 * Revoke previously granted credits in the active period.
 *
 * This decreases both `credits` and `allowance` to reverse a prior top-up while
 * preserving the invariant that credits never go negative.
 */
async function revokeGrant(tenantId, {
  period,
  amount,
  operation = "manual_revoke",
  interactionId = null
}) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`revoke amount must be a positive integer, got ${amount}`);
  }

  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `UPDATE credit_balance
          SET credits = credits - $3,
              allowance = allowance - $3,
              updated_at = now()
        WHERE tenant_id = $1
          AND period = $2
          AND credits >= $3
          AND allowance >= $3
        RETURNING credits, allowance`,
      [tenantId, period, amount]
    );

    if (!rows.length) {
      const { rows: existing } = await client.query(
        "SELECT credits, allowance FROM credit_balance WHERE tenant_id = $1 AND period = $2",
        [tenantId, period]
      );

      if (!existing.length) {
        return { ok: false, reason: "no_balance", amount, remaining: 0, allowance: 0 };
      }

      const balance = existing[0];
      const reason = Number(balance.credits) < amount ? "insufficient_credits" : "insufficient_allowance";
      return {
        ok: false,
        reason,
        amount,
        remaining: Number(balance.credits),
        allowance: Number(balance.allowance)
      };
    }

    await client.query(
      `INSERT INTO credit_transaction
         (tenant_id, period, operation, cost, balance_after, interaction_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [tenantId, period, operation, amount, rows[0].credits, interactionId]
    );

    return {
      ok: true,
      amount,
      remaining: rows[0].credits,
      allowance: rows[0].allowance,
      reason: null
    };
  });
}

async function getBalance(tenantId, period) {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      "SELECT credits, allowance, plan, period FROM credit_balance WHERE tenant_id = $1 AND period = $2",
      [tenantId, period]);
    return rows[0] || null;
  });
}

/** Recent movements, for a support investigation or a billing dispute. */
async function history(tenantId, { limit = 50 } = {}) {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT period, operation, cost, balance_after, interaction_id, created_at
         FROM credit_transaction
        WHERE tenant_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [tenantId, Math.min(limit, 500)]);
    return rows;
  });
}

/** Is atomic accounting available, or must the caller fall back? */
function available() {
  return isConfigured();
}

module.exports = { ensureBalance, consume, refund, grant, revokeGrant, getBalance, history, available };
