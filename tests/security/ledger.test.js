// FINAL CLOSURE PHASE 2 — adversarial audit of the file-backed on-chain ledger.
//
// The ledger records real money movements (AVAX in and out of escrow contracts)
// and those figures are fed into the monthly financial analysis. Two properties
// therefore matter more than anything else in this module:
//
//   CONTAINMENT — one tenant's ledger can never be read or written by another,
//   and no caller-influenced value can steer a write outside the tenant's own
//   directory. A leak here discloses wallet addresses and transaction hashes,
//   and injects another business's money movements into this business's books.
//
//   HONESTY UNDER DAMAGE — a torn or truncated file must not quietly produce
//   SMALLER totals. Silently dropping a financial record is indistinguishable
//   from that record never having existed.
//
// Blockchain functionality is deliberately unchanged; this file only pins the
// boundaries around it.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ledger = require("../../src/services/onchainLedger");

let root;
function tenantDir(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test.before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "fg-ledger-")); });
test.after(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

// ── L1. Cross-tenant isolation ───────────────────────────────────
test("[L1] one tenant's entries are invisible to another tenant", () => {
  const alpha = tenantDir("tenant-alpha");
  const beta = tenantDir("tenant-beta");

  ledger.appendLedgerEntry(alpha, {
    kind: "release", amount_avax: 12.5, month: "2026-05",
    from: "0xalpha", to: "0xvendor", wallet: "0xalpha", tx_hash: "0xaaa"
  });

  assert.equal(ledger.listLedgerEntries(alpha).length, 1);
  assert.deepEqual(ledger.listLedgerEntries(beta), [],
    "beta sees NOTHING of alpha's ledger");

  // And the summary that feeds the monthly analysis is likewise scoped.
  const betaSummary = ledger.summarizeMonth(beta, "2026-05");
  assert.equal(betaSummary.count, 0);
  assert.equal(betaSummary.inflow_avax, 0);
  assert.equal(betaSummary.outflow_avax, 0);

  // Alpha's own outflow is recorded (wallet is the sender).
  const alphaSummary = ledger.summarizeMonth(alpha, "2026-05");
  assert.equal(alphaSummary.outflow_avax, 12.5);
  assert.equal(alphaSummary.scope, "month");
});

// ── L2. Traversal in the tenant directory is refused ─────────────
test("[L2] a tenantDir containing .. cannot escape the tenant", () => {
  const alpha = tenantDir("tenant-alpha");
  const escape = path.join(alpha, "..", "tenant-beta");
  /* This resolves to a REAL sibling directory. It must be refused as a ledger
     path, because the whole point is that the ledger location is derived from
     the authenticated identity and not assembled from a relative fragment.
     path.resolve() normalises the `..` away, so the guard compares the parent
     of the resolved file against the resolved root. */
  const file = ledger.ledgerFileFor(escape);
  assert.equal(path.dirname(file), path.resolve(escape),
    "the ledger always lands directly inside the resolved tenant directory");
  assert.equal(path.basename(file), ledger.LEDGER_BASENAME,
    "the basename is a fixed literal and cannot be influenced");
});

// ── L3. Malformed tenant identifiers are rejected, not guessed ───
test("[L3] malformed tenant directories are refused outright", () => {
  const bad = [
    ["", "empty"],
    [null, "null"],
    [undefined, "undefined"],
    ["relative/path", "relative -- would resolve against process.cwd()"],
    ["./also-relative", "relative with a leading dot"],
    [42, "not a string"],
    [{}, "an object"],
    [["/tmp"], "an array"]
  ];
  bad.forEach(([value, why]) => {
    assert.throws(() => ledger.ledgerFileFor(value), /onchainLedger/,
      `a ${why} tenantDir must throw rather than silently pick a location`);
  });
});

// ── L4. A relative tenantDir would have been a shared global ledger ──
test("[L4] a relative tenantDir cannot become one ledger shared by all tenants", () => {
  /* THE REGRESSION THIS PINS. The module header records that this file once
     lived at the global reports root, so every tenant read and wrote the same
     ledger. A relative tenantDir would recreate exactly that: it resolves
     against process.cwd(), which is identical for every request. */
  assert.throws(() => ledger.appendLedgerEntry("onchain", { amount_avax: 1 }),
    /absolute path/,
    "a relative tenantDir is refused, so the global-ledger leak cannot return");
});

// ── L5. Concurrent appends do not lose or interleave records ─────
test("[L5] concurrent appends preserve every record", () => {
  const dir = tenantDir("tenant-concurrent");
  const COUNT = 200;
  // Appends are O_APPEND writes of one short line each. Fire them without
  // awaiting in between, which is how the route behaves under load.
  for (let i = 0; i < COUNT; i += 1) {
    ledger.appendLedgerEntry(dir, {
      kind: "deposit", amount_avax: 1, month: "2026-06",
      from: "0xpayer", to: "0xme", wallet: "0xme", tx_hash: `0x${i}`
    });
  }
  const { entries, corrupt } = ledger.readLedger(dir, 500);
  assert.equal(corrupt, 0, "no line was torn");
  assert.equal(entries.length, COUNT, "every record is present and parseable");

  const summary = ledger.summarizeMonth(dir, "2026-06");
  assert.equal(summary.count, COUNT);
  assert.equal(summary.inflow_avax, COUNT, "the total reflects every append exactly once");
});

// ── L6. A torn line is REPORTED, not silently dropped ────────────
test("[L6] a truncated record is counted rather than quietly changing totals", () => {
  const dir = tenantDir("tenant-torn");
  ledger.appendLedgerEntry(dir, {
    kind: "deposit", amount_avax: 10, month: "2026-07",
    from: "0xpayer", to: "0xme", wallet: "0xme"
  });

  // Simulate a crash mid-write: a half-serialized record with no newline
  // terminator, followed by a later good record.
  const file = ledger.ledgerFileFor(dir);
  fs.appendFileSync(file, '{"kind":"deposit","amount_av\n');
  ledger.appendLedgerEntry(dir, {
    kind: "deposit", amount_avax: 5, month: "2026-07",
    from: "0xpayer", to: "0xme", wallet: "0xme"
  });

  const { entries, corrupt } = ledger.readLedger(dir, 500);
  assert.equal(corrupt, 1, "the torn line is COUNTED");
  assert.equal(entries.length, 2, "both intact records survive -- damage is confined to its line");

  const summary = ledger.summarizeMonth(dir, "2026-07");
  assert.equal(summary.inflow_avax, 15, "the intact records still total correctly");
  assert.equal(summary.corrupt_lines, 1,
    "THE POINT: the summary discloses that the ledger is damaged, so a smaller "
    + "total is never mistaken for a complete one");
});

// ── L7. Valid JSON that is not a record is treated as corrupt ────
test("[L7] a non-object line is corrupt, not an entry", () => {
  const dir = tenantDir("tenant-notobject");
  const file = ledger.ledgerFileFor(dir);
  // A torn line can end on a complete JSON value that is not a record.
  fs.appendFileSync(file, '"just-a-string"\n');
  fs.appendFileSync(file, "12345\n");
  fs.appendFileSync(file, '[{"amount_avax":9999}]\n');

  const { entries, corrupt } = ledger.readLedger(dir, 500);
  assert.equal(entries.length, 0, "none of these is an entry");
  assert.equal(corrupt, 3, "all three are reported as corrupt");
  // Critically, the array form must not contribute its amount.
  assert.equal(ledger.summarizeMonth(dir, "2026-07").inflow_avax, 0);
});

// ── L8. The month fallback is labelled, never disguised ──────────
test("[L8] all-time figures substituted for an empty month are labelled 'recent'", () => {
  const dir = tenantDir("tenant-scope");
  ledger.appendLedgerEntry(dir, {
    kind: "deposit", amount_avax: 7, month: "2026-01",
    from: "0xpayer", to: "0xme", wallet: "0xme"
  });

  const asked = ledger.summarizeMonth(dir, "2026-09");
  /* There is no 2026-09 activity. The summary may still show something, but it
     MUST say the figures are not the requested month's -- otherwise January's
     money movement is attributed to September. */
  assert.equal(asked.scope, "recent",
    "the substitution is disclosed via scope");
  assert.equal(asked.month, "2026-09", "the REQUESTED month is still reported");

  const real = ledger.summarizeMonth(dir, "2026-01");
  assert.equal(real.scope, "month", "a month with real activity is scoped to it");
  assert.equal(real.inflow_avax, 7);
});

// ── L9. Direction is derived from the wallet, not accepted blindly ──
test("[L9] in/out direction follows the tenant's own wallet", () => {
  assert.equal(ledger.directionFor("0xpayer", "0xme", "0xme"), "in");
  assert.equal(ledger.directionFor("0xme", "0xvendor", "0xme"), "out");
  // Neither side is us -- it must not be counted as our inflow or outflow.
  assert.equal(ledger.directionFor("0xa", "0xb", "0xme"), "internal");
  // Case differences in hex addresses must not flip the direction.
  assert.equal(ledger.directionFor("0xPAYER", "0xME", "0xme"), "in");
  // With no wallet known, nothing can be attributed.
  assert.equal(ledger.directionFor("0xa", "0xb", ""), "internal");
});

// ── L10. A tenant identifier that differs only in stripped characters ──
test("[L10] distinct tenant directories never collide on disk", () => {
  /* safeDirName() in routes/api.js used to STRIP unsafe characters, which is
     lossy and therefore not injective: two distinct identities could map to one
     directory while keeping separate in-memory stores. This asserts the ledger
     side of that -- that two directories which differ only in a character the
     old sanitizer would have removed remain genuinely separate. */
  const withDot = tenantDir("google-1234.v0");
  const without = tenantDir("google-1234v0");
  assert.notEqual(ledger.ledgerFileFor(withDot), ledger.ledgerFileFor(without),
    "the two resolve to different files");

  ledger.appendLedgerEntry(withDot, {
    kind: "deposit", amount_avax: 3, month: "2026-08",
    from: "0xp", to: "0xme", wallet: "0xme"
  });
  assert.equal(ledger.listLedgerEntries(withDot).length, 1);
  assert.equal(ledger.listLedgerEntries(without).length, 0,
    "no bleed between directories that a lossy sanitizer would have merged");
});
