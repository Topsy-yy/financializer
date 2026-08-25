// STARTUP CONFIGURATION VALIDATION — fail fast, and fail loudly.
//
// WHAT THIS REPLACES. There was exactly ONE startup check in the whole
// application: SESSION_SECRET, gated on NODE_ENV === "production". Everything
// else defaulted silently, which produced two specific hazards:
//
//   1. A deployment that forgot NODE_ENV=production got the DEVELOPMENT paths
//      for four separate security controls — ephemeral session secret, cleartext
//      credential storage, demo data enabled, and the test AI stub gate — with
//      only a console.warn. render.yaml never sets NODE_ENV; it relies on the
//      platform's default.
//
//   2. SECRETS_KEY and DATABASE_URL were undocumented in .env.example, so an
//      operator following the setup instructions got neither. Missing
//      SECRETS_KEY means API keys and Zoho refresh tokens are written to disk in
//      cleartext behind a once-per-process warning; missing DATABASE_URL means
//      the entire persistence layer silently does nothing.
//
// THE RULE: production must never silently fall back to a development or demo
// behaviour. Development stays convenient.

const crypto = require("crypto");

/** Values that must never be accepted as a real secret. */
const KNOWN_WEAK_SECRETS = new Set([
  "secret", "changeme", "change-me", "password", "dev", "development", "test",
  "finguard", "insecure", "default", "please-change", "your-secret-here",
  "supersecret", "123456", "0000000000000000"
]);

const MIN_SECRET_LENGTH = 32;

/** Severity of a configuration problem. */
const LEVEL = Object.freeze({ FATAL: "fatal", WARN: "warn" });

/**
 * Validate the environment for a given mode.
 *
 * Pure: takes an env object, returns findings. Nothing exits here, so the same
 * function can be exercised by tests across every environment matrix cell.
 *
 * @param {object} env  process.env, or a fixture
 * @returns {object} { ok, mode, problems, summary }
 */
