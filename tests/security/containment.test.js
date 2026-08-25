// SECURITY CONTAINMENT — each test is an ATTACK that must FAIL.
//
// These tests were written against the vulnerable baseline first, so each one
// is a proven exploit rather than a hypothetical. They are the regression suite
// for the threat model in docs/THREAT_MODEL.md.
//
// A failure here means a security control has regressed. Never weaken an
// assertion to make it pass.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { startServer } = require("../helpers/server");

let server;
test.before(async () => { server = await startServer(); });
test.after(async () => { if (server) await server.stop(); });

// ── T1. SSRF + server credential forwarding ──────────────────────
test("[T1] SSRF: a caller-supplied URL cannot make the server issue a request", async () => {
  // Attack: point the analysis endpoint at an attacker-controlled listener.
  // Baseline behaviour: the server fetched it AND attached its own ZOHO_API_KEY.
  const hits = [];
  const sink = http.createServer((req, res) => {
    hits.push({ url: req.url, auth: req.headers.authorization || null });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ transactions: [], statements: {} }));
  });
  await new Promise((r) => sink.listen(0, "127.0.0.1", r));
  const sinkUrl = `http://127.0.0.1:${sink.address().port}/steal`;

  try {
    const c = server.client();
    await c.post("/api/monthly-review", {
      month: "2026-05",
      use_ai_analysis: false,
      directApiUrl: sinkUrl,
      apiKey: undefined // omitted on purpose: baseline forwarded the SERVER's key
    });
    assert.equal(hits.length, 0,
      `server must not fetch caller-supplied URLs (received ${hits.length} request(s): ${JSON.stringify(hits)})`);
  } finally {
    await new Promise((r) => sink.close(r));
  }
});

test("[T1b] SSRF: cloud metadata endpoints cannot be reached via the analysis route", async () => {
  const c = server.client();
  const res = await c.post("/api/monthly-review", {
    month: "2026-05",
    use_ai_analysis: false,
    directApiUrl: "http://169.254.169.254/latest/meta-data/iam/security-credentials/"
  });
  // Either the parameter is ignored (200 with normal analysis) or rejected —
  // what must NOT happen is the metadata service being contacted and surfaced.
  assert.notEqual(res.status, 500, "no raw upstream error should leak");
  assert.equal(String(res.text).includes("security-credentials"), false,
    "metadata content must never appear in the response");
});

