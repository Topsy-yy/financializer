const fs = require("fs");
const path = require("path");
const config = require("../config");

const historyFile = path.resolve(config.reportsDir, "contract-deployments.jsonl");

function ensureHistoryFile() {
  if (!fs.existsSync(config.reportsDir)) {
    fs.mkdirSync(config.reportsDir, { recursive: true });
  }
  if (!fs.existsSync(historyFile)) {
    fs.writeFileSync(historyFile, "");
  }
}

function appendDeploymentRecord(record) {
  ensureHistoryFile();
  const line = JSON.stringify({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    created_at: new Date().toISOString(),
    ...record
  });
  fs.appendFileSync(historyFile, `${line}\n`);
}

function listDeploymentRecords(limit = 25) {
  ensureHistoryFile();
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
