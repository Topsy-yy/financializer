# Blockchain bounded-context decision (JOB 10)

## Decision: **Option A — isolate behind an explicit boundary**

The Avalanche/on-chain subsystem stays, because it is a shipped, user-visible
feature (treasury and escrow contracts, an on-chain ledger, transaction
verification), not speculative scaffolding. Freezing it would remove
functionality users already have.

What JOB 10 does is make the boundary explicit and prove the property that
mattered in the original audit: **on-chain data cannot enter financial analysis
without tenant scoping and provenance.**

No new blockchain features were built.

## What was verified

### 1. It is disabled by default and does not load at startup

| Flag | Default |
|---|---|
| `ENABLE_AVALANCHE` | `false` |
| `ENABLE_AVALANCHE_CONTRACT_DEPLOY` | `false` |

The CLI-shelling path (`avalancheClient.runAvalanche`) is gated on
`config.enableAvalanche`, and contract deployment on
`config.enableAvalancheContractDeploy`. Neither runs during normal startup: the
only thing `server.js` starts is the monitoring scheduler.

### 2. The deterministic engine has no on-chain dependency

`src/domain/` contains **zero** references to the on-chain modules. Verified
mechanically, and enforced by `tests/domain/purity.test.js`, which fails if the
domain layer imports anything outside itself.

This is the important one. The financial engine — findings, metrics, risk score,
rules — cannot be influenced by on-chain data, because it cannot see it.

### 3. On-chain data enters only as a labelled, tenant-scoped *extra*

`toLegacyContext(run, extras)` accepts an `onchain` block and passes it through
to the response. It is:

- **not** an input to any calculation — the engine has already run by then;
- **not** in `citable.numbers`, so the AI cannot cite an on-chain figure as an
  authoritative financial fact;
- **tenant-scoped by construction** — `summarizeOnchainMonth(reportsDir, period)`
  reads from `req.userStore.reportsDir`, which is derived from the server-side
  session identity, never from a request parameter;
- **explicitly absent by default**: `{ scope: "unavailable", count: 0, items: [] }`
  rather than a fabricated zero.

### 4. Reporting does not depend on it

`reportFormatter` and `pdfReport` read `context.cashflow`, `context.health` and
`context.anomalies`. Neither reads the `onchain` block, so a report is unaffected
whether the subsystem is on or off.

## The boundary, stated

```
on-chain subsystem  ──►  reportsDir/<tenant>/  ──►  summarizeOnchainMonth()
                                                          │
                                                          ▼
                                         toLegacyContext(run, { onchain })
                                                          │
                                                          ▼
                                                   API response only
```

Nothing crosses left-to-right into the engine. The subsystem is a *consumer* of
tenant scope, never a source of financial truth.

## Residual limitations

- **`walletAuth` is not an identity provider.** `POST /api/wallet/verify` stamps
  `walletVerified` onto the already-resolved store; it cannot be used to log in.
  Its nonce store is global-per-address rather than bound to a session, so a
  nonce issued to one browser can be consumed by another. That is a
  wallet-linking weakness, not an authentication bypass, but it should be bound
  to the session before wallet linking is treated as an identity claim.
- **`avalancheClient` shells out to a CLI.** Disabled by default; it should move
  behind an RPC client before it is enabled in any hosted environment.
- **The on-chain ledger is file-backed**, under `reportsDir`, not in PostgreSQL.
  It is therefore outside RLS. Tenant scoping comes from the directory path,
  which is derived from the server-side identity — sound, but a different
  mechanism from everything else, and worth unifying if the subsystem grows.

## Not done, deliberately

No new contracts, no new chains, no RPC migration, no expansion of the
subsystem's surface. The mandate was to decide and isolate, and the isolation
was already substantially correct — what was missing was the proof, which now
exists as a test.
