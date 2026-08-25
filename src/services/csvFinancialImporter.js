const crypto = require("crypto");
const { parse } = require("csv-parse/sync");

const HEADER_ALIASES = {
  date: ["date", "transaction date", "posted date", "value date", "trans date"],
  description: ["description", "narrative", "memo", "details", "particulars", "reference"],
  amount: ["amount", "value", "transaction amount"],
  debit: ["debit", "withdrawal", "money out", "debit amount", "out"],
  credit: ["credit", "deposit", "money in", "credit amount", "in"],
  counterparty: ["counterparty", "payee", "vendor", "customer", "name", "third party", "paid to", "received from"],
  // JOB 7: currency now SURVIVES ingestion. It was dropped entirely, so every
  // uploaded row arrived unlabelled and the engine could not tell a KES total
  // from a mixed-currency one.
  currency: ["currency", "currency code", "ccy", "curr"],
  account: ["account", "account name", "bank account"]
};

function normalizeHeader(value) {
  return String(value || "").trim().toLowerCase();
}

function buildHeaderMap(headers) {
  const normalized = headers.map(normalizeHeader);
  const map = {};
  Object.entries(HEADER_ALIASES).forEach(([field, aliases]) => {
    for (const alias of aliases) {
      const idx = normalized.indexOf(alias);
      if (idx !== -1) {
        map[field] = headers[idx];
        return;
      }
    }
  });
  return map;
}

function toNumber(rawValue) {
  if (rawValue == null || rawValue === "") return 0;
  let text = String(rawValue).trim();
  let negative = false;

  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }

  text = text.replace(/[^0-9.\-]/g, "");
  if (text.startsWith("-")) {
    negative = true;
    text = text.slice(1);
  }
  if (!text) return 0;

  const num = Number(text);
  if (!Number.isFinite(num)) return 0;
  return negative ? -num : num;
}

function normalizeDate(rawValue) {
  const text = String(rawValue || "").trim();
  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return null;
}

/**
 * Parses a bank/accounting CSV export into the same monthlyData shape the
 * risk engine already consumes from Zoho, so uploaded files run through the
 * identical analysis pipeline.
 */
