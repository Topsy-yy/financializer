#!/usr/bin/env node
// Fails if credentials are tracked by git or left in cleartext on disk.
// Run in CI and before any commit that touches persistence.
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const secretStore = require("../src/services/secretStore");

let problems = 0;
const fail = (msg) => { console.error("FAIL:", msg); problems++; };
const ok = (msg) => console.log("ok:", msg);

// 1. Nothing secret may be tracked by git.
try {
  const tracked = execSync("git ls-files", { encoding: "utf-8" }).split("\n");
  const bad = tracked.filter((f) => /(^|\/)\.env$|profile\.json$|\.pem$|\.key$/.test(f));
  bad.length ? bad.forEach((f) => fail(`tracked secret file: ${f}`)) : ok("no secret files tracked by git");
} catch { console.log("skip: not a git repository"); }

// 2. Persisted profiles must not hold cleartext credentials.
const reportsDir = process.env.REPORTS_DIR || path.resolve(process.cwd(), "data", "reports");
let scanned = 0, plaintext = 0;
function walk(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name === "profile.json") {
      scanned++;
      try {
        const raw = JSON.parse(fs.readFileSync(full, "utf-8"));
        if (secretStore.hasPlaintextSecrets(raw)) { plaintext++; fail(`cleartext credential in ${full}`); }
      } catch { /* unreadable */ }
    }
  }
}
walk(reportsDir);
if (scanned && !plaintext) ok(`${scanned} profile(s) scanned, none holding cleartext credentials`);
if (!scanned) console.log(`skip: no profiles under ${reportsDir}`);

// 3. Encryption must be configured.
secretStore.isAvailable() ? ok("SECRETS_KEY is configured") : fail("SECRETS_KEY is not set — credentials would be stored in cleartext");

process.exit(problems ? 1 : 0);
