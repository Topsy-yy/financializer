#!/usr/bin/env node
// One-off migration: encrypt credentials already persisted in cleartext.
//
// NOT run automatically. Requires SECRETS_KEY, and that key must remain
// available forever afterwards or the credentials become unrecoverable.
//
//   Dry run:  SECRETS_KEY=... node scripts/encrypt-existing-secrets.js
//   Apply:    SECRETS_KEY=... node scripts/encrypt-existing-secrets.js --apply
//
// NOTE: encrypting an already-exposed credential does not un-expose it.
// Rotate anything that was stored in cleartext.
const fs = require("node:fs");
const path = require("node:path");
const secretStore = require("../src/services/secretStore");

const apply = process.argv.includes("--apply");
const reportsDir = process.env.REPORTS_DIR || path.resolve(process.cwd(), "data", "reports");

if (!secretStore.isAvailable()) {
  console.error("SECRETS_KEY is not set. Refusing to run.");
  process.exit(1);
}

let scanned = 0, needing = 0, changed = 0;
for (const entry of fs.readdirSync(reportsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const file = path.join(reportsDir, entry.name, "profile.json");
  if (!fs.existsSync(file)) continue;
  scanned++;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, "utf-8")); } catch { console.warn("unreadable:", file); continue; }
  if (!secretStore.hasPlaintextSecrets(raw)) continue;
  needing++;
  const fields = secretStore.SECRET_FIELDS.filter((f) => raw[f] && !secretStore.isEncrypted(raw[f]));
  console.log(`${apply ? "encrypting" : "would encrypt"}: ${entry.name} [${fields.join(", ")}]`);
  if (apply) {
    fs.copyFileSync(file, `${file}.bak`);
    fs.writeFileSync(file, JSON.stringify(secretStore.sealProfile(raw), null, 2));
    changed++;
  }
}
console.log(`\nscanned=${scanned} needing_encryption=${needing} changed=${changed}`);
if (!apply && needing) console.log("Dry run. Re-run with --apply to write (a .bak is kept).");
if (needing) console.log("REMINDER: rotate any credential that was ever stored in cleartext.");
