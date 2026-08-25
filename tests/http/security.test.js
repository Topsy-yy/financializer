// FINAL CLOSURE PHASES 1B, 1C, 1D — proven over HTTP against the real server.
//
// Every test here drives the actual Express application in a child process.
// Nothing constructs a service directly, because the properties being proven
// are properties of the WIRING: a check that exists in a module but is not
// reached by a request protects nothing.
//
//   1B — an identity whose email Google has not verified is refused.
//   1C — the 400-day identity cookie can be revoked server-side, so a COPY of
//        it stops working after logout.
//   1D — security headers, rate limits, and CSRF on state-changing requests.
//
// The Google identity provider is stubbed by pointing the token/userinfo
// endpoints at a local HTTP server (a test-only override, refused outside
// NODE_ENV=test). The application's own callback code is entirely real — which
// is the point, since 1B's check lives inside it.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { startServer } = require("../helpers/server");

/* ── A stub Google ───────────────────────────────────────────────
   Returns whatever profile the current test asks for, so the same real
   callback can be driven with a verified and an unverified account. */
let stubProfile = null;
let idp = null;
let idpBase = "";

async function startIdp() {
  idp = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/token")) {
      res.end(JSON.stringify({ access_token: "stub-access-token", token_type: "Bearer" }));
      return;
    }
    if (req.url.startsWith("/userinfo")) {
      res.end(JSON.stringify(stubProfile || {}));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => idp.listen(0, "127.0.0.1", resolve));
  idpBase = `http://127.0.0.1:${idp.address().port}`;
}

/** Drive the REAL OAuth callback end to end and return the final response. */
async function login(server, client, profile) {
  stubProfile = profile;
  // /auth/google/start mints the state the callback requires.
  const start = await client.get("/api/auth/google/start");
  assert.equal(start.status, 302, "the start endpoint redirects to the provider");
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  assert.ok(state, "a state parameter was issued");
  return client.get(`/api/auth/google/callback?code=stub-code&state=${state}`);
}

let server;

test.before(async () => {
  await startIdp();
  server = await startServer({
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    TEST_GOOGLE_TOKEN_URL: `${idpBase}/token`,
    TEST_GOOGLE_USERINFO_URL: `${idpBase}/userinfo`
  });
});

test.after(async () => {
  if (server) await server.stop();
  if (idp) await new Promise((r) => idp.close(r));
});

// ══════════════════════════════════════════════════════════════════
// PHASE 1B — a verified email is required
// ══════════════════════════════════════════════════════════════════

test("[V1] an UNVERIFIED Google email is refused as an identity", async () => {
  const c = await server.primedClient();
  const res = await login(server, c, {
    sub: "unverified-user-1", email: "victim@example.com",
    email_verified: false, name: "Impostor"
  });

  assert.equal(res.status, 302);
  const location = res.headers.get("location");
  assert.match(location, /auth=error/, "login did not succeed");
  assert.match(location, /reason=email_not_verified/,
    "and it was refused for the RIGHT reason, not incidentally");

  // The decisive check: no identity was established.
  const session = await c.get("/api/auth/session");
  assert.equal(session.json.authenticated, false,
    "an unverified account holds no session -- it never became an identity");

  // No identity cookie was issued either.
  assert.equal(c.jar.has("fg_google_sub"), false,
    "no long-lived identity cookie was handed out");
});

test("[V2] a MISSING email_verified claim is refused (absent is not verified)", async () => {
  const c = await server.primedClient();
  // The claim is simply absent -- an identity source that never asserts it.
  const res = await login(server, c, { sub: "no-claim-user", email: "x@example.com", name: "No Claim" });
  assert.match(res.headers.get("location"), /reason=email_not_verified/,
    "an absent claim is treated as unverified, not as permission");
  const session = await c.get("/api/auth/session");
  assert.equal(session.json.authenticated, false);
});

