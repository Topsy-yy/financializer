const fs = require("fs");
const path = require("path");
const config = require("../config");

// Persistent log of on-chain money movements (deposits, withdrawals, releases,
// refunds, claims) tied to the user's contracts. Fed into the monthly analysis.
const ledgerFile = path.resolve(config.reportsDir, "onchain-ledger.jsonl");

function ensureFile() {
  if (!fs.existsSync(config.reportsDir)) fs.mkdirSync(config.reportsDir, { recursive: true });
  if (!fs.existsSync(ledgerFile)) fs.writeFileSync(ledgerFile, "");
}

function monthOf(value) {
  // Accept an explicit YYYY-MM, else derive from an ISO timestamp / now.
  if (typeof value === "string" && /^\d{4}-\d{2}$/.test(value)) return value;
  const d = value ? new Date(value) : new Date();
  return d.toISOString().slice(0, 7);
}

function directionFor(from, to, wallet) {
  const w = String(wallet || "").toLowerCase();
  if (!w) return "internal";
  if (String(to || "").toLowerCase() === w) return "in";
  if (String(from || "").toLowerCase() === w) return "out";
  return "internal";
}

function appendLedgerEntry(entry) {
  ensureFile();
  const createdAt = new Date().toISOString();
  const amount = Number(entry.amount_avax != null ? entry.amount_avax : entry.amount) || 0;
  const record = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    created_at: createdAt,
    month: monthOf(entry.month || createdAt),
    kind: entry.kind || "transfer",
    contract_name: entry.contract_name || entry.contractName || "Contract",
    contract_address: entry.contract_address || entry.contractAddress || "",
    tx_hash: entry.tx_hash || entry.txHash || "",
    chain_id: Number(entry.chain_id || entry.chainId) || null,
    from: entry.from || "",
    to: entry.to || "",
    wallet: entry.wallet || "",
    amount_avax: amount,
    direction: entry.direction || directionFor(entry.from, entry.to, entry.wallet),
    verified: Boolean(entry.verified)
  };
  fs.appendFileSync(ledgerFile, `${JSON.stringify(record)}\n`);
  return record;
}

function listLedgerEntries(limit = 100) {
  ensureFile();
  const max = Math.max(1, Math.min(500, Number(limit) || 100));
  const content = fs.readFileSync(ledgerFile, "utf-8").trim();
  if (!content) return [];
  return content.split(/\r?\n/).filter(Boolean).slice(-max).reverse()
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// Summarize a period (YYYY-MM) into inflow / outflow / net for the monthly analysis.
// Falls back to all-time recent activity if nothing matches the requested month.
function summarizeMonth(month) {
  const all = listLedgerEntries(500);
  let items = month ? all.filter((e) => e.month === month) : all;
  let scope = "month";
  if (month && items.length === 0) { items = all.slice(0, 20); scope = "recent"; }

  let inflow = 0, outflow = 0;
  items.forEach((e) => {
    if (e.direction === "in") inflow += Number(e.amount_avax) || 0;
    else if (e.direction === "out") outflow += Number(e.amount_avax) || 0;
  });
  const round = (n) => Math.round(n * 1e6) / 1e6;
  return {
    scope,
    month: month || null,
    count: items.length,
    inflow_avax: round(inflow),
    outflow_avax: round(outflow),
    net_avax: round(inflow - outflow),
    items: items.slice(0, 25),
    skills: ["onchain-ledger"]
  };
}

module.exports = {
  appendLedgerEntry,
  listLedgerEntries,
  summarizeMonth,
  directionFor
};
