// HTTP SECURITY BASELINE — headers, rate limiting, CSRF.
//
// The application had none of these. What follows is shaped by the actual
// authentication model rather than applied generically, because a generic CSRF
// or CORS policy would break the two flows this app depends on.
//
// ─────────────────────────────────────────────────────────────────
// WHAT THE AUTH MODEL ACTUALLY IS, and what that implies
// ─────────────────────────────────────────────────────────────────
// * Identity is COOKIE-BASED: an express-session cookie (`fg_sid`) plus a
//   signed long-lived identity cookie (`fg_google_sub`), both `sameSite: lax`.
//   Cookie auth means the app IS exposed to CSRF and needs real protection.
//
// * `sameSite: lax` already blocks cross-site POST/PUT/DELETE from carrying
//   cookies. That is a genuine layer, but not sufficient on its own: it is a
//   browser behaviour, older clients ignore it, and `lax` deliberately permits
//   top-level GET navigations. So CSRF tokens are added for state-changing
//   requests, and `lax` remains as defence in depth.
//
// * The frontend is FIRST-PARTY and same-origin (`public/app.js` served by this
//   server, calling `/api/*` with relative URLs). It never makes a
//   cross-origin request, so a double-submit cookie token works without any
//   CORS relaxation.
//
// * `sameSite: lax` is required, not `strict`: the Google OAuth redirect is a
//   cross-site top-level navigation back to `/api/auth/google/callback`, and
//   `strict` would drop the session cookie on the way in and break login.
//
// ─────────────────────────────────────────────────────────────────
// WHY DOUBLE-SUBMIT RATHER THAN A SERVER-SIDE TOKEN STORE
// ─────────────────────────────────────────────────────────────────
// A per-session server token would need a store consulted on every mutating
// request. The double-submit pattern needs none: the token is a
// cryptographically random value in a readable cookie, echoed by the client in
// a header. An attacker on another origin cannot read the cookie (same-origin
// policy) and therefore cannot produce the header — which is the whole
// requirement. The token is additionally bound to the session secret so it
// cannot be minted by an attacker who can only set cookies.

const crypto = require("crypto");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { logger } = require("./logger");

const log = logger.child({ component: "http-security" });

const CSRF_COOKIE = "fg_csrf";
const CSRF_HEADER = "x-csrf-token";

/** Requests that change state and therefore require a CSRF token. */
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Paths exempt from CSRF, each for a stated reason.
 *
 * An exemption list is a security decision, so every entry carries why.
 */