function parseFinancialCsv({ csvText, period, businessName, currentCashBalance }) {
  let records;
  try {
    records = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true
    });
  } catch (error) {
    throw new Error(`Could not read the CSV file: ${error.message}`);
  }

  if (!records.length) {
    throw new Error("The CSV file has no data rows.");
  }

  const headers = Object.keys(records[0]);
  const map = buildHeaderMap(headers);

  if (!map.date) {
    throw new Error("Couldn't find a date column. Include a column named something like \"Date\".");
  }
  if (!map.amount && !map.debit && !map.credit) {
    throw new Error("Couldn't find an amount column. Include \"Amount\", or separate \"Debit\"/\"Credit\" columns.");
  }

  const skipped = [];
  /**
   * CSV PROVENANCE (JOB 5).
   *
   * A CSV has no natural primary key, but a finding must still be able to cite
   * the record that produced it. The id is therefore derived from the row's
   * CONTENT — date, amount, description, counterparty, account — hashed with the
   * period.
   *
   * Why content and not array position: rows can be re-exported in a different
   * order, so a positional id would point at a DIFFERENT transaction on the next
   * upload, silently re-attributing findings. A content hash is stable across
   * reordering and identical across re-uploads of the same file, which is also
   * what makes re-ingestion idempotent (the DB unique key is
   * (tenant, source_system, source_record_id)).
   *
   * Genuinely identical rows (same date, amount, description, counterparty) are
   * a real possibility — a true duplicate payment. An occurrence index is
   * appended so each physical row keeps its own identity while remaining
   * deterministic for a given file.
   */
  const seenRowKeys = new Map();
  function csvSourceRecordId(period, row) {
    const basis = [
      period,
      row.date || "",
      String(row.amount),
      row.description || "",
      row.counterparty || "",
      row.account || ""
    ].join("|");
    const hash = crypto.createHash("sha256").update(basis).digest("hex").slice(0, 16);
    const occurrence = (seenRowKeys.get(hash) || 0) + 1;
    seenRowKeys.set(hash, occurrence);
    return occurrence === 1 ? `csv:${hash}` : `csv:${hash}:${occurrence}`;
  }

  const transactions = [];

  records.forEach((row, index) => {
    const date = normalizeDate(row[map.date]);
    let amount;
    if (map.amount) {
      amount = toNumber(row[map.amount]);
    } else {
      const debit = map.debit ? Math.abs(toNumber(row[map.debit])) : 0;
      const credit = map.credit ? Math.abs(toNumber(row[map.credit])) : 0;
      amount = credit - debit;
    }

    if (!date || amount === 0) {
      skipped.push(index + 2); // +2: header row + 1-indexing
      return;
    }

    const normalized = {
      date,
      account: map.account ? (row[map.account] || "Main Bank") : "Main Bank",
      amount,
      description: map.description ? (row[map.description] || "") : "",
      // JOB 7: an unattributed row stays UNATTRIBUTED. This previously became a
      // counterparty literally named "Unmapped", which the concentration
      // calculator then treated as a real vendor — the same fabricated-party
      // pattern the audit found in buildCustomerSummary. Null means "we do not
      // know who this was", and the engine reports it as unattributed rather
      // than inventing a relationship.
      counterparty: (map.counterparty && String(row[map.counterparty] || "").trim())
        ? String(row[map.counterparty]).trim()
        : null,
      // Preserved verbatim, never defaulted. A row with no currency column is
      // UNLABELLED, which the engine treats differently from a declared one.
      currency: map.currency && row[map.currency]
        ? String(row[map.currency]).trim().toUpperCase().slice(0, 3)
        : null,
      // EXPLICIT DIRECTION (JOB 7 bug fix).
      //
      // This importer follows the BANK-STATEMENT convention: a credit (money
      // arriving) is positive, a debit is negative — see the inflow/outflow sums
      // below, which have always read it that way.
      //
      // The engine's fallback, used for records that state no direction, is the
      // OPPOSITE: it treats a positive amount as an outflow. The two conventions
      // silently disagreed, so for every CSV upload the vendor-concentration
      // metric was computed over customers and the customer metric over vendors.
      //
      // The fix is not to pick a winner but to stop inferring: the source knows
      // its own convention, so it states it, and the engine never has to guess.
      direction: amount > 0 ? "inflow" : "outflow"
    };
    transactions.push(Object.assign({
      // Provenance: every normalized record must be citable by a finding.
      sourceSystem: "csv-upload",
      sourceRecordId: csvSourceRecordId(period, normalized),
      recordType: "other"
    }, normalized));
  });

  if (!transactions.length) {
    throw new Error("No usable rows found — check that the date and amount columns contain valid values.");
  }

  const inflow = transactions.filter((t) => t.amount > 0).reduce((sum, t) => sum + t.amount, 0);
  const outflow = Math.abs(transactions.filter((t) => t.amount < 0).reduce((sum, t) => sum + t.amount, 0));
  const netIncome = inflow - outflow;
  /* CASH BALANCE: OBSERVED OR DERIVED — and the difference is recorded.
   *
   * THE DEFECT. When the uploader supplies no cash balance, this falls back to
   * `Math.max(0, netIncome)` and writes it into the balance sheet
   * INDISTINGUISHABLY from a figure the user actually gave us. Two things go
   * wrong. The cash-runway calculation then treats a guess as an observation.
   * And for a period with more outflow than inflow the derivation clamps to
   * ZERO — so a business that never told us its balance is recorded as having
   * no cash at all, which is a statement about their solvency that nobody made.
   *
   * The fallback is kept (removing it would change every existing analysis),
   * but its PROVENANCE now travels with it, so a consumer can tell an observed
   * balance from a derived one and a persisted run can record which it was. */
  const cashProvided = currentCashBalance != null && currentCashBalance !== ""
    && Number.isFinite(toNumber(currentCashBalance));
  const cashAndEquivalents = cashProvided
    ? toNumber(currentCashBalance)
    : Math.max(0, netIncome);

  return {
    company: { name: businessName || "Uploaded Business", country: "" },
    period: period || null,
    transactions,
    journalEntries: [],
    reconciliations: [],
    statements: {
      cashFlow: { inflow: Math.round(inflow), outflow: Math.round(outflow) },
      profitAndLoss: { netIncome: Math.round(netIncome) },
      balanceSheet: {
        cashAndEquivalents: Math.round(cashAndEquivalents),
        /* THE BASIS TRAVELS WITH THE FIGURE, into the domain.
           The engine must be able to tell an observed cash position from an
           estimate inferred from net income, because the two are not
           interchangeable for a runway calculation. Carrying it here (rather
           than only in meta) means the calculator sees it without ingestion
           having to reach into the engine, and without the engine learning
           anything about where data came from. */
        cashAndEquivalentsBasis: cashProvided ? "observed" : "derived_from_net_income"
      }
    },
    meta: {
      source: "csv-upload",
      rowCount: transactions.length,
      skippedRows: skipped.length,
      importedAt: new Date().toISOString(),
      /* THE PROVENANCE OF THE CASH BALANCE. "observed" means the uploader gave
         us the figure; "derived_from_net_income" means we inferred it and the
         value is an estimate, not a measurement. Persisted with the run so a
         recovered analysis still knows which it was -- a derived figure must
         never come back looking like an observed one. */
      cashBalance: {
        basis: cashProvided ? "observed" : "derived_from_net_income",
        providedValue: cashProvided ? toNumber(currentCashBalance) : null,
        value: Math.round(cashAndEquivalents)
      }
    }
  };
}

module.exports = { parseFinancialCsv };