test("[V3] a VERIFIED Google email is accepted", async () => {
  const c = await server.primedClient();
  const res = await login(server, c, {
    sub: "verified-user-1", email: "real@example.com",
    email_verified: true, name: "Real User"
  });

  assert.equal(res.status, 302);
  assert.match(res.headers.get("location"), /auth=success/, "login succeeded");

  const session = await c.get("/api/auth/session");
  assert.equal(session.json.authenticated, true);
  assert.equal(session.json.user.sub, "verified-user-1");
  assert.equal(session.json.user.email, "real@example.com");
  assert.ok(c.jar.has("fg_google_sub"), "an identity cookie was issued");
});

// ══════════════════════════════════════════════════════════════════
// PHASE 1C — the identity cookie can be revoked
// ══════════════════════════════════════════════════════════════════

test("[R1] a COPIED identity cookie stops working after logout", async () => {
  // ── Step 1: log in for real.
  const original = await server.primedClient();
  const res = await login(server, original, {
    sub: "revocation-subject-1", email: "owner@example.com",
    email_verified: true, name: "Owner"
  });
  assert.match(res.headers.get("location"), /auth=success/);

  const identityCookie = original.jar.get("fg_google_sub");
  assert.ok(identityCookie, "the 400-day identity cookie was issued");

  const before = await original.get("/api/auth/session");
  assert.equal(before.json.authenticated, true, "the original session works");

  // ── Step 2: COPY the cookie into a different client, with no session.
  // This is the stolen-cookie scenario: a shared machine, a synced browser
  // profile, an exfiltrated cookie jar. Only the identity cookie is copied.
  const thief = server.client();
  thief.jar.set("fg_google_sub", identityCookie);

  const thiefBefore = await thief.get("/api/auth/session");
  assert.equal(thiefBefore.json.authenticated, true,
    "PRECONDITION: the copy works before revocation. Without this the test "
    + "would pass even if the cookie had never been valid at all.");
  assert.equal(thiefBefore.json.user.sub, "revocation-subject-1");

  // ── Step 3: the real user logs out. This must revoke the IDENTITY, not
  // just clear the cookie in the responding browser.
  const out = await original.post("/api/auth/google/logout");
  assert.ok([200, 204, 302].includes(out.status), `logout returned ${out.status}`);

  // ── Step 4: BOTH are now invalid.
  const originalAfter = await original.get("/api/auth/session");
  assert.equal(originalAfter.json.authenticated, false,
    "the original browser is logged out");

  const thiefAfter = await thief.get("/api/auth/session");
  assert.equal(thiefAfter.json.authenticated, false,
    "THE POINT OF THIS PHASE: the COPY is invalid too. Clearing one browser's "
    + "cookie never invalidated a copy; incrementing the identity version does.");
  assert.equal(thiefAfter.json.user, null, "and no profile data leaked to it");
});

test("[R2] a revoked cookie is not restored by re-presenting it", async () => {
  const c = await server.primedClient();
  await login(server, c, {
    sub: "revocation-subject-2", email: "owner2@example.com",
    email_verified: true, name: "Owner Two"
  });
  const cookie = c.jar.get("fg_google_sub");
  await c.post("/api/auth/google/logout");

  /* A fresh client presenting the revoked cookie repeatedly must never be
     accepted. This is the property that would break if the server treated
     "cookie present and signature valid" as sufficient, or if it re-derived
     the identity from disk on a session miss. */
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const retry = server.client();
    retry.jar.set("fg_google_sub", cookie);
    const session = await retry.get("/api/auth/session");
    assert.equal(session.json.authenticated, false,
      `attempt ${attempt + 1}: a revoked cookie stays revoked`);
  }
});