const CSRF_EXEMPT = [
  // OAuth callbacks are GET redirects from the provider; they carry the
  // provider's `state` parameter, which is the CSRF control for that flow.
  { pattern: /^\/auth\/google\/(start|callback)$/, why: "OAuth flow, protected by its own state parameter" },
  { pattern: /^\/oauth\/zoho\/(start|callback)$/, why: "OAuth flow, protected by its own state parameter" },
  // Health probes are unauthenticated and change nothing.
  { pattern: /^\/health(\/(live|ready))?$/, why: "unauthenticated liveness/readiness probe" },
  // The public methodology document changes nothing.
  { pattern: /^\/methodology$/, why: "public, read-only" },
  // Test-only stub, itself double-gated on NODE_ENV=test.
  { pattern: /^\/__test\//, why: "test-only, gated on NODE_ENV=test" },
  /* Payment provider callbacks. Called by the PROVIDER, not a browser, so there
     is no session and no token to present. Safe because the route authorises
     nothing on its own: it resolves the tenant from the stored payment and can
     only settle a pending, unexpired row that already exists. */
  { pattern: /^\/billing\/webhook\//, why: "provider callback; no browser session, authorises nothing by itself" }
];

function isCsrfExempt(pathname) {
  return CSRF_EXEMPT.some((e) => e.pattern.test(pathname));
}

/**
 * Mint a SELF-CONTAINED CSRF token: `<random>.<hmac>`.
 *
 * An earlier version derived the token from `req.session.id`. That does not
 * work here: `saveUninitialized: false` means an un-saved session gets a NEW id
 * on every request, so the expected value changed between the request that
 * issued the token and the request that presented it — rejecting every
 * legitimate mutation.
 *
 * A self-contained token has no such dependency. The HMAC is what stops an
 * attacker who can set a cookie (a subdomain, say) from minting a valid pair:
 * they can choose the random half, but cannot compute the signature.
 */
function mintToken(secret) {
  const nonce = crypto.randomBytes(18).toString("base64url");
  return `${nonce}.${signNonce(nonce, secret)}`;
}

function signNonce(nonce, secret) {
  return crypto.createHmac("sha256", secret).update(nonce).digest("base64url");
}

/** Is this a token this server issued? */
function verifyToken(token, secret) {
  const raw = String(token || "");
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return false;
  const nonce = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  const expected = signNonce(nonce, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Security headers.
 *
 * The CSP is written for THIS app: `public/app.js` uses inline handlers
 * (`onclick="..."`) throughout, and the wallet pages load `ethers` from the
 * bundle. `'unsafe-inline'` for scripts is therefore required until the
 * frontend is refactored — narrowing it now would break the UI, which is not a
 * trade this phase is allowed to make. It is recorded as a known limitation
 * rather than silently omitted.
 *
 * WHY `scriptSrcAttr` IS STATED EXPLICITLY. Helmet's default set includes
 * `script-src-attr 'none'`, which is NOT covered by `scriptSrc` above — it is a
 * separate directive, and it blocks event-handler ATTRIBUTES specifically. It
 * was being emitted silently, so every `onclick=""` in the app was inert: the
 * browser never compiled the handler and the button did nothing, with no
 * console error. Roughly 83 controls across the app were dead, including the
 * alerts bell, "sync now", and plan navigation.
 *
 * Allowing it back costs nothing that `scriptSrc` has not already conceded:
 * with `'unsafe-inline'` on `script-src`, an attacker who could inject an
 * `onclick` attribute could equally inject a `<script>` tag, which is
 * permitted. Keeping `script-src-attr 'none'` therefore bought no real
 * protection while breaking the entire UI. The genuine hardening is dropping
 * `'unsafe-inline'` from BOTH, which needs the frontend refactor.
 */
function securityHeaders({ isProduction = false } = {}) {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // See the note above: the existing frontend requires inline handlers.
        scriptSrc: ["'self'", "'unsafe-inline'"],
        /* Must be stated, or helmet's default `'none'` silently kills every
           onclick attribute in the app. See the note above. */
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        // The app talks only to its own origin; wallet flows use an injected
        // provider rather than a remote endpoint.
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"]
      }
    },
    // HSTS only where TLS actually terminates; sending it over plain HTTP in
    // development would pin localhost to HTTPS in the developer's browser.
    hsts: isProduction ? { maxAge: 15552000, includeSubDomains: true } : false,
    // The app is never framed.
    frameguard: { action: "deny" },
    // Referrer would otherwise leak the app URL to third parties.
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    // Cross-origin isolation headers are left off: they break the OAuth
    // popup/redirect flow and the injected wallet provider.
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false
  });
}

/**
 * CSRF protection: double-submit, bound to the session.
 *
 * The token is issued in a readable cookie on any GET, and required in a header
 * on any mutating request. Same-origin policy stops another origin reading the
 * cookie, so it cannot produce the header.
 */
/**
 * Ensure a valid CSRF token cookie exists. Issues one if it does not.
 *
 * Deliberately NOT httpOnly: the frontend must read it to echo it back. That is
 * safe — the value is useless to another origin, which cannot read it at all.
 *
 * An existing valid token is KEPT rather than rotated, so a token does not
 * change under a long-lived page with requests in flight.
 */
function ensureToken(req, res, secret, isProduction) {
  const cookieToken = (req.cookies || {})[CSRF_COOKIE];
  if (cookieToken && verifyToken(cookieToken, secret)) return cookieToken;
  const token = mintToken(secret);
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false,
    secure: isProduction,
    sameSite: "lax",
    maxAge: 24 * 60 * 60 * 1000
  });
  return token;
}

/**
 * Issue a token WITHOUT enforcing one. Mounted on the HTML page routes.
 *
 * THE DEFECT THIS CLOSES. Enforcement is mounted on `/api`, and so was token
 * issuance — which meant loading the app served NO token, because `GET /app` is
 * not an `/api` route. A browser only received one once the frontend happened to
 * make a safe `/api` call first. Any flow whose first API request was a
 * mutation therefore got a 403 on a completely legitimate action, with the user
 * having done nothing wrong.
 *
 * Serving the page now seeds the token, which is when a browser should get it.
 * This middleware never rejects anything; enforcement stays on `/api` alone, so
 * the exemption paths (which are matched relative to that mount) are unchanged.
 */
function csrfIssue({ secret, isProduction = false } = {}) {
  return function issueCsrf(req, res, next) {
    if (!MUTATING.has(req.method)) ensureToken(req, res, secret, isProduction);
    next();
  };
}

