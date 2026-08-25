// Normalized financial record contracts.
//
// These are the shapes the deterministic engine consumes, regardless of whether
// the data came from Zoho, a CSV upload or explicit demo mode. Plain frozen
// objects with validators — not classes — matching this codebase's style.
//
// The single hard rule: EVERY record carries provenance
// (sourceSystem + sourceRecordId). Without it a finding cannot cite the record
// that produced it, which is the whole point of the Finding model.

const RECORD_TYPE = Object.freeze({
  INVOICE: "invoice",
  BILL: "bill",
  EXPENSE: "expense",
  PAYMENT: "payment",
  BANK_TRANSACTION: "bank_transaction",
  JOURNAL_ENTRY: "journal_entry",
  OTHER: "other"
});

const DIRECTION = Object.freeze({ INFLOW: "inflow", OUTFLOW: "outflow" });

const SOURCE_SYSTEM = Object.freeze({
  ZOHO: "zoho-books",
  CSV: "csv-upload",
  DEMO: "demo"
});

class InvalidRecordError extends Error {
  constructor(message, record) {
    super(message);
    this.name = "InvalidRecordError";
    this.code = "invalid_record";
    this.record = record;
  }
}

function num(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Provenance every persisted record must carry.
 * `sourceUpdatedAt` lets a later incremental sync detect staleness.
 */
function assertProvenance(record, context = "record") {
  if (!record || typeof record !== "object") throw new InvalidRecordError(`${context} must be an object`, record);
  if (!record.sourceSystem) throw new InvalidRecordError(`${context} is missing sourceSystem`, record);
  if (!record.sourceRecordId) throw new InvalidRecordError(`${context} is missing sourceRecordId`, record);
  return true;
}

/**
 * A normalized transaction — the atom the engine reasons over.
 *
 * Direction convention (preserved from the existing engine): a NEGATIVE amount
 * is an inflow, a positive amount is an outflow. `direction` makes that explicit
 * so downstream code never has to infer it from the sign.
 */
function createTransaction(input) {
  assertProvenance(input, "transaction");
  const amount = num(input.amount);
  const date = String(input.date || "").slice(0, 10);
  if (!ISO_DATE.test(date)) {
    throw new InvalidRecordError(`transaction ${input.sourceRecordId} has an invalid date: ${input.date}`, input);
  }
  const recordType = input.recordType || input.txnType || RECORD_TYPE.OTHER;
  if (!Object.values(RECORD_TYPE).includes(recordType)) {
    throw new InvalidRecordError(`transaction ${input.sourceRecordId} has unknown type: ${recordType}`, input);
  }

  return Object.freeze({
    sourceSystem: String(input.sourceSystem),
    sourceRecordId: String(input.sourceRecordId),
    sourceUpdatedAt: input.sourceUpdatedAt || null,
    recordType,
    date,
    amount,
    direction: input.direction || (amount < 0 ? DIRECTION.INFLOW : DIRECTION.OUTFLOW),
    // Currency is EXPLICIT and never converted (see docs: multi-currency is
    // represented, not flattened).
    currency: input.currency || null,
    exchangeRate: input.exchangeRate == null ? null : num(input.exchangeRate, null),
    counterparty: input.counterparty || null,
    description: input.description || null,
    account: input.account || null,
    reference: input.reference || null,
    // Tri-state on purpose: undefined/null means "the source does not report
    // this", which is NOT the same as false.
    hasReceipt: input.hasReceipt === undefined ? null : input.hasReceipt,
    isReconciled: input.isReconciled === undefined ? null : input.isReconciled,
    dueDate: input.dueDate || null,
    balance: input.balance == null ? null : num(input.balance)
  });
}

/** A party the business trades with. `kind` distinguishes customer from vendor. */
function createCounterparty(input) {
  assertProvenance(input, "counterparty");
  const kind = input.kind || "other";
  if (!["customer", "vendor", "other"].includes(kind)) {
    throw new InvalidRecordError(`counterparty has unknown kind: ${kind}`, input);
  }
  return Object.freeze({
    sourceSystem: String(input.sourceSystem),
    sourceRecordId: String(input.sourceRecordId),
    sourceUpdatedAt: input.sourceUpdatedAt || null,
    kind,
    name: input.name || null
  });
}

/** A ledger/bank account. */
function createAccount(input) {
  assertProvenance(input, "account");
  return Object.freeze({
    sourceSystem: String(input.sourceSystem),
    sourceRecordId: String(input.sourceRecordId),
    sourceUpdatedAt: input.sourceUpdatedAt || null,
    name: input.name || null,
    accountType: input.accountType || null,
    currency: input.currency || null,
    balance: input.balance == null ? null : num(input.balance)
  });
}

/** An outstanding receivable or payable. */
function createOutstanding(input, kind) {
  assertProvenance(input, kind);
  return Object.freeze({
    sourceSystem: String(input.sourceSystem),
    sourceRecordId: String(input.sourceRecordId),
    kind, // "receivable" | "payable"
    party: input.customer || input.vendor || input.party || null,
    amount: num(input.amount),
    balance: input.balance == null ? null : num(input.balance),
    currency: input.currency || null,
    dueDate: input.dueDate || null
  });
}

/** A business/tenant. */
function createBusiness(input) {
  if (!input || !input.tenantId) throw new InvalidRecordError("business requires a tenantId", input);
  return Object.freeze({
    tenantId: String(input.tenantId),
    name: input.name || null,
    baseCurrency: input.baseCurrency || null
  });
}

/**
 * An accounting period. Bounds are inclusive.
 * Strict validation lives in src/ingestion/period.js; this is the domain shape.
 */
function createFinancialPeriod(input) {
  if (!input || !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(input.period || ""))) {
    throw new InvalidRecordError(`invalid financial period: ${input && input.period}`, input);
  }
  return Object.freeze({
    period: String(input.period),
    startsOn: input.startsOn || null,
    endsOn: input.endsOn || null,
    currency: input.currency || null
  });
}

/** Validate a batch, collecting failures rather than throwing on the first. */
function validateTransactions(rows) {
  const valid = [];
  const invalid = [];
  (rows || []).forEach((row, index) => {
    try { valid.push(createTransaction(row)); }
    catch (err) { invalid.push({ index, reason: err.message, record: row }); }
  });
  return { valid, invalid };
}

module.exports = {
  RECORD_TYPE,
  DIRECTION,
  SOURCE_SYSTEM,
  InvalidRecordError,
  assertProvenance,
  createTransaction,
  createCounterparty,
  createAccount,
  createOutstanding,
  createBusiness,
  createFinancialPeriod,
  validateTransactions
};
