// JOB 12 PART A — a clean database, built ONLY from the documented process.
//
// THE DEFECT. The repository could build a schema but not a working deployment.
// Migrations 001-003 create fourteen tables and grant on none of them, so a
// database stood up from this repository connected fine and then failed every
// query with "permission denied for table tenant". The missing GRANT statements
// existed nowhere in the repo — whoever built the original environment ran them
// by hand. Nothing could have revealed that except trying to build a new one.
//
// THIS TEST BUILDS A NEW ONE, every run, from nothing:
//
//   1. create a throwaway database
//   2. run ONLY the documented bootstrap (npm run db:bootstrap)
//   3. connect as the restricted, NON-SUPERUSER application role
//   4. verify tables and recorded migrations
//   5. verify RLS actually confines that role
//   6. do one real tenant-scoped write and read back
//
// It fails if a hidden out-of-band grant is ever needed again, because step 2 is
// the only setup performed and step 6 exercises the role for real.
//
// A SUPERUSER CONNECTION IS REQUIRED TO RUN THIS (creating a database and a role
// needs one). Where none is available the test skips loudly rather than passing
// on no evidence.

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const crypto = require("node:crypto");
const { Client } = require("pg");

const ADMIN_DB = process.env.TEST_ADMIN_DATABASE_URL || "";
const SKIP = !ADMIN_DB;

if (SKIP) {
  console.warn("\n*** SKIPPING BOOTSTRAP TEST: TEST_ADMIN_DATABASE_URL is not set. ***");
  console.warn("*** Reproducible deployment is therefore NOT VERIFIED in this run. ***\n");
}

const ROOT = path.resolve(__dirname, "..", "..");

/* A throwaway database and role per run, so this never collides with the
   developer's own and never leaves state behind. */
const SUFFIX = crypto.randomBytes(4).toString("hex");
const DB_NAME = `fg_bootstrap_${SUFFIX}`;
const ROLE_NAME = `fg_app_${SUFFIX}`;
const ROLE_PASSWORD = "bootstrap-test-password";

function urlFor(database, { user = null, password = null } = {}) {
  const parsed = new URL(ADMIN_DB);
  parsed.pathname = `/${database}`;
  if (user) {
    parsed.username = user;
    parsed.password = password || "";
  }
  return parsed.toString();
}

async function withClient(url, fn) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

/** Superuser connection to the maintenance database, for setup and teardown. */
async function maintenance(fn) {
  return withClient(urlFor("postgres"), fn);
}

let bootstrapOutput = "";

test.before(async () => {
  if (SKIP) return;
  // Absolutely nothing but an empty database exists at this point. In
  // particular: no role, no schema, no grants.
  await maintenance(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
    await c.query(`DROP ROLE IF EXISTS ${ROLE_NAME}`);
  });
});

test.after(async () => {
  if (SKIP) return;
  await maintenance(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
    await c.query(`DROP ROLE IF EXISTS ${ROLE_NAME}`);
  }).catch(() => { /* best effort */ });
});

// ── B1. The documented process, and nothing else ─────────────────
test("[B1] `npm run db:bootstrap` builds a usable database from nothing",
  { skip: SKIP }, () => {
    /* THE WHOLE POINT. This is the only setup any other test in this file
       performs. If it does not produce a working deployment, the deployment
       process is not reproducible — which is the defect. */
    bootstrapOutput = execFileSync("node", ["scripts/bootstrap-db.js"], {
      cwd: ROOT,
      encoding: "utf-8",
      env: Object.assign({}, process.env, {
        ADMIN_DATABASE_URL: urlFor(DB_NAME),
        DATABASE_URL: urlFor(DB_NAME, { user: ROLE_NAME, password: ROLE_PASSWORD }),
        APP_DB_ROLE: ROLE_NAME,
        APP_DB_PASSWORD: ROLE_PASSWORD,
        LOG_LEVEL: "error"
      })
    });

    assert.match(bootstrapOutput, /created database/i, "it created the database");
    assert.match(bootstrapOutput, /created non-superuser role/i,
      "and the restricted role");
    assert.match(bootstrapOutput, /applied \d+ migration/i, "and ran the migrations");
    assert.match(bootstrapOutput, /can reach every table/i,
      "and verified the role can actually use them");
  });

