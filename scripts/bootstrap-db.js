#!/usr/bin/env node
// ONE COMMAND TO STAND UP A DATABASE FROM NOTHING.
//
//   npm run db:bootstrap
//
// THE DEFECT THIS CLOSES. The repository could build a SCHEMA but not a working
// DEPLOYMENT. Migrations create the tables; nothing created the restricted
// application role, and nothing granted it access to fourteen of them. The
// environment this was originally developed against had those steps applied by
// hand, in SQL that lived nowhere. Anyone standing up a new instance — a new
// developer, a new region, a disaster-recovery rebuild — got a database that
// connected and then failed every query with "permission denied for table
// tenant". The setup instructions were not wrong so much as incomplete in a way
// that could not be discovered by reading them.
//
// WHAT THIS DOES, in order, all idempotent:
//
//   1. creates the database, if it does not exist
//   2. creates the NON-SUPERUSER application role, if it does not exist
//   3. runs every migration
//   4. grants that role exactly the DML it needs (src/db/grants.js)
//   5. verifies the role can actually reach every table
//
// WHAT IT DELIBERATELY DOES NOT DO. It never grants DDL, ownership or superuser
// to the application role. RLS is only a boundary if the role it constrains
// cannot turn it off, and a role with ALTER TABLE can. Step 5 exists because
// steps 1-4 succeeding is not the same as the application working.
//
// ENVIRONMENT
//   ADMIN_DATABASE_URL   a superuser/owner connection (creates role + schema)
//   DATABASE_URL         the application's own connection, using APP_DB_ROLE
//   APP_DB_ROLE          the restricted role name (default: finguard_app)
//   APP_DB_PASSWORD      its password, required when creating the role

const { Client } = require("pg");
const grants = require("../src/db/grants");

const ADMIN_URL = process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL || "";
const APP_URL = process.env.DATABASE_URL || "";
const ROLE = process.env.APP_DB_ROLE || "finguard_app";
const PASSWORD = process.env.APP_DB_PASSWORD || "";

function fail(message) {
  console.error(`\nbootstrap failed: ${message}\n`);
  process.exit(1);
}

/** Connect to a specific database on the same server as `url`. */
function urlForDatabase(url, database) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function databaseNameOf(url) {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
}

async function connect(url) {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

async function ensureDatabase() {
  const target = databaseNameOf(ADMIN_URL);
  if (!target) fail("ADMIN_DATABASE_URL has no database name");

  /* Connect to `postgres` to ask whether the target exists. CREATE DATABASE
     cannot run inside a transaction and cannot run from within the database
     being created. */
  let maintenance;
  try {
    maintenance = await connect(urlForDatabase(ADMIN_URL, "postgres"));
  } catch (err) {
    // Some managed providers forbid connecting to `postgres`. The database
    // usually already exists there, so this is a warning, not a failure.
    console.log(`  (could not reach the maintenance database: ${err.message})`);
    console.log("  assuming the target database already exists");
    return target;
  }
  try {
    const { rows } = await maintenance.query(
      "SELECT 1 FROM pg_database WHERE datname = $1", [target]);
    if (rows.length) {
      console.log(`  database ${target} already exists`);
    } else {
      await maintenance.query(`CREATE DATABASE ${quoteIdent(target)}`);
      console.log(`  created database ${target}`);
    }
  } finally {
    await maintenance.end();
  }
  return target;
}

/** Identifiers cannot be parameterized; validate and quote. */
function quoteIdent(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_$]{0,62}$/.test(name)) {
    throw new Error(`unsafe identifier: ${JSON.stringify(name)}`);
  }
  return `"${name}"`;
}

async function ensureRole(client) {
  grants.assertSafeRoleName(ROLE);
  if (await grants.roleExists(client, ROLE)) {
    console.log(`  role ${ROLE} already exists`);
    return;
  }
  if (!PASSWORD) {
    fail(`role ${ROLE} does not exist and APP_DB_PASSWORD is not set, so it `
      + "cannot be created. Set APP_DB_PASSWORD, or create the role yourself.");
  }
  /* LOGIN, and nothing else. No SUPERUSER, no CREATEDB, no CREATEROLE, no
     BYPASSRLS — the last one especially: a role that can bypass RLS makes every
     tenant-isolation guarantee in this system decorative. */
  await client.query(
    `CREATE ROLE ${quoteIdent(ROLE)} LOGIN PASSWORD $1
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`.replace("$1", `'${PASSWORD.replace(/'/g, "''")}'`)
  );
  console.log(`  created non-superuser role ${ROLE}`);
}

async function verify(client) {
  const missing = await grants.findUngrantedTables(client, ROLE);
  if (missing.length) {
    fail(
      `the application role ${ROLE} still cannot read: ${missing.join(", ")}.\n`
      + "  This is the exact defect bootstrap exists to prevent — it means a\n"
      + "  grant is being applied outside the repository. Fix src/db/grants.js\n"
      + "  rather than running GRANT by hand.");
  }
  console.log(`  verified: ${ROLE} can reach every table`);
}

async function main() {
  if (!ADMIN_URL) {
    fail("set ADMIN_DATABASE_URL (a superuser/owner connection) — see docs/ENVIRONMENT.md");
  }
  console.log("\nFinGuard database bootstrap\n");

  console.log("1. database");
  await ensureDatabase();

  console.log("2. application role");
  const admin = await connect(ADMIN_URL);
  try {
    await ensureRole(admin);
  } finally {
    await admin.end();
  }

  console.log("3. migrations");
  // Migrations run as the ADMIN connection; the runner reads DATABASE_URL, so
  // point it at the admin URL for this step only.
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = ADMIN_URL;
  process.env.APP_DB_ROLE = ROLE;
  // Required after the env change: pool.js reads DATABASE_URL when first loaded.
  const { migrate } = require("../src/db/migrate");
  const pool = require("../src/db/pool");
  await migrate();
  await pool.close();
  if (previousUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousUrl;

  console.log("4. verification");
  const verifier = await connect(ADMIN_URL);
  try {
    await verify(verifier);
  } finally {
    await verifier.end();
  }

  console.log(`\nReady. The application connects as ${ROLE}.`);
  if (APP_URL && !APP_URL.includes(ROLE)) {
    console.log(
      `\nNOTE: DATABASE_URL does not appear to use ${ROLE}. The application `
      + "should connect\n      as the restricted role, not as an owner or superuser.");
  }
}

if (require.main === module) {
  main().catch((err) => fail(err.message));
}

module.exports = { main };
