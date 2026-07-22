const config = require("../config");

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function stdDev(values) {
  if (values.length < 2) return 0;
  const avg = average(values);
  const variance = average(values.map((v) => (v - avg) ** 2));
  return Math.sqrt(variance);
}

function detectDuplicates(transactions) {
  const seen = new Map();
  const duplicatePairs = [];

  transactions.forEach((tx) => {
    const key = `${tx.date || ""}|${tx.amount || ""}|${tx.counterparty || tx.description || ""}`;
    if (seen.has(key)) {
      duplicatePairs.push({ original: seen.get(key), duplicate: tx });
    } else {
      seen.set(key, tx);
    }
  });

  return duplicatePairs;
}

function detectRoundNumbers(transactions) {
  return transactions.filter((tx) => {
    const amount = Math.abs(toNumber(tx.amount));
    return amount >= 10000 && amount % 1000 === 0;
  });
}

function detectUnusualTransactions(transactions) {
  const amounts = transactions.map((tx) => Math.abs(toNumber(tx.amount))).filter((a) => a > 0);
  const mean = average(amounts);
  const sd = stdDev(amounts);
  const threshold = mean + 2 * sd;

  return transactions.filter((tx) => Math.abs(toNumber(tx.amount)) > threshold && threshold > 0);
}

function detectMissingEntries(transactions, journalEntries) {
  const missingTransactionFields = transactions.filter(
    (tx) => !tx.date || !tx.account || tx.amount == null || !tx.description
  );

  const missingJournalFields = journalEntries.filter(
    (je) => !je.date || !je.debitAccount || !je.creditAccount || je.amount == null
  );

  return {
    missingTransactionFields,
    missingJournalFields
  };
}

function detectMixedFunds(transactions) {
  const keywords = config.businessOwnerKeywords.map((k) => k.toLowerCase());
  return transactions.filter((tx) => {
    // Zoho Books' own `is_personal` flag (set by the bookkeeper/owner) is a
    // direct signal -- trust it over keyword-guessing when it's present.
    if (tx.isPersonal === true) return true;
    if (tx.isPersonal === false) return false;
    const haystack = `${tx.counterparty || ""} ${tx.description || ""}`.toLowerCase();
    return keywords.some((keyword) => haystack.includes(keyword));
  });
}

function detectUnreconciledAccounts(reconciliations) {
  return reconciliations.filter((r) => !r.isReconciled);
}

function detectMissingReceipts(transactions) {
  // `hasReceipt` is only present on transactions sourced from Zoho Books
  // expenses -- CSV imports and other sources simply have nothing to flag.
  return transactions.filter((tx) => tx.hasReceipt === false);
}

function daysBetween(dateStr, referenceDate) {
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return 0;
  return Math.round((referenceDate.getTime() - date.getTime()) / (24 * 60 * 60 * 1000));
}

function detectOverdueReceivables(receivables, now = new Date()) {
  return (receivables || []).filter((r) => {
    if (String(r.status || "").toLowerCase() === "overdue") return true;
    return r.dueDate && daysBetween(r.dueDate, now) > 0;
  });
}

function detectOverduePayables(payables, now = new Date()) {
  return (payables || []).filter((p) => {
    if (String(p.status || "").toLowerCase() === "overdue") return true;
    return p.dueDate && daysBetween(p.dueDate, now) > 0;
  });
}

function scoreCashFlowRisk(statements, overdueReceivablesTotal = 0) {
  const inflow = toNumber(statements.cashFlow?.inflow);
  const outflow = Math.abs(toNumber(statements.cashFlow?.outflow));
  const net = inflow - outflow;
  const monthlyBurn = outflow > inflow ? outflow - inflow : 0;
  const cashReserves = toNumber(statements.balanceSheet?.cashAndEquivalents);
  const runwayMonths = monthlyBurn > 0 ? cashReserves / monthlyBurn : 12;

  let riskScore = 20;
  if (net < 0) riskScore += 25;
  if (monthlyBurn > 0) riskScore += 15;
  if (runwayMonths < 6) riskScore += 25;
  if (runwayMonths < 3) riskScore += 15;
  // Real overdue receivables (from Zoho invoice balance/due_date) directly
  // threaten near-term liquidity even when this month's cash flow looks fine.
  if (overdueReceivablesTotal > 0 && inflow > 0 && overdueReceivablesTotal / inflow > 0.25) riskScore += 10;

  riskScore = Math.max(0, Math.min(100, Math.round(riskScore)));

  let severity = "low";
  if (riskScore >= 70) severity = "high";
  else if (riskScore >= 40) severity = "medium";

  return {
    riskScore,
    severity,
    netCashFlow: net,
    runwayMonths: Number.isFinite(runwayMonths) ? Number(runwayMonths.toFixed(1)) : null
  };
}

function buildEarlyWarnings(cashFlowRisk, detections) {
  const warnings = [];

  if (cashFlowRisk.severity === "high") {
    warnings.push("Cash flow is in high-risk zone. Review burn rate and upcoming obligations this week.");
  }

  if (detections.unusualTransactions.length > 0) {
    warnings.push("Unusual high-value transactions detected. Verify approvals and source documents.");
  }

  if (detections.duplicates.length > 0) {
    warnings.push("Possible duplicate transactions found. Confirm if any expenses were recorded twice.");
  }

  if (detections.unreconciledAccounts.length > 0) {
    warnings.push("Some accounts are not reconciled. Reconciliation gaps can hide reporting errors.");
  }

  if (detections.overdueReceivables.length > 0) {
    warnings.push("Overdue customer invoices detected. Follow up to protect near-term cash flow.");
  }

  if (detections.missingReceipts.length > 0) {
    warnings.push("Some expenses are missing receipts. Weak documentation hurts audit readiness.");
  }

  return warnings;
}

function analyzeFinancialRisk(data) {
  const overdueReceivables = detectOverdueReceivables(data.receivables);
  const overdueReceivablesTotal = overdueReceivables.reduce((sum, r) => sum + toNumber(r.amount), 0);

  const detections = {
    duplicates: detectDuplicates(data.transactions),
    roundNumbers: detectRoundNumbers(data.transactions),
    unusualTransactions: detectUnusualTransactions(data.transactions),
    mixedFunds: detectMixedFunds(data.transactions),
    unreconciledAccounts: detectUnreconciledAccounts(data.reconciliations),
    overdueReceivables,
    overduePayables: detectOverduePayables(data.payables),
    missingReceipts: detectMissingReceipts(data.transactions),
    ...detectMissingEntries(data.transactions, data.journalEntries)
  };

  const cashFlowRisk = scoreCashFlowRisk(data.statements, overdueReceivablesTotal);
  cashFlowRisk.overdueReceivablesTotal = Math.round(overdueReceivablesTotal);
  const earlyWarnings = buildEarlyWarnings(cashFlowRisk, detections);

  return {
    detections,
    cashFlowRisk,
    earlyWarnings
  };
}

module.exports = {
  analyzeFinancialRisk
};
