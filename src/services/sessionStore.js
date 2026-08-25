// POSTGRESQL-BACKED SESSION STORE.
//
// WHAT THIS REPLACES. `express-session` with no `store` option, i.e. the bundled
// MemoryStore. Two consequences:
//
//   * every logged-in user was logged out by any restart or deploy;
//   * a second instance could not see the first's sessions, so continuity
//     required sticky sessions.
//
// The gap was papered over by a 400-day signed identity cookie that silently
// re-authenticated a browser after restart with no re-verification against the
// identity provider. That made restarts survivable while making sessions
// effectively unrevocable — logout nulled a field but left the cookie valid.
//
// This store makes the session itself durable, which lets logout actually
// destroy it.
//
// WHY NOT connect-pg-simple: it is a small, well-understood interface and this
// codebase already owns its pool, its migrations and its tenant conventions.
// A dependency here would bring its own table shape and its own migration path.
//
// WHAT A SESSION HOLDS: an identity. Not financial data. The payload is opaque
// jsonb so the session table cannot quietly become another place tenant data
// accumulates.

const session = require("express-session");
const pool = require("../db/pool");
const { logger } = require("./logger");

const log = logger.child({ component: "session" });

const Store = session.Store;

class PostgresSessionStore extends Store {
  constructor({ ttlMs = 14 * 24 * 60 * 60 * 1000, sweepIntervalMs = 15 * 60 * 1000 } = {}) {
    super();
    this.ttlMs = ttlMs;

    // Expired rows are deleted on a timer rather than on every read: a read is
    // on the hot path of every request, and an expired session is already
    // rejected by the query's own expiry predicate.
    this.sweepTimer = setInterval(() => {
      this.sweep().catch((err) => log.warn("session sweep failed", { error: err.message }));
    }, sweepIntervalMs);
    if (this.sweepTimer.unref) this.sweepTimer.unref();
  }

  async query(text, params) {
    const client = await pool.getPool().connect();
    try {
      return await client.query(text, params);
    } finally {
      client.release();
    }
  }

  /**
   * Read a session.
   *
   * The expiry predicate is in the QUERY, so an expired row can never be
   * returned even if the sweep has not run yet.
   */
  get(sid, callback) {
    this.query(
      "SELECT data FROM user_session WHERE sid = $1 AND expires_at > now()", [sid])
      .then(({ rows }) => callback(null, rows.length ? rows[0].data : null))
      .catch((err) => {
        // A database blip must not throw a user out; express-session treats an
        // error as "no session", which degrades to logged-out rather than to a
        // 500. It is logged so the blip is visible.
        log.error("session read failed", { error: err.message });
        callback(null, null);
      });
  }

  set(sid, sessionData, callback) {
    const expiresAt = sessionData.cookie && sessionData.cookie.expires
      ? new Date(sessionData.cookie.expires)
      : new Date(Date.now() + this.ttlMs);

    // Denormalised for revocation ("log this user out everywhere") without
    // decoding the payload.
    const userId = extractUserId(sessionData);

    this.query(
      `INSERT INTO user_session (sid, user_id, data, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (sid) DO UPDATE
         SET data = EXCLUDED.data,
             user_id = EXCLUDED.user_id,
             expires_at = EXCLUDED.expires_at`,
      [sid, userId, sessionData, expiresAt])
      .then(() => callback && callback(null))
      .catch((err) => {
        log.error("session write failed", { error: err.message });
        callback && callback(err);
      });
  }

  /** Destroy a session. This is what makes logout real. */
  destroy(sid, callback) {
    this.query("DELETE FROM user_session WHERE sid = $1", [sid])
      .then(() => callback && callback(null))
      .catch((err) => {
        log.error("session destroy failed", { error: err.message });
        callback && callback(err);
      });
  }

  touch(sid, sessionData, callback) {
    const expiresAt = sessionData.cookie && sessionData.cookie.expires
      ? new Date(sessionData.cookie.expires)
      : new Date(Date.now() + this.ttlMs);
    this.query(
      "UPDATE user_session SET expires_at = $2 WHERE sid = $1", [sid, expiresAt])
      .then(() => callback && callback(null))
      .catch(() => callback && callback(null));
  }

  /** Revoke every session for a user — for password change, or a support action. */
  async destroyAllForUser(userId) {
    const { rowCount } = await this.query(
      "DELETE FROM user_session WHERE user_id = $1", [userId]);
    return { destroyed: rowCount };
  }

  async sweep() {
    const { rowCount } = await this.query(
      "DELETE FROM user_session WHERE expires_at < now()");
    if (rowCount) log.debug("expired sessions swept", { count: rowCount });
    return rowCount;
  }

  stop() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }
}

/** Pull a user id out of the session payload, if there is one. */
function extractUserId(sessionData) {
  const google = sessionData && sessionData.googleUser;
  // The store column is a uuid FK; a Google subject is not one, so only a real
  // internal user id is stored. Everything else stays inside the opaque payload.
  return (sessionData && sessionData.userId) || null;
}

/**
 * Build the session store for this environment.
 *
 * Production REQUIRES the database — a MemoryStore in production is the defect
 * this module exists to remove, so it is refused rather than silently used.
 */
function createSessionStore({ isProduction = false } = {}) {
  if (pool.isConfigured()) {
    log.info("session store: postgres");
    return { store: new PostgresSessionStore(), kind: "postgres", durable: true };
  }
  if (isProduction) {
    // Startup validation already refuses a production boot without
    // DATABASE_URL; this is the second line, so a future change to that check
    // cannot silently reintroduce in-memory sessions in production.
    throw new Error(
      "Refusing to use an in-memory session store in production. "
      + "Set DATABASE_URL so sessions survive restart and are shared across instances.");
  }
  log.warn("session store: in-memory (development)", {
    detail: "Sessions will not survive a restart and are not shared across instances."
  });
  return { store: null, kind: "memory", durable: false };
}

module.exports = { PostgresSessionStore, createSessionStore };
