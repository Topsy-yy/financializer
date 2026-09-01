const fs = require("node:fs");
const path = require("node:path");
const dbPool = require("../db/pool");

const REQUIRED_TABLES = Object.freeze([
  "app_user",
  "tenant",
  "membership",
  "subscription",
  "payment",
  "credit_balance",
  "credit_transaction",
  "ai_interaction",
  "analysis_run",
  "finding",
  "finding_evidence",
  "metric_value",
  "tenant_profile_state"
]);

class StartupDatabaseError extends Error {
  constructor(message, detail = null) {
    super(message);
    this.name = "StartupDatabaseError";
    this.code = "startup_database_invalid";
    this.detail = detail;
  }
}

function migrationFiles() {
  const dir = path.resolve(__dirname, "..", "db", "migrations");
  return fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
}

async function verifyProductionDatabase({
  env = process.env,
  log,
  getMigrationFiles = migrationFiles,
  pool = dbPool
} = {}) {
  const mode = String(env.NODE_ENV || "development").toLowerCase();
  if (mode !== "production") {
    return { ok: true, skipped: true, reason: "not_production" };
  }

  if (!pool.isConfigured()) {
    throw new StartupDatabaseError("DATABASE_URL is not configured.");
  }

  const client = await pool.getPool().connect();
  try {
    await client.query("SELECT 1");

    const reg = await client.query(
      "SELECT to_regclass('public.schema_migration')::text AS name"
    );
    if (!reg.rows.length || !reg.rows[0].name) {
      throw new StartupDatabaseError(
        "Database schema is not initialized (schema_migration table missing).",
        "Run migrations before starting production."
      );
    }

    const expectedMigrations = getMigrationFiles();
    const appliedRows = await client.query("SELECT name FROM schema_migration");
    const applied = new Set(appliedRows.rows.map((r) => r.name));
    const missingMigrations = expectedMigrations.filter((name) => !applied.has(name));
    if (missingMigrations.length) {
      throw new StartupDatabaseError(
        "Database schema is behind this release (missing migrations).",
        `Missing: ${missingMigrations.join(", ")}`
      );
    }

    const tableRows = await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
    );
    const tables = new Set(tableRows.rows.map((r) => r.tablename));
    const missingTables = REQUIRED_TABLES.filter((t) => !tables.has(t));
    if (missingTables.length) {
      throw new StartupDatabaseError(
        "Database schema is incompatible (required tables missing).",
        `Missing tables: ${missingTables.join(", ")}`
      );
    }

    if (log && typeof log.info === "function") {
      log.info("database.validated", {
        mode,
        migrations: expectedMigrations.length,
        requiredTables: REQUIRED_TABLES.length
      });
    }

    return {
      ok: true,
      mode,
      migrations: expectedMigrations.length,
      requiredTables: REQUIRED_TABLES.length
    };
  } catch (err) {
    if (err instanceof StartupDatabaseError) throw err;
    throw new StartupDatabaseError(
      "Database validation failed during startup.",
      err && err.message ? err.message : String(err)
    );
  } finally {
    client.release();
  }
}

module.exports = {
  REQUIRED_TABLES,
  StartupDatabaseError,
  migrationFiles,
  verifyProductionDatabase
};
