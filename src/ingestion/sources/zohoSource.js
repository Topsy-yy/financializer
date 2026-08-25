// THE authoritative Zoho Books source.
//
// Collapses the responsibilities previously split between zohoClient.js (mock
// generation + a second normalizer) and zohoBooksClient.js (transport + a first
// normalizer). Transport now lives in zohoTransport.js; this module does
// fetching, validation and normalization, and reports per-dataset outcomes.
//
// Key behavioural changes vs the audited implementation:
//   * NO `.catch(() => [])`. A dataset that fails to load is recorded as FAILED
//     and named in the quality report — never silently rendered as "none".
//   * Datasets are fetched independently (allSettled), so one outage does not
//     void the whole sync, and the caller learns exactly what is missing.
//   * Statements are RETRIEVED from Zoho's report endpoints; when a report is
//     unavailable the locally-derived figures are marked `is_derived: true`
//     rather than being presented as retrieved.
//   * Source record ids, source timestamps and per-record currency survive
//     normalization (previously invoice_id was folded into a display string and
//     currency was dropped entirely).
//   * Pagination truncation is surfaced, not silent.

const { createZohoTransport } = require("./zohoTransport");
const { periodRange } = require("../period");

const SOURCE_SYSTEM = "zoho-books";

function toNumber(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function within(dateStr, start, end) {
  if (!dateStr) return false;
  const d = String(dateStr).slice(0, 10);
  return d >= start && d <= end;
}

/**
 * Zoho reports the reconciliation workflow state in `status`. "uncategorized"
 * is the only state meaning nobody has reviewed the line yet.
 * Preserved from the audited implementation.
 */
function isReconciled(tx) {
  return String(tx.status || "").toLowerCase() !== "uncategorized";
}

/** Datasets this source expects to retrieve. */
const DATASETS = Object.freeze([
  "invoices", "bills", "expenses", "bankaccounts", "banktransactions",
  "statements.cashFlow", "statements.profitAndLoss", "statements.balanceSheet"
]);

/**
 * Fetch one dataset, converting any throw into a recorded outcome.
 * This replaces the old all-or-nothing Promise.all plus swallowing catch.
 */
async function attempt(name, fn) {
  try {
    const value = await fn();
    return { name, ok: true, value };
  } catch (err) {
    return { name, ok: false, error: err.message || String(err), code: err.code || null };
  }
}

/**
 * Retrieve Zoho's own statement reports. These endpoints are not available on
 * every plan/scope, so failure is expected and handled — but never hidden.
 */
async function fetchStatements(transport, start, end) {
  const params = { from_date: start, to_date: end };
  return {
    /* `/reports/cashflowstatement` DOES NOT EXIST. Zoho answers it with a 404
       and the message "We couldnt find any resource for the given ID", which
       reads like a bad organization_id and is not — the same org id works on
       the two reports below. The endpoint is `/reports/cashflow`. Verified
       against the live API: cashflowstatement 404s, cashflow returns
       { code, message, cash_flow, page_context }. */
    cashFlow: await attempt("statements.cashFlow", () => transport.request("/reports/cashflow", params)),
    profitAndLoss: await attempt("statements.profitAndLoss", () => transport.request("/reports/profitandloss", params)),
    balanceSheet: await attempt("statements.balanceSheet", () => transport.request("/reports/balancesheet", params))
  };
}

/* The keys Zoho actually wraps each report in. The payload is NOT
   `{sections: […]}` — it is `{code, message, <report_key>: […], page_context}`,
   where the report body is an ARRAY of sections, each `{name, total, …}` and
   optionally nesting more sections under `account_transactions`. */
const REPORT_BODY_KEYS = ["cash_flow", "profit_and_loss", "balance_sheet",
  "sections", "report", "data"];

function normalizeName(value) {
  return String(value == null ? "" : value).toLowerCase().replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

/**
 * Zoho report payloads vary by account configuration. Extract conservatively:
 * return null when a figure cannot be located rather than guessing zero.
 *
 * WHY THIS WAS REWRITTEN. It looked for `report.sections | report.report |
 * report.data` — none of which Zoho sends. Every lookup therefore returned
 * null, and every statement fell through to the "derive it from transactions"
 * path. The reports were being fetched, parsed, and thrown away: an account
 * whose books say Net Profit 115,000 had that figure recomputed locally
 * instead of read. Nothing was WRONG on screen, but nothing was authoritative
 * either, and the disclosure said "derived" for figures Zoho had supplied.
 *
 * Sections are matched on their NAME as well as on flat keys, because that is
 * how Zoho labels the figures. Names are normalized ("Net Profit/Loss" ->
 * `net_profit_loss`) so punctuation and casing cannot break the match. A name
 * that is not found still returns null — a mislabelled account must not
 * silently borrow another section's number.
 */
function readReportTotal(report, keys) {
  if (!report || typeof report !== "object") return null;
  const wanted = new Set(keys.map(normalizeName));

  // 1. A flat key on the envelope itself.
  for (const key of keys) {
    const direct = report[key];
    if (direct != null && Number.isFinite(Number(direct))) return Number(direct);
  }

  // 2. The report body, wherever Zoho put it.
  let body = null;
  for (const k of REPORT_BODY_KEYS) {
    if (Array.isArray(report[k])) { body = report[k]; break; }
  }
  if (!body) return null;

  // 3. Walk the section tree, matching on section name or on a flat key.
  const stack = [...body];
  let guard = 0;
  while (stack.length && guard++ < 500) {
    const section = stack.shift();
    if (!section || typeof section !== "object") continue;

    if (wanted.has(normalizeName(section.name))
      || wanted.has(normalizeName(section.total_label))) {
      const total = Number(section.total);
      if (Number.isFinite(total)) return total;
    }
    for (const key of keys) {
      const v = section[key] ?? (section.total && typeof section.total === "object"
        ? section.total[key] : undefined);
      if (v != null && Number.isFinite(Number(v))) return Number(v);
    }
    if (Array.isArray(section.account_transactions)) stack.push(...section.account_transactions);
    if (Array.isArray(section.sections)) stack.push(...section.sections);
  }
  return null;
}

function normalizeTransactions({ invoices, bills, expenses, bankTransactions }, start, end, baseCurrency) {
  const rows = [];

  invoices.filter((i) => within(i.date, start, end)).forEach((inv) => {
    rows.push({
      sourceSystem: SOURCE_SYSTEM,
      sourceRecordId: String(inv.invoice_id || inv.invoice_number),
      sourceUpdatedAt: inv.last_modified_time || null,
      txnType: "invoice",
      date: inv.date,
      // Negative = inflow, matching the engine's direction convention.
      // Negate for inflow, but never produce -0.
      amount: toNumber(inv.total) === 0 ? 0 : -Math.abs(toNumber(inv.total)),
      currency: inv.currency_code || baseCurrency,
      exchangeRate: inv.exchange_rate == null ? null : toNumber(inv.exchange_rate, null),
      counterparty: inv.customer_name || null,
      description: `Invoice ${inv.invoice_number || inv.invoice_id || ""}`.trim(),
      reference: inv.reference_number || inv.invoice_number || null,
      balance: toNumber(inv.balance),
      dueDate: inv.due_date || null,
      status: inv.status || null
    });
  });

  bills.filter((b) => within(b.date, start, end)).forEach((bill) => {
    rows.push({
      sourceSystem: SOURCE_SYSTEM,
      sourceRecordId: String(bill.bill_id || bill.bill_number),
      sourceUpdatedAt: bill.last_modified_time || null,
      txnType: "bill",
      date: bill.date,
      amount: Math.abs(toNumber(bill.total)),
      currency: bill.currency_code || baseCurrency,
      exchangeRate: bill.exchange_rate == null ? null : toNumber(bill.exchange_rate, null),
      counterparty: bill.vendor_name || null,
      description: `Bill ${bill.bill_number || bill.bill_id || ""}`.trim(),
      reference: bill.reference_number || bill.bill_number || null,
      balance: toNumber(bill.balance),
      dueDate: bill.due_date || null,
      status: bill.status || null
    });
  });

  expenses.filter((e) => within(e.date, start, end)).forEach((exp) => {
    rows.push({
      sourceSystem: SOURCE_SYSTEM,
      sourceRecordId: String(exp.expense_id),
      sourceUpdatedAt: exp.last_modified_time || null,
      txnType: "expense",
      date: exp.date,
      amount: Math.abs(toNumber(exp.total ?? exp.amount)),
      currency: exp.currency_code || baseCurrency,
      exchangeRate: exp.exchange_rate == null ? null : toNumber(exp.exchange_rate, null),
      counterparty: exp.vendor_name || exp.account_name || null,
      description: exp.description || exp.account_name || "Expense",
      reference: exp.reference_number || null,
      // Only Zoho expenses report receipt presence; other sources leave it
      // undefined so "unknown" stays distinguishable from "absent".
      hasReceipt: exp.has_attachment === true ? true : exp.has_attachment === false ? false : undefined
    });
  });

  bankTransactions.filter((t) => within(t.date, start, end)).forEach((tx) => {
    rows.push({
      sourceSystem: SOURCE_SYSTEM,
      sourceRecordId: String(tx.transaction_id),
      sourceUpdatedAt: tx.last_modified_time || null,
      txnType: "bank_transaction",
      date: tx.date,
      amount: toNumber(tx.amount),
      currency: tx.currency_code || baseCurrency,
      counterparty: tx.payee || tx.description || null,
      description: tx.description || tx.reference_number || "Bank transaction",
      reference: tx.reference_number || null,
      account: tx.account_name || null,
      isReconciled: isReconciled(tx)
    });
  });

  return rows;
}

/**
 * Fetch and normalize one accounting period.
 *
 * Returns the normalized dataset PLUS the per-dataset outcomes, so the caller
 * (src/ingestion) can build an honest DataQualityReport. This function never
 * throws for a partial failure — it throws only when authentication itself
 * fails, because that means nothing at all could be retrieved.
 */
async function fetchPeriod(profile, periodValue, opts = {}) {
  const { period, start, end } = periodRange(periodValue);
  const transport = opts.transport || createZohoTransport(profile, opts);

  // Auth first: without it nothing is retrievable, so this is a hard failure.
  await transport.ensureFreshToken();
  await transport.resolveOrganizationId();

  const dateParams = { date_start: start, date_end: end };
  const baseCurrency = profile.zohoBaseCurrency || opts.baseCurrency || null;

  // Independent attempts — one failure no longer voids the sync.
  const [invoices, bills, expenses, bankAccounts, bankTransactions] = await Promise.all([
    attempt("invoices", () => transport.paginate("/invoices", "invoices", dateParams)),
    attempt("bills", () => transport.paginate("/bills", "bills", dateParams)),
    attempt("expenses", () => transport.paginate("/expenses", "expenses", dateParams)),
    attempt("bankaccounts", () => transport.request("/bankaccounts", {}).then((d) => ({ items: d.bankaccounts || [], truncated: false }))),
    attempt("banktransactions", () => transport.paginate("/banktransactions", "banktransactions", dateParams))
  ]);

  const statements = await fetchStatements(transport, start, end);

  const outcomes = [invoices, bills, expenses, bankAccounts, bankTransactions,
    statements.cashFlow, statements.profitAndLoss, statements.balanceSheet];
  const failures = outcomes.filter((o) => !o.ok).map((o) => ({ dataset: o.name, message: o.error, code: o.code }));
  const truncated = outcomes.filter((o) => o.ok && o.value && o.value.truncated).map((o) => o.name);

  const list = (o) => (o.ok && o.value ? o.value.items || [] : []);

  const transactions = normalizeTransactions({
    invoices: list(invoices),
    bills: list(bills),
    expenses: list(expenses),
    bankTransactions: list(bankTransactions)
  }, start, end, baseCurrency);

  // Reconciliations come from bank transactions. If that dataset FAILED we must
  // not emit [] — the caller marks it missing so it cannot read as "reconciled".
  const reconciliations = bankTransactions.ok
    ? list(bankTransactions).filter((t) => within(t.date, start, end)).map((t) => ({
      sourceSystem: SOURCE_SYSTEM,
      sourceRecordId: String(t.transaction_id),
      accountName: t.account_name || "Bank Account",
      date: t.date,
      amount: toNumber(t.amount),
      currency: t.currency_code || baseCurrency,
      isReconciled: isReconciled(t)
    }))
    : undefined; // undefined => "not retrieved", distinct from [] => "none exist"

  /* ── Statements: retrieved where possible, explicitly derived otherwise ──
     The names below are the SECTION LABELS Zoho returns, alongside the flat
     API keys that some plans emit instead. Both are tried; neither is assumed.

     Zoho's Cash Flow report states Beginning / Net Change / Ending balance —
     it does NOT break the period into gross inflow and outflow. Those two stay
     derived from the transactions, which is honest and is disclosed as such;
     inventing a split from a net figure would be a fabrication. What the report
     DOES give authoritatively is the closing cash position, which is worth
     far more than the inflow/outflow split and had never been read. */
  const inflowRetrieved = readReportTotal(statements.cashFlow.value,
    ["cash_inflow", "total_inflow", "inflow"]);
  const outflowRetrieved = readReportTotal(statements.cashFlow.value,
    ["cash_outflow", "total_outflow", "outflow"]);
  const endingCashRetrieved = readReportTotal(statements.cashFlow.value,
    ["ending_cash_balance", "closing_balance", "ending_balance"]);

  const revenueRetrieved = readReportTotal(statements.profitAndLoss.value,
    ["total_income", "gross_revenue", "revenue", "operating_income", "gross_profit"]);
  const netRetrieved = readReportTotal(statements.profitAndLoss.value,
    ["net_profit", "net_income", "net_profit_loss"]);

  /* Cash on the balance sheet, else the cash-flow report's own closing
     position. Both are OBSERVED figures from the books — unlike summing bank
     account balances, which is a derivation. */
  const cashRetrieved = readReportTotal(statements.balanceSheet.value,
    ["cash_and_equivalents", "total_cash", "cash_and_cash_equivalents"])
    ?? endingCashRetrieved;

  const derivedInflow = transactions.filter((t) => t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0);
  const derivedOutflow = transactions.filter((t) => t.amount > 0 && t.txnType !== "bank_transaction")
    .reduce((s, t) => s + t.amount, 0);
  const derivedCash = list(bankAccounts).reduce((s, a) => s + toNumber(a.balance ?? a.bcy_balance), 0);

  const cashFlowDerived = inflowRetrieved == null || outflowRetrieved == null;
  const plDerived = revenueRetrieved == null;
  const bsDerived = cashRetrieved == null;

  // A derived statement is only meaningful if there was something to derive it
  // from. With zero transactions, emitting {inflow: 0, outflow: 0} would assert
  // "this month had no money movement" when the truth is "we have no evidence".
  const nothingToDeriveFrom = transactions.length === 0;
  const emitStatement = (isDerived, value) => (isDerived && nothingToDeriveFrom ? undefined : value);

  const built = {
    period,
    currency: baseCurrency,
    transactions,
    // journalEntries are not retrieved by this source; `undefined` says
    // "not retrieved" rather than the old hardcoded [] meaning "none exist".
    journalEntries: undefined,
    reconciliations,
    statements: {
      cashFlow: emitStatement(cashFlowDerived, {
        inflow: cashFlowDerived ? derivedInflow : inflowRetrieved,
        outflow: cashFlowDerived ? derivedOutflow : outflowRetrieved,
        is_derived: cashFlowDerived
      }),
      profitAndLoss: emitStatement(plDerived, {
        revenue: plDerived ? derivedInflow : revenueRetrieved,
        netIncome: netRetrieved != null ? netRetrieved : derivedInflow - derivedOutflow,
        is_derived: plDerived
      }),
      // The balance sheet derives from bank ACCOUNTS, not transactions, so it
      // is emitted whenever any account balance was retrieved.
      balanceSheet: (bsDerived && list(bankAccounts).length === 0) ? undefined : {
        cashAndEquivalents: bsDerived ? derivedCash : cashRetrieved,
        is_derived: bsDerived,
        /* LABELLED EXPLICITLY. cashPosition.readCashPosition() defaults an
           unlabelled figure to "observed" on the stated assumption that every
           source which derives a value says so — and this source said nothing
           at all. The label is OBSERVED either way here, and deliberately:
           when the reports carry the figure it is read from the books, and
           when they do not it is the SUM OF REAL BANK ACCOUNT BALANCES, which
           is an aggregation of observed values rather than an inference. That
           is categorically different from `derived_from_net_income`, which
           guesses a cash position from profit. Only emitted when at least one
           account was actually retrieved (see the guard above), so this can
           never be a 0 standing in for "we found nothing". */
        cashAndEquivalentsBasis: "observed"
      }
    },
    receivables: invoices.ok
      ? list(invoices).filter((i) => toNumber(i.balance) > 0).map((i) => ({
        sourceSystem: SOURCE_SYSTEM,
        sourceRecordId: String(i.invoice_id || i.invoice_number),
        customer: i.customer_name || null,
        amount: toNumber(i.total),
        balance: toNumber(i.balance),
        currency: i.currency_code || baseCurrency,
        dueDate: i.due_date || null
      }))
      : undefined,
    payables: bills.ok
      ? list(bills).filter((b) => toNumber(b.balance) > 0).map((b) => ({
        sourceSystem: SOURCE_SYSTEM,
        sourceRecordId: String(b.bill_id || b.bill_number),
        vendor: b.vendor_name || null,
        amount: toNumber(b.total),
        balance: toNumber(b.balance),
        currency: b.currency_code || baseCurrency,
        dueDate: b.due_date || null
      }))
      : undefined,
    meta: {
      source: SOURCE_SYSTEM,
      fetchedAt: new Date(opts.now == null ? Date.now() : opts.now).toISOString(),
      organizationId: profile.zohoOrgId || null,
      counts: {
        invoices: list(invoices).length,
        bills: list(bills).length,
        expenses: list(expenses).length,
        bankAccounts: list(bankAccounts).length,
        bankTransactions: list(bankTransactions).length
      },
      statementsDerived: { cashFlow: cashFlowDerived, profitAndLoss: plDerived, balanceSheet: bsDerived },
      truncatedDatasets: truncated,
      currencies: Array.from(new Set(transactions.map((t) => t.currency).filter(Boolean))).sort()
    }
  };

  return { data: built, failures, truncated, datasets: DATASETS };
}

/** Factory matching the `{ fetch(period) }` shape ingestPeriod() expects. */
function createZohoSource(profile, opts = {}) {
  return {
    system: SOURCE_SYSTEM,
    async fetchWithOutcomes(period) { return fetchPeriod(profile, period, opts); },
    async fetch(period) { return (await fetchPeriod(profile, period, opts)).data; }
  };
}

module.exports = { createZohoSource, fetchPeriod, SOURCE_SYSTEM, DATASETS, isReconciled };
