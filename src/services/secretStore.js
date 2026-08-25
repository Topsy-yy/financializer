// Encryption-at-rest for third-party credentials held in a user's profile.
//
// WHY: profiles are persisted as JSON on disk. The audit found live xAI API keys
// and long-lived Zoho refresh tokens sitting in cleartext in
// data/reports/<user>/profile.json — readable by any process running as the app
// user, and copied by any backup, rsync or container layer.
//
// SCOPE (JOB 2 containment, not the final design): this wraps the values so a
// stolen file is not immediately usable. JOB 3 replaces it with secret
// REFERENCES — the application stores a handle, and the actual credential lives
// in a dedicated secret manager. Treat this module as a stopgap with a clear
// successor, not as the destination.
//
// Envelope format:  enc:v1:<iv-b64>:<tag-b64>:<ciphertext-b64>
// Algorithm:        AES-256-GCM, key derived from SECRETS_KEY via scrypt.
//
// Legacy plaintext values are read as-is (so no customer loses a stored key) and
// are re-written encrypted the next time the profile is saved — migrate-on-write.

const crypto = require("crypto");
const { logger } = require("./logger");
const log = logger.child({ component: "secrets" });

const PREFIX = "enc:v1:";
const ALGO = "aes-256-gcm";
// Fixed salt: the key material is already high-entropy and per-deployment, and a
// stable salt keeps decryption possible without storing per-value metadata.
const SALT = "finguard.secretstore.v1";

// Profile fields treated as secrets. Anything listed here is encrypted on write
// and decrypted on read.
const SECRET_FIELDS = ["aiApiKey", "zohoApiKey", "zohoRefreshToken"];

let cachedKey = null;
let warned = false;

function keyMaterial() {
  return process.env.SECRETS_KEY || "";
}

/** Returns a 32-byte key, or null when no SECRETS_KEY is configured. */
function getKey() {
  const material = keyMaterial();
  if (!material) return null;
  if (!cachedKey || cachedKey.material !== material) {
    cachedKey = { material, key: crypto.scryptSync(material, SALT, 32) };
  }
  return cachedKey.key;
}

function isEncrypted(value) {
  return typeof value === "string" && value.startsWith(PREFIX);
}

/** True when this deployment is able to encrypt secrets at rest. */
function isAvailable() {
  return Boolean(getKey());
}

function encrypt(plaintext) {
  if (plaintext == null || plaintext === "") return plaintext;
  // An undecryptable value is passed straight back as its ORIGINAL ciphertext,
  // so a failed read can never overwrite good stored data.
  if (isUndecryptable(plaintext)) return plaintext.ciphertext;
  if (isEncrypted(plaintext)) return plaintext; // idempotent
  const key = getKey();
  if (!key) {
    // Never fail silently in a way that hides the exposure.
    if (process.env.NODE_ENV === "production") {
      throw new SecretStoreError(
        "SECRETS_KEY is not configured; refusing to persist a credential in cleartext.",
        "secrets_key_missing");
    }
    if (!warned) {
      warned = true;
      log.warn("WARNING: SECRETS_KEY is not set — credentials are being stored UNENCRYPTED. " +
        "Set SECRETS_KEY before handling real customer credentials.");
    }
    return plaintext;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

/**
 * A credential that could not be decrypted.
 *
 * THE DATA-LOSS BUG THIS FIXES. `decrypt` used to return "" on failure. That is
 * indistinguishable from "no credential is set" — so the next `persistProfile`
 * re-sealed the empty string and OVERWROTE the good ciphertext. A transient
 * wrong key, or a SECRETS_KEY rotation, silently destroyed the customer's
 * stored Zoho refresh token and AI key on the very next profile write.
 *
 * An undecryptable value is now returned as this SENTINEL, which:
 *   * is falsy in the places that test a credential for presence, so nothing
 *     tries to USE it;
 *   * is recognisable by `sealProfile`, which preserves the original ciphertext
 *     untouched rather than replacing it;
 *   * makes the failure reportable rather than invisible.
 */
class UndecryptableSecret {
  constructor(ciphertext, reason) {
    this.__undecryptable = true;
    this.ciphertext = ciphertext;
    this.reason = reason;
  }
  /* Falsy-like in string contexts, so `if (profile.aiApiKey)` does not treat a
     broken credential as a usable one. */
  toString() { return ""; }
  valueOf() { return ""; }
  get length() { return 0; }
}

function isUndecryptable(value) {
  return Boolean(value && typeof value === "object" && value.__undecryptable);
}

class SecretStoreError extends Error {
  constructor(message, code, detail = null) {
    super(message);
    this.name = "SecretStoreError";
    this.code = code;
    this.detail = detail;
  }
}

function decrypt(value) {
  if (!isEncrypted(value)) return value; // legacy plaintext passes through
  const key = getKey();
  if (!key) {
    log.error("encrypted value present but SECRETS_KEY is not set — cannot decrypt");
    // NOT "" — see UndecryptableSecret. Returning "" here is what destroyed
    // the ciphertext on the next write.
    return new UndecryptableSecret(value, "no_key");
  }
  try {
    const [ivB64, tagB64, ctB64] = value.slice(PREFIX.length).split(":");
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, "base64")),
      decipher.final()
    ]).toString("utf8");
  } catch (e) {
    // A wrong key or a tampered file. Never log the value.
    log.error("failed to decrypt a stored credential", { reason: e.message });
    return new UndecryptableSecret(value, "decrypt_failed");
  }
}

/** Copy of `profile` with secret fields encrypted — use when writing to disk. */
function sealProfile(profile) {
  const out = Object.assign({}, profile);
  SECRET_FIELDS.forEach((field) => {
    if (out[field]) out[field] = encrypt(out[field]);
  });
  return out;
}

/** Copy of `profile` with secret fields decrypted — use when loading from disk. */
function openProfile(profile) {
  const out = Object.assign({}, profile);
  SECRET_FIELDS.forEach((field) => {
    if (out[field]) out[field] = decrypt(out[field]);
  });
  return out;
}

/** True if any secret field in a persisted profile is still cleartext. */
function hasPlaintextSecrets(persisted) {
  return SECRET_FIELDS.some((f) => persisted && persisted[f] && !isEncrypted(persisted[f]));
}

module.exports = {
  UndecryptableSecret,
  isUndecryptable,
  SecretStoreError,
  SECRET_FIELDS,
  isAvailable,
  isEncrypted,
  encrypt,
  decrypt,
  sealProfile,
  openProfile,
  hasPlaintextSecrets
};
