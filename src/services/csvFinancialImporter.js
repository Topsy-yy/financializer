const { parse } = require("csv-parse/sync");

const HEADER_ALIASES = {
  date: ["date", "transaction date", "posted date", "value date", "trans date"],
  description: ["description", "narrative", "memo", "details", "particulars", "reference"],
  amount: ["amount", "value", "transaction amount"],
  debit: ["debit", "withdrawal", "money out", "debit amount", "out"],
  credit: ["credit", "deposit", "money in", "credit amount", "in"],
  counterparty: ["counterparty", "payee", "vendor", "customer", "name", "third party", "paid to", "received from"],
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

    transactions.push({
      date,
      account: map.account ? (row[map.account] || "Main Bank") : "Main Bank",
      amount,
      description: map.description ? (row[map.description] || "") : "",
      counterparty: map.counterparty ? (row[map.counterparty] || "Unmapped") : "Unmapped"
    });
  });

  if (!transactions.length) {
    throw new Error("No usable rows found — check that the date and amount columns contain valid values.");
  }

  const inflow = transactions.filter((t) => t.amount > 0).reduce((sum, t) => sum + t.amount, 0);
  const outflow = Math.abs(transactions.filter((t) => t.amount < 0).reduce((sum, t) => sum + t.amount, 0));
  const netIncome = inflow - outflow;
  const cashAndEquivalents = currentCashBalance != null && currentCashBalance !== ""
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
      balanceSheet: { cashAndEquivalents: Math.round(cashAndEquivalents) }
    },
    meta: {
      source: "csv-upload",
      rowCount: transactions.length,
      skippedRows: skipped.length,
      importedAt: new Date().toISOString()
    }
  };
}

module.exports = { parseFinancialCsv };
