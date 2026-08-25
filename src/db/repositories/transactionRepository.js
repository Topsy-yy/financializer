// Financial transaction persistence.
//
// Ingestion is IDEMPOTENT: (tenant_id, source_system, source_record_id) is
// unique, so re-fetching a period updates rows instead of duplicating them.
// The audit found CSV re-uploads silently overwriting a period and Zoho
// re-fetches having no duplicate protection at all.
const { withTenant } = require("../pool");

const COLUMNS = `tenant_id, period, source_system, source_record_id, txn_type, txn_date,
  amount, currency, base_amount, base_currency, exchange_rate, direction,
  counterparty_name, description, reference, has_receipt, is_reconciled,
  due_date, balance, source_updated_at`;

function toParams(tenantId, t) {
  return [
    tenantId, t.period, t.sourceSystem, t.sourceRecordId, t.txnType, t.txnDate,
    t.amount, t.currency, t.baseAmount ?? null, t.baseCurrency ?? null, t.exchangeRate ?? null,
    t.direction, t.counterpartyName ?? null, t.description ?? null, t.reference ?? null,
    t.hasReceipt ?? null, t.isReconciled ?? null, t.dueDate ?? null, t.balance ?? null,
    t.sourceUpdatedAt ?? null
  ];
}

/** Upsert a batch inside one transaction. Returns counts, not a silent success. */
async function upsertMany(tenantId, transactions) {
  if (!transactions || !transactions.length) return { inserted: 0, updated: 0 };
  return withTenant(tenantId, async (c) => {
    let inserted = 0, updated = 0;
    for (const t of transactions) {
      const { rows } = await c.query(
        `INSERT INTO financial_transaction (${COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         ON CONFLICT (tenant_id, source_system, source_record_id) DO UPDATE SET
           period = EXCLUDED.period, txn_date = EXCLUDED.txn_date, amount = EXCLUDED.amount,
           currency = EXCLUDED.currency, direction = EXCLUDED.direction,
           counterparty_name = EXCLUDED.counterparty_name, description = EXCLUDED.description,
           balance = EXCLUDED.balance, is_reconciled = EXCLUDED.is_reconciled,
           has_receipt = EXCLUDED.has_receipt, due_date = EXCLUDED.due_date,
           source_updated_at = EXCLUDED.source_updated_at, updated_at = now()
         RETURNING (xmax = 0) AS was_inserted`,
        toParams(tenantId, t)
      );
      rows[0].was_inserted ? inserted++ : updated++;
    }
    return { inserted, updated };
  });
}

async function findByPeriod(tenantId, period) {
  return withTenant(tenantId, async (c) => {
    const { rows } = await c.query(
      "SELECT * FROM financial_transaction WHERE period = $1 ORDER BY txn_date, source_record_id",
      [period]
    );
    return rows;
  });
}

async function countByPeriod(tenantId, period) {
  return withTenant(tenantId, async (c) => {
    const { rows } = await c.query(
      "SELECT count(*)::int AS n FROM financial_transaction WHERE period = $1", [period]);
    return rows[0].n;
  });
}

/** Currencies present in a period — the input to multi-currency handling. */
async function currenciesInPeriod(tenantId, period) {
  return withTenant(tenantId, async (c) => {
    const { rows } = await c.query(
      "SELECT DISTINCT currency FROM financial_transaction WHERE period = $1 ORDER BY currency", [period]);
    return rows.map((r) => r.currency);
  });
}

/* ═══════════════════════════════════════════════════════════════
   THE READ PATH — resolving stored records back into domain shape.

   JOB 11 recovered scores, metrics, findings and evidence. It did NOT recover
   the RECORDS those findings cite, so a recovered finding could say "these two
   payments are duplicates" and nothing could show which two. `findByPeriod` and
   its siblings existed with no production caller, exactly like the analysis
   read path before it.

   Everything here is tenant-scoped through withTenant(), which is what applies
   the RLS setting. A source_record_id from another tenant therefore resolves to
   nothing — not to an error that would confirm it exists.
   ═══════════════════════════════════════════════════════════════ */

