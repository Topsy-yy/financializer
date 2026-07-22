const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const config = require("../config");
const { fetchMonthlyData } = require("../services/zohoClient");
const zohoBooksClient = require("../services/zohoBooksClient");
const { parseFinancialCsv } = require("../services/csvFinancialImporter");
const { analyzeFinancialRisk } = require("../services/riskEngine");
const { buildStructuredReport } = require("../services/reportBuilder");
const { runFollowUpWorkflow } = require("../services/followUpWorkflow");
const { getCoreWalletIntegrationSummary } = require("../services/coreWalletClient");
const { deployCChainContract } = require("../services/avalancheContractDeployer");
const { appendDeploymentRecord, listDeploymentRecords } = require("../services/contractDeploymentHistory");
const { listContractTemplates } = require("../services/contractTemplateRegistry");
const { createNonce, verifySignature } = require("../services/walletAuth");
const { verifyDeploymentTx } = require("../services/onchainVerifier");
const { ethers } = require("ethers");
const { generateAiChatResponse, generateAiInterpretation } = require("../services/aiAnalysisClient");
const googleAuth = require("../services/googleAuth");

const router = express.Router();

function defaultProfile() {
  return {
    userName: config.userName || "Aisha",
    businessName: config.businessName || "ABC Traders Ltd",
    zohoApiKey: config.zohoApiKey || "",
    zohoOrgId: "",
    zohoRefreshToken: "",
    zohoApiDomain: "",
    zohoTokenExpiresAt: null,
    walletAddress: "",
    walletVerified: false,
    walletChainId: null,
    aiProvider: "openai",
    aiApiKey: "",
    aiAssistant: "controller-core",
    googleSub: "",
    googleName: "",
    googleEmail: "",
    googlePicture: ""
  };
}

function safeDirName(id) {
  return String(id || "guest").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 128) || "guest";
}

/* Every visitor -- a Google-authenticated user or an anonymous guest/demo
   session -- gets fully isolated profile, review history, uploaded data,
   and on-disk report storage. Nothing is shared across users. */
const userStores = new Map();

// Sentinel the frontend echoes back for fields it never received the real
// value of (see GET /profile below) -- must never be written back as data.
const MASKED_VALUE = "***";

// A visible-but-safe preview (e.g. "sk-a1******3f9k") so a user can confirm
// which key is actually saved without the full secret ever reaching the
// browser -- more reassuring than a plain "configured: true" boolean.
function maskSecretPreview(secret) {
  const value = String(secret || "");
  if (value.length <= 8) return value ? "****" : "";
  return `${value.slice(0, 4)}${"*".repeat(Math.min(8, value.length - 8))}${value.slice(-4)}`;
}

function profileFilePath(reportsDir) {
  return path.join(reportsDir, "profile.json");
}

function persistProfile(userStore) {
  try {
    fs.writeFileSync(profileFilePath(userStore.reportsDir), JSON.stringify(userStore.profile, null, 2));
  } catch (e) {
    // Non-fatal: profile still works for the lifetime of this process.
  }
}

function loadPersistedProfile(reportsDir) {
  try {
    return JSON.parse(fs.readFileSync(profileFilePath(reportsDir), "utf-8"));
  } catch (e) {
    return null;
  }
}

function getUserId(req) {
  // express-session's default MemoryStore does not survive a process
  // restart (a dev-server reload, a redeploy, a crash) -- every active
  // Google-authenticated visitor would silently fall back to a brand new
  // guest identity and appear to lose their saved profile/API key. The
  // long-lived fg_google_sub cookie survives restarts, so prefer the live
  // session when we have it but fall back to the cookie rather than guest.
  if (req.session && req.session.googleUser && req.session.googleUser.sub) {
    return `google-${req.session.googleUser.sub}`;
  }
  if (req.cookies && req.cookies.fg_google_sub) {
    return `google-${req.cookies.fg_google_sub}`;
  }
  return `guest-${(req.cookies && req.cookies.fg_guest_id) || "anonymous"}`;
}

