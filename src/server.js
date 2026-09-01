const path = require("path");
const fs = require("fs");
const dns = require("dns");
const express = require("express");

// Prefer IPv4 when resolving outbound hosts. On networks with a broken or
// half-open IPv6 route, Node's fetch stalls on the AAAA address until the
// connection attempt times out (UND_ERR_CONNECT_TIMEOUT) while tools like curl
// silently fall back to IPv4. Preferring IPv4 removes that whole failure class.
// Set AI_PREFER_IPV4=false to restore Node's default ordering.
if (String(process.env.AI_PREFER_IPV4 || "true") === "true") {
  try { dns.setDefaultResultOrder("ipv4first"); } catch (e) { /* older Node: ignore */ }
}

const crypto = require("crypto");
const cookieParser = require("cookie-parser");
const session = require("express-session");
const config = require("./config");
const apiRouter = require("./routes/api");
const { logger, requestLogging } = require("./services/logger");
const startupValidation = require("./services/startupValidation");
const { verifyProductionDatabase } = require("./services/startupDatabaseValidation");
const { createSessionStore } = require("./services/sessionStore");
const httpSecurity = require("./services/httpSecurity");

const IS_PRODUCTION = process.env.NODE_ENV === "production";
const log = logger.child({ component: "server" });

/* ── STARTUP VALIDATION ───────────────────────────────────────────
   Fail fast on a misconfigured production environment, rather than starting
   and silently taking a development path. This replaces a single inline
   SESSION_SECRET check; see services/startupValidation.js for what it now
   covers and why each item is fatal. */
startupValidation.enforce({ log });

/* Outside production an ephemeral random secret is safer than a shared literal:
   it cannot be guessed, and the only cost is that dev sessions end on restart.
   In production, startup validation above has already refused to boot without
   a real one. */
const signingSecret = config.sessionSecret || startupValidation.ephemeralSecret();

const app = express();

/* Behind Render/any TLS-terminating proxy, Express must be told to trust the
   forwarded protocol — otherwise `secure: true` cookies are never set, because
   Express believes the connection is plain HTTP. Without this line, marking
   cookies Secure in production silently breaks login instead of hardening it. */
if (IS_PRODUCTION) app.set("trust proxy", 1);

/* SECURITY HEADERS, before anything that can produce a response — including an
   error page. See services/httpSecurity.js for why the CSP is shaped the way it
   is for this frontend. */
app.use(httpSecurity.securityHeaders({ isProduction: IS_PRODUCTION }));

/* RAW BODY FOR WEBHOOK SIGNATURES.
   A provider signs the exact bytes it sent. Re-serialising a parsed object
   changes key order and whitespace, so the digest would never match — and a
   signature check that never matches tends to get quietly removed. The raw
   buffer is kept only for the billing webhook path, which is the only place
   that needs it. */
app.use(express.json({
  limit: "2mb",
  verify: (req, res, buf) => {
    if (req.originalUrl && req.originalUrl.startsWith("/api/billing/webhook")) {
      req.rawBody = buf;
    }
  }
}));

/* Request correlation, before anything that might log. Every line for a request
   carries the same requestId, and it is echoed in the x-request-id response
   header so a user report can be matched to the exact request. */
app.use(requestLogging());

// The SAME secret signs identity cookies, so they cannot be hand-crafted.
app.use(cookieParser(signingSecret));

/* ── SESSIONS ─────────────────────────────────────────────────────
   PostgreSQL-backed where a database is configured, so a session survives a
   restart and is shared across instances. Production refuses an in-memory
   store outright. */
const sessionStore = createSessionStore({ isProduction: IS_PRODUCTION });

app.use(session({
  secret: signingSecret,
  store: sessionStore.store || undefined,
  resave: false,
  saveUninitialized: false,
  // Rolling expiry: an active user is not logged out mid-session.
  rolling: true,
  name: "fg_sid",
  cookie: {
    maxAge: 14 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    // Secure ONLY in production: forcing it in development over plain HTTP
    // would make the cookie silently undeliverable and break local login.
    secure: IS_PRODUCTION,
    // `lax` allows the OAuth redirect back from Google to carry the session,
    // which `strict` would drop.
    sameSite: "lax"
  }
}));

// Every visitor -- logged in or not (demo mode, pre-login) -- gets a stable
// anonymous identity so their data never leaks into another visitor's session.
app.use((req, res, next) => {
  // SIGNED cookies only. req.signedCookies contains a value only when the
  // signature verifies, so a forged or tampered identity is simply absent.
  if (!req.signedCookies.fg_guest_id) {
    const guestId = crypto.randomBytes(16).toString("hex");
    res.cookie("fg_guest_id", guestId, {
      maxAge: 400 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      secure: IS_PRODUCTION,
      sameSite: "lax",
      signed: true
    });
    req.signedCookies.fg_guest_id = guestId;
  }
  next();
});

/* ── RATE LIMITING ────────────────────────────────────────────────
   Scoped per route class rather than globally: one limit could not be both
   loose enough for a dashboard page (many cheap GETs) and tight enough for the
   AI endpoints (real provider cost per call). */