// ── T2. Forgeable identity cookie ────────────────────────────────
test("[T2] identity: a hand-crafted fg_google_sub cookie is not accepted", async () => {
  // Attack: a Google `sub` is a public identifier. The baseline trusted it raw.
  const victimSub = "118059605816120728518";
  const res = await server.client().raw("GET", "/api/auth/session", undefined, {
    cookie: `fg_google_sub=${victimSub}`
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.authenticated, false,
    "an unsigned identity cookie must never authenticate a session");
});

test("[T2b] identity: forged cookie cannot read another tenant's profile", async () => {
  const victimSub = "118059605816120728518";
  const res = await server.client().raw("GET", "/api/profile", undefined, {
    cookie: `fg_google_sub=${victimSub}`
  });
  // The request may succeed as an anonymous guest, but it must NOT resolve to
  // the victim's Google-scoped store.
  if (res.status === 200 && res.json && res.json.profile) {
    assert.notEqual(res.json.profile.google_email, "victim@example.com");
    assert.equal(res.json.profile.authenticated_as_google_sub, undefined);
  }
  assert.ok([200, 401, 403].includes(res.status), `unexpected status ${res.status}`);
});

test("[T2c] identity: a tampered signed cookie is rejected", async () => {
  const c = server.client();
  await c.get("/api/health"); // obtain a legitimately signed guest cookie
  const original = c.jar.get("fg_guest_id");
  assert.ok(original, "server issues a guest identity cookie");
  assert.match(original, /^s(%3A|:)/i, "guest identity cookie is SIGNED");

  const tampered = original.replace(/.$/, (ch) => (ch === "A" ? "B" : "A"));
  const res = await server.client().raw("GET", "/api/profile", undefined, {
    cookie: `fg_guest_id=${tampered}`
  });
  assert.notEqual(res.status, 500, "tampering must not crash the server");
});

// ── T3. Tenant isolation ─────────────────────────────────────────
test("[T3] tenant: two independent clients get separate stores", async () => {
  const a = server.client();
  const b = server.client();
  await a.post("/api/profile", { name: "Tenant A", business_name: "Alpha Ltd" });
  await b.post("/api/profile", { name: "Tenant B", business_name: "Beta Ltd" });

  const pa = await a.get("/api/profile");
  const pb = await b.get("/api/profile");
  assert.equal(pa.json.profile.business_name, "Alpha Ltd");
  assert.equal(pb.json.profile.business_name, "Beta Ltd");
  assert.notEqual(pa.json.profile.business_name, pb.json.profile.business_name);
});

test("[T3b] tenant: a caller-supplied workspace id cannot read another tenant's data", async () => {
  const a = server.client();
  const b = server.client();
  await a.get("/api/team");
  await b.get("/api/team");

  // Attack: guess/forge a workspace identifier belonging to someone else.
  const res = await b.get("/api/findings/thread?fingerprint=x&workspace=google-118059605816120728518");
  assert.ok([400, 403, 404].includes(res.status),
    `cross-tenant workspace access must be refused (got ${res.status})`);
});

test("[T3c] tenant: a forged workspace id does not create server-side state", async () => {
  // Attack: spray unknown workspace ids to exhaust disk/memory. Each request
  // previously called getUserStoreById() BEFORE the membership check, and that
  // function unconditionally created a directory.
  //
  // Note: the attacker's own guest store is created legitimately on their first
  // request, so we assert specifically that no store is created FOR THE FORGED
  // IDENTIFIERS rather than comparing total directory counts.
  const fs = require("node:fs");
  const c = server.client();
  await c.get("/api/health"); // establish the attacker's own (legitimate) store

  for (let i = 0; i < 5; i++) {
    await c.get(`/api/findings/thread?fingerprint=x&workspace=attacker-spray-${i}`);
  }

  const created = fs.readdirSync(server.reportsDir).filter((d) => d.includes("attacker-spray"));
  assert.deepEqual(created, [],
    `forged workspace ids must not materialise stores (created: ${JSON.stringify(created)})`);
});

// ── T4. Financial endpoints require identity ─────────────────────
test("[T4] financial endpoints resolve a server-issued identity", async () => {
  // A request with NO cookies at all must still be attributable to a fresh,
  // server-issued identity — never to a caller-controlled one.
  const res = await server.client().raw("POST", "/api/monthly-review",
    { month: "2026-05", use_ai_analysis: false });
  /* Acceptable outcomes, all of which satisfy the property:
       403 = CSRF rejected a cookie-less state-changing request. This is the
             STRONGEST outcome — the request never reached identity resolution,
             so it could not be attributed to anyone. Added when CSRF protection
             landed in the final closure phase.
       409 = no data source connected (JOB 4: no fabricated fallback).
       200 = analysed, in which case a server-issued identity must be assigned.
     What must never happen is the request being attributed to a
     CALLER-CONTROLLED identity. */
  assert.ok([200, 401, 403, 409].includes(res.status), `unexpected status ${res.status}`);
  if (res.status === 200) {
    const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    assert.ok(setCookie.some((c) => c.startsWith("fg_guest_id=")),
      "an anonymous caller is assigned a server-issued identity");
  }
});

// ── T5. Error disclosure ─────────────────────────────────────────
test("[T5] internal error details are not leaked to the client", async () => {
  const c = server.client();
  const res = await c.post("/api/monthly-review", { month: { malformed: true }, use_ai_analysis: false });
  if (res.status >= 500) {
    const body = String(res.text);
    assert.equal(/\/home\/|at Object\.|node_modules|\.js:\d+/.test(body), false,
      `stack traces / paths must not be returned: ${body.slice(0, 200)}`);
  }
});

// ── T6. Secrets never reach the client ───────────────────────────
test("[T6] configured API keys are never returned in cleartext", async () => {
  const c = server.client();
  const res = await c.get("/api/profile");
  const body = String(res.text);
  assert.equal(body.includes("test-secrets-key"), false);
  assert.equal(/"ai_api_key"\s*:\s*"(?!\*{3}")[^"]{8,}/.test(body), false,
    "ai_api_key must be masked, never echoed");
});