// ── B2. The role is genuinely restricted ─────────────────────────
test("[B2] the application role is NOT a superuser and cannot bypass RLS",
  { skip: SKIP }, async () => {
    /* If the application connected as a superuser, every RLS policy in this
       system would be decorative — Postgres does not apply row-level security
       to superusers, and BYPASSRLS does the same thing explicitly. */
    const role = await maintenance(async (c) =>
      (await c.query(
        "SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = $1",
        [ROLE_NAME])).rows[0]);

    assert.ok(role, "the role exists");
    assert.equal(role.rolsuper, false, "NOT a superuser");
    assert.equal(role.rolbypassrls, false, "cannot bypass row-level security");
    assert.equal(role.rolcreatedb, false, "cannot create databases");
    assert.equal(role.rolcreaterole, false, "cannot create roles");
  });

// ── B3. Schema and migration ledger ──────────────────────────────
test("[B3] every migration is recorded and the core tables exist",
  { skip: SKIP }, async () => {
    const appUrl = urlFor(DB_NAME, { user: ROLE_NAME, password: ROLE_PASSWORD });
    const state = await withClient(appUrl, async (c) => ({
      migrations: (await c.query("SELECT name FROM schema_migration ORDER BY name")).rows
        .map((r) => r.name),
      tables: (await c.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")).rows
        .map((r) => r.tablename)
    }));

    assert.ok(state.migrations.length >= 7,
      `all migrations were applied and recorded (got ${state.migrations.length})`);
    assert.ok(state.migrations.includes("001_init.sql"));

    // The tables the application cannot function without.
    ["tenant", "app_user", "membership", "financial_transaction", "analysis_run",
      "finding", "finding_evidence", "metric_value", "credit_balance", "ai_interaction"]
      .forEach((table) => {
        assert.ok(state.tables.includes(table), `${table} exists`);
      });
  });

// ── B4. THE REGRESSION GUARD for the original defect ─────────────
test("[B4] the application role can reach EVERY table with no manual grant",
  { skip: SKIP }, async () => {
    /* THIS IS THE TEST THAT WOULD HAVE CAUGHT IT. Twelve tables — tenant,
       app_user, membership, account, counterparty, financial_period,
       financial_statement, rule_version, audit_event, ai_invocation,
       zoho_connection, schema_migration — had no GRANT in any migration. Only
       the documented bootstrap has run here, so any table this role cannot read
       is a table whose grant lives outside the repository. */
    const appUrl = urlFor(DB_NAME, { user: ROLE_NAME, password: ROLE_PASSWORD });
    const unreachable = await withClient(appUrl, async (c) =>
      (await c.query(
        `SELECT tablename FROM pg_tables
          WHERE schemaname = 'public'
            AND NOT has_table_privilege(current_user,
                  quote_ident(schemaname) || '.' || quote_ident(tablename), 'SELECT')
          ORDER BY tablename`)).rows.map((r) => r.tablename));

    assert.deepEqual(unreachable, [],
      "no table requires a grant that the documented bootstrap does not apply. "
      + "A name here means a hidden out-of-band GRANT is needed again.");
  });

test("[B5] the role can WRITE to the tables it must write to", { skip: SKIP }, async () => {
  // SELECT privilege alone would let B4 pass while every insert failed.
  const appUrl = urlFor(DB_NAME, { user: ROLE_NAME, password: ROLE_PASSWORD });
  const cannotWrite = await withClient(appUrl, async (c) =>
    (await c.query(
      `SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
          AND NOT has_table_privilege(current_user,
                quote_ident(schemaname) || '.' || quote_ident(tablename), 'INSERT')
        ORDER BY tablename`)).rows.map((r) => r.tablename));
  assert.deepEqual(cannotWrite, [], "every table is writable by the application role");
});

test("[B6] the role has NO DDL rights — RLS stays enforceable", { skip: SKIP }, async () => {
  /* RLS is only a boundary if the constrained role cannot switch it off. A role
     that can ALTER TABLE can disable a policy, so this asserts the absence of a
     privilege rather than the presence of one. */
  const appUrl = urlFor(DB_NAME, { user: ROLE_NAME, password: ROLE_PASSWORD });
  await withClient(appUrl, async (c) => {
    await assert.rejects(
      () => c.query("ALTER TABLE financial_transaction DISABLE ROW LEVEL SECURITY"),
      /must be owner|permission denied/i,
      "the application role cannot disable row-level security");

    await assert.rejects(
      () => c.query("CREATE TABLE bootstrap_should_not_exist (id int)"),
      /permission denied/i,
      "nor create tables");
  });
});

// ── B7. RLS behaviour, on the freshly built database ─────────────
test("[B7] RLS confines the application role to one tenant", { skip: SKIP }, async () => {
  const appUrl = urlFor(DB_NAME, { user: ROLE_NAME, password: ROLE_PASSWORD });

  // Two tenants, created through the admin connection.
  const [tenantA, tenantB] = await withClient(urlFor(DB_NAME), async (c) => {
    const a = (await c.query(
      "INSERT INTO tenant (name) VALUES ('Alpha') RETURNING id")).rows[0].id;
    const b = (await c.query(
      "INSERT INTO tenant (name) VALUES ('Beta') RETURNING id")).rows[0].id;
    return [a, b];
  });

  // ── One minimal tenant-scoped write/read, exactly as the app performs it.
  await withClient(appUrl, async (c) => {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
    await c.query(
      `INSERT INTO financial_transaction
         (tenant_id, period, source_system, source_record_id, txn_type, txn_date,
          amount, currency, direction)
       VALUES ($1,'2026-05','bootstrap-test','rec-1','other','2026-05-04',
               -1000,'KES','outflow')`,
      [tenantA]);

    const mine = await c.query("SELECT source_record_id FROM financial_transaction");
    assert.equal(mine.rows.length, 1, "the tenant reads back its own row");
    assert.equal(mine.rows[0].source_record_id, "rec-1");
    await c.query("COMMIT");
  });

  // ── The other tenant sees nothing of it.
  await withClient(appUrl, async (c) => {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantB]);
    const theirs = await c.query("SELECT source_record_id FROM financial_transaction");
    assert.equal(theirs.rows.length, 0,
      "RLS hides tenant A's records from tenant B on a freshly bootstrapped database");
    await c.query("COMMIT");
  });

  // ── And writing another tenant's id is refused, not silently accepted.
  await withClient(appUrl, async (c) => {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantB]);
    await assert.rejects(
      () => c.query(
        `INSERT INTO financial_transaction
           (tenant_id, period, source_system, source_record_id, txn_type, txn_date,
            amount, currency, direction)
         VALUES ($1,'2026-05','bootstrap-test','rec-2','other','2026-05-04',
                 -1000,'KES','outflow')`,
        [tenantA]),
      /row-level security|violates/i,
      "a tenant cannot write rows attributed to another");
    await c.query("ROLLBACK").catch(() => {});
  });
});