const limiters = httpSecurity.rateLimiters();

/* ── CSRF ─────────────────────────────────────────────────────────
   Double-submit, bound to the session, applied to mutating requests. The
   frontend is same-origin so no CORS relaxation is needed; the OAuth callbacks
   are exempt because they carry their own `state` control. */
app.use("/api", httpSecurity.csrfProtection({
  secret: signingSecret, isProduction: IS_PRODUCTION
}));

app.use("/api/auth", limiters.auth);
app.use("/api/wallet", limiters.auth);
app.use("/api/copilot", limiters.ai);
app.use("/api/chat", limiters.ai);
app.use("/api/monthly-review", limiters.ai);
app.use("/api/forecast", limiters.ai);
app.use("/api/what-if", limiters.ai);
app.use("/api/action-plan", limiters.ai);
/* Emailing a report sends the business's financial position OUT of the system,
   so it is throttled with the auth-sensitive limiter rather than the general
   one — the cost of abuse here is disclosure, not CPU. */
app.use("/api/executive-report/email", limiters.auth);
/* Checkout starts a real payment; the webhook is an unauthenticated public
   endpoint. Both are throttled as auth-sensitive. */
app.use("/api/billing/checkout", limiters.billing);
app.use("/api/billing/webhook", limiters.webhook);
app.use("/api/financial-data/upload", limiters.upload);
app.use("/api", limiters.general);

const publicDir = path.resolve(process.cwd(), "public");

/* SEED THE CSRF TOKEN WHEN THE PAGE IS SERVED.
   Enforcement lives on /api (below), and issuance used to as well -- so a
   freshly-loaded page held no token until the frontend happened to make a safe
   /api call first, and any flow that began with a mutation got a spurious 403.
   Serving the app is the right moment for a browser to receive the token. */
app.use(httpSecurity.csrfIssue({ secret: signingSecret, isProduction: IS_PRODUCTION }));

// The marketing landing page lives at "/"; the actual app (onboarding,
// dashboard, everything behind FinGuardWallet/hash routing) lives at "/app".
app.get("/", (req, res) => res.sendFile(path.join(publicDir, "landing.html")));
app.get("/app", (req, res) => res.sendFile(path.join(publicDir, "index.html")));

/* ETHERS IS SERVED FROM OUR OWN ORIGIN.
   index.html loaded it from cdn.jsdelivr.net, which `default-src 'self'`
   blocks — so `ethers` was undefined in the browser and every wallet control
   was dead. Allowlisting the CDN would fix it by trusting a third party with
   script execution on a financial app; serving the copy already in
   node_modules keeps the policy intact and pins the version to package-lock
   rather than to whatever the CDN serves. */
const ETHERS_UMD = (() => {
  /* The package's `exports` map blocks subpath resolution, so the dist file is
     located from the package root rather than required directly. */
  try {
    const main = require.resolve("ethers");                    // …/lib.commonjs/index.js
    const root = path.resolve(path.dirname(main), "..");       // …/node_modules/ethers
    const umd = path.join(root, "dist", "ethers.umd.min.js");
    return fs.existsSync(umd) ? umd : null;
  } catch { return null; }
})();

app.get("/vendor/ethers.umd.min.js", (req, res) => {
  if (!ETHERS_UMD) {
    log.error("vendor.ethers_missing", { detail: "run npm install" });
    return res.status(503).type("application/javascript")
      .send("/* ethers is not installed on this server */");
  }
  res.type("application/javascript").sendFile(ETHERS_UMD);
});

app.use(express.static(publicDir, { index: false }));
app.use("/api", apiRouter);

/* Exported for the end-to-end suite, which drives the REAL app rather than a
   reconstruction of it. */
async function startServer() {
  // Production must not start on a schema that is missing/incompatible.
  await verifyProductionDatabase({ log });

  return app.listen(config.port, () => {
    log.info("server.started", {
      port: config.port,
      mode: process.env.NODE_ENV || "development",
      sessionStore: sessionStore.kind,
      googleAuth: config.enableGoogleAuth
    });
    if (!config.enableGoogleAuth) {
      log.warn("google auth not configured", {
        detail: "Login disabled; guest/demo mode only. "
          + "Set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET to enable."
      });
    }
    // Continuous Financial Monitoring: hourly wake-up that syncs users whose
    // schedule is due. On a host that sleeps when idle this still catches up via
    // the /api/notifications request path when the user next visits.
    if (typeof apiRouter.startMonitoring === "function") {
      apiRouter.startMonitoring();
      log.info("monitoring.scheduler.started");
    }
  });
}

module.exports = { app, sessionStore, startServer };

/* istanbul ignore next -- only the process entry point starts a listener. */
if (require.main === module) {
  startServer().catch((err) => {
    log.error("startup refused", {
      error: err.message,
      detail: err.detail || null,
      code: err.code || null
    });
    process.exit(1);
  });
}