test("[R3] the server CLEARS a cookie it will not honour", async () => {
  const c = await server.primedClient();
  await login(server, c, {
    sub: "revocation-subject-3", email: "owner3@example.com",
    email_verified: true, name: "Owner Three"
  });
  const cookie = c.jar.get("fg_google_sub");
  await c.post("/api/auth/google/logout");

  const stale = server.client();
  stale.jar.set("fg_google_sub", cookie);
  const res = await stale.get("/api/auth/session");
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const line = setCookie.find((l) => l.startsWith("fg_google_sub="));
  assert.ok(line, "the response addresses the identity cookie");

  /* EXPIRY is the mechanism a browser actually obeys, and it is what this must
     assert. The VALUE is not empty-looking: clearCookie() is called with
     `signed: true`, so express signs the empty string and emits
     `fg_google_sub=s%3A.<signature>`. Asserting on the value shape would have
     been asserting on an implementation detail of the cookie signer. */
  const expires = /Expires=([^;]+)/i.exec(line);
  assert.ok(expires, "an Expires attribute is present");
  assert.ok(new Date(expires[1]).getTime() <= 0,
    "it is expired at the epoch, so the browser drops a credential the server "
    + "has stopped honouring rather than presenting it for 400 more days");

  // And the value carries no identity, whatever its signature envelope.
  const value = decodeURIComponent(line.slice("fg_google_sub=".length).split(";")[0]);
  assert.equal(value.includes("revocation-subject-3"), false,
    "the cleared cookie carries no subject");
});

test("[R4] a forged identity cookie is rejected (the signature still matters)", async () => {
  const forger = server.client();
  // No valid signature -- cookieParser will not surface it as a signed cookie.
  forger.jar.set("fg_google_sub", "s%3Averified-user-1.v0.forged-signature");
  const session = await forger.get("/api/auth/session");
  assert.equal(session.json.authenticated, false,
    "revocation is an ADDITIONAL layer; it did not replace signature checking");
});

test("[R5] a revoked identity is not restored by a server restart", async () => {
  /* The revocation must be DURABLE. If it lived only in process memory, a
     restart would silently resurrect every revoked cookie -- which is exactly
     the failure mode the original design had, where an identity survived a
     restart because it was re-derived from a cookie and disk. */
  const fresh = await startServer({
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    TEST_GOOGLE_TOKEN_URL: `${idpBase}/token`,
    TEST_GOOGLE_USERINFO_URL: `${idpBase}/userinfo`
  });
  try {
    const c = await fresh.primedClient();
    await login(fresh, c, {
      sub: "restart-subject-1", email: "restart@example.com",
      email_verified: true, name: "Restart User"
    });
    const cookie = c.jar.get("fg_google_sub");
    await c.post("/api/auth/google/logout");

    // Restart the application against the SAME reports directory, which is
    // where the file-backed revocation store lives when there is no database.
    const restarted = await startServer({
      REPORTS_DIR: fresh.reportsDir,
      GOOGLE_CLIENT_ID: "test-client-id",
      GOOGLE_CLIENT_SECRET: "test-client-secret",
      TEST_GOOGLE_TOKEN_URL: `${idpBase}/token`,
      TEST_GOOGLE_USERINFO_URL: `${idpBase}/userinfo`
    });
    try {
      const afterRestart = restarted.client();
      afterRestart.jar.set("fg_google_sub", cookie);
      const session = await afterRestart.get("/api/auth/session");
      assert.equal(session.json.authenticated, false,
        "the revocation survived the restart -- a restart must not resurrect a "
        + "cookie that was revoked before it");
    } finally {
      await restarted.stop();
    }
  } finally {
    await fresh.stop();
  }
});

// ══════════════════════════════════════════════════════════════════
// PHASE 1D — headers, rate limits, CSRF
// ══════════════════════════════════════════════════════════════════

