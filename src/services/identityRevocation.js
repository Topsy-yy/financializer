// IDENTITY REVOCATION.
//
// THE DEFECT THIS CLOSES. Login sets `fg_google_sub` — a SIGNED cookie with a
// 400-day lifetime — and `getUserId()` accepts it whenever the session is
// absent. That was deliberate: it let an identity survive a restart when
// sessions lived in memory.
//
// The consequence was that the cookie became a 400-day bearer credential with
// NO server-side revocation. Logout cleared it from the responding browser, but
// a copy taken beforehand — from a shared machine, a synced browser profile, an
// exfiltrated cookie jar — stayed valid for over a year. There was nothing to
// check it against.
//
// THE FIX, minimal by design. Authentication is NOT redesigned. The cookie
// keeps its shape and its signature. What changes is that it now carries an
// IDENTITY VERSION, and the server holds the current version for that identity:
//
//     cookie value:  "<sub>.v<version>"
//     server state:  identity_version[sub] = N
//
// A cookie is accepted only when its version matches. Logout (or an explicit
// revocation) increments the server's version, which invalidates every cookie
// ever issued for that identity — the original and every copy — in one write.
//
// BACKWARD COMPATIBILITY. A cookie with no version suffix is a pre-existing
// session. It is accepted while its identity has never been revoked, so
// deploying this does not log anyone out. The first revocation moves that
// identity to version 1, after which unversioned cookies for it are refused.
//
// STORAGE. PostgreSQL when available, so a revocation holds across instances
// and restarts. Without a database it degrades to in-process state, which is
// correct for a single-instance development deployment and is reported as such.

const fs = require("fs");
const path = require("path");
const pool = require("../db/pool");
const { logger } = require("./logger");

const log = logger.child({ component: "identity" });

/** In-process cache, and the fallback store when there is no database. */
const versions = new Map();

/** Where the fallback persists, so a dev restart does not resurrect a
 *  revoked identity. */
let fallbackPath = null;
function setFallbackPath(dir) {
  fallbackPath = dir ? path.join(dir, "_identity", "revocations.json") : null;
}

function loadFallback() {
  if (!fallbackPath) return;
  try {
    const raw = JSON.parse(fs.readFileSync(fallbackPath, "utf-8"));
    Object.entries(raw).forEach(([k, v]) => versions.set(k, Number(v) || 0));
  } catch { /* no file yet */ }
}

function saveFallback() {
  if (!fallbackPath) return;
  try {
    fs.mkdirSync(path.dirname(fallbackPath), { recursive: true });
    const out = {};
    versions.forEach((v, k) => { out[k] = v; });
    const temp = `${fallbackPath}.tmp-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(out));
    fs.renameSync(temp, fallbackPath);
  } catch (err) {
    // A revocation that cannot be recorded is a security failure, not a
    // cosmetic one: say so loudly.
    log.error("identity revocation could not be persisted", { error: err.message });
  }
}

/** Encode an identity + version into the cookie value. */
function encodeCookie(subject, version) {
  return `${subject}.v${version}`;
}

/**
 * Split a cookie value into its subject and version.
 * An unversioned value returns version null, meaning "issued before versioning".
 */
function decodeCookie(value) {
  const raw = String(value || "");
  const match = raw.match(/^(.+)\.v(\d+)$/);
  if (!match) return { subject: raw, version: null, versioned: false };
  return { subject: match[1], version: Number(match[2]), versioned: true };
}

async function currentVersion(subject) {
  if (!subject) return 0;
  if (pool.isConfigured()) {
    try {
      const client = await pool.getPool().connect();
      try {
        const { rows } = await client.query(
          "SELECT version FROM identity_revocation WHERE subject = $1", [subject]);
        return rows.length ? rows[0].version : 0;
      } finally { client.release(); }
    } catch (err) {
      /* FAIL CLOSED on a lookup error. If we cannot confirm an identity has not
         been revoked, we must not accept it — the alternative is honouring a
         cookie we were unable to check, which is exactly the hole being closed.
         The caller sees the identity as revoked and the user re-authenticates. */
      log.error("identity version lookup failed; treating as revoked", { error: err.message });
      return Number.POSITIVE_INFINITY;
    }
  }
  if (!versions.size) loadFallback();
  return versions.get(subject) || 0;
}

/**
 * Is this cookie still valid for its identity?
 *
 * @returns {object} { valid, subject, reason }
 */
async function verifyCookie(value) {
  const { subject, version, versioned } = decodeCookie(value);
  if (!subject) return { valid: false, subject: null, reason: "empty" };

  const current = await currentVersion(subject);
  if (current === Number.POSITIVE_INFINITY) {
    return { valid: false, subject, reason: "verification_unavailable" };
  }

  if (!versioned) {
    // A pre-versioning cookie. Honoured only while this identity has never been
    // revoked, so deploying this does not log existing users out — but the
    // first revocation invalidates it.
    return current === 0
      ? { valid: true, subject, version: 0, reason: "legacy_unversioned" }
      : { valid: false, subject, reason: "revoked_legacy" };
  }

  if (version !== current) {
    return { valid: false, subject, reason: "version_mismatch" };
  }
  // `version` is returned so a caller establishing a session can stamp it
  // without a second lookup (see routes/api.js session revocation middleware).
  return { valid: true, subject, version: current, reason: "current" };
}

/**
 * Revoke every cookie for an identity by incrementing its version.
 *
 * One write invalidates the original cookie AND every copy, because they all
 * carry the version that was current when they were issued.
 */
async function revoke(subject) {
  if (!subject) return { revoked: false, reason: "no_subject" };

  if (pool.isConfigured()) {
    const client = await pool.getPool().connect();
    try {
      const { rows } = await client.query(
        `INSERT INTO identity_revocation (subject, version, revoked_at)
         VALUES ($1, 1, now())
         ON CONFLICT (subject) DO UPDATE
           SET version = identity_revocation.version + 1, revoked_at = now()
         RETURNING version`,
        [subject]);
      versions.set(subject, rows[0].version);
      log.info("identity.revoked", { version: rows[0].version });
      return { revoked: true, version: rows[0].version, durable: true };
    } finally { client.release(); }
  }

  if (!versions.size) loadFallback();
  const next = (versions.get(subject) || 0) + 1;
  versions.set(subject, next);
  saveFallback();
  log.info("identity.revoked", { version: next, durable: false });
  return { revoked: true, version: next, durable: false };
}

/** The cookie value to issue for an identity right now. */
async function issueCookieValue(subject) {
  const version = await currentVersion(subject);
  const safe = Number.isFinite(version) ? version : 0;
  return encodeCookie(subject, safe);
}

/** Test/maintenance hook. */
function reset() { versions.clear(); }

module.exports = {
  verifyCookie, revoke, issueCookieValue, currentVersion,
  encodeCookie, decodeCookie, setFallbackPath, reset
};
