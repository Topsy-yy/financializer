/**
 * Runway, stated honestly.
 *
 * JOB 6: the engine no longer substitutes a 12-month runway when it cannot be
 * computed, so this sentence must distinguish three real cases — measured,
 * not burning cash, and not measurable. Previously an unmeasurable runway
 * printed "Estimated runway is 12 months", which read as a solvent year.
 */
function runwayLine(cashFlowRisk) {
  if (cashFlowRisk.runwayMonths != null) {
    return `Estimated runway is ${cashFlowRisk.runwayMonths} months based on current burn trends.`;
  }
  if (cashFlowRisk.neverDepletes) {
    return "Cash is not being depleted at the current run-rate, so there is no runway limit to report.";
  }
  return "Runway could not be calculated for this period: a cash balance and a burn rate are both required.";
}

function buildPlainLanguageSummary({ businessName, period, analysis }) {
  const { cashFlowRisk, detections, earlyWarnings } = analysis;

  const issueCount =
    detections.unusualTransactions.length +
    detections.duplicates.length +
    detections.mixedFunds.length +
    detections.unreconciledAccounts.length +
    detections.missingTransactionFields.length +
    detections.missingJournalFields.length;

  const severityText =
    cashFlowRisk.severity === "high"
      ? "high"
      : cashFlowRisk.severity === "medium"
        ? "moderate"
        : "low";

  return {
    headline: `${businessName}: ${period || "Current month"} financial health is ${severityText} risk`,
    founderSummary: [
      `Your estimated cash flow risk score is ${cashFlowRisk.riskScore}/100 (${cashFlowRisk.severity} risk).`,
      runwayLine(cashFlowRisk),
      `We detected ${issueCount} issues that need review before next investor update.`
    ],
    warnings: earlyWarnings
  };
}

function buildIssueChecklist(analysis) {
  const { detections } = analysis;

  return [
    {
      item: "Missing transaction fields",
      count: detections.missingTransactionFields.length,
      status: detections.missingTransactionFields.length ? "action-needed" : "ok"
    },
    {
      item: "Missing journal fields",
      count: detections.missingJournalFields.length,
      status: detections.missingJournalFields.length ? "action-needed" : "ok"
    },
    {
      item: "Potential duplicates",
      count: detections.duplicates.length,
      status: detections.duplicates.length ? "action-needed" : "ok"
    },
    {
      item: "Round-number payments (possible fraud signal)",
      count: detections.roundNumbers.length,
      status: detections.roundNumbers.length ? "review" : "ok"
    },
    {
      item: "Unusual transactions",
      count: detections.unusualTransactions.length,
      status: detections.unusualTransactions.length ? "review" : "ok"
    },
    {
      item: "Possible mixed personal/business funds",
      count: detections.mixedFunds.length,
      status: detections.mixedFunds.length ? "action-needed" : "ok"
    },
    {
      item: "Unreconciled accounts",
      count: detections.unreconciledAccounts.length,
      status: detections.unreconciledAccounts.length ? "action-needed" : "ok"
    }
  ];
}

function buildStructuredReport({ businessName, businessAddress, period, analysis }) {
  const summary = buildPlainLanguageSummary({ businessName, period, analysis });
  const checklist = buildIssueChecklist(analysis);

  return {
    generatedAt: new Date().toISOString(),
    company: {
      name: businessName,
      address: businessAddress
    },
    period,
    risk: analysis.cashFlowRisk,
    summary,
    checklist,
    details: analysis.detections
  };
}

module.exports = {
  buildStructuredReport
};