// ── B8. Re-running bootstrap is safe ─────────────────────────────
test("[B8] bootstrap is idempotent", { skip: SKIP }, () => {
  // A deployment runs this on every release; the second run must be a no-op
  // rather than an error or a reset.
  const second = execFileSync("node", ["scripts/bootstrap-db.js"], {
    cwd: ROOT,
    encoding: "utf-8",
    env: Object.assign({}, process.env, {
      ADMIN_DATABASE_URL: urlFor(DB_NAME),
      DATABASE_URL: urlFor(DB_NAME, { user: ROLE_NAME, password: ROLE_PASSWORD }),
      APP_DB_ROLE: ROLE_NAME,
      APP_DB_PASSWORD: ROLE_PASSWORD,
      LOG_LEVEL: "error"
    })
  });

  assert.match(second, /already exists/i, "it recognises what is already there");
  assert.match(second, /already up to date|applied 0 migration/i,
    "and applies no migration a second time");
  assert.match(second, /can reach every table/i, "while still verifying access");
});

// ══════════════════════════════════════════════════════════════════
// JOB 13 PHASE A — PUBLIC has no access to anything.
//
// Migrations 004-007 granted to PUBLIC, which in PostgreSQL means EVERY role in
// the cluster. A live inventory found 16 tables and 3 sequences reachable that
// way, including `user_session` and `identity_revocation` — which sit OUTSIDE
// row-level security by design, because they are consulted before a tenant is
// known. For those, PUBLIC was the only gate.
//
// These tests create a REAL, UNRELATED PostgreSQL role and try to use it. RLS
// is irrelevant to the question being asked here: the point is whether a role
// that is not the application can reach the tables at all.
// ══════════════════════════════════════════════════════════════════

/* WHAT "DENIED" LOOKS LIKE FOR AN OUTSIDER.
   Two different errors both mean no access, and the second is the STRONGER
   outcome:

     "permission denied for table X"  -> the role can resolve the name but not
                                         use it (schema USAGE, no table grant)
     "relation X does not exist"      -> the role cannot even resolve the name,
                                         because migration 008 revoked schema
                                         USAGE from PUBLIC

   Asserting only the first would fail against the better result. */
const DENIED = /permission denied|does not exist/i;

