// Deterministic detectors.
//
// A detector's ONLY job is to decide WHETHER a rule matched and to cite the
// records that made it match. It does not decide how severe the result is, how
// confident to be, or what threshold to use — all three come from the
// authoritative registry (src/domain/rules/registry.js) via resolveRule().
//
// Before JOB 7 each detector chose its own `severity: SEVERITY.HIGH` and its own
// `confidence: 0.4`, so two rules could rank the same strength of evidence
// differently and nothing would catch it. Those literals are gone: search this
// file for SEVERITY or a bare confidence number and you will not find one.
//
// PURE: no HTTP, no filesystem, no AI, no database.

const { createFinding, createEvidence, createMatchCriteria } = require("../model/finding");
const { getRule, resolveRule } = require("../rules/registry");
const { comparableAmounts, currencyKey } = require("../rules/currency");
const { num, fmt, recordIdOf: txId } = require("../calculators/shared");

function txEvidence(tx, index, label, relationship = null, field = null, value = undefined) {
  return createEvidence({
    label,
    sourceSystem: tx.sourceSystem || tx.source_system || null,
    sourceRecordId: txId(tx, index),
    recordType: tx.recordType || tx.txnType || "transaction",
    relationship,
    field,
    value,
    fields: {
      date: tx.date || null,
      amount: num(tx.amount),
      currency: tx.currency || null,
      counterparty: tx.counterparty || null,
      description: tx.description || null,
      account: tx.account || null
    }
  });
}

/**
 * Build a finding from a registry rule.
 *
 * Every detector goes through here, so a finding cannot exist without the rule
 * id, rule version, severity basis and confidence basis that produced it.
 */
function ruleFinding(ruleId, ctx, options) {
  const { observed, signals, ...rest } = options;
  const r = resolveRule(ruleId, { observed, signals });
  return createFinding(Object.assign({
    tenantId: ctx.tenantId,
    period: ctx.period,
    ruleId: r.ruleId,
    ruleVersion: r.ruleVersion,
    category: r.category,
    severity: r.severity,
    severityBasis: r.severityBasis,
    severityReason: r.severityReason,
    confidence: r.confidence,
    confidenceBasis: r.confidenceBasis,
    confidenceReason: r.confidenceReason,
    title: r.title,
    observedValue: observed
  }, rest));
}

/**
 * Duplicate payments.
 *
 * v3: CURRENCY is part of the match key. Two payments of "1000" in different
 * declared currencies are not the same payment, whatever the numbers say. When
 * a record declares no currency it falls back to comparing the number alone —
 * refusing there would lose genuine duplicates in CSV uploads, which carry no
 * currency at all. See domain/rules/currency.js for the policy.
 */