test("[H1] security headers are present on real responses", async () => {
  const c = await server.primedClient();
  const res = await c.get("/api/health/live");

  assert.ok(res.headers.get("content-security-policy"), "a CSP is set");
  assert.match(res.headers.get("content-security-policy"), /default-src 'self'/);
  assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'none'/,
    "the app cannot be framed");
  assert.match(res.headers.get("content-security-policy"), /object-src 'none'/);

  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("referrer-policy"), "strict-origin-when-cross-origin");

  // Helmet removes this fingerprinting header.
  assert.equal(res.headers.get("x-powered-by"), null,
    "the framework is not advertised");

  /* HSTS is deliberately ABSENT outside production: sending it over plain HTTP
     in development would pin localhost to HTTPS in the developer's browser. */
  assert.equal(res.headers.get("strict-transport-security"), null,
    "HSTS is not sent in a non-production environment");
});

test("[H2] headers are present on the HTML pages too, not just the API", async () => {
  const c = server.client();
  const res = await c.get("/app");
  assert.ok(res.headers.get("content-security-policy"),
    "the header middleware runs before static file serving");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
});

test("[H3] the CSP does not silently disable the app's own event handlers",
  async () => {
    /* Helmet's DEFAULT directive set includes `script-src-attr 'none'`, which
       is separate from `script-src` and blocks event-handler ATTRIBUTES
       specifically. It was being emitted even though the policy explicitly
       allows `'unsafe-inline'` for scripts, so every `onclick=""` in the
       frontend was inert: the browser never compiled the handler, the button
       did nothing, and no error was logged. ~83 controls were dead, including
       the alerts bell, "Sync now" and plan navigation.

       This is not a request to weaken the CSP. It pins the policy to what the
       app actually needs, so the two directives cannot drift apart again and
       silently kill the UI. */
    const c = await server.primedClient();
    const csp = (await c.get("/app")).headers.get("content-security-policy");

    assert.equal(/script-src-attr 'none'/.test(csp), false,
      `script-src-attr 'none' makes every inline handler in the app inert: ${csp}`);
    assert.match(csp, /script-src-attr 'unsafe-inline'/,
      "the directive is stated explicitly rather than left to helmet's default");

    // The concessions the frontend needs, and nothing beyond them.
    assert.match(csp, /script-src 'self' 'unsafe-inline'/);
    assert.match(csp, /default-src 'self'/, "still same-origin by default");
    assert.equal(/unsafe-eval/.test(csp), false, "eval is still forbidden");
  });

