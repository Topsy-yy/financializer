// PostgreSQL connection + tenant-scoped transaction helper.
//
// Two rules this module exists to enforce:
//   1. Nothing outside src/db knows SQL. Routes and the domain engine never
//      import `pg`.
//   2. Every tenant-scoped query runs inside a transaction that has set
//      `app.tenant_id`, which the RLS policies filter on. Forgetting the scope
//      returns ZERO rows rather than another tenant's data.

const { Pool } = require("pg");
const { logger } = require("../services/logger");

let pool = null;

function connectionString() {
  return process.env.DATABASE_URL || "";
}

function isConfigured() {
  return Boolean(connectionString());
}

function getPool() {
  if (!isConfigured()) throw new Error("DATABASE_URL is not configured");
  if (!pool) {
    pool = new Pool({
      connectionString: connectionString(),
      max: Number(process.env.PGPOOL_MAX || 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000
    });
    // A pool error must never take the process down silently.
    pool.on("error", (err) => logger.error("[db] idle client error:", err.message));
  }
  return pool;
}

/** Run a callback inside a transaction. Rolls back on any throw. */
async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* connection already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run a callback inside a transaction scoped to ONE tenant.
 *
 * `set_config(..., true)` is transaction-local, so the scope cannot leak to the
 * next user of a pooled connection.
 */
async function withTenant(tenantId, fn) {
  if (!tenantId) throw new Error("withTenant requires a tenantId");
  return withTransaction(async (client) => {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [String(tenantId)]);
    return fn(client);
  });
}

/** Admin-scoped work (migrations, tenant creation). Bypasses tenant scoping. */
async function withAdmin(fn) {
  const client = await getPool().connect();
  try { return await fn(client); } finally { client.release(); }
}

async function close() {
  if (pool) { await pool.end(); pool = null; }
}

module.exports = { getPool, withTransaction, withTenant, withAdmin, close, isConfigured };
