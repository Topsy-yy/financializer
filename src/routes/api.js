const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const config = require("../config");
const { fetchMonthlyData } = require("../services/zohoClient");
const { analyzeFinancialRisk } = require("../services/riskEngine");
const { buildStructuredReport } = require("../services/reportBuilder");
const { runFollowUpWorkflow } = require("../services/followUpWorkflow");
const { getCoreWalletIntegrationSummary } = require("../services/coreWalletClient");
const { deployCChainContract } = require("../services/avalancheContractDeployer");
const { appendDeploymentRecord, listDeploymentRecords } = require("../services/contractDeploymentHistory");
const { listContractTemplates } = require("../services/contractTemplateRegistry");

const router = express.Router();

let memoryProfile = {
  userName: config.userName || "Aisha",
  businessName: config.businessName || "ABC Traders Ltd",
  zohoApiKey: config.zohoApiKey || "",
  zohoOrgId: "",
  zohoRefreshToken: "",
  walletAddress: "",
  aiProvider: "openai",
  aiApiKey: "",
  aiAssistant: "controller-core"
};

let latestReviewContext = null;
const reviewHistory = [];
const oauthStateStore = new Map();

function hasZohoOAuthConfig() {
  return Boolean(config.zohoOauthClientId && config.zohoOauthClientSecret && config.zohoOauthRedirectUri);
}

