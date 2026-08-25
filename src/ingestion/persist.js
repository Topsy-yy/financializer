// Ingestion -> repository -> PostgreSQL.
//
// The dependency direction the mandate requires:
//
//     ingestion  ->  repository  ->  PostgreSQL
//     repository ->  domain objects -> deterministic engine
//
// This module is the ONLY place that connects an ingestion result to the
// repository layer. Routes never write SQL, and the deterministic engine never
// learns that a database exists.
//
// Persistence is OPTIONAL and non-fatal by design: the product still works
// entirely in-memory (as it does today), so a database outage degrades storage
// rather than blocking analysis. What it must never do is fail silently — a
// failed persist is reported in the returned result.

const { isConfigured } = require("../db/pool");
const transactionRepository = require("../db/repositories/transactionRepository");
const { validateTransactions, RECORD_TYPE, DIRECTION } = require("../domain/model/records");

/** Map a normalized ingestion record onto the repository's column contract. */
function toRepositoryRow(tx, period) {
  const recordType = tx.recordType || tx.txnType || RECORD_TYPE.OTHER;
  return {
    period,
    sourceSystem: tx.sourceSystem,
    sourceRecordId: tx.sourceRecordId,
    txnType: Object.values(RECORD_TYPE).includes(recordType) ? recordType : RECORD_TYPE.OTHER,
    txnDate: tx.date,
    amount: tx.amount,
    currency: tx.currency || "KES",
    // Currency is preserved, NEVER converted. base_amount stays null until a
    // real conversion requirement exists (JOB 4 decision, unchanged here).
    baseAmount: null,
    baseCurrency: null,
    exchangeRate: tx.exchangeRate == null ? null : tx.exchangeRate,
    direction: tx.direction || (Number(tx.amount) < 0 ? DIRECTION.INFLOW : DIRECTION.OUTFLOW),
    counterpartyName: tx.counterparty || null,
    description: tx.description || null,
    reference: tx.reference || null,
    hasReceipt: tx.hasReceipt == null ? null : tx.hasReceipt,
    isReconciled: tx.isReconciled == null ? null : tx.isReconciled,
    dueDate: tx.dueDate || null,
    balance: tx.balance == null ? null : tx.balance,
    sourceUpdatedAt: tx.sourceUpdatedAt || null
  };
}

/**
 * Persist an ingestion envelope's transactions for a tenant.
 *
 * Re-ingesting a period UPDATES rather than duplicates, because the repository
 * upserts on (tenant_id, source_system, source_record_id) — which is exactly why
 * every record needs stable provenance (see CSV source ids).
 *
 * @returns {object} { persisted, skipped, inserted, updated, invalid, reason }
 */
async function persistIngestion(tenantId, envelope, opts = {}) {
  const enabled = opts.enabled == null ? isConfigured() : opts.enabled;
  if (!enabled) {
    return { persisted: false, skipped: true, reason: "database_not_configured" };
  }
  if (!tenantId) {
    return { persisted: false, skipped: true, reason: "no_tenant" };
  }
  if (!envelope || !envelope.data) {
    return { persisted: false, skipped: true, reason: "no_data" };
  }

  const period = envelope.period;
  const rows = envelope.data.transactions || [];

  // Records without provenance cannot be stored idempotently, so they are
  // reported rather than written with a fabricated key.
  const { valid, invalid } = validateTransactions(rows);

  try {
    const result = await transactionRepository.upsertMany(
      tenantId,
      valid.map((tx) => toRepositoryRow(tx, period))
    );
    return {
      persisted: true,
      skipped: false,
      period,
      source: envelope.source,
      inserted: result.inserted,
      updated: result.updated,
      invalid: invalid.length,
      invalidReasons: invalid.slice(0, 5).map((i) => i.reason)
    };
  } catch (err) {
    // Never silent: the caller decides whether to surface or retry.
    return { persisted: false, skipped: false, reason: "persist_failed", error: err.message, invalid: invalid.length };
  }
}

module.exports = { persistIngestion, toRepositoryRow };
