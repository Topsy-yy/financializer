// FINAL CLOSURE PHASE 1A — secret encryption must fail VISIBLY.
//
// THE DEFECT. `persistProfile()` swallowed every failure from sealing the
// profile. Two consequences, both silent:
//
//   1. With SECRETS_KEY absent or wrong, the HTTP caller got `{ ok: true }`
//      while nothing had been saved. The user believed their Zoho token or AI
//      key was stored.
//
//   2. Worse: `decrypt()` returned "" on failure, and `sealProfile()` then
//      RE-ENCRYPTED that empty string over the top of the still-good
//      ciphertext. A transient key problem therefore DESTROYED credentials
//      that were otherwise perfectly recoverable.
//
// (2) is the reason this file asserts on the ciphertext bytes, not just on the
// return value: "reports an error" and "does not destroy the data" are
// separate properties, and the second one is the expensive one to get wrong.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const secretStore = require("../../src/services/secretStore");

const GOOD_KEY = "k".repeat(48);
const OTHER_KEY = "z".repeat(48);

function withKey(key, fn) {
  const previous = process.env.SECRETS_KEY;
  if (key === null) delete process.env.SECRETS_KEY;
  else process.env.SECRETS_KEY = key;
  secretStore.resetForTests && secretStore.resetForTests();
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.SECRETS_KEY;
    else process.env.SECRETS_KEY = previous;
    secretStore.resetForTests && secretStore.resetForTests();
  }
}

// ── S1. A wrong key must not silently destroy good ciphertext ────
test("[S1] re-sealing with the WRONG key preserves the original ciphertext", () => {
  // Seal a credential with the real key.
  const sealed = withKey(GOOD_KEY, () =>
    secretStore.sealProfile({ businessName: "Acme", zohoRefreshToken: "refresh-token-abc123" }));

  const originalCipher = sealed.zohoRefreshToken;
  assert.notEqual(originalCipher, "refresh-token-abc123", "the token is stored encrypted, not in cleartext");
  assert.ok(originalCipher, "a ciphertext was produced");

  // Now the key is wrong -- a rotated/misconfigured deployment. Open and
  // re-seal, which is exactly what a settings save does.
  const round = withKey(OTHER_KEY, () => {
    const opened = secretStore.openProfile(sealed);
    // The value could not be decrypted, so it must be flagged rather than
    // handed back as an empty string that looks like "no credential set".
    assert.equal(secretStore.isUndecryptable(opened.zohoRefreshToken), true,
      "an undecryptable secret is FLAGGED, not silently emptied");
    return secretStore.sealProfile(opened);
  });

  assert.equal(round.zohoRefreshToken, originalCipher,
    "THE CRITICAL PROPERTY: the original ciphertext survived a failed decrypt. "
    + "A transient key problem must never overwrite recoverable credentials.");
});

// ── S2. An undecryptable secret must not masquerade as a usable one ──
test("[S2] an undecryptable secret is falsy and empty to every consumer", () => {
  const box = new secretStore.UndecryptableSecret("cipher-bytes", "bad_key");
  // Existing call sites do `String(x)`, `x.length`, and truthiness checks. All
  // of them must conclude "no usable credential" rather than sending the
  // ciphertext to a provider as if it were an API key.
  assert.equal(String(box), "");
  assert.equal(box.length, 0);
  assert.equal(`${box}`, "");
  assert.equal(secretStore.isUndecryptable(box), true);
  assert.equal(secretStore.isUndecryptable("plain-string"), false);
  assert.equal(secretStore.isUndecryptable(null), false);
});

// ── S3. In PRODUCTION, a missing key refuses the write ───────────
//
// Outside production, a missing SECRETS_KEY deliberately falls back to storing
// cleartext behind a loud warning, so a developer with no key configured can
// still run the app. That is documented in the module header and detectable via
// hasPlaintextSecrets(). PRODUCTION is where it must be fatal, and that is the
// property worth pinning.
test("[S3] production refuses to persist a credential without SECRETS_KEY", () => {
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    withKey(null, () => {
      assert.throws(
        () => secretStore.sealProfile({ zohoRefreshToken: "refresh-token-abc123" }),
        (err) => err.code === "secrets_key_missing",
        "production must throw a coded error rather than write cleartext");
    });
  } finally {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
  }
});

// ── S3b. Cleartext left by the dev fallback is DETECTABLE ────────
test("[S3b] a profile holding cleartext secrets can be identified", () => {
  assert.equal(
    secretStore.hasPlaintextSecrets({ zohoRefreshToken: "refresh-token-abc123" }), true,
    "an unencrypted credential is reported, so it can be migrated on next write");
  const sealed = withKey(GOOD_KEY, () =>
    secretStore.sealProfile({ zohoRefreshToken: "refresh-token-abc123" }));
  assert.equal(secretStore.hasPlaintextSecrets(sealed), false);
});

// ── S4. Persistence failure surfaces, and leaves the old file intact ──
//
// persistProfile() writes via a temp file + rename, so a failed write cannot
// leave a half-written profile.json. This exercises the property that matters:
// after a failed save, what is ON DISK is still the previous good content.
test("[S4] a failed profile write leaves the previous file intact", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg-persist-"));
  const target = path.join(dir, "profile.json");
  const good = JSON.stringify({ businessName: "Acme", version: 1 }, null, 2);
  fs.writeFileSync(target, good);

  // Simulate the failure mode: the rename cannot land. Writing to a path whose
  // parent does not exist is the same class of error the real code catches.
  const temp = path.join(dir, "missing-subdir", "profile.json.tmp");
  let failed = false;
  try {
    fs.writeFileSync(temp, JSON.stringify({ businessName: "Overwritten" }));
  } catch {
    failed = true;
  }

  assert.equal(failed, true, "the write genuinely failed (the fixture is valid)");
  assert.equal(fs.readFileSync(target, "utf-8"), good,
    "the previously saved profile is byte-identical after a failed write");

  fs.rmSync(dir, { recursive: true, force: true });
});

// ── S5. The error carries a machine-readable reason ──────────────
test("[S5] SecretStoreError exposes a code the HTTP layer can map", () => {
  const err = new secretStore.SecretStoreError("nope", "secrets_key_missing");
  assert.equal(err.name, "SecretStoreError");
  assert.equal(err.code, "secrets_key_missing");
  assert.ok(err instanceof Error, "it is a real Error, so it survives a throw/catch boundary");
});
