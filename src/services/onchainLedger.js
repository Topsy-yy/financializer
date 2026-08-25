const fs = require("fs");
const path = require("path");
const { logger } = require("./logger");

const log = logger.child({ component: "onchain-ledger" });

// Persistent log of on-chain money movements (deposits, withdrawals, releases,
// refunds, claims) tied to the user's contracts. Fed into the monthly analysis.
//
// SECURITY / CORRECTNESS: this file used to live at the GLOBAL reports root, so
// every tenant wrote to and read from one ledger -- leaking wallet addresses and
// transaction hashes across businesses AND injecting other tenants' money
// movements into each tenant's monthly financial analysis. Every entry point now
// requires the caller's own tenant directory.
// See docs/THREAT_MODEL.md T4 and tests/security/containment.test.js.
const LEDGER_BASENAME = "onchain-ledger.jsonl";

/**
 * Resolve the ledger path for a tenant, refusing anything that could escape it.
 *
 * The basename is a FIXED literal, so the filename itself can never carry
 * traversal. The checks below cover the remaining ways a caller could get this
 * wrong, because this module is the last place that can still tell:
 *
 *  - a RELATIVE tenantDir would resolve against process.cwd(), silently writing
 *    one shared ledger for every tenant — the exact cross-tenant leak the
 *    comment above says was already fixed once;
 *  - a tenantDir containing `..` would resolve outside the reports root even
 *    though the basename is safe;
 *  - a non-string tenantDir would stringify into something arbitrary.
 *
 * These are defence in depth: the caller derives tenantDir from safeDirName().
 * They exist so a FUTURE caller cannot reintroduce the leak silently.
 */
function ledgerFileFor(tenantDir) {
  if (!tenantDir || typeof tenantDir !== "string") {
    throw new Error("onchainLedger: tenantDir is required and must be a string");
  }
  if (!path.isAbsolute(tenantDir)) {
    throw new Error("onchainLedger: tenantDir must be an absolute path");
  }
  const root = path.resolve(tenantDir);
  const file = path.resolve(root, LEDGER_BASENAME);
  // path.resolve normalises `..`; confirm we did not climb out of the tenant.
  if (path.dirname(file) !== root) {
    throw new Error("onchainLedger: refusing a ledger path outside the tenant directory");
  }
  return file;
}

function ensureFile(tenantDir) {
  const file = ledgerFileFor(tenantDir);
  if (!fs.existsSync(tenantDir)) fs.mkdirSync(tenantDir, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, "");
  return file;
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

function appendLedgerEntry(tenantDir, entry) {
  const ledgerFile = ensureFile(tenantDir);
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

/**
 * Read the most recent entries, newest first.
 *
 * CORRUPT LINES. A torn line — a crash or an interleaved concurrent append
 * mid-record — used to be dropped SILENTLY by the `catch { return null }`
 * below. That quietly changed the inflow/outflow totals fed into the monthly
 * analysis, which is the one thing this module must not do without saying so.
 * Unparseable lines are still skipped (they carry no usable amount), but they
 * are now COUNTED and logged, and the count is reported on the summary so a
 * damaged ledger is visible instead of merely producing smaller numbers.
 *
 * JSONL is deliberate here: it is the format where damage stays confined to the
 * line it happened on, so one torn record cannot cost us the whole history.
 */
function readLedger(tenantDir, limit = 100) {
  const ledgerFile = ensureFile(tenantDir);
  const max = Math.max(1, Math.min(500, Number(limit) || 100));
  const content = fs.readFileSync(ledgerFile, "utf-8").trim();
  if (!content) return { entries: [], corrupt: 0 };

  let corrupt = 0;
  const entries = content.split(/\r?\n/).filter(Boolean).slice(-max).reverse()
    .map((line) => {
      try {
        const parsed = JSON.parse(line);
        // A line can be valid JSON yet not a record (e.g. a torn line that
        // happens to end on a complete value). Require the record shape.
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          corrupt += 1;
          return null;
        }
        return parsed;
      } catch {
        corrupt += 1;
        return null;
      }
    })
    .filter(Boolean);

  if (corrupt > 0) {
    // No record contents are logged -- these are financial rows.
    log.error("onchain_ledger.corrupt_lines", { corrupt, readable: entries.length });
  }
  return { entries, corrupt };
}

function listLedgerEntries(tenantDir, limit = 100) {
  return readLedger(tenantDir, limit).entries;
}

// Summarize a period (YYYY-MM) into inflow / outflow / net for the monthly analysis.
// Falls back to all-time recent activity if nothing matches the requested month.
function summarizeMonth(tenantDir, month) {
  const { entries: all, corrupt } = readLedger(tenantDir, 500);
  let items = month ? all.filter((e) => e.month === month) : all;
  let scope = "month";
  /* The `recent` fallback substitutes ALL-TIME activity when the requested
     month has none. It is kept (a caller may want to show something rather
     than an empty panel) but `scope` must be read: these figures are NOT the
     requested month's, and presenting them as such would attribute money
     movements to a period they did not occur in. Callers that need the month
     specifically check `scope === "month"`. */
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
    // Surfaced so a damaged ledger is visible rather than silently smaller.
    corrupt_lines: corrupt,
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
  directionFor,
  // Exported for the adversarial containment tests, which must be able to
  // assert on path resolution and corrupt-line accounting directly.
  ledgerFileFor,
  readLedger,
  LEDGER_BASENAME
};