function validate(env = process.env) {
  const mode = String(env.NODE_ENV || "development").toLowerCase();
  const isProduction = mode === "production";
  const isTest = mode === "test";
  const problems = [];

  const fatal = (key, message, remedy) =>
    problems.push({ level: LEVEL.FATAL, key, message, remedy });
  const warn = (key, message, remedy) =>
    problems.push({ level: LEVEL.WARN, key, message, remedy });

  // ── SESSION_SECRET ──
  const sessionSecret = env.SESSION_SECRET || "";
  if (!sessionSecret) {
    if (isProduction) {
      fatal("SESSION_SECRET", "No session secret is configured.",
        "Set SESSION_SECRET to a random value of at least 32 characters. "
        + "Without it, session cookies and signed identity cookies are unsigned "
        + "or ephemeral, and every restart logs every user out.");
    } else if (!isTest) {
      warn("SESSION_SECRET", "Not set — an ephemeral development secret will be used.",
        "Sessions will not survive a restart. Set SESSION_SECRET before deploying.");
    }
  } else if (isWeakSecret(sessionSecret)) {
    // A weak secret in production is worse than none: it looks configured.
    if (isProduction) {
      fatal("SESSION_SECRET", "The session secret is weak, short or a known default.",
        `Use at least ${MIN_SECRET_LENGTH} random characters, e.g. `
        + "`openssl rand -hex 32`.");
    } else {
      warn("SESSION_SECRET", "The session secret is weak or a known default.",
        "Acceptable in development; production will refuse to start with this value.");
    }
  }

  // ── DATABASE_URL ──
  // Production REQUIRES it: without it, persistence, RLS, the AI audit trail
  // and atomic credit accounting are all silently inert.
  if (!env.DATABASE_URL) {
    if (isProduction) {
      fatal("DATABASE_URL", "No database is configured.",
        "Production requires PostgreSQL: without it there is no persistence, no "
        + "tenant isolation at the data layer, no AI audit trail, and credit "
        + "accounting cannot be made atomic across instances.");
    } else {
      warn("DATABASE_URL", "Not set — the application will run without persistence.",
        "Analysis works in memory. Set DATABASE_URL to exercise persistence, "
        + "RLS, the audit trail and atomic billing.");
    }
  }

  // ── SECRETS_KEY ──
  // Without it, credentials are written to disk in cleartext.
  if (!env.SECRETS_KEY) {
    if (isProduction) {
      fatal("SECRETS_KEY", "No encryption key for stored credentials.",
        "Customer Zoho refresh tokens and AI API keys would be written to disk "
        + "in cleartext. Set SECRETS_KEY to a random 32+ character value.");
    } else if (!isTest) {
      warn("SECRETS_KEY", "Not set — stored credentials will NOT be encrypted at rest.",
        "Acceptable for local development with fake credentials only.");
    }
  } else if (isProduction && isWeakSecret(env.SECRETS_KEY)) {
    fatal("SECRETS_KEY", "The credential encryption key is weak or a known default.",
      `Use at least ${MIN_SECRET_LENGTH} random characters.`);
  }

  // ── APP_BASE_URL ──
  // OAuth redirects and secure-cookie decisions depend on it.
  if (isProduction) {
    const base = env.APP_BASE_URL || "";
    if (!base) {
      fatal("APP_BASE_URL", "No public base URL is configured.",
        "OAuth redirect URIs are derived from it, and it determines whether "
        + "cookies are marked Secure.");
    } else if (!/^https:\/\//i.test(base)) {
      fatal("APP_BASE_URL", `Production base URL is not HTTPS (${base}).`,
        "Session and identity cookies must only travel over TLS.");
    }
  }

  // ── DEMO DATA ──
  // Demo data must be an explicit opt-in in production, never a fallback.
  if (isProduction && String(env.ALLOW_DEMO_DATA || "") === "true") {
    warn("ALLOW_DEMO_DATA", "Demo data is ENABLED in production.",
      "Synthetic financial data can be analysed and shown to users. It is "
      + "labelled as demo, but confirm this is intentional.");
  }

  // ── MOCK INTEGRATIONS ──
  // This defaults to "true", so a production deploy that does not override it
  // runs against mocked integrations while looking live.
  if (isProduction && String(env.MOCK_REQUIRED_INTEGRATIONS || "true") === "true") {
    fatal("MOCK_REQUIRED_INTEGRATIONS", "Production is configured to MOCK required integrations.",
      "This defaults to \"true\". Set MOCK_REQUIRED_INTEGRATIONS=false in "
      + "production, or the application serves mocked integration data as real.");
  }

  // ── AI ──
  if (isProduction && String(env.ENABLE_AI_ANALYSIS || "true") === "true") {
    if (!env.NVIDIA_API_KEY && !env.MISTRAL_APP_KEY) {
      warn("AI keys", "AI is enabled but no managed provider key is configured.",
        "Managed-plan tenants will receive an honest 'AI unavailable' response. "
        + "Deterministic analysis is unaffected.");
    }
  }

  // ── TEST HOOKS must never be armed in production ──
  if (isProduction && env.AI_TEST_PROVIDER === "1") {
    fatal("AI_TEST_PROVIDER", "The AI test stub is armed in production.",
      "This would serve canned AI responses instead of calling a provider. "
      + "Unset AI_TEST_PROVIDER.");
  }

  const fatalCount = problems.filter((p) => p.level === LEVEL.FATAL).length;
  return Object.freeze({
    ok: fatalCount === 0,
    mode,
    problems: Object.freeze(problems),
    fatalCount,
    warnCount: problems.length - fatalCount,
    summary: fatalCount
      ? `${fatalCount} fatal configuration problem(s) in ${mode} mode.`
      : problems.length
        ? `${problems.length} configuration warning(s) in ${mode} mode.`
        : `Configuration valid for ${mode} mode.`
  });
}

function isWeakSecret(secret) {
  const s = String(secret || "");
  if (s.length < MIN_SECRET_LENGTH) return true;
  if (KNOWN_WEAK_SECRETS.has(s.toLowerCase())) return true;
  // A secret made of one repeated character carries no entropy.
  if (new Set(s).size <= 4) return true;
  return false;
}

/**
 * Validate and, on a fatal problem, refuse to start.
 *
 * Called once from server.js. Prints every problem — an operator fixing one
 * misconfiguration should not have to restart to discover the next.
 */
function enforce({ env = process.env, log, exit = (code) => process.exit(code) } = {}) {
  const result = validate(env);

  result.problems.forEach((p) => {
    const fields = { key: p.key, remedy: p.remedy };
    if (p.level === LEVEL.FATAL) log.error(`config.invalid: ${p.message}`, fields);
    else log.warn(`config.warning: ${p.message}`, fields);
  });

  if (!result.ok) {
    log.error("startup refused", {
      mode: result.mode,
      fatalCount: result.fatalCount,
      detail: "Production must not fall back to development behaviour. "
        + "Fix the problems above and restart."
    });
    exit(1);
    return result;
  }

  log.info("config.validated", {
    mode: result.mode, warnings: result.warnCount
  });
  return result;
}

/** A development secret, so the ephemeral path is explicit rather than implicit. */
function ephemeralSecret() {
  return crypto.randomBytes(32).toString("hex");
}

module.exports = {
  validate, enforce, isWeakSecret, ephemeralSecret,
  LEVEL, MIN_SECRET_LENGTH, KNOWN_WEAK_SECRETS
};
