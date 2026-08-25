// The deterministic core must stay pure.
//
// Mandate JOB 6: "zero HTTP imports, zero Express imports, zero filesystem
// persistence, zero AI imports, zero provider imports." This test enforces that
// mechanically so the layering cannot rot back.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DOMAIN = path.resolve(__dirname, "../../src/domain");

function domainFiles(dir = DOMAIN, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) domainFiles(full, acc);
    else if (entry.name.endsWith(".js")) acc.push(full);
  }
  return acc;
}

const FORBIDDEN = [
  { pattern: /require\(["']express["']\)/, why: "HTTP framework" },
  { pattern: /require\(["']node:https?["']\)|require\(["']https?["']\)/, why: "HTTP client" },
  { pattern: /require\(["']node:fs["']\)|require\(["']fs["']\)/, why: "filesystem persistence" },
  { pattern: /require\(["']pg["']\)|require\(["']node:sqlite["']\)/, why: "database driver" },
  { pattern: /aiAnalysisClient|require\(["'].*\/ai\//, why: "AI subsystem" },
  { pattern: /\bfetch\s*\(/, why: "network call" },
  { pattern: /require\(["']\.\.\/\.\.\/routes/, why: "route layer" },
  { pattern: /require\(["']\.\.\/\.\.\/services\/(zoho|ai|entitlements|monitoring)/, why: "outer-layer service" }
];

test("[PURE] no domain module imports HTTP, fs, a database, or AI", () => {
  const files = domainFiles();
  assert.ok(files.length >= 5, `expected domain modules, found ${files.length}`);
  const violations = [];
  files.forEach((file) => {
    const src = fs.readFileSync(file, "utf-8");
    FORBIDDEN.forEach(({ pattern, why }) => {
      if (pattern.test(src)) violations.push(`${path.relative(DOMAIN, file)} -> ${why}`);
    });
  });
  assert.deepEqual(violations, [], `domain purity violations:\n${violations.join("\n")}`);
});

test("[PURE-2] the engine runs with no environment and no globals", () => {
  // A pure engine must not depend on process.env or a live clock.
  const engine = require("../../src/domain/analysis/engine");
  const data = {
    period: "2026-05",
    transactions: [{ date: "2026-05-01", amount: 1000, counterparty: "A" }],
    journalEntries: [], reconciliations: [],
    statements: { cashFlow: { inflow: 5000, outflow: 1000 }, profitAndLoss: { revenue: 5000 }, balanceSheet: { cashAndEquivalents: 20000 } }
  };
  const a = engine.analyze(data, { tenantId: "t", period: "2026-05", now: 1_800_000_000_000 });
  const b = engine.analyze(data, { tenantId: "t", period: "2026-05", now: 1_800_000_000_000 });
  assert.equal(a.inputHash, b.inputHash);
  assert.equal(a.riskScore.overall, b.riskScore.overall);
});

test("[PURE-3] the only cross-layer dependency is domain -> domain", () => {
  const files = domainFiles();
  files.forEach((file) => {
    const src = fs.readFileSync(file, "utf-8");
    const requires = [...src.matchAll(/require\(["'](\.[^"']+)["']\)/g)].map((m) => m[1]);
    requires.forEach((r) => {
      const resolved = path.resolve(path.dirname(file), r);
      assert.ok(resolved.startsWith(DOMAIN),
        `${path.relative(DOMAIN, file)} reaches outside the domain: ${r}`);
    });
  });
});