function csrfProtection({ secret, isProduction = false } = {}) {
  return function csrf(req, res, next) {
    const cookieToken = (req.cookies || {})[CSRF_COOKIE];

    if (!MUTATING.has(req.method)) {
      ensureToken(req, res, secret, isProduction);
      return next();
    }

    if (isCsrfExempt(req.path)) return next();

    const supplied = req.get(CSRF_HEADER) || (req.body && req.body._csrf);
    if (!supplied || !cookieToken) {
      log.warn("csrf.missing", { route: req.path, method: req.method });
      return res.status(403).json({
        ok: false, error: "csrf_token_missing",
        detail: "This request requires a CSRF token. Reload the page and try again."
      });
    }

    /* DOUBLE SUBMIT: the header must equal the cookie, and the cookie must be
       one this server signed. The first check is what a cross-origin attacker
       cannot satisfy (they cannot read the cookie); the second is what an
       attacker who can only WRITE cookies cannot satisfy. */
    const a = Buffer.from(String(supplied));
    const b = Buffer.from(String(cookieToken));
    const matches = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!matches || !verifyToken(cookieToken, secret)) {
      log.warn("csrf.invalid", { route: req.path, method: req.method });
      return res.status(403).json({
        ok: false, error: "csrf_token_invalid",
        detail: "This request could not be verified. Reload the page and try again."
      });
    }
    return next();
  };
}

/** Shared limiter options: JSON errors, and a logged rejection. */
function limiterOptions({ windowMs, max, name, message }) {
  return {
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    // Health probes must never be throttled out of existence.
    skip: (req) => req.path.startsWith("/health"),
    handler: (req, res) => {
      log.warn("ratelimit.exceeded", { limiter: name, route: req.path });
      res.status(429).json({
        ok: false, error: "rate_limited", limiter: name,
        detail: message
      });
    }
  };
}

/**
 * Rate limits, scoped to what is actually expensive or attackable.
 *
 * A single global limit would either be too loose to protect the AI endpoints
 * or too tight for normal dashboard use, which issues many cheap GETs per page.
 */
function rateLimiters() {
  return {
    /* AUTH-SENSITIVE. Login and wallet verification are credential-adjacent and
       cheap to attack in a loop. */
    auth: rateLimit(limiterOptions({
      windowMs: 15 * 60 * 1000, max: 30, name: "auth",
      message: "Too many authentication attempts. Wait a few minutes and try again."
    })),

    /* AI-EXPENSIVE. Each of these can cost real provider tokens and credits, so
       the limit is per-window-per-IP on top of the credit ledger. */
    ai: rateLimit(limiterOptions({
      windowMs: 60 * 1000, max: 20, name: "ai",
      message: "Too many AI requests in a short period. Wait a moment and try again."
    })),

    /* UPLOADS. Parsing a CSV is CPU work and writes to disk. */
    upload: rateLimit(limiterOptions({
      windowMs: 60 * 1000, max: 10, name: "upload",
      message: "Too many uploads in a short period. Wait a moment and try again."
    })),

    /* PAYMENT CHECKOUT. Initiating a charge sends a prompt to someone's phone,
       so it is abusable as a nuisance — but it is a deliberate user action, not
       a credential guess, and a legitimate customer may retry a few times after
       a failed PIN entry. */
    billing: rateLimit(limiterOptions({
      /* A customer whose M-Pesa PIN entry fails legitimately retries a few
         times, and may compare plans before committing. 40 in five minutes
         bounds abuse without blocking a real purchase. */
      windowMs: 5 * 60 * 1000, max: 40, name: "billing",
      message: "Too many payment attempts. Wait a few minutes and try again."
    })),

    /* PROVIDER WEBHOOKS — deliberately generous.
       A payment provider retries a callback until it is acknowledged, and every
       delivery arrives from the SAME small set of provider IPs. Throttling this
       like an auth endpoint drops legitimate retries, and a dropped retry is a
       customer who paid and never got their plan. The route is safe to hammer:
       it authorises nothing on its own and settles a given payment exactly once,
       so the limit exists only to bound a flood, not to police callers. */
    webhook: rateLimit(limiterOptions({
      windowMs: 60 * 1000, max: 300, name: "webhook",
      message: "Callback rate exceeded."
    })),

    /* EVERYTHING ELSE — a generous backstop against a runaway client, set high
       enough that a dashboard page load (many GETs) is never affected. */
    general: rateLimit(limiterOptions({
      windowMs: 60 * 1000, max: 300, name: "general",
      message: "Too many requests. Slow down and try again shortly."
    }))
  };
}

module.exports = {
  securityHeaders, csrfProtection, csrfIssue, rateLimiters,
  CSRF_COOKIE, CSRF_HEADER, CSRF_EXEMPT, isCsrfExempt, mintToken, verifyToken, MUTATING
};