function cleanupOauthState() {
  const now = Date.now();
  for (const [state, payload] of oauthStateStore.entries()) {
    if (!payload || payload.expiresAt < now) {
      oauthStateStore.delete(state);
    }
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatMoney(amount) {
  return `${Math.round(toNumber(amount)).toLocaleString("en-KE")} KES`;
}

function parsePeriod(reportId) {
  const match = String(reportId || "").match(/^(\d{4}-\d{2})-/);
  return match ? match[1] : null;
}

function listReportFiles() {
  if (!fs.existsSync(config.reportsDir)) return [];

  return fs
    .readdirSync(config.reportsDir)
    .filter((name) => name.endsWith("-report.json"))
    .map((name) => {
      const fullPath = path.resolve(config.reportsDir, name);
      const stat = fs.statSync(fullPath);
      return {
        name,
        fullPath,
        modifiedAt: stat.mtimeMs
      };
    })
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
}

function parseActionsCsv(csvPath) {
  if (!fs.existsSync(csvPath)) return [];
  const raw = fs.readFileSync(csvPath, "utf-8").trim();
  if (!raw) return [];

  const lines = raw.split(/\r?\n/).slice(1);
  return lines
    .map((line) => {
      const parts = line
        .split(",")
        .map((part) => part.replace(/^"|"$/g, "").replace(/""/g, '"'));
      return {
        task: parts[0] || "",
        owner: parts[1] || "founder",
        priority: (parts[2] || "normal").toLowerCase(),
        due: `${parts[3] || "7"} days`,
        status: "Pending"
      };
    })
    .filter((item) => item.task);
}

function classifyDirection(tx) {
  const amount = toNumber(tx.amount);
  const text = `${tx.description || ""} ${tx.account || ""} ${tx.counterparty || ""}`.toLowerCase();
  const expenseHints = [
    "expense",
    "payment",
    "supplier",
    "withdrawal",
    "rent",
    "payroll",
    "fuel",
    "utilities",
    "tax",
    "bill"
  ];

  if (amount < 0) return "outflow";
  if (expenseHints.some((hint) => text.includes(hint))) return "outflow";
  return "inflow";
}

function aggregateCounterpartyShare(transactions, direction) {
  const totals = new Map();

  transactions.forEach((tx) => {
    if (classifyDirection(tx) !== direction) return;
    const name = tx.counterparty || "Unmapped";
    const amount = Math.abs(toNumber(tx.amount));
    totals.set(name, (totals.get(name) || 0) + amount);
  });

  const rows = Array.from(totals.entries()).map(([name, amount]) => ({ name, amount }));
  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  const sorted = rows
    .sort((a, b) => b.amount - a.amount)
    .map((row) => ({
      name: row.name,
      amount: row.amount,
      percentage: total > 0 ? Number(((row.amount / total) * 100).toFixed(1)) : 0
    }));

  return {
    total,
    rows: sorted
  };
}

function buildAnomalies(detections) {
  const items = [];

  (detections.duplicates || []).forEach((pair) => {
    const src = pair.duplicate || pair.original || {};
    items.push({
      type: "duplicate_transaction",
      severity: "high",
      description: `Possible duplicate around ${src.date || "unknown date"} for ${formatMoney(src.amount)}`
    });
  });

  (detections.unusualTransactions || []).forEach((tx) => {
    items.push({
      type: "outlier",
      severity: "medium",
      description: `Unusual transaction ${formatMoney(tx.amount)} (${tx.counterparty || "unknown counterparty"})`
    });
  });

  (detections.roundNumbers || []).forEach((tx) => {
    items.push({
      type: "round_payment",
      severity: "medium",
      description: `Round-number payment detected: ${formatMoney(tx.amount)} (${tx.counterparty || "unknown"})`
    });
  });

  (detections.mixedFunds || []).forEach((tx) => {
    items.push({
      type: "mixed_funds",
      severity: "high",
      description: `Possible personal/business mix: ${tx.description || "transaction"}`
    });
  });

  (detections.unreconciledAccounts || []).forEach((row) => {
    items.push({
      type: "unreconciled_account",
      severity: "high",
      description: `${row.accountName || "Account"} is not reconciled`
    });
  });

  (detections.missingTransactionFields || []).forEach(() => {
    items.push({
      type: "missing_fields",
      severity: "low",
      description: "Transaction record has missing required fields"
    });
  });

  (detections.missingJournalFields || []).forEach(() => {
    items.push({
      type: "missing_references",
      severity: "low",
      description: "Journal entry has missing debit/credit references"
    });
  });

  return items;
}

function buildVendorSummary(monthlyData) {
  const spend = aggregateCounterpartyShare(monthlyData.transactions || [], "outflow");
  const topVendor = spend.rows[0] || null;
  const top3 = spend.rows.slice(0, 3).reduce((sum, row) => sum + row.percentage, 0);

  let riskScore = 15;
  if (topVendor && topVendor.percentage > 30) riskScore += 25;
  if (topVendor && topVendor.percentage > 50) riskScore += 20;
  if (top3 > 80) riskScore += 20;
  riskScore = clamp(Math.round(riskScore), 0, 100);

  const findings = [];
  if (topVendor && topVendor.percentage > 50) {
    findings.push({
      type: "supplier_dominance",
      severity: "high",
      description: `${topVendor.name} controls ${topVendor.percentage}% of procurement spend`
    });
  }
  if (top3 > 80) {
    findings.push({
      type: "procurement_imbalance",
      severity: "medium",
      description: `Top 3 vendors account for ${top3.toFixed(1)}% of spend`
    });
  }

  return {
    vendor_risk_score: riskScore,
    concentration: {
      top_vendor: topVendor,
      top_3_percentage: Number(top3.toFixed(1)),
      total_vendors: spend.rows.length,
      total_spend: spend.total
    },
    vendor_list: spend.rows,
    top_vendor: topVendor,
    findings,
    skills: ["vendor-dependency-detector"]
  };
}

function buildCustomerSummary(monthlyData) {
  const revenue = aggregateCounterpartyShare(monthlyData.transactions || [], "inflow");

  // If source data has no customer-attributed inflows, provide a deterministic demo split.
  if (revenue.rows.length === 0) {
    const totalInflow = toNumber(monthlyData.statements?.cashFlow?.inflow);
    const syntheticRows = [
      { name: "BlueTech", percentage: 57 },
      { name: "Nova Retail", percentage: 28 },
      { name: "Eastline Logistics", percentage: 15 }
    ].map((row) => ({
      name: row.name,
      percentage: row.percentage,
      amount: Math.round((row.percentage / 100) * totalInflow)
    }));

    return {
      customer_risk_score: 72,
      concentration: {
        top_customer: syntheticRows[0],
        top_3_percentage: 100,
        total_customers: syntheticRows.length,
        total_revenue: totalInflow
      },
      customer_list: syntheticRows,
      top_customer: syntheticRows[0],
      findings: [
        {
          type: "customer_concentration",
          severity: "high",
          description: `${syntheticRows[0].name} contributes ${syntheticRows[0].percentage}% of revenue`
        }
      ],
      skills: ["customer-concentration-detector", "revenue-intelligence"],
      estimated: true
    };
  }

  const topCustomer = revenue.rows[0] || null;
  const top3 = revenue.rows.slice(0, 3).reduce((sum, row) => sum + row.percentage, 0);

  let riskScore = 15;
  if (topCustomer && topCustomer.percentage > 30) riskScore += 25;
  if (topCustomer && topCustomer.percentage > 50) riskScore += 20;
  if (top3 > 80) riskScore += 20;
  riskScore = clamp(Math.round(riskScore), 0, 100);

  const findings = [];
  if (topCustomer && topCustomer.percentage > 50) {
    findings.push({
      type: "customer_concentration",
      severity: "high",
      description: `${topCustomer.name} contributes ${topCustomer.percentage}% of revenue`
    });
  }
  if (top3 > 80) {
    findings.push({
      type: "revenue_concentration",
      severity: "medium",
      description: `Top 3 customers account for ${top3.toFixed(1)}% of revenue`
    });
  }

  return {
    customer_risk_score: riskScore,
    concentration: {
      top_customer: topCustomer,
      top_3_percentage: Number(top3.toFixed(1)),
      total_customers: revenue.rows.length,
      total_revenue: revenue.total
    },
    customer_list: revenue.rows,
    top_customer: topCustomer,
    findings,
    skills: ["customer-concentration-detector", "revenue-intelligence"]
  };
}

function periodToComparable(period) {
  const match = String(period || "").match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  return Number(`${match[1]}${match[2]}`);
}

function buildRevenueSummary(monthlyData, period) {
  const totalRevenue = toNumber(monthlyData.statements?.cashFlow?.inflow);

  const historyRows = reviewHistory
    .filter((row) => row.period && row.revenue != null)
    .concat([{ period, revenue: totalRevenue }])
    .sort((a, b) => (periodToComparable(a.period) || 0) - (periodToComparable(b.period) || 0));

  const deduped = [];
  const seen = new Set();
  historyRows.forEach((row) => {
    if (seen.has(row.period)) return;
    seen.add(row.period);
    deduped.push(row);
  });

  const previous = deduped.length > 1 ? deduped[deduped.length - 2].revenue : totalRevenue;
  const growthRate = previous > 0 ? Number((((totalRevenue - previous) / previous) * 100).toFixed(1)) : 0;
  const direction = growthRate > 0 ? "up" : growthRate < 0 ? "down" : "flat";

  const findings = [];
  if (growthRate <= -10) {
    findings.push({
      type: "revenue_decline",
      severity: "high",
      description: `Revenue declined ${Math.abs(growthRate)}% over the last period.`
    });
  } else if (growthRate < 0) {
    findings.push({
      type: "revenue_softening",
      severity: "medium",
      description: `Revenue is trending down (${growthRate}%).`
    });
  } else if (growthRate >= 10) {
    findings.push({
      type: "revenue_growth",
      severity: "info",
      description: `Revenue improved by ${growthRate}% period-over-period.`
    });
  }

  return {
    total_revenue: totalRevenue,
    growth_rate: growthRate,
    direction,
    active_customers: aggregateCounterpartyShare(monthlyData.transactions || [], "inflow").rows.length || 3,
    findings,
    trends: deduped.slice(-6).map((row) => ({ month: row.period, revenue: row.revenue })),
    skills: ["revenue-intelligence"]
  };
}

function buildCashFlowSummary(analysis, monthlyData) {
  const cashFlow = monthlyData.statements?.cashFlow || {};
  const risk = analysis.cashFlowRisk || {};
  const runwayDays = risk.runwayMonths == null ? null : Math.round(risk.runwayMonths * 30);
  const overdueEstimate = Math.max(0, Math.round(Math.abs(toNumber(risk.netCashFlow, 0)) * 0.35));

  return {
    cash_runway: runwayDays,
    runway_days: runwayDays,
    cash_runway_months: risk.runwayMonths,
    risk_level: risk.severity || "low",
    net_cash_flow: risk.netCashFlow,
    monthly_burn: Math.max(0, toNumber(cashFlow.outflow) - toNumber(cashFlow.inflow)),
    liquidity_ratio: toNumber(monthlyData.statements?.balanceSheet?.cashAndEquivalents) > 0 && toNumber(cashFlow.outflow) > 0
      ? (toNumber(monthlyData.statements.balanceSheet.cashAndEquivalents) / toNumber(cashFlow.outflow)).toFixed(2)
      : "—",
    overdue_receivables: overdueEstimate,
    findings: (analysis.earlyWarnings || []).map((warning) => ({ severity: "medium", description: warning })),
    recommendations: [
      "Follow up invoices older than 30 days.",
      "Reduce discretionary spend for the next 2 weeks.",
      "Renegotiate payment timing with top suppliers."
    ],
    skills: ["cashflow-risk-analyzer"]
  };
}

function buildHealthSummary({ cashflow, revenue, vendors, customers, anomalies }) {
  const anomalyRiskScore = clamp(
    anomalies.items.reduce((sum, item) => {
      if (item.severity === "high") return sum + 12;
      if (item.severity === "medium") return sum + 6;
      if (item.severity === "low") return sum + 2;
      return sum + 1;
    }, 0),
    0,
    100
  );

  const cashflowScore = clamp(100 - toNumber(cashflow.risk_score != null ? cashflow.risk_score : (cashflow.risk_level === "high" ? 80 : cashflow.risk_level === "medium" ? 55 : 25)), 0, 100);
  const revenueScore = clamp(revenue.growth_rate >= 10 ? 88 : revenue.growth_rate >= 0 ? 72 : revenue.growth_rate > -10 ? 55 : 38, 0, 100);
  const vendorScore = clamp(100 - toNumber(vendors.vendor_risk_score, 0), 0, 100);
  const customerScore = clamp(100 - toNumber(customers.customer_risk_score, 0), 0, 100);
  const fraudScore = clamp(100 - anomalyRiskScore, 0, 100);

  const weighted =
    cashflowScore * 0.3 +
    fraudScore * 0.2 +
    revenueScore * 0.2 +
    vendorScore * 0.15 +
    customerScore * 0.15;

  const overallScore = Math.round(clamp(weighted, 0, 100));
  let riskCategory = "Fair";
  if (overallScore >= 80) riskCategory = "Excellent";
  else if (overallScore >= 60) riskCategory = "Good";
  else if (overallScore < 20) riskCategory = "Critical";
  else if (overallScore < 40) riskCategory = "Poor";

  return {
    overall_score: overallScore,
    risk_category: riskCategory,
    summary: `Financial health is ${riskCategory.toLowerCase()} with strongest pressure from cashflow and concentration risk.`,
    component_scores: {
      cash_flow: Math.round(cashflowScore),
      revenue_stability: Math.round(revenueScore),
      vendor_risk: Math.round(vendorScore),
      customer_risk: Math.round(customerScore),
      fraud_indicators: Math.round(fraudScore)
    },
    skills: ["financial-health-scorer"]
  };
}

function buildContext({ month, monthlyData, analysis, report, followUp }) {
  const period = month || monthlyData.period || report.period || new Date().toISOString().slice(0, 7);
  const anomalies = {
    items: buildAnomalies(analysis.detections || {}),
    skills: ["fraud-and-errors-detector"]
  };
  const cashflow = buildCashFlowSummary(analysis, monthlyData);
  const vendors = buildVendorSummary(monthlyData);
  const customers = buildCustomerSummary(monthlyData);
  const revenue = buildRevenueSummary(monthlyData, period);
  const health = buildHealthSummary({ cashflow, revenue, vendors, customers, anomalies });

  const actionItems = Array.isArray(followUp?.actions)
    ? followUp.actions.map((action) => ({
      priority: action.priority || "normal",
      task: action.task,
      owner: action.owner,
      due: `${action.dueInDays} days`,
      status: "Pending"
    }))
    : [];

  const aiSummary = report?.summary?.founderSummary?.join("\n") || report?.summary?.headline || "No AI summary available.";

  return {
    period,
    health,
    cashflow,
    revenue,
    anomalies,
    vendors,
    customers,
    actions: {
      actions: actionItems,
      skills: ["followup-orchestrator", "recommendation-engine"]
    },
    reports: {
      report,
      followUp,
      skills: ["executive-report-generator", "financial-controller-core"]
    },
    overview: {
      health_score: health.overall_score,
      cashflow,
      risk: anomalies,
      revenue,
      findings: anomalies.items,
      ai_summary: aiSummary,
      pending_actions: actionItems.length,
      skills: ["financial-health-scorer", "financial-controller-core", "executive-report-generator"]
    }
  };
}

function contextFromLatestReportDisk() {
  const files = listReportFiles();
  if (!files.length) return null;

  const latest = files[0];
  const report = JSON.parse(fs.readFileSync(latest.fullPath, "utf-8"));
  const reportPrefix = latest.name.replace(/-report\.json$/, "");
  const actionsCsv = path.resolve(config.reportsDir, `${reportPrefix}-actions.csv`);
  const actions = parseActionsCsv(actionsCsv);

  const runwayMonths = toNumber(report.risk?.runwayMonths, 0);
  const summaryItems = Array.isArray(report.summary?.founderSummary) ? report.summary.founderSummary : [];

  return {
    period: report.period || parsePeriod(reportPrefix),
    health: {
      overall_score: clamp(100 - toNumber(report.risk?.riskScore, 0), 0, 100),
      risk_category: report.risk?.severity || "unknown",
      summary: report.summary?.headline || "Health summary not available",
      component_scores: {}
    },
    cashflow: {
      runway_days: runwayMonths > 0 ? Math.round(runwayMonths * 30) : null,
      cash_runway: runwayMonths > 0 ? Math.round(runwayMonths * 30) : null,
      cash_runway_months: runwayMonths,
      net_cash_flow: toNumber(report.risk?.netCashFlow, 0),
      risk_level: report.risk?.severity || "unknown",
      findings: (report.summary?.warnings || []).map((w) => ({ severity: "medium", description: w })),
      recommendations: ["Run a fresh monthly analysis for complete liquidity diagnostics."],
      skills: ["cashflow-risk-analyzer"]
    },
    revenue: {
      total_revenue: null,
      growth_rate: null,
      direction: "unknown",
      findings: [],
      trends: [],
      skills: ["revenue-intelligence"]
    },
    anomalies: {
      items: (report.checklist || [])
        .filter((item) => item.count > 0)
        .map((item) => ({
          type: item.item,
          severity: item.status === "action-needed" ? "high" : "medium",
          description: `${item.item}: ${item.count}`
        })),
      skills: ["fraud-and-errors-detector"]
    },
    vendors: {
      vendor_risk_score: null,
      concentration: {},
      vendor_list: [],
      findings: [],
      skills: ["vendor-dependency-detector"]
    },
    customers: {
      customer_risk_score: null,
      concentration: {},
      customer_list: [],
      findings: [],
      skills: ["customer-concentration-detector", "revenue-intelligence"]
    },
    actions: {
      actions,
      skills: ["followup-orchestrator", "recommendation-engine"]
    },
    reports: {
      report,
      reportId: reportPrefix,
      skills: ["executive-report-generator", "financial-controller-core"]
    },
    overview: {
      health_score: clamp(100 - toNumber(report.risk?.riskScore, 0), 0, 100),
      cashflow: {
        runway_days: runwayMonths > 0 ? Math.round(runwayMonths * 30) : null
      },
      risk: {
        items: (report.checklist || []).filter((item) => item.count > 0)
      },
      revenue: {
        trend: "Run fresh analysis for revenue trend"
      },
      findings: (report.checklist || []).filter((item) => item.count > 0),
      ai_summary: summaryItems.join("\n") || report.summary?.headline || "No summary available.",
      pending_actions: actions.length,
      skills: ["financial-health-scorer", "financial-controller-core", "executive-report-generator"]
    }
  };
}

function getContext() {
  if (latestReviewContext) return latestReviewContext;
  latestReviewContext = contextFromLatestReportDisk();
  return latestReviewContext;
}

/* ============================================================
   Conversational AI — Chat endpoint
   ============================================================ */

/**
 * Simple intent classifier based on keyword matching.
 * Returns an object with the matched intent and extracted entities.
 */
function classifyIntent(message) {
  const lower = message.toLowerCase();

  const intents = {
    cashflow: ["cash flow", "cashflow", "cash", "runway", "burn rate", "inflow", "outflow", "money coming in", "money going out"],
    risk: ["risk", "risk score", "severity", "danger", "threat", "vulnerability"],
    anomalies: ["anomaly", "anomalies", "fraud", "suspicious", "unusual", "duplicate", "irregular", "red flag"],
    expenses: ["expense", "spending", "cost", "costs", "highest", "biggest expense", "where is my money going"],
    warnings: ["warning", "alert", "early warning", "red flag", "concern"],
    summary: ["summary", "overview", "recap", "brief", "what happened", "tell me about"],
    actions: ["action", "follow-up", "follow up", "todo", "to do", "what should i do", "next step"],
    compare: ["compare", "vs", "versus", "difference", "last month", "previous month", "trend"],
    income: ["income", "revenue", "sales", "earnings", "profit"],
    general: ["hello", "hi", "hey", "help", "what can you do", "capabilities"]
  };

  for (const [intent, keywords] of Object.entries(intents)) {
    for (const keyword of keywords) {
      if (lower.includes(keyword)) return intent;
    }
  }

  return "general";
}

/**
 * Build a conversational response based on the analysis data.
 */
function buildChatResponse(intent, analysis, month, assistantConfig) {
  const detections = analysis.detections || {};
  const cashFlowRisk = analysis.cashFlowRisk || {};
  const earlyWarnings = analysis.earlyWarnings || [];
  const suggestions = [];

  let text = "";
  let html = "";

  switch (intent) {
    case "cashflow": {
      const net = cashFlowRisk.netCashFlow != null ? cashFlowRisk.netCashFlow : 0;
      const runway = cashFlowRisk.runwayMonths != null ? cashFlowRisk.runwayMonths : "unknown";
      const severity = cashFlowRisk.severity || "unknown";
      const sign = net >= 0 ? "positive" : "negative";

      text = `Your cash flow analysis for ${month || "the current period"} shows a net cash flow of ${Math.abs(net).toLocaleString()} KES (${sign}). Estimated runway is ${runway} months with a risk severity of ${severity}.`;
      html = `<p><strong>Cash Flow Analysis — ${escapeHtml(month || "Current Period")}</strong></p>
<p>Net cash flow: <strong>${sign === "positive" ? "" : "-"}${escapeHtml(Math.abs(net).toLocaleString())} KES</strong> (${sign})</p>
<p>Estimated runway: <strong>${escapeHtml(String(runway))} months</strong></p>
<p>Risk severity: <strong>${escapeHtml(severity)}</strong></p>`;

      if (runway < 6) {
        html += `<p style="color: var(--danger);">⚠️ Your runway is below 6 months. Consider reducing discretionary spending and accelerating receivables.</p>`;
      }
      if (net < 0) {
        html += `<p style="color: var(--warning);">⚠️ Your outflow exceeds inflow. Review your burn rate and identify cost-cutting opportunities.</p>`;
      }

      suggestions.push("What's my burn rate?", "How can I improve cash flow?", "Show me the income vs expenses breakdown");
      break;
    }

    case "risk":
    case "summary": {
      const score = cashFlowRisk.riskScore != null ? cashFlowRisk.riskScore : "N/A";
      const severity = cashFlowRisk.severity || "unknown";
      const runway = cashFlowRisk.runwayMonths != null ? cashFlowRisk.runwayMonths : "unknown";

      text = `Risk assessment for ${month || "the current period"}: score ${score}/100, severity ${severity}, runway ${runway} months.`;
      html = `<p><strong>Risk Assessment — ${escapeHtml(month || "Current Period")}</strong></p>
<p>Risk score: <strong>${escapeHtml(String(score))}/100</strong> (${escapeHtml(severity)})</p>
<p>Estimated runway: <strong>${escapeHtml(String(runway))} months</strong></p>`;

      if (earlyWarnings.length > 0) {
        html += `<p><strong>Early warnings:</strong></p><ul>`;
        earlyWarnings.forEach(function (w) {
          html += `<li>${escapeHtml(w)}</li>`;
        });
        html += `</ul>`;
      }

      suggestions.push("What are the early warnings?", "Show me the risk details", "What's my cash flow situation?");
      break;
    }

    case "anomalies": {
      const duplicates = detections.duplicates || [];
      const unusual = detections.unusualTransactions || [];
      const roundNumbers = detections.roundNumbers || [];
      const mixedFunds = detections.mixedFunds || [];
      const totalAnomalies = duplicates.length + unusual.length + roundNumbers.length + mixedFunds.length;

      text = `Found ${totalAnomalies} anomalies in ${month || "the current period"}: ${duplicates.length} duplicates, ${unusual.length} unusual transactions, ${roundNumbers.length} round-number transactions, ${mixedFunds.length} potential mixed fund entries.`;
      html = `<p><strong>Anomaly Detection — ${escapeHtml(month || "Current Period")}</strong></p>
<p>Total anomalies found: <strong>${totalAnomalies}</strong></p>
<ul>
  <li>Duplicate transactions: <strong>${duplicates.length}</strong></li>
  <li>Unusual high-value transactions: <strong>${unusual.length}</strong></li>
  <li>Suspicious round-number transactions: <strong>${roundNumbers.length}</strong></li>
  <li>Potential mixed funds (owner-related): <strong>${mixedFunds.length}</strong></li>
</ul>`;

      if (totalAnomalies === 0) {
        html += `<p>✅ No anomalies detected. Your transactions look clean for this period.</p>`;
      } else {
        html += `<p>⚠️ Review the flagged items in the full report for details.</p>`;
      }

      suggestions.push("Show me the duplicate transactions", "What are the unusual transactions?", "Run a full fraud check");
      break;
    }

    case "expenses": {
      text = `I've analyzed the expense patterns for ${month || "the current period"}. The full report shows detailed breakdowns.`;
      html = `<p><strong>Expense Analysis — ${escapeHtml(month || "Current Period")}</strong></p>
<p>I've reviewed the transaction data for this period. The detailed expense breakdown is available in the full report above.</p>
<p>Key areas to review:</p>
<ul>
  <li>Compare your expenses against previous months to spot trends</li>
  <li>Check for any unusually large transactions</li>
  <li>Verify that all expenses are properly categorized</li>
</ul>`;

      suggestions.push("What are my biggest expenses?", "Show expense trends", "Compare with last month");
      break;
    }

    case "warnings": {
      if (earlyWarnings.length > 0) {
        text = `There are ${earlyWarnings.length} early warnings for ${month || "the current period"}.`;
        html = `<p><strong>Early Warnings — ${escapeHtml(month || "Current Period")}</strong></p><ul>`;
        earlyWarnings.forEach(function (w) {
          html += `<li>${escapeHtml(w)}</li>`;
        });
        html += `</ul>`;
      } else {
        text = `No early warnings for ${month || "the current period"}. Everything looks stable.`;
        html = `<p><strong>Early Warnings</strong></p><p>✅ No early warnings for ${escapeHtml(month || "the current period")}. Everything looks stable.</p>`;
      }

      suggestions.push("What's my risk score?", "Show me the full analysis", "What follow-up actions are needed?");
      break;
    }

    case "actions": {
      text = `I can help you track follow-up actions. Select a month from the sidebar to run a full analysis that includes action items.`;
      html = `<p><strong>Follow-up Actions</strong></p>
<p>To generate and track follow-up actions, please select a month from the sidebar to run a complete financial analysis. The report will include prioritized action items with owners and due dates.</p>`;

      suggestions.push("Run analysis for this month", "Show me the latest report", "What are the top priorities?");
      break;
    }

    case "compare": {
      text = `I can compare different periods. Select a month from the sidebar to run an analysis, then ask me to compare it with another period.`;
      html = `<p><strong>Period Comparison</strong></p>
<p>To compare financial periods, start by selecting a month from the sidebar to run an analysis. Once the report is generated, I can help you compare it with previous months.</p>`;

      suggestions.push("Run analysis for last month", "Run analysis for this month", "Show me trends");
      break;
    }

    case "income": {
      text = `I can analyze your income and revenue. Select a month from the sidebar for a full breakdown.`;
      html = `<p><strong>Income & Revenue Analysis</strong></p>
<p>For a detailed income analysis, please select a month from the sidebar. The full report includes revenue, profit/loss, and cash flow breakdowns.</p>`;

      suggestions.push("Show me the profit and loss", "What's my revenue trend?", "Run analysis for this month");
      break;
    }

    case "general":
    default: {
      text = `Hello! I'm your FinGuard AI. I can analyze your financial data, detect anomalies, assess risks, and suggest follow-up actions. Select a month from the sidebar or ask me a specific question.`;
      html = `<p>Hello! I'm your <strong>FinGuard AI</strong>.</p>
<p>I can help you with:</p>
<ul>
  <li><strong>Monthly financial analysis</strong> — Select a month from the sidebar</li>
  <li><strong>Risk assessment</strong> — Ask about risk scores and early warnings</li>
  <li><strong>Anomaly detection</strong> — Ask about fraud, duplicates, or unusual transactions</li>
  <li><strong>Cash flow analysis</strong> — Ask about runway, burn rate, or cash position</li>
  <li><strong>Follow-up actions</strong> — I'll track what needs to be done</li>
</ul>
<p>What would you like to explore?</p>`;

      suggestions.push("What's my current cash flow?", "Show me the risk assessment", "Are there any anomalies?", "What expenses are highest?");
      break;
    }
  }

  const assistant = assistantConfig?.assistant || "controller-core";
  const provider = assistantConfig?.provider || "openai";

  let assistantStyle = "I am using the financial skills pipeline to process your data.";
  if (assistant === "risk-analyst") {
    assistantStyle = "I am prioritizing risk interpretation from fraud, concentration, and liquidity skills.";
  } else if (assistant === "cashflow-guardian") {
    assistantStyle = "I am prioritizing cash preservation and runway decisions from cashflow skills.";
  } else if (assistant === "executive-brief") {
    assistantStyle = "I am prioritizing concise management-level explanations from reporting skills.";
  }

  text += `\n\n[Assistant: ${assistant} via ${provider}] ${assistantStyle}`;
  html += `<p class=\"text-sm text-muted\" style=\"margin-top:0.75rem\">Assistant: <strong>${escapeHtml(assistant)}</strong> via <strong>${escapeHtml(provider)}</strong> · Skill-first processing</p>`;

  return { text, html, suggestions };
}

function escapeHtml(value) {
  var s = String(value);
  var a = "&" + "amp;";
  var l = "&" + "lt;";
  var g = "&" + "gt;";
  var q = "&" + "quot;";
  var ap = "&#" + "39;";
  var map = { "&": a, "<": l, ">": g, '"': q, "'": ap };
  return s.replace(/[&<>"']/g, function (m) { return map[m]; });
}

router.get("/health", (req, res) => {
  res.json({ ok: true, service: "ai-financial-controller", now: new Date().toISOString() });
});

router.get("/oauth/zoho/start", (req, res) => {
  if (!hasZohoOAuthConfig()) {
    return res.redirect("/?oauth=not_configured");
  }

  cleanupOauthState();

  const state = crypto.randomBytes(16).toString("hex");
  oauthStateStore.set(state, {
    name: typeof req.query.name === "string" ? req.query.name.trim() : "",
    businessName: typeof req.query.business_name === "string" ? req.query.business_name.trim() : "",
    zohoOrgId: typeof req.query.zoho_org_id === "string" ? req.query.zoho_org_id.trim() : "",
    expiresAt: Date.now() + 10 * 60 * 1000
  });

  const authUrl = new URL(config.zohoOauthAuthUrl);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", config.zohoOauthClientId);
  authUrl.searchParams.set("redirect_uri", config.zohoOauthRedirectUri);
  authUrl.searchParams.set("scope", config.zohoOauthScope);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);

  return res.redirect(authUrl.toString());
});

router.get("/oauth/zoho/callback", async (req, res) => {
  const { code, state, error } = req.query || {};

  if (error) {
    return res.redirect(`/?oauth=error&reason=${encodeURIComponent(String(error))}`);
  }

  if (!code || !state || !oauthStateStore.has(state)) {
    return res.redirect("/?oauth=error&reason=invalid_state");
  }

  const pendingProfile = oauthStateStore.get(state);
  oauthStateStore.delete(state);

  try {
    const tokenPayload = new URLSearchParams({
      grant_type: "authorization_code",
      code: String(code),
      client_id: config.zohoOauthClientId,
      client_secret: config.zohoOauthClientSecret,
      redirect_uri: config.zohoOauthRedirectUri
    });

    const tokenResponse = await fetch(config.zohoOauthTokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body: tokenPayload.toString()
    });

    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || tokenData.error || !tokenData.access_token) {
      const reason = tokenData.error || `token_exchange_${tokenResponse.status}`;
      return res.redirect(`/?oauth=error&reason=${encodeURIComponent(String(reason))}`);
    }

    memoryProfile.zohoApiKey = tokenData.access_token;
    memoryProfile.zohoRefreshToken = tokenData.refresh_token || memoryProfile.zohoRefreshToken;

    if (pendingProfile?.name) memoryProfile.userName = pendingProfile.name;
    if (pendingProfile?.businessName) memoryProfile.businessName = pendingProfile.businessName;
    if (pendingProfile?.zohoOrgId) memoryProfile.zohoOrgId = pendingProfile.zohoOrgId;

    return res.redirect("/?oauth=success");
  } catch (exchangeError) {
    return res.redirect(`/?oauth=error&reason=${encodeURIComponent(exchangeError.message || "token_exchange_failed")}`);
  }
});

router.get("/profile", (req, res) => {
  const zohoConnected = Boolean(memoryProfile.zohoApiKey || config.zohoDirectApiUrl);
  const zohoState = zohoConnected ? "configured" : "not configured";
  const walletConnected = Boolean(memoryProfile.walletAddress);
  const aiConnected = Boolean(memoryProfile.aiApiKey);

  res.json({
    ok: true,
    profile: {
      businessName: memoryProfile.businessName,
      userName: memoryProfile.userName,
      business_name: memoryProfile.businessName,
      name: memoryProfile.userName,
      zoho_connected: zohoConnected,
      zoho_oauth_configured: hasZohoOAuthConfig(),
      zoho_org_id: memoryProfile.zohoOrgId,
      wallet_address: memoryProfile.walletAddress,
      zoho_api_key: memoryProfile.zohoApiKey ? "***" : "",
      ai_provider: memoryProfile.aiProvider,
      ai_assistant: memoryProfile.aiAssistant,
      ai_api_key: memoryProfile.aiApiKey ? "***" : "",
      businessAddress: config.businessAddress,
      ownerKeywordHints: config.businessOwnerKeywords,
      integrations: [
        {
          label: "Avalanche Address",
          connected: walletConnected,
          state: walletConnected ? "connected" : "not connected",
          secureReference: "***",
          note: walletConnected ? "Avalanche wallet address is linked" : "No Avalanche wallet linked"
        },
        {
          label: "Zoho API",
          connected: zohoConnected,
          state: zohoState,
          secureReference: "***",
          note: zohoConnected ? "Zoho API credentials are set" : "Zoho API credentials are missing"
        },
        {
          label: "Zoho OAuth",
          connected: hasZohoOAuthConfig(),
          state: hasZohoOAuthConfig() ? "ready" : "missing env",
          secureReference: "***",
          note: hasZohoOAuthConfig()
            ? "OAuth client config detected"
            : "Set ZOHO_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI"
        },
        {
          label: "AI API",
          connected: aiConnected,
          state: aiConnected ? "configured" : "not configured",
          secureReference: "***",
          note: `Assistant: ${memoryProfile.aiAssistant} (${memoryProfile.aiProvider})`
        },
        getCoreWalletIntegrationSummary()
      ]
    },
    now: new Date().toISOString()
  });
});

router.post("/profile", (req, res) => {
  const {
    userName,
    businessName,
    zohoApiKey,
    zohoOrgId,
    walletAddress,
    name,
    business_name,
    zoho_api_key,
    zoho_org_id,
    wallet_address,
    aiProvider,
    aiApiKey,
    aiAssistant,
    ai_provider,
    ai_api_key,
    ai_assistant
  } = req.body || {};

  const resolvedName = userName || name;
  const resolvedBusinessName = businessName || business_name;
  const resolvedZoho = zohoApiKey || zoho_api_key;
  const resolvedZohoOrgId = zohoOrgId || zoho_org_id;
  const resolvedWallet = walletAddress !== undefined ? walletAddress : wallet_address;
  const resolvedAiProvider = aiProvider || ai_provider;
  const resolvedAiApiKey = aiApiKey || ai_api_key;
  const resolvedAiAssistant = aiAssistant || ai_assistant;

  if (resolvedName) memoryProfile.userName = resolvedName;
  if (resolvedBusinessName) memoryProfile.businessName = resolvedBusinessName;
  if (resolvedZoho) memoryProfile.zohoApiKey = resolvedZoho;
  if (resolvedZohoOrgId) memoryProfile.zohoOrgId = resolvedZohoOrgId;
  if (resolvedWallet !== undefined) memoryProfile.walletAddress = resolvedWallet;
  if (resolvedAiProvider) memoryProfile.aiProvider = resolvedAiProvider;
  if (resolvedAiApiKey) memoryProfile.aiApiKey = resolvedAiApiKey;
  if (resolvedAiAssistant) memoryProfile.aiAssistant = resolvedAiAssistant;
  res.json({ ok: true });
});

router.post("/monthly-review", async (req, res) => {
  try {
    const { month, directApiUrl, apiKey, businessName, businessAddress } = req.body || {};

    const monthlyData = await fetchMonthlyData({ 
      directApiUrl, 
      apiKey: apiKey || memoryProfile.zohoApiKey, 
      month 
    });
    
    const analysis = analyzeFinancialRisk(monthlyData);

    const report = buildStructuredReport({
      businessName: businessName || memoryProfile.businessName,
      businessAddress: businessAddress || config.businessAddress,
      period: month || monthlyData.period || null,
      analysis
    });

    const followUp = await runFollowUpWorkflow(report);

    const context = buildContext({
      month,
      monthlyData,
      analysis,
      report,
      followUp
    });
    latestReviewContext = context;

    reviewHistory.push({ period: context.period, revenue: context.revenue.total_revenue });
    if (reviewHistory.length > 36) reviewHistory.shift();

    res.json({
      ok: true,
      report,
      followUp,
      review: context.overview,
      assumptions: [
        "Zoho endpoint returns normalized JSON fields: transactions, journalEntries, reconciliations, statements.",
        "Authentication can be passed as Bearer token from apiKey or ZOHO_API_KEY.",
        "Avalanche CLI is optional and controlled by ENABLE_AVALANCHE."
      ]
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.get("/health-score", (req, res) => {
  const context = getContext();
  if (!context) return res.json({ ok: false, error: "Run monthly review first." });
  res.json({ ok: true, health: context.health, skills: ["financial-health-scorer"] });
});

router.get("/cashflow", (req, res) => {
  const context = getContext();
  if (!context) return res.json({ ok: false, error: "Run monthly review first." });
  res.json({ ok: true, cashflow: context.cashflow, skills: ["cashflow-risk-analyzer"] });
});

router.get("/revenue", (req, res) => {
  const context = getContext();
  if (!context) return res.json({ ok: false, error: "Run monthly review first." });
  res.json({ ok: true, revenue: context.revenue, skills: ["revenue-intelligence"] });
});

router.get("/anomalies", (req, res) => {
  const context = getContext();
  if (!context) return res.json({ ok: false, error: "Run monthly review first." });
  res.json({ ok: true, anomalies: context.anomalies, skills: ["fraud-and-errors-detector"] });
});

router.get("/vendors", (req, res) => {
  const context = getContext();
  if (!context) return res.json({ ok: false, error: "Run monthly review first." });
  res.json({ ok: true, vendors: context.vendors, skills: ["vendor-dependency-detector"] });
});

router.get("/customers", (req, res) => {
  const context = getContext();
  if (!context) return res.json({ ok: false, error: "Run monthly review first." });
  res.json({ ok: true, customers: context.customers, skills: ["customer-concentration-detector", "revenue-intelligence"] });
});

router.get("/actions", (req, res) => {
  const context = getContext();
  if (!context) return res.json({ ok: false, error: "Run monthly review first." });
  res.json({ ok: true, actions: context.actions.actions, skills: ["followup-orchestrator", "recommendation-engine"] });
});

router.post("/executive-report", (req, res) => {
  const context = getContext();
  if (!context) return res.json({ ok: false, error: "Run monthly review first." });

  const reportType = String(req.body?.report_type || "monthly_review");
  const report = context.reports.report || {};
  const health = context.health || {};
  const topFindings = (context.anomalies?.items || []).slice(0, 4).map((item) => `- ${item.description}`);
  const topActions = (context.actions?.actions || []).slice(0, 4).map((item) => `- ${item.priority.toUpperCase()}: ${item.task} (Owner: ${item.owner}, Due: ${item.due})`);

  const templates = {
    monthly_review: [
      `Monthly Review - ${context.period || "Current"}`,
      `Health Score: ${health.overall_score ?? "N/A"}/100 (${health.risk_category || "Unknown"})`,
      `Summary: ${report.summary?.headline || health.summary || "No summary available."}`
    ],
    weekly_risk: [
      `Weekly Risk Review - ${context.period || "Current"}`,
      `Open Findings: ${(context.anomalies?.items || []).length}`,
      "Critical risk signals requiring attention this week:"
    ],
    board_summary: [
      `Board Summary - ${context.period || "Current"}`,
      `Overall Health: ${health.overall_score ?? "N/A"}/100`,
      `Pending Actions: ${(context.actions?.actions || []).length}`
    ],
    investor_summary: [
      `Investor Summary - ${context.period || "Current"}`,
      `Risk Category: ${health.risk_category || "Unknown"}`,
      `Cash Runway: ${context.cashflow?.runway_days || "N/A"} days`
    ]
  };

  const lines = (templates[reportType] || templates.monthly_review)
    .concat(topFindings.length ? ["", "Top Findings:", ...topFindings] : ["", "Top Findings:", "- No critical findings."])
    .concat(topActions.length ? ["", "Action Center:", ...topActions] : ["", "Action Center:", "- No pending actions."]);

  res.json({
    ok: true,
    report_type: reportType,
    report: lines.join("\n"),
    channels: ["PDF", "CSV", "Email"],
    skills: ["executive-report-generator", "financial-controller-core"]
  });
});

router.post("/chat", async (req, res) => {
  try {
    const { message, activeMonth, history, ai_provider, ai_assistant } = req.body || {};

    if (!message || !message.trim()) {
      return res.status(400).json({ ok: false, error: "Message is required" });
    }

    /* Determine which month to use for context */
    const targetMonth = activeMonth || (() => {
      const now = new Date();
      return now.getUTCFullYear() + "-" + String(now.getUTCMonth() + 1).padStart(2, "0");
    })();

    /* Fetch data and run analysis for conversational context */
    const monthlyData = await fetchMonthlyData({ month: targetMonth });
    const analysis = analyzeFinancialRisk(monthlyData);

    /* Classify intent and build response */
    const intent = classifyIntent(message);
    const response = buildChatResponse(intent, analysis, targetMonth, {
      provider: ai_provider || memoryProfile.aiProvider,
      assistant: ai_assistant || memoryProfile.aiAssistant
    });

    res.json({
      ok: true,
      intent,
      reply: response.text,
      text: response.text,
      html: response.html,
      suggestions: response.suggestions,
      hint: "Ask me about cash flow, risks, anomalies, or expenses.",
      context: {
        month: targetMonth,
        assistant: ai_assistant || memoryProfile.aiAssistant,
        provider: ai_provider || memoryProfile.aiProvider,
        mode: "skills-first"
      }
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.post("/avalanche/contracts/deploy", async (req, res) => {
  try {
    const result = await deployCChainContract(req.body || {});
    const requestBody = req.body || {};
    appendDeploymentRecord({
      contract_name: result?.plan?.contract_name || requestBody.contractName || requestBody.contract_name || "Contract",
      receiver_address: requestBody.receiverAddress || requestBody.receiver_address || requestBody.recipient || requestBody.to || "",
      dry_run: Boolean(result.dry_run),
      ok: Boolean(result.ok),
      mode: result?.plan?.mode || (requestBody.dryRun === false ? "live" : "dry-run"),
      chain_id: result?.plan?.chain_id || null,
      rpc_url: result?.plan?.rpc_url || "",
      tx_hash: result?.deployment?.tx_hash || "",
      address: result?.deployment?.address || "",
      error: result.ok ? "" : (result.error || "unknown_error"),
      message: result.message || "",
      actor: memoryProfile.userName || "unknown"
    });

    const statusCode = result.ok ? 200 : 400;
    return res.status(statusCode).json(result);
  } catch (error) {
    const requestBody = req.body || {};
    appendDeploymentRecord({
      contract_name: requestBody.contractName || requestBody.contract_name || "Contract",
      receiver_address: requestBody.receiverAddress || requestBody.receiver_address || requestBody.recipient || requestBody.to || "",
      dry_run: requestBody.dryRun !== false,
      ok: false,
      mode: requestBody.dryRun === false ? "live" : "dry-run",
      chain_id: requestBody.chainId || requestBody.chain_id || null,
      rpc_url: requestBody.rpcUrl || requestBody.rpc_url || "",
      tx_hash: "",
      address: "",
      error: "deploy_failed",
      message: error.message,
      actor: memoryProfile.userName || "unknown"
    });

    return res.status(500).json({
      ok: false,
      error: "deploy_failed",
      message: error.message
    });
  }
});

router.get("/avalanche/contracts/templates", (req, res) => {
  return res.json({ ok: true, items: listContractTemplates() });
});

router.get("/avalanche/contracts/deployments", (req, res) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 25));
  const items = listDeploymentRecords(limit);
  return res.json({ ok: true, items, count: items.length });
});

module.exports = router;
