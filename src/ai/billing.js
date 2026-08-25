// THE ONE PLACE CREDITS ARE SPENT.
//
// ─────────────────────────────────────────────────────────────────
// PRODUCTION FAILS CLOSED.
// ─────────────────────────────────────────────────────────────────
// JOB 9 left this module falling back to an in-process credit path whenever
// PostgreSQL was unavailable. In a single-instance dev environment that is
// harmless. In production it is not: two instances both fall back, both hold
// their own copy of the balance, and a tenant spends credits they do not have —
// on a provider account we are billed for.
//
// So the fallback is now MODE-DEPENDENT, and the modes are explicit:
//
//   production   PostgreSQL is REQUIRED. If the ledger is unavailable the
//                charge is refused, the caller must not call the provider, and
//                the user is told billing is unavailable. We would rather
//                decline a request than serve one we cannot account for.
//
//   development  An in-memory path may operate, because a single process makes
//                check-then-deduct indivisible. It returns `atomic: false` and
//                says so, so nothing downstream can mistake it for the real
//                thing.
//
// THE ORDERING THAT MATTERS. Billing availability is checked BEFORE the
// provider is called, not after. A charge that fails after the model has
// answered has already cost us the tokens.

const entitlements = require("../services/entitlements");
const creditRepository = require("../db/repositories/creditRepository");

/** Why a charge could not be made. */
const REASON = Object.freeze({
  BILLING_UNAVAILABLE: "billing_unavailable",
  INSUFFICIENT_CREDITS: "insufficient_credits",
  NO_TENANT: "billing_no_tenant",
  BYOK_UNMETERED: "byok_unmetered",
  NO_COST: "no_cost"
});

/** Which mode is this process running in? */
function mode() {
  return process.env.NODE_ENV === "production" ? "production" : "development";
}

function isProduction() {
  return mode() === "production";
}

/**
 * Can a charge be made AT ALL right now?
 *
 * Called BEFORE the provider, so a billing outage costs no provider tokens.
 *
 * @returns {object} { ok, mode, atomic, reason }
 */
function preflight({ tenantId = null, profile = null, operation = null } = {}) {
  // BYOK is unmetered by design: the tenant is billed by their own provider,
  // so a billing outage is irrelevant to them.
  if (entitlements.can(profile, "unmetered_ai")) {
    return frozen({ ok: true, mode: mode(), atomic: true, reason: REASON.BYOK_UNMETERED, cost: 0 });
  }

  const cost = operation ? entitlements.creditCost(operation) : 0;
  if (!cost) {
    return frozen({ ok: true, mode: mode(), atomic: true, reason: REASON.NO_COST, cost: 0 });
  }

  const ledgerReady = creditRepository.available();

  if (isProduction()) {
    if (!ledgerReady) {
      // FAIL CLOSED. No ledger means no accountable spend, so no spend.
      return frozen({
        ok: false, mode: "production", atomic: true,
        reason: REASON.BILLING_UNAVAILABLE, cost,
        message: "Billing is temporarily unavailable, so AI requests are paused. "
          + "Your financial analysis is unaffected."
      });
    }
    if (!tenantId) {
      // A charge with no tenant cannot be attributed or recovered.
      return frozen({
        ok: false, mode: "production", atomic: true,
        reason: REASON.NO_TENANT, cost,
        message: "This workspace is not fully provisioned for metered AI use."
      });
    }
    return frozen({ ok: true, mode: "production", atomic: true, cost });
  }

  // DEVELOPMENT. The in-memory path is permitted, and is honest about itself.
  return frozen({
    ok: true, mode: "development",
    atomic: Boolean(ledgerReady && tenantId),
    cost,
    note: ledgerReady && tenantId
      ? null
      : "Development billing: credits are tracked in this process only and are "
        + "NOT atomic across instances."
  });
}

/**
 * Spend credits for a COMPLETED operation.
 *
 * Charge only after a validated answer exists — the caller enforces that, and
 * `preflight` is what protects the provider call itself.
 */
async function charge({ tenantId, profile, operation, interactionId = null } = {}) {
  const check = preflight({ tenantId, profile, operation });
  if (!check.ok) {
    return frozen({ ok: false, cost: check.cost, remaining: null,
      atomic: check.atomic, mode: check.mode, reason: check.reason, message: check.message });
  }
  if (check.reason === REASON.BYOK_UNMETERED || check.reason === REASON.NO_COST) {
    return frozen({ ok: true, cost: 0, remaining: null, atomic: true,
      mode: check.mode, reason: check.reason });
  }

  const cost = check.cost;

  if (creditRepository.available() && tenantId) {
    const ent = entitlements.getEntitlement(profile);
    await creditRepository.ensureBalance(tenantId, {
      period: ent.period, allowance: ent.allowance, plan: ent.plan
    });
    const result = await creditRepository.consume(tenantId, {
      period: ent.period, cost, operation, interactionId
    });
    if (result.ok) {
      // Mirror into the in-memory profile so the UI shows the true balance
      // without a second query. The LEDGER is authoritative, not this.
      profile.credits = result.remaining;
      return frozen({ ok: true, cost, remaining: result.remaining, atomic: true, mode: check.mode });
    }
    return frozen({ ok: false, cost, remaining: result.remaining, atomic: true,
      mode: check.mode, reason: result.reason });
  }

  /* DEVELOPMENT-ONLY in-process path. `entitlements.charge` is synchronous with
     no await between the check and the decrement, so it cannot interleave
     WITHIN one Node process — but it gives no guarantee across instances, which
     is exactly why production refuses to reach here. */
  if (isProduction()) {
    // Unreachable via preflight; kept as a hard stop so a future caller cannot
    // bypass the mode check by calling charge() directly.
    return frozen({ ok: false, cost, remaining: null, atomic: true,
      mode: "production", reason: REASON.BILLING_UNAVAILABLE });
  }

  const result = entitlements.charge(profile, operation);
  return result.ok
    ? frozen({ ok: true, cost: result.cost, remaining: result.remaining,
      atomic: false, mode: "development" })
    : frozen({ ok: false, cost, remaining: result.remaining, atomic: false,
      mode: "development", reason: result.reason || REASON.INSUFFICIENT_CREDITS });
}

function frozen(obj) { return Object.freeze(obj); }

module.exports = { charge, preflight, mode, isProduction, REASON };
