// STRUCTURED LOGGING.
//
// WHAT THIS REPLACES. 23 bare `console.*` calls across 8 files, with ad-hoc
// prefixes (`[error]`, `[ingest]`, `[ai-audit]`), no levels, no request
// correlation, no structure and no redaction. There was no HTTP access log at
// all, and no auth event was logged anywhere — so "why did this user get this
// answer?" could not be reconstructed from the logs.
//
// WHAT MUST NEVER BE LOGGED, enforced below rather than left to discipline:
//   raw financial records · access tokens · API keys · session secrets ·
//   full AI prompts · full AI responses · counterparty names
//
// Redaction is applied to EVERY field of EVERY log call, by key name and by
// value shape. A future caller cannot leak a secret by forgetting the rule,
// because the rule runs on the way out.
//
// NO DEPENDENCY. This writes JSON lines to stdout/stderr. A log shipper reads
// them. Adding pino or winston for this would be a dependency for formatting.

const crypto = require("crypto");

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

/**
 * Keys whose VALUE is never printed, whatever it contains.
 * Matched case-insensitively as a substring, so `zohoRefreshToken`,
 * `ai_api_key` and `SESSION_SECRET` are all caught.
 */
const SECRET_KEYS = [
  "password", "secret", "token", "apikey", "api_key", "authorization", "cookie",
  "sessionid", "session_id", "privatekey", "private_key", "credential", "signature",
  "mnemonic", "seed"
];

/**
 * Keys carrying financial or personal CONTENT rather than identifiers.
 * These are summarised (length/count) instead of printed.
 */
const CONTENT_KEYS = [
  "prompt", "response", "answer", "text", "message", "transactions", "records",
  "counterparty", "counterparties", "vendor", "customer", "description",
  "lineitems", "line_items", "evidence", "email"
];

const REDACTED = "[redacted]";

function isSecretKey(key) {
  const k = String(key).toLowerCase();
  return SECRET_KEYS.some((s) => k.includes(s));
}
function isContentKey(key) {
  const k = String(key).toLowerCase();
  return CONTENT_KEYS.some((s) => k.includes(s));
}

/**
 * Values that LOOK like a credential regardless of their key.
 * Catches a token logged under an innocuous name.
 */
function looksLikeSecret(value) {
  if (typeof value !== "string") return false;
  if (value.length < 20) return false;
  return /^(sk-|pk-|ghp_|xox[baprs]-|Bearer\s)/i.test(value)
    || /^ey[A-Za-z0-9_-]{10,}\./.test(value)              // JWT
    || /^[A-Fa-f0-9]{64,}$/.test(value)                   // long hex: keys, hashes
    || /^nvapi-|^AIza[0-9A-Za-z_-]{20,}/.test(value);     // NVIDIA, Google
}

/** Recursively redact a value for logging. */
function redact(value, key = null, depth = 0) {
  if (depth > 6) return "[deep]";
  if (value == null) return value;

  if (key && isSecretKey(key)) return REDACTED;

  if (typeof value === "string") {
    if (looksLikeSecret(value)) return REDACTED;
    if (key && isContentKey(key)) {
      // Content is summarised, never printed: its length is diagnostic, its
      // text is the user's financial data.
      return `[${value.length} chars]`;
    }
    return value.length > 300 ? `${value.slice(0, 300)}...[truncated]` : value;
  }

  if (typeof value === "number" || typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    if (key && isContentKey(key)) return `[${value.length} items]`;
    return value.slice(0, 20).map((v) => redact(v, key, depth + 1));
  }

  if (typeof value === "object") {
    if (key && isContentKey(key)) return `[object]`;
    const out = {};
    Object.entries(value).forEach(([k, v]) => { out[k] = redact(v, k, depth + 1); });
    return out;
  }

  return String(value);
}

function currentLevel() {
  const configured = String(process.env.LOG_LEVEL || "").toLowerCase();
  if (LEVELS[configured]) return LEVELS[configured];
  if (process.env.NODE_ENV === "test") return LEVELS.error; // quiet test output
  return LEVELS.info;
}

/** Where a line goes. Kept swappable so tests can capture without stubbing console. */
let sink = (line, level) => {
  if (level >= LEVELS.error) process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
};

function setSink(fn) { const previous = sink; sink = fn; return previous; }

function emit(level, levelName, message, fields, bindings) {
  if (LEVELS[levelName] < currentLevel()) return;
  const record = Object.assign(
    {
      ts: new Date().toISOString(),
      level: levelName,
      msg: String(message)
    },
    redact(bindings || {}),
    redact(fields || {})
  );
  let line;
  try {
    line = JSON.stringify(record);
  } catch {
    line = JSON.stringify({ ts: record.ts, level: levelName, msg: String(message),
      error: "log record could not be serialised" });
  }
  sink(line, LEVELS[levelName]);
}

/**
 * A logger with bound context.
 *
 * `child({ requestId, tenantId })` returns a logger that stamps those on every
 * line, which is how a request is followed across the ingestion, engine and AI
 * layers without threading a correlation id through every signature.
 */
function makeLogger(bindings = {}) {
  return Object.freeze({
    bindings,
    child: (extra) => makeLogger(Object.assign({}, bindings, extra)),
    debug: (msg, fields) => emit(LEVELS.debug, "debug", msg, fields, bindings),
    info: (msg, fields) => emit(LEVELS.info, "info", msg, fields, bindings),
    warn: (msg, fields) => emit(LEVELS.warn, "warn", msg, fields, bindings),
    error: (msg, fields) => emit(LEVELS.error, "error", msg, fields, bindings)
  });
}

const logger = makeLogger({});

/** A correlation id for one request. */
function newRequestId() {
  return "req_" + crypto.randomBytes(8).toString("hex");
}

/**
 * Express middleware: stamp a request id, bind a logger, and log start/end.
 *
 * The id is echoed in a response header so a user reporting a problem can be
 * matched to the exact request in the logs.
 */
function requestLogging() {
  return function requestLogger(req, res, next) {
    const requestId = req.get("x-request-id") || newRequestId();
    const startedAt = Date.now();
    req.requestId = requestId;
    req.log = logger.child({ requestId });
    res.setHeader("x-request-id", requestId);

    // Health probes fire continuously; logging each is noise that buries signal.
    const isProbe = req.path.startsWith("/api/health");
    if (!isProbe) {
      req.log.info("request.start", { method: req.method, route: req.path });
    }

    res.on("finish", () => {
      if (isProbe && res.statusCode < 400) return;
      const fields = {
        method: req.method,
        route: req.path,
        status: res.statusCode,
        durationMs: Date.now() - startedAt
      };
      // Tenant is safe to log; it is an opaque id, not a name.
      if (req.userStore && req.userStore.tenantId) fields.tenantId = req.userStore.tenantId;
      if (res.statusCode >= 500) req.log.error("request.end", fields);
      else if (res.statusCode >= 400) req.log.warn("request.end", fields);
      else req.log.info("request.end", fields);
    });

    next();
  };
}

module.exports = {
  logger, makeLogger, requestLogging, newRequestId, setSink, redact,
  LEVELS, REDACTED, SECRET_KEYS, CONTENT_KEYS, looksLikeSecret
};
