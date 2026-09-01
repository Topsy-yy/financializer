const test = require("node:test");
const assert = require("node:assert/strict");

const {
  verifyProductionDatabase,
  StartupDatabaseError,
  REQUIRED_TABLES
} = require("../../src/services/startupDatabaseValidation");

function makeClient({
  hasMigrationTable = true,
  appliedMigrations = ["001_init.sql"],
  tables = REQUIRED_TABLES,
  queryError = null
} = {}) {
  return {
    released: false,
    async query(sql) {
      if (queryError) throw queryError;
      if (sql.includes("to_regclass('public.schema_migration')")) {
        return { rows: [{ name: hasMigrationTable ? "schema_migration" : null }] };
      }
      if (sql.startsWith("SELECT name FROM schema_migration")) {
        return { rows: appliedMigrations.map((name) => ({ name })) };
      }
      if (sql.includes("FROM pg_tables")) {
        return { rows: tables.map((tablename) => ({ tablename })) };
      }
      return { rows: [{ ok: 1 }] };
    },
    release() {
      this.released = true;
    }
  };
}

function makePool(client, configured = true) {
  return {
    isConfigured() {
      return configured;
    },
    getPool() {
      return {
        async connect() {
          return client;
        }
      };
    }
  };
}

test("[DB-STARTUP-1] non-production skips startup DB validation", async () => {
  const client = makeClient();
  const result = await verifyProductionDatabase({
    env: { NODE_ENV: "development", DATABASE_URL: "postgres://x" },
    pool: makePool(client),
    getMigrationFiles: () => ["001_init.sql"]
  });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
});

test("[DB-STARTUP-2] production fails when DATABASE_URL is absent", async () => {
  const client = makeClient();
  await assert.rejects(
    verifyProductionDatabase({
      env: { NODE_ENV: "production" },
      pool: makePool(client, false),
      getMigrationFiles: () => ["001_init.sql"]
    }),
    (err) => err instanceof StartupDatabaseError && /DATABASE_URL/.test(err.message)
  );
});

test("[DB-STARTUP-3] production fails when schema migration table is missing", async () => {
  const client = makeClient({ hasMigrationTable: false });
  await assert.rejects(
    verifyProductionDatabase({
      env: { NODE_ENV: "production", DATABASE_URL: "postgres://x" },
      pool: makePool(client),
      getMigrationFiles: () => ["001_init.sql"]
    }),
    (err) => err instanceof StartupDatabaseError && /schema_migration/.test(err.message)
  );
  assert.equal(client.released, true, "connection is released on failure");
});

test("[DB-STARTUP-4] production fails when migrations are missing", async () => {
  const client = makeClient({ appliedMigrations: ["001_init.sql"] });
  await assert.rejects(
    verifyProductionDatabase({
      env: { NODE_ENV: "production", DATABASE_URL: "postgres://x" },
      pool: makePool(client),
      getMigrationFiles: () => ["001_init.sql", "002_finding_evidence.sql"]
    }),
    (err) => err instanceof StartupDatabaseError && /missing migrations/i.test(err.message)
  );
});

test("[DB-STARTUP-5] production fails when required tables are missing", async () => {
  const partialTables = REQUIRED_TABLES.filter((t) => t !== "tenant_profile_state");
  const client = makeClient({
    appliedMigrations: ["001_init.sql", "002_finding_evidence.sql"],
    tables: partialTables
  });
  await assert.rejects(
    verifyProductionDatabase({
      env: { NODE_ENV: "production", DATABASE_URL: "postgres://x" },
      pool: makePool(client),
      getMigrationFiles: () => ["001_init.sql", "002_finding_evidence.sql"]
    }),
    (err) => err instanceof StartupDatabaseError && /required tables missing/i.test(err.message)
  );
});

test("[DB-STARTUP-6] production passes when DB is reachable and schema is current", async () => {
  const migrations = ["001_init.sql", "002_finding_evidence.sql", "011_tenant_profile_state.sql"];
  const client = makeClient({ appliedMigrations: migrations, tables: REQUIRED_TABLES });
  const logs = [];
  const result = await verifyProductionDatabase({
    env: { NODE_ENV: "production", DATABASE_URL: "postgres://x" },
    pool: makePool(client),
    getMigrationFiles: () => migrations,
    log: {
      info(msg, fields) {
        logs.push({ msg, fields });
      }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(client.released, true);
  assert.ok(logs.some((l) => l.msg === "database.validated"));
});
