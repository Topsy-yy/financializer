// APPLICATION-ROLE GRANTS — the step that was previously done by hand.
//
// THE DEFECT. Migrations 001-003 create fourteen tables and grant on none of
// them. 004-007 grant on some. The result was that a clean database built from
// the repository could not be used by the application: the restricted role
// could connect, and then every query failed with "permission denied for table
// tenant". Whoever set up the original environment ran GRANT statements by
// hand, and those statements existed nowhere in the repository — so the
// deployment was not reproducible, and nobody would discover that until they
// tried to stand up a new one.
//
// WHY THIS IS NOT ANOTHER MIGRATION. A migration is static SQL, so it cannot
// name a role that varies per deployment without string-substituting into DDL.
// Grants are also not a one-time schema change: they must cover whatever tables
// exist NOW, including tables added by a migration written after this file. So
// they are applied as a step that runs AFTER migrations, is idempotent, and is
// derived from the live catalogue rather than a hardcoded list that would drift.
//
// WHY NOT `GRANT ... TO PUBLIC`. Four existing migrations do that, and it does
// work. It is looser than it needs to be: PUBLIC includes every role in the
// cluster, and the tables that deliberately sit OUTSIDE row-level security
// (schema_migration, rule_version, identity_revocation) would then be readable
// and writable by any role that can connect. Granting to a NAMED role keeps the
// blast radius at the one role the application actually uses. The existing
// PUBLIC grants are left in place — revoking them is a separate decision with
// its own migration — but they are no longer what the deployment depends on.
//
// WHAT IS DELIBERATELY NOT GRANTED. No DDL, no ownership, no superuser. The
// application role can read and write rows and nothing else, which is what makes
// RLS meaningful: a role that could ALTER TABLE could simply switch the policy
// off. See docs/ENVIRONMENT.md.

const { logger } = require("../services/logger");

const log = logger.child({ component: "db-grants" });

/** DML only. Deliberately no TRUNCATE, no REFERENCES, no TRIGGER, no DDL. */
const TABLE_PRIVILEGES = "SELECT, INSERT, UPDATE, DELETE";
const SEQUENCE_PRIVILEGES = "USAGE, SELECT";

/**
 * Is this a legal role name?
 *
 * The role name is interpolated into DDL, which no parameter placeholder can
 * carry, so it is validated rather than escaped. Anything outside this
 * character class is refused instead of quoted-and-hoped.
 */
function assertSafeRoleName(role) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(role)) {
    throw new Error(
      `unsafe database role name: ${JSON.stringify(role)}. `
      + "Expected a plain identifier (letters, digits, underscore).");
  }
}

async function roleExists(client, role) {
  const { rows } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
  return rows.length > 0;
}

/**
 * Grant the application role everything it needs, and nothing more.
 *
 * Idempotent: safe to run on every deploy, and re-running after a new migration
 * is how that migration's tables become reachable.
 *
 * @returns {object} what was granted, for the caller to log or assert on.
 */
async function applyGrants(client, role, { schema = "public" } = {}) {
  assertSafeRoleName(role);
  if (!await roleExists(client, role)) {
    throw new Error(
      `database role "${role}" does not exist. Create it first — `
      + "`npm run db:bootstrap` does this, or see docs/ENVIRONMENT.md.");
  }

  // USAGE on the schema, or every other grant below is unreachable.
  await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);

  await client.query(
    `GRANT ${TABLE_PRIVILEGES} ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
  await client.query(
    `GRANT ${SEQUENCE_PRIVILEGES} ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);

  /* FUNCTION EXECUTE — required, and easy to miss.
   *
   * Migration 008 revokes function privileges from PUBLIC, and PostgreSQL
   * grants EXECUTE to PUBLIC by default. Two things break without an explicit
   * grant here, and neither is obvious from reading the schema:
   *
   *   current_tenant_id()  is called by EVERY row-level security policy. Without
   *                        EXECUTE, the application role gets "permission denied
   *                        for function current_tenant_id" on every query
   *                        against a tenant table — RLS fails closed, so the
   *                        application simply stops working.
   *
   *   gen_random_uuid()    from pgcrypto, used in column DEFAULTs throughout
   *                        this schema. The default evaluates as the INSERTING
   *                        role, so that role needs EXECUTE or every insert
   *                        fails.
   *
   * Found by connecting as the real restricted role after the revoke, not by
   * reading the migration. */
  await client.query(
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} TO ${role}`);
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema}
       GRANT EXECUTE ON FUNCTIONS TO ${role}`);

  /* DEFAULT PRIVILEGES so a table created by a FUTURE migration is reachable
     without anyone remembering to come back here. This is what stops the
     original defect recurring the next time a migration adds a table.

     Scoped to the role running this (the migration owner), because default
     privileges apply to objects created BY a particular role. */
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema}
       GRANT ${TABLE_PRIVILEGES} ON TABLES TO ${role}`);
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema}
       GRANT ${SEQUENCE_PRIVILEGES} ON SEQUENCES TO ${role}`);

  const { rows } = await client.query(
    `SELECT count(*)::int AS tables FROM pg_tables WHERE schemaname = $1`, [schema]);

  log.info("db.grants.applied", { role, schema, tables: rows[0].tables });
  return { role, schema, tables: rows[0].tables };
}

/**
 * Report tables the role CANNOT read — the assertion a bootstrap test needs.
 *
 * An empty list is the property: every table the application might touch is
 * reachable by the application's own role, with no hidden manual step.
 */
async function findUngrantedTables(client, role, { schema = "public" } = {}) {
  assertSafeRoleName(role);
  const { rows } = await client.query(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = $1
        AND NOT has_table_privilege($2, quote_ident(schemaname) || '.' || quote_ident(tablename), 'SELECT')
      ORDER BY tablename`,
    [schema, role]
  );
  return rows.map((r) => r.tablename);
}

module.exports = {
  applyGrants, findUngrantedTables, assertSafeRoleName, roleExists,
  TABLE_PRIVILEGES, SEQUENCE_PRIVILEGES
};