function detectDuplicates(transactions, ctx) {
  const rule = getRule("duplicate_payment");
  const groups = new Map();

  (transactions || []).forEach((tx, index) => {
    const counterparty = String(tx.counterparty || "").trim().toLowerCase();
    if (rule.params.requireCounterparty && !counterparty) return; // insufficient identity
    const date = String(tx.date || "").slice(0, 10);
    const amount = num(tx.amount);
    if (!date || !amount) return;
    const key = `${date}|${amount}|${counterparty}|${currencyKey(tx)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ tx, index });
  });

  const findings = [];
  groups.forEach((members, key) => {
    if (members.length < rule.evidence.minRecords) return;
    const first = members[0].tx;

    // Guard the undeclared-currency path: members grouped only because neither
    // side names a currency must still be comparable.
    if (!members.every((m) => comparableAmounts(m.tx, first))) return;

    // `currency` only counts as a matched field if every member declared one.
    const matched = rule.params.matchOn.filter(
      (f) => f !== "currency" || members.every((m) => currencyKey(m.tx)));
    // Corroborating attributes raise confidence — the registry decides by how much.
    rule.params.corroborating.forEach((field) => {
      if (first[field] && members.every((m) => (m.tx[field] || null) === (first[field] || null))) {
        matched.push(field);
      }
    });

    findings.push(ruleFinding("duplicate_payment", ctx, {
      observed: members.length,
      signals: { matchedFields: matched.length },
      description:
        `${members.length} transactions of ${fmt(first.amount)}${first.currency ? " " + first.currency : ""} `
        + `to ${first.counterparty} on ${String(first.date).slice(0, 10)} share the same date, amount and counterparty.`,
      metric: "matching_transactions",
      threshold: rule.evidence.minRecords,
      comparator: ">=",
      currency: first.currency || null,
      calculation:
        `Grouped transactions by (${rule.params.matchOn.join(", ")}); this group has `
        + `${members.length} members matching on: ${matched.join(", ")}.`,
      matchCriteria: createMatchCriteria(matched, "equals"),
      evidence: members.map((m, i) => txEvidence(
        m.tx, m.index, `Transaction ${i + 1} of ${members.length}`, "matched", "amount", num(m.tx.amount))),
      discriminator: key
    }));
  });
  return findings;
}

/**
 * Round-number payments at or above the period's MATERIALITY threshold.
 *
 * v3: the fixed `>= 10000` bar is gone. The threshold now comes from
 * domain/rules/materiality.js, which accounts for the currency the records are
 * in and the size of the business's own activity. `ctx.materiality` is resolved
 * once per run by the engine and passed in.
 */
function detectRoundNumbers(transactions, ctx) {
  // Each record is judged against the threshold for ITS OWN currency. A period
  // holding both KES and USD has no single significance bar.
  const resolve = ctx.materialityFor || (() => ctx.materiality);
  if (!ctx.materiality && !ctx.materialityFor) return []; // no threshold to judge against
  const findings = [];

  (transactions || []).forEach((tx, index) => {
    const materiality = resolve(tx.currency);
    if (!materiality) return;
    const amount = Math.abs(num(tx.amount));
    if (amount < materiality.significant) return;
    if (amount % materiality.roundNumberMultiple !== 0) return;

    findings.push(ruleFinding("round_number_payment", ctx, {
      observed: amount,
      signals: { multipleOfMateriality: amount / materiality.significant },
      description:
        `${fmt(amount)}${tx.currency ? " " + tx.currency : ""} paid to `
        + `${tx.counterparty || "an unnamed counterparty"} is an exact multiple of `
        + `${fmt(materiality.roundNumberMultiple)}.`,
      metric: "amount",
      threshold: materiality.significant,
      comparator: ">=",
      currency: tx.currency || materiality.currency || null,
      calculation:
        `amount ${fmt(amount)} >= materiality ${fmt(materiality.significant)} `
        + `AND amount % ${materiality.roundNumberMultiple} === 0. ${materiality.calculation}`,
      evidence: [txEvidence(tx, index, "Round-number payment", "exceeded_threshold", "amount", amount)],
      discriminator: `${index}`
    }));
  });
  return findings;
}

/**
 * Transactions more than N sigma above the mean.
 *
 * v2.1: the distribution is computed WITHIN A SINGLE CURRENCY. Mixing currencies
 * into one mean produced a meaningless threshold — a handful of USD amounts
 * among KES ones dragged the mean down and flagged ordinary KES payments.
 */
function detectOutliers(transactions, ctx) {
  const rule = getRule("statistical_outlier");
  const byCurrency = new Map();

  (transactions || []).forEach((tx, index) => {
    const amount = Math.abs(num(tx.amount));
    if (amount <= 0) return;
    const key = rule.params.perCurrency ? currencyKey(tx) : "";
    if (!byCurrency.has(key)) byCurrency.set(key, []);
    byCurrency.get(key).push({ tx, index, amount });
  });

  const findings = [];
  byCurrency.forEach((rows, key) => {
    if (rows.length < rule.params.minSampleSize) return;
    const mean = rows.reduce((s, r) => s + r.amount, 0) / rows.length;
    const variance = rows.reduce((s, r) => s + Math.pow(r.amount - mean, 2), 0) / rows.length;
    const sd = Math.sqrt(variance);
    if (sd === 0) return;
    const limit = mean + rule.params.sigma * sd;

    rows.filter((r) => r.amount > limit).forEach((r) => {
      findings.push(ruleFinding("statistical_outlier", ctx, {
        observed: r.amount,
        signals: { sampleSize: rows.length },
        description:
          `${fmt(r.amount)}${r.tx.currency ? " " + r.tx.currency : ""} to `
          + `${r.tx.counterparty || "an unnamed counterparty"} is well above the typical transaction this period.`,
        metric: "amount",
        threshold: Math.round(limit),
        comparator: ">",
        currency: r.tx.currency || null,
        calculation:
          `Within ${key || "the unlabelled currency basis"}: mean ${fmt(mean)} + `
          + `${rule.params.sigma} x sd ${fmt(sd)} = ${fmt(limit)}; this transaction is `
          + `${fmt(r.amount)} (n=${rows.length}).`,
        evidence: [txEvidence(r.tx, r.index, "Outlier transaction", "statistical_outlier", "amount", r.amount)],
        discriminator: `${r.index}`
      }));
    });
  });
  return findings;
}

/** Descriptions matching owner/personal keywords from the registry. */
function detectMixedFunds(transactions, ctx, ownerKeywords) {
  const rule = getRule("mixed_personal_business");
  // A tenant may extend the list; the registry list is the default and the
  // single definition shared with custom rules.
  const keywords = (ownerKeywords && ownerKeywords.length ? ownerKeywords : rule.params.keywords)
    .map((k) => String(k).toLowerCase());
  const findings = [];

  (transactions || []).forEach((tx, index) => {
    const haystack = `${tx.description || ""} ${tx.counterparty || ""}`.toLowerCase();
    const hit = keywords.find((k) => k && haystack.includes(k));
    if (!hit) return;
    findings.push(ruleFinding("mixed_personal_business", ctx, {
      observed: hit,
      description:
        `"${tx.description || tx.counterparty}" matches the keyword "${hit}", `
        + "which may indicate personal spending through the business.",
      metric: "keyword_match",
      threshold: null,
      currency: tx.currency || null,
      calculation: `Description/counterparty contains the owner keyword "${hit}".`,
      evidence: [txEvidence(tx, index, "Matching transaction", "keyword_match", "description", tx.description || null)],
      discriminator: `${index}`
    }));
  });
  return findings;
}

// ── Data-quality detectors ──────────────────────────────────────
// These describe the BOOKS, not the business. They are categorised as
// DATA_QUALITY / CONTROL_WEAKNESS and are excluded from business risk scoring.

function detectUnreconciled(reconciliations, ctx) {
  return (reconciliations || [])
    .map((r, index) => ({ r, index }))
    .filter(({ r }) => r.isReconciled === false)
    .map(({ r, index }) => ruleFinding("unreconciled_account", ctx, {
      observed: false,
      description: `${r.accountName || "An account"} has unreconciled bank activity.`,
      metric: "is_reconciled",
      threshold: true,
      calculation: "Bank transaction is not marked reconciled in the source system.",
      evidence: [createEvidence({
        label: "Unreconciled bank activity",
        sourceRecordId: r.sourceRecordId || r.id || `reconciliation:${index}`,
        recordType: "account",
        relationship: "matched",
        fields: { accountName: r.accountName || null, date: r.date || null, amount: num(r.amount) }
      })],
      discriminator: `${index}`
    }));
}

function detectMissingTransactionFields(transactions, ctx) {
  const rule = getRule("missing_transaction_fields");
  const findings = [];

  (transactions || []).forEach((tx, index) => {
    const missing = rule.params.required.filter((field) => {
      // A ZERO amount counts as missing: `amount == null` was false for 0, so a
      // transaction recorded with no value passed as complete (v3 fix).
      if (field === "amount") return !num(tx.amount);
      return !tx[field];
    });
    if (!missing.length) return;
    findings.push(ruleFinding("missing_transaction_fields", ctx, {
      observed: missing.join(","),
      description: `A transaction is missing: ${missing.join(", ")}.`,
      metric: "missing_fields",
      threshold: null,
      calculation: `Required fields absent: ${missing.join(", ")}.`,
      evidence: [txEvidence(tx, index, "Incomplete record", "missing_field", "missing", missing.join(","))],
      discriminator: `${index}`
    }));
  });
  return findings;
}

function detectMissingJournalReferences(journalEntries, ctx) {
  const rule = getRule("missing_journal_references");
  const findings = [];

  (journalEntries || []).forEach((je, index) => {
    const missing = rule.params.required.filter((field) => !je[field]);
    if (!missing.length) return;
    findings.push(ruleFinding("missing_journal_references", ctx, {
      observed: missing.join(","),
      description: `A journal entry is missing: ${missing.join(", ")}.`,
      metric: "missing_fields",
      threshold: null,
      calculation: `Journal entry lacks ${missing.join(" and ")}.`,
      evidence: [createEvidence({
        label: "Journal entry",
        sourceRecordId: je.sourceRecordId || je.id || `journal:${index}`,
        recordType: "journal_entry",
        relationship: "missing_field",
        fields: { date: je.date || null, amount: num(je.amount) }
      })],
      discriminator: `${index}`
    }));
  });
  return findings;
}

/** Missing receipts. See the registry rationale for the source asymmetry. */
function detectMissingReceipts(transactions, ctx) {
  const findings = [];
  (transactions || []).forEach((tx, index) => {
    if (tx.hasReceipt !== false) return;
    findings.push(ruleFinding("missing_receipt", ctx, {
      observed: false,
      description:
        `${fmt(tx.amount)}${tx.currency ? " " + tx.currency : ""} to `
        + `${tx.counterparty || "an unnamed counterparty"} has no attached receipt.`,
      metric: "has_receipt",
      threshold: true,
      currency: tx.currency || null,
      calculation: "Expense record reports no attached receipt.",
      evidence: [txEvidence(tx, index, "Expense without receipt", "missing_field", "hasReceipt", false)],
      discriminator: `${index}`
    }));
  });
  return findings;
}

/**
 * Overdue receivables/payables. `now` is injected so results are reproducible.
 * Only rows with an OUTSTANDING BALANCE are flagged.
 */
function detectOverdue(rows, ctx, kind) {
  const ruleId = kind === "receivable" ? "overdue_receivable" : "overdue_payable";
  const rule = getRule(ruleId);
  // Absent data is a data-quality matter, not "none overdue".
  if (!Array.isArray(rows)) return [];
  const now = ctx.now == null ? Date.now() : ctx.now;
  const findings = [];

  rows.forEach((row, index) => {
    const due = row.dueDate || row.due_date;
    if (!due) return;
    const dueTs = Date.parse(due);
    if (!Number.isFinite(dueTs) || dueTs >= now) return;
    const balance = row.balance != null ? num(row.balance) : num(row.amount);
    if (rule.params.requireOutstandingBalance && balance <= 0) return;

    const party = row.customer || row.vendor || "Counterparty";
    const daysOverdue = Math.floor((now - dueTs) / 86400000);
    findings.push(ruleFinding(ruleId, ctx, {
      observed: daysOverdue,
      description:
        `${party} has ${fmt(balance)}${row.currency ? " " + row.currency : ""} outstanding, `
        + `${daysOverdue} days past the due date.`,
      metric: "days_overdue",
      threshold: 0,
      comparator: ">",
      currency: row.currency || null,
      calculation: `Due ${String(due).slice(0, 10)}; outstanding balance ${fmt(balance)}.`,
      evidence: [createEvidence({
        label: kind === "receivable" ? "Overdue invoice" : "Overdue bill",
        sourceRecordId: row.sourceRecordId || row.id || `${kind}:${index}`,
        recordType: kind === "receivable" ? "invoice" : "bill",
        relationship: "matched",
        fields: { party, amount: balance, dueDate: due, currency: row.currency || null }
      })],
      discriminator: `${index}`
    }));
  });
  return findings;
}

// ── Metric-derived detectors ────────────────────────────────────
// These consume a CALCULATOR result rather than raw records, so calculators
// stay pure arithmetic and every Finding is produced by exactly one layer.

/** Cash runway below the registry's warning threshold. */
function detectCashflowRisk(cashflow, ctx) {
  const rule = getRule("cashflow_runway");
  if (!cashflow || !cashflow.available || cashflow.cash_runway_months == null) return [];
  const months = cashflow.cash_runway_months;
  if (months >= rule.params.warningMonths) return [];

  return [ruleFinding("cashflow_runway", ctx, {
    observed: months,
    description: `At the current burn rate of ${fmt(cashflow.monthly_burn)} per month, cash lasts about ${months} months.`,
    metric: "cash_runway_months",
    threshold: months < rule.params.criticalMonths ? rule.params.criticalMonths : rule.params.warningMonths,
    comparator: "<",
    currency: cashflow.currency || null,
    calculation: `cash on hand ${fmt(cashflow.cash_on_hand)} / monthly burn ${fmt(cashflow.monthly_burn)} = ${months} months.`,
    evidence: [createEvidence({
      label: "Cash position",
      recordType: "statement",
      relationship: "computed_from",
      fields: {
        cash_on_hand: cashflow.cash_on_hand,
        monthly_burn: cashflow.monthly_burn,
        net_cash_flow: cashflow.net_cash_flow,
        currency: cashflow.currency || null
      }
    })]
  })];
}

/** Single-party and top-3 concentration. */
function detectConcentration(conc, ctx) {
  if (!conc || !conc.available) return [];
  const kind = conc.kind;
  const ruleId = kind === "vendor" ? "vendor_concentration" : "customer_concentration";
  const rule = getRule(ruleId);
  const p = rule.params;
  const top = conc.top_party;
  const findings = [];

  if (top.percentage > p.mediumSharePct) {
    findings.push(ruleFinding(ruleId, ctx, {
      observed: top.percentage,
      description: `${top.name} accounts for ${top.percentage}% of ${kind === "vendor" ? "spend" : "revenue"} this period.`,
      metric: kind === "vendor" ? "top_vendor_share_pct" : "top_customer_share_pct",
      threshold: top.percentage > p.highSharePct ? p.highSharePct : p.mediumSharePct,
      comparator: ">",
      currency: conc.currency || null,
      calculation: `${fmt(top.amount)} of ${fmt(conc.total)} total = ${top.percentage}%.`,
      evidence: ((conc._rows && conc._rows[0] && conc._rows[0].rows) || []).slice(0, 10).map((r) => createEvidence({
        label: `Transaction with ${top.name}`,
        sourceSystem: r.sourceSystem || null,
        sourceRecordId: r.sourceRecordId,
        recordType: "transaction",
        relationship: "contributing",
        fields: { amount: r.amount, date: r.date, currency: conc.currency || null }
      })),
      discriminator: top.name
    }));
  }

  if (conc.top_three_share_pct > p.topThreeSharePct && conc.parties.length >= 3) {
    findings.push(ruleFinding(ruleId, ctx, {
      // Scored against the SINGLE-party bands so severity stays consistent: a
      // top-3 finding is a medium exposure, not a high one.
      observed: p.mediumSharePct + 1,
      title: `Top-3 ${kind} concentration`,
      description: `The top 3 ${kind === "vendor" ? "vendors" : "customers"} account for ${conc.top_three_share_pct}% of the total.`,
      metric: "top_three_share_pct",
      threshold: p.topThreeSharePct,
      comparator: ">",
      currency: conc.currency || null,
      calculation: conc.parties.slice(0, 3).map((r) => `${r.name} ${r.percentage}%`).join(" + "),
      evidence: [createEvidence({
        label: "Top 3 concentration",
        recordType: "aggregate",
        relationship: "computed_from",
        fields: { parties: conc.parties.slice(0, 3), currency: conc.currency || null }
      })],
      discriminator: "top3"
    }));
  }
  return findings;
}

/**
 * Run the detectors that consume calculator output.
 * @param {object} calculations { cashflow, vendors, customers }
 */
function runMetricDetectors(calculations = {}, ctx = {}) {
  return [].concat(
    detectCashflowRisk(calculations.cashflow, ctx),
    detectConcentration(calculations.vendors, ctx),
    detectConcentration(calculations.customers, ctx)
  );
}

/**
 * Run every RECORD-level detector.
 * @param {object} data normalized monthly dataset
 * @param {object} ctx  { tenantId, period, now, ownerKeywords, materiality }
 */
function runDetectors(data, ctx = {}) {
  const d = data || {};
  return [].concat(
    detectDuplicates(d.transactions, ctx),
    detectRoundNumbers(d.transactions, ctx),
    detectOutliers(d.transactions, ctx),
    detectMixedFunds(d.transactions, ctx, ctx.ownerKeywords),
    detectUnreconciled(d.reconciliations, ctx),
    detectMissingTransactionFields(d.transactions, ctx),
    detectMissingJournalReferences(d.journalEntries, ctx),
    detectMissingReceipts(d.transactions, ctx),
    detectOverdue(d.receivables, ctx, "receivable"),
    detectOverdue(d.payables, ctx, "payable")
  );
}

module.exports = {
  runDetectors,
  runMetricDetectors,
  ruleFinding,
  detectCashflowRisk,
  detectConcentration,
  detectDuplicates,
  detectRoundNumbers,
  detectOutliers,
  detectMixedFunds,
  detectUnreconciled,
  detectMissingTransactionFields,
  detectMissingJournalReferences,
  detectMissingReceipts,
  detectOverdue
};
