const fs = require("fs");
const path = require("path");

// SECURITY: previously a single GLOBAL file shared by every tenant.
// See docs/THREAT_MODEL.md T4.
function historyFileFor(tenantDir) {
  if (!tenantDir) throw new Error("contractDeploymentHistory: tenantDir is required");
  return path.resolve(tenantDir, "contract-deployments.jsonl");
}

function ensureHistoryFile(tenantDir) {
  const historyFile = historyFileFor(tenantDir);
  if (!fs.existsSync(tenantDir)) {
    fs.mkdirSync(tenantDir, { recursive: true });
  }
  if (!fs.existsSync(historyFile)) {
    fs.writeFileSync(historyFile, "");
  }
  return historyFile;
}

function appendDeploymentRecord(tenantDir, record) {
  const historyFile = ensureHistoryFile(tenantDir);
  const line = JSON.stringify({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    created_at: new Date().toISOString(),
    ...record
  });
  fs.appendFileSync(historyFile, `${line}\n`);
}

function listDeploymentRecords(tenantDir, limit = 25) {
  const historyFile = ensureHistoryFile(tenantDir);
  const max = Math.max(1, Math.min(100, Number(limit) || 25));
  const content = fs.readFileSync(historyFile, "utf-8").trim();
  if (!content) return [];

  const lines = content
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-max)
    .reverse();

  return lines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

module.exports = {
  appendDeploymentRecord,
  listDeploymentRecords
};