const OUTSIDER = `fg_outsider_${SUFFIX}`;
const OUTSIDER_PASSWORD = "outsider-test-password";

/** Tables holding data no unrelated role may touch. */
const PROTECTED = [
  ["financial_transaction", "the tenant's financial records"],
  ["analysis_run", "completed analyses"],
  ["finding", "what the engine concluded"],
  ["finding_evidence", "the records those conclusions cite"],
  ["metric_value", "computed financial metrics"],
  ["credit_balance", "billing state"],
  ["credit_transaction", "the billing ledger"],
  ["ai_interaction", "the AI audit trail"],
  ["conversation", "chat history"],
  ["conversation_turn", "chat messages"],
  ["user_session", "session material — NOT under RLS"],
  ["identity_revocation", "identity versions — NOT under RLS"],
  ["app_user", "user identities"],
  ["tenant", "the tenant directory"]
];

test.before(async () => {
  if (SKIP) return;
  // An unrelated role: it can log in and holds no grant of any kind.
  await maintenance(async (c) => {
    await c.query(`DROP ROLE IF EXISTS ${OUTSIDER}`);
    await c.query(
      `CREATE ROLE ${OUTSIDER} LOGIN PASSWORD '${OUTSIDER_PASSWORD}' `
      + "NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS");
  });
});

test.after(async () => {
  if (SKIP) return;
  await maintenance((c) => c.query(`DROP ROLE IF EXISTS ${OUTSIDER}`))
    .catch(() => { /* best effort */ });
});