function getUserStoreById(id) {
  if (!userStores.has(id)) {
    const reportsDir = path.join(config.reportsDir, safeDirName(id));
    fs.mkdirSync(reportsDir, { recursive: true });
    // A dev-server restart (nodemon) or process redeploy would otherwise wipe
    // every profile back to defaults, silently losing saved API keys.
    const persisted = loadPersistedProfile(reportsDir);
    userStores.set(id, {
      id,
      profile: Object.assign(defaultProfile(), persisted || {}),
      latestReviewContext: null,
      reviewHistory: [],
      uploadedMonthlyData: {},
      reportsDir
    });
  }
  return userStores.get(id);
}

function getUserStore(req) {
  return getUserStoreById(getUserId(req));
}

router.use((req, res, next) => {
  req.userStore = getUserStore(req);
  next();
});

const oauthStateStore = new Map();

const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

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

function listReportFiles(reportsDir) {
  if (!fs.existsSync(reportsDir)) return [];

  return fs
    .readdirSync(reportsDir)
    .filter((name) => name.endsWith("-report.json"))
    .map((name) => {
      const fullPath = path.resolve(reportsDir, name);
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

  (detections.overdueReceivables || []).forEach((r) => {
    items.push({
      type: "overdue_receivable",
      severity: "high",
      description: `${r.customer || "Customer"} invoice overdue for ${formatMoney(r.amount)}${r.dueDate ? ` (due ${r.dueDate})` : ""}`
    });
  });

  (detections.overduePayables || []).forEach((p) => {
    items.push({
      type: "overdue_payable",
      severity: "medium",
      description: `${p.vendor || "Vendor"} bill overdue for ${formatMoney(p.amount)}${p.dueDate ? ` (due ${p.dueDate})` : ""}`
    });
  });

  (detections.missingReceipts || []).forEach((tx) => {
    items.push({
      type: "missing_documentation",
      severity: "low",
      description: `Expense missing a receipt: ${formatMoney(tx.amount)} (${tx.counterparty || tx.description || "unknown"})`
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

function buildRevenueSummary(monthlyData, period, reviewHistory) {
  const totalRevenue = toNumber(monthlyData.statements?.cashFlow?.inflow);

  const historyRows = (reviewHistory || [])
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
  // Real overdue amount (from Zoho invoice balance/due_date) when available;
  // falls back to a rough estimate for data sources with no receivables detail
  // (mock data, CSV imports).
  const hasRealOverdueData = Array.isArray(monthlyData.receivables);
  const overdueReceivables = hasRealOverdueData
    ? Math.round(toNumber(risk.overdueReceivablesTotal, 0))
    : Math.max(0, Math.round(Math.abs(toNumber(risk.netCashFlow, 0)) * 0.35));

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
    overdue_receivables: overdueReceivables,
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

function buildContext({ month, monthlyData, analysis, report, followUp, reviewHistory }) {
  const period = month || monthlyData.period || report.period || new Date().toISOString().slice(0, 7);
  const anomalies = {
    items: buildAnomalies(analysis.detections || {}),
    skills: ["fraud-and-errors-detector"]
  };
  const cashflow = buildCashFlowSummary(analysis, monthlyData);
  const vendors = buildVendorSummary(monthlyData);
  const customers = buildCustomerSummary(monthlyData);
  const revenue = buildRevenueSummary(monthlyData, period, reviewHistory);
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

function contextFromLatestReportDisk(reportsDir) {
  const files = listReportFiles(reportsDir);
  if (!files.length) return null;

  const latest = files[0];
  const report = JSON.parse(fs.readFileSync(latest.fullPath, "utf-8"));
  const reportPrefix = latest.name.replace(/-report\.json$/, "");
  const actionsCsv = path.resolve(reportsDir, `${reportPrefix}-actions.csv`);
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

function getContext(req) {
  if (req.userStore.latestReviewContext) return req.userStore.latestReviewContext;
  req.userStore.latestReviewContext = contextFromLatestReportDisk(req.userStore.reportsDir);
  return req.userStore.latestReviewContext;
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

router.get("/auth/session", (req, res) => {
  let googleUser = req.session && req.session.googleUser;

  // Session lost (e.g. server restarted) but the persistent cookie still
  // identifies this browser as a known Google user -- reconstruct their
  // display info from the profile we saved at login instead of silently
  // demoting them to a guest.
  if (!googleUser && req.cookies && req.cookies.fg_google_sub) {
    const store = getUserStoreById(`google-${req.cookies.fg_google_sub}`);
    if (store.profile.googleSub) {
      googleUser = {
        sub: store.profile.googleSub,
        name: store.profile.googleName,
        email: store.profile.googleEmail,
        picture: store.profile.googlePicture
      };
      req.session.googleUser = googleUser;
    }
  }

  const authenticated = Boolean(googleUser);
  res.json({
    ok: true,
    google_enabled: config.enableGoogleAuth,
    authenticated,
    user: authenticated
      ? {
        sub: googleUser.sub,
        name: googleUser.name || null,
        email: googleUser.email || null,
        picture: googleUser.picture || null
      }
      : null
  });
});

const googleOauthStateStore = new Map();

router.get("/auth/google/start", (req, res) => {
  if (!config.enableGoogleAuth) {
    return res.redirect("/app?auth=not_configured");
  }

  const now = Date.now();
  for (const [key, value] of googleOauthStateStore.entries()) {
    if (!value || value.expiresAt < now) googleOauthStateStore.delete(key);
  }

  const state = crypto.randomBytes(16).toString("hex");
  googleOauthStateStore.set(state, { expiresAt: now + 10 * 60 * 1000 });

  return res.redirect(googleAuth.buildAuthUrl(state));
});

router.get("/auth/google/callback", async (req, res) => {
  const { code, state, error } = req.query || {};

  if (error) {
    return res.redirect(`/app?auth=error&reason=${encodeURIComponent(String(error))}`);
  }
  if (!code || !state || !googleOauthStateStore.has(state)) {
    return res.redirect("/app?auth=error&reason=invalid_state");
  }
  googleOauthStateStore.delete(state);

  try {
    const tokens = await googleAuth.exchangeCodeForTokens(String(code));
    const profile = await googleAuth.fetchUserInfo(tokens.access_token);

    req.session.googleUser = profile;
    // req.userStore was already resolved by the router-level middleware using
    // whatever identity this request arrived with (a guest, most likely) --
    // fetch/create the REAL google-scoped store directly so login info lands
    // in the right place, and set a persistent cookie so this identity
    // survives a lost session (see getUserId).
    const googleStore = getUserStoreById(`google-${profile.sub}`);
    googleStore.profile.googleSub = profile.sub;
    googleStore.profile.googleName = profile.name || "";
    googleStore.profile.googleEmail = profile.email || "";
    googleStore.profile.googlePicture = profile.picture || "";
    persistProfile(googleStore);

    res.cookie("fg_google_sub", profile.sub, {
      maxAge: 400 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: "lax"
    });

    return res.redirect("/app?auth=success");
  } catch (exchangeError) {
    return res.redirect(`/app?auth=error&reason=${encodeURIComponent(exchangeError.message || "google_auth_failed")}`);
  }
});

router.get("/auth/google/logout", (req, res) => {
  if (req.session) req.session.googleUser = null;
  res.clearCookie("fg_google_sub");
  res.redirect("/app");
});

router.post("/financial-data/upload", csvUpload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "No file uploaded. Attach a CSV file." });
    }

    const period = String((req.body || {}).period || "").trim();
    if (!/^\d{4}-\d{2}$/.test(period)) {
      return res.status(400).json({ ok: false, error: "A valid period (YYYY-MM) is required." });
    }

    const currentCashBalance = (req.body || {}).currentCashBalance;
    const csvText = req.file.buffer.toString("utf-8");

    const monthlyData = parseFinancialCsv({
      csvText,
      period,
      businessName: req.userStore.profile.businessName,
      currentCashBalance
    });

    req.userStore.uploadedMonthlyData[period] = monthlyData;

    return res.json({
      ok: true,
      period,
      summary: {
        transaction_count: monthlyData.transactions.length,
        skipped_rows: monthlyData.meta.skippedRows,
        inflow: monthlyData.statements.cashFlow.inflow,
        outflow: monthlyData.statements.cashFlow.outflow,
        net_income: monthlyData.statements.profitAndLoss.netIncome,
        cash_and_equivalents: monthlyData.statements.balanceSheet.cashAndEquivalents
      }
    });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
});

router.get("/financial-data/uploads", (req, res) => {
  const periods = Object.keys(req.userStore.uploadedMonthlyData).sort().reverse();
  res.json({ ok: true, periods });
});

router.get("/oauth/zoho/start", (req, res) => {
  if (!hasZohoOAuthConfig()) {
    return res.redirect("/app?oauth=not_configured");
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
    return res.redirect(`/app?oauth=error&reason=${encodeURIComponent(String(error))}`);
  }

  if (!code || !state || !oauthStateStore.has(state)) {
    return res.redirect("/app?oauth=error&reason=invalid_state");
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
      return res.redirect(`/app?oauth=error&reason=${encodeURIComponent(String(reason))}`);
    }

    req.userStore.profile.zohoApiKey = tokenData.access_token;
    req.userStore.profile.zohoRefreshToken = tokenData.refresh_token || req.userStore.profile.zohoRefreshToken;
    req.userStore.profile.zohoTokenExpiresAt = Date.now() + (Number(tokenData.expires_in) || 3600) * 1000;
    if (tokenData.api_domain) req.userStore.profile.zohoApiDomain = tokenData.api_domain;

    if (pendingProfile?.name) req.userStore.profile.userName = pendingProfile.name;
    if (pendingProfile?.businessName) req.userStore.profile.businessName = pendingProfile.businessName;
    if (pendingProfile?.zohoOrgId) req.userStore.profile.zohoOrgId = pendingProfile.zohoOrgId;

    persistProfile(req.userStore);
    return res.redirect("/app?oauth=success");
  } catch (exchangeError) {
    return res.redirect(`/app?oauth=error&reason=${encodeURIComponent(exchangeError.message || "token_exchange_failed")}`);
  }
});

router.post("/oauth/zoho/disconnect", (req, res) => {
  req.userStore.profile.zohoApiKey = "";
  req.userStore.profile.zohoRefreshToken = "";
  req.userStore.profile.zohoOrgId = "";
  req.userStore.profile.zohoApiDomain = "";
  req.userStore.profile.zohoTokenExpiresAt = null;
  persistProfile(req.userStore);
  res.json({ ok: true });
});

router.get("/profile", (req, res) => {
  const zohoConnected = Boolean(req.userStore.profile.zohoApiKey || config.zohoDirectApiUrl);
  const zohoState = zohoConnected ? "configured" : "not configured";
  const walletConnected = Boolean(req.userStore.profile.walletAddress);
  const aiConnected = Boolean(req.userStore.profile.aiApiKey);

  res.json({
    ok: true,
    profile: {
      businessName: req.userStore.profile.businessName,
      userName: req.userStore.profile.userName,
      business_name: req.userStore.profile.businessName,
      name: req.userStore.profile.userName,
      zoho_connected: zohoConnected,
      zoho_oauth_configured: hasZohoOAuthConfig(),
      zoho_org_id: req.userStore.profile.zohoOrgId,
      wallet_address: req.userStore.profile.walletAddress,
      wallet_verified: Boolean(req.userStore.profile.walletVerified),
      wallet_chain_id: req.userStore.profile.walletChainId,
      zoho_api_key: req.userStore.profile.zohoApiKey ? MASKED_VALUE : "",
      ai_provider: req.userStore.profile.aiProvider,
      ai_assistant: req.userStore.profile.aiAssistant,
      ai_api_key: req.userStore.profile.aiApiKey ? MASKED_VALUE : "",
      ai_api_key_configured: Boolean(req.userStore.profile.aiApiKey),
      ai_api_key_preview: maskSecretPreview(req.userStore.profile.aiApiKey),
      businessAddress: config.businessAddress,
      ownerKeywordHints: config.businessOwnerKeywords,
      integrations: [
        {
          label: "Avalanche Wallet",
          connected: walletConnected,
          state: req.userStore.profile.walletVerified ? "verified" : (walletConnected ? "unverified" : "not connected"),
          secureReference: "***",
          note: req.userStore.profile.walletVerified
            ? "Wallet ownership verified by signature"
            : (walletConnected ? "Wallet address set but not signature-verified" : "No wallet connected")
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
          note: `Assistant: ${req.userStore.profile.aiAssistant} (${req.userStore.profile.aiProvider})`
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

  if (resolvedName) req.userStore.profile.userName = resolvedName;
  if (resolvedBusinessName) req.userStore.profile.businessName = resolvedBusinessName;
  // GET /profile echoes "***" for any already-set secret so it never leaves
  // the server in the clear. If the client sends that same sentinel back
  // (e.g. it round-tripped an unmodified form field), treat it as "unchanged"
  // rather than overwriting the real secret with the literal string "***".
  if (resolvedZoho && resolvedZoho !== MASKED_VALUE) req.userStore.profile.zohoApiKey = resolvedZoho;
  if (resolvedZohoOrgId) req.userStore.profile.zohoOrgId = resolvedZohoOrgId;
  if (resolvedWallet !== undefined && resolvedWallet !== req.userStore.profile.walletAddress) {
    req.userStore.profile.walletAddress = resolvedWallet;
    req.userStore.profile.walletVerified = false;
    req.userStore.profile.walletChainId = null;
  }
  if (resolvedAiProvider) req.userStore.profile.aiProvider = resolvedAiProvider;
  if (resolvedAiApiKey && resolvedAiApiKey !== MASKED_VALUE) req.userStore.profile.aiApiKey = resolvedAiApiKey;
  if (resolvedAiAssistant) req.userStore.profile.aiAssistant = resolvedAiAssistant;
  persistProfile(req.userStore);
  res.json({ ok: true });
});

router.post("/monthly-review", async (req, res) => {
  try {
    const { month, directApiUrl, apiKey, businessName, businessAddress, use_ai_analysis } = req.body || {};

    const uploaded = month ? req.userStore.uploadedMonthlyData[month] : null;
    let monthlyData;

    if (uploaded) {
      monthlyData = uploaded;
    } else if (req.userStore.profile.zohoRefreshToken) {
      // Real Zoho Books OAuth connection on file -- pull actual data.
      try {
        monthlyData = await zohoBooksClient.fetchMonthlyDataFromZoho(req.userStore.profile, month);
      } catch (zohoError) {
        return res.status(502).json({
          ok: false,
          error: "zoho_fetch_failed",
          message: zohoError.message || "Could not fetch data from Zoho Books."
        });
      }
    } else {
      monthlyData = await fetchMonthlyData({
        directApiUrl,
        apiKey: apiKey || req.userStore.profile.zohoApiKey,
        month
      });
    }

    const analysis = analyzeFinancialRisk(monthlyData);

    const report = buildStructuredReport({
      businessName: businessName || req.userStore.profile.businessName,
      businessAddress: businessAddress || config.businessAddress,
      period: month || monthlyData.period || null,
      analysis
    });

    const followUp = await runFollowUpWorkflow(report, req.userStore.reportsDir);

    const context = buildContext({
      month,
      monthlyData,
      analysis,
      report,
      followUp,
      reviewHistory: req.userStore.reviewHistory
    });
    context.rawMonthlyData = monthlyData;
    context.rawAnalysis = analysis;
    req.userStore.latestReviewContext = context;

    const resolvedAiKey = req.userStore.profile.aiApiKey || "";
    const shouldUseAi = use_ai_analysis !== false;
    let aiAnalysis = {
      ok: false,
      mode: "skills-only",
      reason: "ai_not_requested"
    };

    if (shouldUseAi) {
      if (resolvedAiKey) {
        // The deterministic skill engine above (riskEngine.js + buildContext)
        // has already computed every number for this month. The AI only
        // interprets and narrates it -- explaining, prioritizing, and giving
        // it founder-friendly voice -- it never recomputes or overrides it.
        const aiResult = await generateAiInterpretation({
          apiKey: resolvedAiKey,
          provider: req.userStore.profile.aiProvider,
          businessName: businessName || req.userStore.profile.businessName,
          period: context.period,
          skillOutputs: {
            health: context.health,
            cashflow: context.cashflow,
            revenue: context.revenue,
            risk: context.anomalies,
            vendors: context.vendors,
            customers: context.customers,
            actions: context.actions
          }
        });

        if (aiResult.ok) {
          req.userStore.latestReviewContext.aiInsights = aiResult.output;

          aiAnalysis = {
            ok: true,
            mode: "ai+skills",
            provider: aiResult.provider,
            model: aiResult.model,
            insights: aiResult.output
          };
        } else {
          aiAnalysis = {
            ok: false,
            mode: "skills-fallback",
            reason: aiResult.reason || "ai_request_failed"
          };
        }
      } else {
        aiAnalysis = {
          ok: false,
          mode: "skills-fallback",
          reason: "missing_ai_api_key"
        };
      }
    }

    req.userStore.reviewHistory.push({ period: context.period, revenue: context.revenue.total_revenue });
    if (req.userStore.reviewHistory.length > 36) req.userStore.reviewHistory.shift();

    res.json({
      ok: true,
      report,
      followUp,
      review: context.overview,
      aiAnalysis,
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
  const context = getContext(req);
  if (!context) return res.json({ ok: false, error: "Run monthly review first." });
  res.json({
    ok: true,
    health: context.health,
    skills: ["financial-health-scorer"],
    ai_insights: context.aiInsights?.pages?.financial_health || null
  });
});

router.get("/cashflow", (req, res) => {
  const context = getContext(req);
  if (!context) return res.json({ ok: false, error: "Run monthly review first." });
  res.json({
    ok: true,
    cashflow: context.cashflow,
    skills: ["cashflow-risk-analyzer"],
    ai_insights: context.aiInsights?.pages?.cashflow || null
  });
});

router.get("/revenue", (req, res) => {
  const context = getContext(req);
  if (!context) return res.json({ ok: false, error: "Run monthly review first." });
  res.json({
    ok: true,
    revenue: context.revenue,
    skills: ["revenue-intelligence"],
    ai_insights: context.aiInsights?.pages?.revenue || null
  });
});

router.get("/anomalies", (req, res) => {
  const context = getContext(req);
  if (!context) return res.json({ ok: false, error: "Run monthly review first." });
  res.json({
    ok: true,
    anomalies: context.anomalies,
    skills: ["fraud-and-errors-detector"],
    ai_insights: context.aiInsights?.pages?.risk || null
  });
});

router.get("/vendors", (req, res) => {
  const context = getContext(req);
  if (!context) return res.json({ ok: false, error: "Run monthly review first." });
  res.json({
    ok: true,
    vendors: context.vendors,
    skills: ["vendor-dependency-detector"],
    ai_insights: context.aiInsights?.pages?.vendors || null
  });
});

router.get("/customers", (req, res) => {
  const context = getContext(req);
  if (!context) return res.json({ ok: false, error: "Run monthly review first." });
  res.json({
    ok: true,
    customers: context.customers,
    skills: ["customer-concentration-detector", "revenue-intelligence"],
    ai_insights: context.aiInsights?.pages?.customers || null
  });
});

router.get("/actions", (req, res) => {
  const context = getContext(req);
  if (!context) return res.json({ ok: false, error: "Run monthly review first." });
  res.json({
    ok: true,
    actions: context.actions.actions,
    skills: ["followup-orchestrator", "recommendation-engine"],
    ai_insights: context.aiInsights?.pages?.actions || null
  });
});

router.post("/executive-report", (req, res) => {
  const context = getContext(req);
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

  let lines = (templates[reportType] || templates.monthly_review)
    .concat(topFindings.length ? ["", "Top Findings:", ...topFindings] : ["", "Top Findings:", "- No critical findings."])
    .concat(topActions.length ? ["", "Action Center:", ...topActions] : ["", "Action Center:", "- No pending actions."]);

  const execInsights = context.aiInsights?.executive_report;
  if (execInsights) {
    lines = lines.concat([
      "",
      "=== AI Executive Insights ===",
      execInsights.executive_summary || "",
      "",
      execInsights.key_insights?.length ? "Key Insights:" : "",
      ...(execInsights.key_insights || []).map((item) => `- ${item}`),
      "",
      execInsights.what_is_working?.length ? "What's Working:" : "",
      ...(execInsights.what_is_working || []).map((item) => `- ${item}`),
      "",
      execInsights.what_needs_attention?.length ? "What Needs Attention:" : "",
      ...(execInsights.what_needs_attention || []).map((item) => `- ${item}`),
      "",
      execInsights.priority_actions?.length ? "Priority Actions:" : "",
      ...(execInsights.priority_actions || []).map((item) => `${item.rank}. ${item.action} -- ${item.why}`)
    ].filter((line) => line !== ""));
  }

  res.json({
    ok: true,
    report_type: reportType,
    report: lines.join("\n"),
    ai_generated: Boolean(execInsights),
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

    /* Reuse the same real data (uploaded CSV / real Zoho / mock) already shown
       on the dashboard for this month instead of re-fetching mock data blind. */
    const cachedContext = req.userStore.latestReviewContext;
    let monthlyData;
    let analysis;
    let chatContext;

    if (cachedContext && cachedContext.period === targetMonth && cachedContext.rawAnalysis) {
      monthlyData = cachedContext.rawMonthlyData;
      analysis = cachedContext.rawAnalysis;
      // Ground chat in whatever is already on the dashboard for this month --
      // AI-computed numbers when an AI key is configured, deterministic
      // skill-engine numbers otherwise. Never a second, possibly-divergent copy.
      chatContext = cachedContext;
    } else {
      const uploaded = req.userStore.uploadedMonthlyData[targetMonth];
      if (uploaded) {
        monthlyData = uploaded;
      } else if (req.userStore.profile.zohoRefreshToken) {
        monthlyData = await zohoBooksClient.fetchMonthlyDataFromZoho(req.userStore.profile, targetMonth);
      } else {
        monthlyData = await fetchMonthlyData({ month: targetMonth });
      }
      analysis = analyzeFinancialRisk(monthlyData);
      chatContext = buildContext({
        month: targetMonth,
        monthlyData,
        analysis,
        report: {},
        followUp: {},
        reviewHistory: req.userStore.reviewHistory
      });
    }

    const resolvedProvider = ai_provider || req.userStore.profile.aiProvider;
    const resolvedAssistant = ai_assistant || req.userStore.profile.aiAssistant;
    const resolvedAiKey = req.userStore.profile.aiApiKey || "";
    let aiFailureReason = null;

    if (resolvedAiKey) {
      const aiChat = await generateAiChatResponse({
        apiKey: resolvedAiKey,
        provider: resolvedProvider,
        assistant: resolvedAssistant,
        month: targetMonth,
        context: chatContext,
        message
      });

      if (aiChat.ok && aiChat.text) {
        return res.json({
          ok: true,
          intent: "ai_generated",
          reply: aiChat.text,
          text: aiChat.text,
          html: `<p>${escapeHtml(aiChat.text).replace(/\n/g, "<br>")}</p><p class=\"text-sm text-muted\" style=\"margin-top:0.75rem\">Assistant: <strong>${escapeHtml(resolvedAssistant)}</strong> via <strong>${escapeHtml(aiChat.provider)}</strong> · AI + skills context</p>`,
          suggestions: [
            "Show risk summary for this month",
            "What are the top 3 actions this week?",
            "Explain cash flow risk in plain terms"
          ],
          hint: "AI-powered response with skills context.",
          context: {
            month: targetMonth,
            assistant: resolvedAssistant,
            provider: aiChat.provider,
            model: aiChat.model,
            mode: "ai+skills"
          }
        });
      }

      aiFailureReason = aiChat.reason || "ai_request_failed";
    }

    /* Classify intent and build response */
    const intent = classifyIntent(message);
    const response = buildChatResponse(intent, analysis, targetMonth, {
      provider: resolvedProvider,
      assistant: resolvedAssistant
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
        assistant: resolvedAssistant,
        provider: resolvedProvider,
        mode: "skills-first",
        ai_error: aiFailureReason
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
      actor: req.userStore.profile.userName || "unknown"
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
      actor: req.userStore.profile.userName || "unknown"
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

router.get("/avalanche/networks", (req, res) => {
  return res.json({ ok: true, items: Object.values(config.avalancheNetworks) });
});

router.get("/wallet/nonce", (req, res) => {
  const address = String(req.query.address || "").trim();
  if (!ethers.isAddress(address)) {
    return res.status(400).json({ ok: false, error: "invalid_address" });
  }
  const message = createNonce(address);
  return res.json({ ok: true, message });
});

router.post("/wallet/verify", (req, res) => {
  const { address, signature, chainId, chain_id } = req.body || {};
  if (!ethers.isAddress(address) || !signature) {
    return res.status(400).json({ ok: false, error: "address and signature are required" });
  }

  const result = verifySignature(address, signature);
  if (!result.ok) {
    return res.status(401).json({ ok: false, error: result.error });
  }

  req.userStore.profile.walletAddress = result.address;
  req.userStore.profile.walletVerified = true;
  req.userStore.profile.walletChainId = Number(chainId || chain_id) || req.userStore.profile.walletChainId;
  persistProfile(req.userStore);

  return res.json({ ok: true, address: result.address, verified: true });
});

router.post("/avalanche/contracts/deployments/record", async (req, res) => {
  const body = req.body || {};
  const contractAddress = String(body.contractAddress || body.contract_address || "").trim();
  const txHash = String(body.txHash || body.tx_hash || "").trim();
  const chainId = Number(body.chainId || body.chain_id);
  const deployerAddress = String(body.deployerAddress || body.deployer_address || "").trim();
  const contractName = body.contractName || body.contract_name || "Contract";
  const templateId = body.templateId || body.template_id || null;

  if (!ethers.isAddress(contractAddress) || !/^0x[0-9a-fA-F]{64}$/.test(txHash) || !chainId) {
    return res.status(400).json({
      ok: false,
      error: "contractAddress, txHash and chainId are required and must be valid"
    });
  }

  const verification = await verifyDeploymentTx({ chainId, txHash, contractAddress });

  appendDeploymentRecord({
    contract_name: contractName,
    template_id: templateId,
    receiver_address: deployerAddress,
    dry_run: false,
    ok: verification.verified,
    mode: "wallet-signed",
    chain_id: chainId,
    rpc_url: "",
    tx_hash: txHash,
    address: contractAddress,
    error: verification.verified ? "" : (verification.reason || "unverified"),
    message: verification.verified
      ? "Deployment confirmed on-chain."
      : `Could not fully verify on-chain (${verification.reason || "unknown"}). Recorded as reported by wallet.`,
    verified: verification.verified,
    actor: req.userStore.profile.userName || "unknown"
  });

  return res.json({ ok: true, verified: verification.verified, reason: verification.reason });
});

module.exports = router;
