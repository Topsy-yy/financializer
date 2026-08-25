#!/usr/bin/env node
// Forward-only migration runner. Each file runs once, inside a transaction,
// and is recorded with a checksum so an edited migration is detected.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { withAdmin, isConfigured, close } = require("./pool");
const { logger } = require("../services/logger");
const grants = require("./grants");

const DIR = path.join(__dirname, "migrations");

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      name        text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )`);
}

function files() {
  return fs.readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
}

async function migrate({ silent = false } = {}) {
  if (!isConfigured()) throw new Error("DATABASE_URL is not configured");
  const log = (...a) => { if (!silent) console.log(...a); };
  const applied = [];

  await withAdmin(async (client) => {
    await ensureTable(client);
    const { rows } = await client.query("SELECT name, checksum FROM schema_migration");
    const seen = new Map(rows.map((r) => [r.name, r.checksum]));

    for (const name of files()) {
      const sql = fs.readFileSync(path.join(DIR, name), "utf-8");
      const checksum = crypto.createHash("sha256").update(sql).digest("hex");
      if (seen.has(name)) {
        if (seen.get(name) !== checksum) {
          throw new Error(`migration ${name} has changed after being applied (checksum mismatch)`);
        }
        continue;
      }
      log(`applying ${name}...`);
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migration (name, checksum) VALUES ($1, $2)", [name, checksum]);
        applied.push(name);
      } catch (err) {
        throw new Error(`migration ${name} failed: ${err.message}`);
      }
    }

    /* GRANTS, EVERY TIME — not once, and not by hand.
       Migrations 001-003 create fourteen tables and grant on none of them, so a
       database built from this repository was unusable by the restricted
       application role until someone ran GRANT statements that existed nowhere
       in the repo. Applying them here, after every migration run, means a new
       table added by a future migration is reachable without anyone
       remembering. Idempotent, so re-running changes nothing. */
    const role = process.env.APP_DB_ROLE || "";
    if (role) {
      const applied = await grants.applyGrants(client, role);
      log(`granted ${applied.tables} table(s) to ${role}`);
    } else {
      /* AFTER 008 THIS IS FATAL, NOT A WARNING.
         008 revokes every PUBLIC privilege, so a database that has applied it
         and has no named application role is unreachable by anything except its
         owner. Continuing would report success and leave a broken deployment —
         the precise failure mode this whole line of work exists to remove. It
         is checked against the migration ledger rather than the file list, so
         it stays correct on a database that has not upgraded yet. */
      const { rows } = await client.query(
        "SELECT 1 FROM schema_migration WHERE name = $1", ["008_revoke_public.sql"]);
      if (rows.length) {
        throw new Error(
          "APP_DB_ROLE is not set, but 008_revoke_public.sql has been applied. "
          + "PUBLIC access is revoked, so the application role must be named and "
          + "granted explicitly or nothing can reach the data. "
          + "Set APP_DB_ROLE (see docs/ENVIRONMENT.md) or run `npm run db:bootstrap`.");
      }
      log("APP_DB_ROLE not set — skipping application-role grants. "
        + "A two-role deployment REQUIRES it; see docs/ENVIRONMENT.md.");
    }
  });

  log(applied.length ? `applied ${applied.length} migration(s)` : "database already up to date");
  return applied;
}

if (require.main === module) {
  migrate().then(() => close()).catch((err) => { logger.error("migration failed:", err.message); process.exit(1); });
}

module.exports = { migrate, files };