test("[B9] PUBLIC holds no privilege on any table or sequence", { skip: SKIP }, async () => {
  const remaining = await withClient(urlFor(DB_NAME), async (c) => ({
    tables: (await c.query(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'PUBLIC' AND table_schema = 'public'
        ORDER BY table_name`)).rows,
    sequences: (await c.query(
      `SELECT c.relname, a.privilege_type
         FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
        WHERE c.relkind = 'S' AND a.grantee = 0`)).rows
  }));

  assert.deepEqual(remaining.tables, [],
    "no table grants PUBLIC anything");
  assert.deepEqual(remaining.sequences, [],
    "and neither does any sequence");
});

test("[B10] PUBLIC has no USAGE on the schema", { skip: SKIP }, async () => {
  const acl = await withClient(urlFor(DB_NAME), async (c) =>
    (await c.query(
      "SELECT array_to_string(nspacl, ',') AS acl FROM pg_namespace WHERE nspname = 'public'"))
      .rows[0].acl);
  /* PostgreSQL renders a PUBLIC grant as an entry with an EMPTY grantee, i.e.
     "=U/owner". Its absence is what this asserts. */
  assert.equal(/(^|,)=[A-Za-z]*\//.test(acl || ""), false,
    `PUBLIC still holds schema privileges: ${acl}`);
});

test("[B11] an unrelated role cannot READ protected data", { skip: SKIP }, async () => {
  /* THE REAL TEST, with a real role. Before 008 every one of these succeeded,
     and for user_session and identity_revocation there was no RLS behind the
     grant to stop it. */
  const outsiderUrl = urlFor(DB_NAME, { user: OUTSIDER, password: OUTSIDER_PASSWORD });
  await withClient(outsiderUrl, async (c) => {
    for (const [table, why] of PROTECTED) {
      await assert.rejects(
        () => c.query(`SELECT * FROM ${table} LIMIT 1`),
        DENIED,
        `an unrelated role cannot read ${table} (${why})`);
    }
  });
});

test("[B12] an unrelated role cannot WRITE protected data", { skip: SKIP }, async () => {
  const outsiderUrl = urlFor(DB_NAME, { user: OUTSIDER, password: OUTSIDER_PASSWORD });
  await withClient(outsiderUrl, async (c) => {
    await assert.rejects(
      () => c.query("INSERT INTO tenant (name) VALUES ('injected')"),
      DENIED,
      "nor create a tenant");
    await assert.rejects(
      () => c.query("DELETE FROM financial_transaction"),
      DENIED,
      "nor delete financial records");
    await assert.rejects(
      () => c.query("UPDATE credit_balance SET credits = 999999"),
      DENIED,
      "nor grant itself credits");
  });
});

test("[B13] an unrelated role cannot bypass RLS by setting a tenant id",
  { skip: SKIP }, async () => {
    /* `app.tenant_id` is a plain session setting that any role may set. Before
       008, setting it was enough to read a tenant's rows, because the table
       grant was PUBLIC and the RLS policy was satisfied. The grant is now the
       outer gate and RLS the inner one. */
    const tenantId = await withClient(urlFor(DB_NAME), async (c) =>
      (await c.query("SELECT id FROM tenant LIMIT 1")).rows[0].id);

    const outsiderUrl = urlFor(DB_NAME, { user: OUTSIDER, password: OUTSIDER_PASSWORD });
    await withClient(outsiderUrl, async (c) => {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      await assert.rejects(
        () => c.query("SELECT * FROM financial_transaction"),
        DENIED,
        "claiming a tenant id does not help a role with no table privilege");
      await c.query("ROLLBACK").catch(() => {});
    });
  });

test("[B14] the APPLICATION role can still do everything it needs", { skip: SKIP }, async () => {
  /* The other half: revoking PUBLIC must not break the application. This
     exercises the full round trip as the app performs it, including the
     function calls that RLS itself depends on. */
  const appUrl = urlFor(DB_NAME, { user: ROLE_NAME, password: ROLE_PASSWORD });
  const tenantId = await withClient(urlFor(DB_NAME), async (c) =>
    (await c.query("SELECT id FROM tenant LIMIT 1")).rows[0].id);

  await withClient(appUrl, async (c) => {
    /* current_tenant_id() is called by EVERY RLS policy, and gen_random_uuid()
       backs column DEFAULTs across the schema. Both were PUBLIC-executable by
       default; revoking function privileges from PUBLIC broke them until the
       grant step was taught to hand EXECUTE to the application role. This is
       what caught that. */
    const fn = await c.query("SELECT gen_random_uuid() AS id");
    assert.ok(fn.rows[0].id, "the application role can call gen_random_uuid()");

    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);

    const tenantFn = await c.query("SELECT current_tenant_id() AS t");
    assert.equal(tenantFn.rows[0].t, tenantId,
      "and current_tenant_id(), which RLS itself depends on");

    await c.query(
      `INSERT INTO financial_transaction
         (tenant_id, period, source_system, source_record_id, txn_type, txn_date,
          amount, currency, direction)
       VALUES ($1,'2026-07','revoke-test','rec-revoke-1','other','2026-07-04',
               -2500,'KES','outflow')
       ON CONFLICT DO NOTHING`,
      [tenantId]);

    const read = await c.query(
      "SELECT source_record_id FROM financial_transaction WHERE period = '2026-07'");
    assert.equal(read.rows.length, 1, "write and read back both work");
    await c.query("COMMIT");
  });
});

test("[B15] RLS still isolates tenants after the revoke", { skip: SKIP }, async () => {
  // Revoking PUBLIC must not have disturbed the inner boundary.
  const appUrl = urlFor(DB_NAME, { user: ROLE_NAME, password: ROLE_PASSWORD });
  const tenants = await withClient(urlFor(DB_NAME), async (c) =>
    (await c.query("SELECT id FROM tenant ORDER BY created_at LIMIT 2")).rows.map((r) => r.id));
  assert.equal(tenants.length, 2, "two tenants exist from [B7]");

  await withClient(appUrl, async (c) => {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenants[1]]);
    const other = await c.query(
      "SELECT source_record_id FROM financial_transaction WHERE period = '2026-07'");
    assert.equal(other.rows.length, 0,
      "tenant B still cannot see the row tenant A just wrote");
    await c.query("COMMIT");
  });
});

test("[B16] the sequences the app uses are still usable", { skip: SKIP }, async () => {
  /* Revoking sequence privileges from PUBLIC would break every insert into a
     table with a serial id — conversation_turn, credit_transaction, job_run —
     if the application role were not granted USAGE explicitly. */
  const appUrl = urlFor(DB_NAME, { user: ROLE_NAME, password: ROLE_PASSWORD });
  await withClient(appUrl, async (c) => {
    for (const seq of ["conversation_turn_id_seq", "credit_transaction_id_seq",
      "job_run_id_seq"]) {
      const res = await c.query(`SELECT nextval('${seq}') AS v`);
      assert.ok(Number(res.rows[0].v) > 0, `${seq} is usable by the application role`);
    }
  });

  // And NOT by an unrelated role.
  const outsiderUrl = urlFor(DB_NAME, { user: OUTSIDER, password: OUTSIDER_PASSWORD });
  await withClient(outsiderUrl, async (c) => {
    await assert.rejects(
      () => c.query("SELECT nextval('job_run_id_seq')"),
      DENIED,
      "an unrelated role cannot advance a sequence");
  });
});
