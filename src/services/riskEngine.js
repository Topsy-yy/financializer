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
    const haystack = `${tx.counterparty || ""} ${tx.description || ""}`.toLowerCase();
    return keywords.some((keyword) => haystack.includes(keyword));
  });
}

function detectUnreconciledAccounts(reconciliations) {
  return reconciliations.filter((r) => !r.isReconciled);
}

function scoreCashFlowRisk(statements) {
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

  return warnings;
}

function analyzeFinancialRisk(data) {
  const detections = {
    duplicates: detectDuplicates(data.transactions),
    roundNumbers: detectRoundNumbers(data.transactions),
    unusualTransactions: detectUnusualTransactions(data.transactions),
    mixedFunds: detectMixedFunds(data.transactions),
    unreconciledAccounts: detectUnreconciledAccounts(data.reconciliations),
    ...detectMissingEntries(data.transactions, data.journalEntries)
  };

  const cashFlowRisk = scoreCashFlowRisk(data.statements);
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