test("[H4] no third-party script is required for the app to work", async () => {
  /* index.html loaded ethers from cdn.jsdelivr.net while the CSP said
     `default-src 'self'`, so the script was blocked, `ethers` was undefined,
     and every wallet control failed. Serving our own copy keeps the policy
     intact AND pins the version to package-lock instead of to whatever a CDN
     decides to serve a financial app. */
  const c = server.client();
  const html = (await c.get("/app")).text;

  const external = [...html.matchAll(/<script[^>]+src="(https?:)?\/\/[^"]+"/g)];
  assert.deepEqual(external.map((m) => m[0]), [],
    "the app pulls no script from another origin");

  const vendored = await c.get("/vendor/ethers.umd.min.js");
  assert.equal(vendored.status, 200, "ethers is served from this origin");
  assert.ok(vendored.text.length > 10000, "and it is the real library");
});

test("[C1] a state-changing request with NO CSRF token is rejected", async () => {
  const c = await server.primedClient();
  // `x-csrf-token: null` is the harness opt-out -- it sends no token, while
  // still sending the cookies a real cross-site request would carry.
  const res = await c.post("/api/profile", { businessName: "Attacker Co" },
    { "x-csrf-token": null });

  assert.equal(res.status, 403, "refused");
  assert.equal(res.json.error, "csrf_token_missing");
});

test("[C2] a state-changing request with a FORGED CSRF token is rejected", async () => {
  const c = await server.primedClient();
  // An attacker who can guess the token FORMAT still cannot sign one.
  const res = await c.post("/api/profile", { businessName: "Attacker Co" },
    { "x-csrf-token": "aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });

  assert.equal(res.status, 403, "refused");
  assert.equal(res.json.error, "csrf_token_invalid",
    "the mismatch was detected, not merely the absence of a token");
});

test("[C3] a token that does not MATCH the cookie is rejected", async () => {
  /* THE ACTUAL CROSS-SITE ATTACK. Another origin can make the browser send its
     cookies, but cannot READ the CSRF cookie, so it cannot produce a matching
     header. Simulated here by presenting a validly-signed token from a
     DIFFERENT client alongside this client's cookies. */
  const victim = await server.primedClient();
  const attacker = await server.primedClient();

  const attackerToken = attacker.csrfToken();
  assert.ok(attackerToken, "the attacker has a legitimately signed token of their own");
  assert.notEqual(attackerToken, victim.csrfToken(), "the two tokens differ");

  const res = await victim.post("/api/profile", { businessName: "Attacker Co" },
    { "x-csrf-token": attackerToken });

  assert.equal(res.status, 403);
  assert.equal(res.json.error, "csrf_token_invalid",
    "a signed-but-not-mine token is refused: the double submit must MATCH");
});

test("[C4] the legitimate same-origin flow still works", async () => {
  // The regression that matters most: CSRF protection that also blocks the
  // real frontend is not protection, it is an outage.
  const c = await server.primedClient();
  assert.ok(c.csrfToken(), "a token was issued on a safe request");

  const res = await c.post("/api/profile", { businessName: "Legitimate Co" });
  assert.ok(res.status < 400, `the real flow succeeded (status ${res.status})`);

  // And it actually took effect.
  const profile = await c.get("/api/profile");
  assert.equal(profile.status, 200);
});

test("[C5] safe requests are never blocked, and issue a usable token", async () => {
  const c = server.client();
  const res = await c.get("/api/health/live");
  assert.equal(res.status, 200, "a GET needs no token");
  assert.ok(c.csrfToken(), "and it receives one for later use");

  // The token must be READABLE by the frontend, which has to echo it.
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const line = setCookie.find((l) => l.startsWith("fg_csrf="));
  assert.ok(line, "the token cookie was set");
  assert.equal(/httponly/i.test(line), false,
    "deliberately NOT httpOnly -- app.js must read it. Safe, because another "
    + "origin cannot read it at all.");
});

test("[C6] an existing valid token is not rotated out from under the page", async () => {
  const c = await server.primedClient();
  const first = c.csrfToken();
  await c.get("/api/health/live");
  await c.get("/api/health/live");
  assert.equal(c.csrfToken(), first,
    "a stable token, so a long-lived page's in-flight requests keep working");
});

test("[L1] the AI-expensive limiter triggers, and says so honestly", async () => {
  /* The AI limiter is 20 requests per minute. A fresh client is used so the
     count is not polluted by other tests -- though the limiter is per-IP, so
     this test must be the one that exhausts it for this route class. */
  const c = await server.primedClient();
  let limited = null;
  // Enough attempts to cross 20 regardless of what earlier tests consumed.
  for (let i = 0; i < 40 && !limited; i += 1) {
    const res = await c.post("/api/copilot/ask", { question: "hello" });
    if (res.status === 429) limited = res;
  }

  assert.ok(limited, "the AI limiter engaged within 40 requests");
  assert.equal(limited.json.error, "rate_limited");
  assert.equal(limited.json.limiter, "ai", "the correct limiter is identified");
  assert.ok(limited.json.detail, "and the caller is told what to do");
  // Standard headers let a well-behaved client back off on its own.
  assert.ok(limited.headers.get("ratelimit-limit") || limited.headers.get("ratelimit"),
    "standard rate-limit headers are exposed");
});

test("[L2] health probes are never rate limited", async () => {
  /* An orchestrator polls liveness constantly. Throttling it would make the
     platform kill a perfectly healthy process. */
  const c = server.client();
  for (let i = 0; i < 60; i += 1) {
    const res = await c.get("/api/health/live");
    assert.equal(res.status, 200, `liveness probe ${i + 1} was not throttled`);
  }
});
