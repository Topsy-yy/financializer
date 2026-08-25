# Environment matrix

The minimum configuration to run the application in each mode. Enforced at boot
by `src/services/startupValidation.js` — production **refuses to start** if a
fatal item is missing, rather than starting and silently taking a development
path.

## Why this document exists

Two of these variables (`DATABASE_URL`, `SECRETS_KEY`) were previously
undocumented, so an operator following the setup instructions got neither. Their
absence was silent: no persistence at all, and credentials written to disk in
cleartext behind a once-per-process warning. Four separate security controls
were gated on `NODE_ENV=production`, which `render.yaml` never set — it relied
on the platform's default.

## Matrix

| Variable | development | test | production | If missing in production |
|---|---|---|---|---|
| `NODE_ENV` | optional | `test` | **`production`** | Four controls silently take the development path. Set it explicitly. |
| `SESSION_SECRET` | optional | optional | **required, 32+ chars** | **FATAL.** Sessions unsigned/ephemeral; every restart logs everyone out. |
| `DATABASE_URL` | optional | required for `test:db` / `test:e2e` | **required** | **FATAL.** No persistence, no RLS, no audit trail, and billing cannot be atomic. |
| `SECRETS_KEY` | optional | optional | **required, 32+ chars** | **FATAL.** Zoho refresh tokens and AI keys stored in cleartext. |
| `APP_BASE_URL` | defaults to localhost | defaults | **required, HTTPS** | **FATAL.** OAuth redirects break; cookies cannot be marked Secure. |
| `MOCK_REQUIRED_INTEGRATIONS` | `true` (default) | `true` | **must be `false`** | **FATAL.** Defaults to `true`, so production would serve mocked integration data as real. |
| `AI_TEST_PROVIDER` | unset | `1` for AI HTTP tests | **must be unset** | **FATAL.** Would serve canned AI responses instead of calling a provider. |
| `NVIDIA_API_KEY` | optional | stubbed | recommended | Warning. Managed tenants get an honest "AI unavailable"; analysis is unaffected. |
| `MISTRAL_APP_KEY` | optional | stubbed | recommended | Warning, as above. |
| `ALLOW_DEMO_DATA` | `true` is convenient | `true` | opt-in only | Warning if enabled — confirm it is intentional. |
| `GOOGLE_CLIENT_ID` / `_SECRET` | optional | optional | required for login | Login disabled; guest mode only. |
| `LOG_LEVEL` | `info` | `error` | `info` | — |

## Minimum to run

**Development** — nothing. It starts, warns about what is missing, and works in
memory.

```bash
npm start
```

### Database bootstrap

A clean PostgreSQL instance is prepared with ONE documented command:

```bash
npm run db:bootstrap
```

It creates the database, creates the **non-superuser** application role, runs
every migration, grants that role exactly the DML it needs, and then verifies
the role can actually reach every table. It is idempotent — run it on every
deploy.

| Variable | Purpose |
|---|---|
| `ADMIN_DATABASE_URL` | Superuser/owner connection. Creates the role and schema. |
| `DATABASE_URL` | The application's own connection, using `APP_DB_ROLE`. |
| `APP_DB_ROLE` | The restricted role name (default `finguard_app`). |
| `APP_DB_PASSWORD` | Its password. Required only when creating the role. |

**Why this exists.** Migrations 001–003 create fourteen tables and grant on none
of them. Until JOB 12 the missing `GRANT` statements lived nowhere in the
repository — whoever built the original environment ran them by hand — so a
database stood up from this repo connected fine and then failed every query with
`permission denied for table tenant`. Grants are now applied by the migration
runner itself, and `ALTER DEFAULT PRIVILEGES` covers tables added by future
migrations. `tests/db/bootstrap.test.js` builds a throwaway database from
nothing on every run and fails if a hidden manual grant is ever needed again.

The application role is deliberately created `NOSUPERUSER NOCREATEDB
NOCREATEROLE NOBYPASSRLS` and granted `SELECT, INSERT, UPDATE, DELETE` only. RLS
is a boundary only if the role it constrains cannot switch it off, and a role
with `ALTER TABLE` can.

**Test** — the unit suite needs nothing. The database and end-to-end suites need
a PostgreSQL with a **non-superuser** role, because RLS does not apply to a
superuser and the isolation tests would prove nothing.

```bash
npm test
```

```bash
export TEST_DATABASE_URL=postgres://finguard_app:app@127.0.0.1:55432/finguard_test
export TEST_ADMIN_DATABASE_URL=postgres://postgres@127.0.0.1:55432/finguard_test
npm run test:db && npm run test:http && npm run test:e2e
```

**Production** — all of the following, or it will not start:

```bash
NODE_ENV=production
SESSION_SECRET=$(openssl rand -hex 32)
SECRETS_KEY=$(openssl rand -hex 32)
DATABASE_URL=postgres://user:pass@host:5432/finguard
APP_BASE_URL=https://your-domain
MOCK_REQUIRED_INTEGRATIONS=false
```

## Email delivery (optional)

Reports can be emailed as a PDF attachment. Unset, the feature is simply not
offered: `/api/executive-report` omits `Email` from its `channels`, and
`/api/executive-report/email` answers `503 mail_not_configured`. Nothing
half-works.

| Variable | Purpose |
|---|---|
| `SMTP_HOST` | e.g. `smtp.gmail.com` |
| `SMTP_PORT` | `465` (implicit TLS) or `587` (STARTTLS). Plaintext is refused. |
| `SMTP_USER` | the sending address |
| `SMTP_PASSWORD` | **app password** — see below |
| `MAIL_FROM` | what recipients see, e.g. `FinGuard AI <you@example.com>` |

**Gmail:** `SMTP_PASSWORD` must be a 16-character **app password** generated at
<https://myaccount.google.com/apppasswords> (requires 2-step verification), not
the account password. An app password can be revoked on its own.

Put it in the environment — never in a file this repository tracks:

```bash
export SMTP_PASSWORD='xxxx xxxx xxxx xxxx'
```

Check it without sending anything:

```bash
curl -s localhost:3000/api/mail/status
```

`configured` means the variables are set; `verified` means the SMTP server
actually accepted the credentials.

**Handling.** The password is read only from the environment, never logged,
never returned in an API response, and stripped out of SMTP errors before they
are logged — see `redactError()` in `src/services/mailer.js`, and the tests in
`tests/ops/mailer.test.js` that use a real Gmail rejection string.

## Health endpoints

| Endpoint | Answers | Fails when |
|---|---|---|
| `GET /api/health/live` | Is the process running? | Only if the process is dead. |
| `GET /api/health/ready` | Can this instance serve traffic in its current mode? | Production + database unreachable → `503`. |

A liveness probe deliberately checks no dependency: consulting one would cause
the orchestrator to **restart** the process when that dependency blips, turning
a database hiccup into a rolling outage.

AI provider availability does **not** affect readiness. The deterministic
analysis — the actual product — works without it and degrades honestly, so
marking the whole application unready because a third party is slow would be a
self-inflicted outage.
