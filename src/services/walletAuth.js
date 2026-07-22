const crypto = require("crypto");
const { ethers } = require("ethers");

const NONCE_TTL_MS = 5 * 60 * 1000;
const nonceStore = new Map();

function buildSignInMessage(address, nonce) {
  return [
    "FinGuard AI wants you to sign in with your wallet.",
    "",
    `Address: ${address}`,
    `Nonce: ${nonce}`,
    `Issued: ${new Date().toISOString()}`
  ].join("\n");
}

function createNonce(address) {
  const nonce = crypto.randomBytes(16).toString("hex");
  const message = buildSignInMessage(address, nonce);
  nonceStore.set(String(address).toLowerCase(), { message, expiresAt: Date.now() + NONCE_TTL_MS });
  return message;
}

function verifySignature(address, signature) {
  const key = String(address || "").toLowerCase();
  const entry = nonceStore.get(key);

  if (!entry) {
    return { ok: false, error: "nonce_missing_or_expired" };
  }
  if (Date.now() > entry.expiresAt) {
    nonceStore.delete(key);
    return { ok: false, error: "nonce_expired" };
  }

  let recovered;
  try {
    recovered = ethers.verifyMessage(entry.message, signature);
  } catch (error) {
    return { ok: false, error: "invalid_signature" };
  }

  nonceStore.delete(key);

  if (recovered.toLowerCase() !== key) {
    return { ok: false, error: "signature_mismatch" };
  }

  return { ok: true, address: recovered };
}

module.exports = {
  createNonce,
  verifySignature
};