/** Postgres numeric arrives as a string. Null stays null, never 0. */
function num(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * A stored row, back in the normalized shape ingestion produced.
 *
 * The inverse of `toParams`. Field names match what the domain and the
 * capabilities already consume, so a recovered record is indistinguishable from
 * a freshly ingested one — except that it is real, and was not re-derived.
 */
/**
 * A `date` column back to the ISO day it actually holds.
 *
 * `pg` parses a DATE into a JS Date at LOCAL midnight, so `toISOString()`
 * re-reads it in UTC and shifts it a day backwards anywhere east of Greenwich
 * — including Nairobi, where every deployment is. A payment stored as
 * 2026-05-04 came back as 2026-05-03 and was shown to the user as evidence for
 * a finding that named the 4th. The calendar day is the fact; it must be read
 * from the components the parser set, not re-projected through a timezone.
 */
function toIsoDay(value) {
  if (value == null) return null;
  if (!(value instanceof Date)) return String(value).slice(0, 10);
  const pad = (n) => String(n).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

function toDomainRecord(row) {
  return Object.freeze({
    // PROVENANCE FIRST. These two are what evidence cites, and what makes a
    // recovered record traceable to the file or API it came from.
    sourceSystem: row.source_system,
    sourceRecordId: row.source_record_id,
    period: (row.period || "").trim(),
    recordType: row.txn_type,
    txnType: row.txn_type,
    // `date` as an ISO day, matching the ingestion contract rather than a
    // Date object whose serialization would drift by timezone.
    date: toIsoDay(row.txn_date),
    amount: num(row.amount),
    currency: row.currency ? String(row.currency).trim() : null,
    baseAmount: num(row.base_amount),
    baseCurrency: row.base_currency ? String(row.base_currency).trim() : null,
    exchangeRate: num(row.exchange_rate),
    direction: row.direction,
    // Null means "we do not know who this was" and must stay null — an
    // unattributed record must never acquire a counterparty on the way back.
    counterparty: row.counterparty_name,
    counterpartyName: row.counterparty_name,
    description: row.description,
    reference: row.reference,
    hasReceipt: row.has_receipt,
    isReconciled: row.is_reconciled,
    dueDate: toIsoDay(row.due_date),
    balance: num(row.balance),
    account: row.account_id || null,
    sourceUpdatedAt: row.source_updated_at,
    ingestedAt: row.ingested_at,
    // Provenance marker, mirroring `recovered` on an analysis run.
    recovered: true
  });
}

/** Every stored record for a period, in domain shape. */
async function recordsForPeriod(tenantId, period, { limit = 5000 } = {}) {
  return withTenant(tenantId, async (c) => {
    const { rows } = await c.query(
      `SELECT * FROM financial_transaction
        WHERE period = $1 ORDER BY txn_date, source_record_id LIMIT $2`,
      [period, limit]
    );
    return rows.map(toDomainRecord);
  });
}

/**
 * Resolve specific records by the key evidence cites.
 *
 * THE DISTINCTION THAT MATTERS. A citation that resolves to nothing is NOT the
 * same as a finding with no evidence. The caller is told which references were
 * found and which were not, so a missing record is reported as missing rather
 * than silently becoming an empty list — an empty list reads as "there were no
 * such transactions", which about a duplicate-payment finding is a false
 * statement about the business's books.
 *
 * @param refs [{ sourceSystem, sourceRecordId }]
 * @returns {object} { records, found, missing }
 */
async function resolveRecords(tenantId, refs = []) {
  const wanted = (refs || [])
    .filter((r) => r && r.sourceRecordId)
    .map((r) => ({
      sourceSystem: r.sourceSystem || null,
      sourceRecordId: String(r.sourceRecordId)
    }));
  if (!wanted.length) return { records: [], found: [], missing: [] };

  return withTenant(tenantId, async (c) => {
    /* Matched on the unique key (tenant, source_system, source_record_id).
       source_system is allowed to be unspecified on the citation side, in which
       case the record id alone identifies it — ids are content hashes and
       already carry their system as a prefix. */
    const { rows } = await c.query(
      `SELECT * FROM financial_transaction
        WHERE source_record_id = ANY($1::text[])
          AND ($2::text[] IS NULL OR source_system = ANY($2::text[]))
        ORDER BY txn_date, source_record_id`,
      [
        wanted.map((w) => w.sourceRecordId),
        wanted.every((w) => w.sourceSystem)
          ? Array.from(new Set(wanted.map((w) => w.sourceSystem)))
          : null
      ]
    );

    const records = rows.map(toDomainRecord);
    const foundIds = new Set(records.map((r) => r.sourceRecordId));
    return {
      records,
      found: Array.from(foundIds),
      // Reported explicitly. A caller that ignores this and renders `records`
      // as the whole answer is the failure mode; naming the gap makes it
      // possible to say "this evidence could not be resolved".
      missing: wanted
        .map((w) => w.sourceRecordId)
        .filter((id) => !foundIds.has(id))
    };
  });
}

/** One record, or null. Tenant-scoped: another tenant's id is simply not found. */
async function findBySourceRecordId(tenantId, sourceRecordId, sourceSystem = null) {
  return withTenant(tenantId, async (c) => {
    const { rows } = await c.query(
      `SELECT * FROM financial_transaction
        WHERE source_record_id = $1
          AND ($2::text IS NULL OR source_system = $2)
        LIMIT 1`,
      [String(sourceRecordId), sourceSystem]
    );
    return rows.length ? toDomainRecord(rows[0]) : null;
  });
}

module.exports = {
  upsertMany, findByPeriod, countByPeriod, currenciesInPeriod,
  // JOB 12 read path.
  recordsForPeriod, resolveRecords, findBySourceRecordId, toDomainRecord
};
