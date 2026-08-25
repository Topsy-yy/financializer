// TENANT RESOLUTION — binding a request identity to a PostgreSQL tenant.
//
// ─────────────────────────────────────────────────────────────────
// THE GAP THIS CLOSES, and why it mattered more than it looked.
// ─────────────────────────────────────────────────────────────────
// `req.userStore.tenantId` was never assigned. Not once, anywhere in the
// codebase. Every read of it evaluated to `undefined` and was coerced to null
// at the call site, and every downstream component treated null as "skip":
//
//   ingestion/persist.js      -> { skipped: true, reason: "no_tenant" }
//   aiAuditRepository.record  -> { recorded: false, reason: "no_tenant" }
//   creditRepository          -> never reached
//
// So the PostgreSQL persistence layer, the RLS policies, the AI audit trail and
// the atomic credit ledger — all built and all tested — were inert against the
// running application. The DB tests passed because they construct tenants
// directly; the app never did.
//
// A deployment WITH a database and one WITHOUT behaved identically, and nothing
// announced it.
//
// ─────────────────────────────────────────────────────────────────
// THE MAPPING
// ─────────────────────────────────────────────────────────────────
// A user store is keyed by an identity string (`google-<sub>` or
// `guest-<signed-id>`). A tenant is a PostgreSQL row. The mapping is
// deterministic and derived SERVER-SIDE from that identity — never from
// anything the client sends — so a request cannot select its own tenant.
//
// The mapping is cached in-process because it is stable for the life of an
// identity, and resolving it is on the hot path of every request.

const crypto = require("crypto");
const tenantRepository = require("../db/repositories/tenantRepository");
const pool = require("../db/pool");
const { logger } = require("./logger");

const log = logger.child({ component: "tenant" });

/** identity -> tenantId. Stable for the life of the identity. */
const cache = new Map();

/**
 * A deterministic UUID for an identity.
 *
 * Derived by hashing the identity with a fixed namespace, so:
 *   * the same identity always maps to the same tenant, across restarts and
 *     across instances, with no coordination;
 *   * the tenant id cannot be guessed from a user id without the namespace;
 *   * no extra lookup table is needed to make the mapping durable.
 *
 * This is a UUIDv5-style derivation. It is NOT a security boundary on its own —
 * RLS is — but it removes a whole class of "which tenant am I?" bugs.
 */
const NAMESPACE = "finguard-tenant-v1";

function deriveTenantId(identity) {
  const hash = crypto.createHash("sha256")
    .update(`${NAMESPACE}|${identity}`).digest("hex");
  // Format as a UUID and set the version/variant nibbles so PostgreSQL's uuid
  // type accepts it and it is recognisably synthetic.
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    "5" + hash.slice(13, 16),
    ((parseInt(hash.slice(16, 17), 16) & 0x3 | 0x8).toString(16)) + hash.slice(17, 20),
    hash.slice(20, 32)
  ].join("-");
}

/**
 * Resolve (and provision, once) the tenant for an identity.
 *
 * Returns null when no database is configured — the application still works
 * in-memory, but the caller now knows that persistence is off rather than
 * silently receiving `undefined`.
 *
 * @param {string} identity  the SERVER-DERIVED user id; never client-supplied
 * @param {object} opts      { name, baseCurrency } used only on first creation
 */
async function resolveTenant(identity, opts = {}) {
  if (!identity) return null;
  if (!pool.isConfigured()) return null;
  if (cache.has(identity)) return cache.get(identity);

  const tenantId = deriveTenantId(identity);

  try {
    await ensureTenantRow(tenantId, {
      name: opts.name || identity,
      baseCurrency: opts.baseCurrency || "KES"
    });
    cache.set(identity, tenantId);
    return tenantId;
  } catch (err) {
    // A provisioning failure must not take the request down: the deterministic
    // analysis works without persistence. It IS logged, because a silently
    // non-persisting deployment is the failure this module exists to end.
    log.error("tenant provisioning failed", { identity: redactIdentity(identity), error: err.message });
    return null;
  }
}

/**
 * Create the tenant row if it does not exist.
 *
 * Runs OUTSIDE withTenant(): the row must exist before any tenant-scoped
 * statement can reference it, so this uses the admin path deliberately and
 * touches nothing but the tenant table.
 */
async function ensureTenantRow(tenantId, { name, baseCurrency }) {
  const client = await pool.getPool().connect();
  try {
    await client.query(
      `INSERT INTO tenant (id, name, base_currency)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [tenantId, String(name).slice(0, 200), baseCurrency]);
  } finally {
    client.release();
  }
}

/** Identities embed a Google subject id; never log one whole. */
function redactIdentity(identity) {
  const s = String(identity || "");
  if (s.length <= 12) return s;
  return `${s.slice(0, 8)}...${s.slice(-4)}`;
}

/** Test/maintenance hook. */
function clearCache() { cache.clear(); }

module.exports = { resolveTenant, deriveTenantId, clearCache, redactIdentity, NAMESPACE };
