const express = require("express");
const config = require("../config");
const { fetchMonthlyData } = require("../services/zohoClient");
const { analyzeFinancialRisk } = require("../services/riskEngine");
const { buildStructuredReport } = require("../services/reportBuilder");
const { runFollowUpWorkflow } = require("../services/followUpWorkflow");
const { getCoreWalletIntegrationSummary } = require("../services/coreWalletClient");

const router = express.Router();

let memoryProfile = {
  userName: config.userName || "Aisha",
  businessName: config.businessName || "ABC Traders Ltd",
  zohoApiKey: config.zohoApiKey || "",
  walletAddress: ""
};

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
function buildChatResponse(intent, analysis, month) {
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
      text = `Hello! I'm your AI Financial Controller. I can analyze your financial data, detect anomalies, assess risks, and suggest follow-up actions. Select a month from the sidebar or ask me a specific question.`;
      html = `<p>Hello! I'm your <strong>AI Financial Controller</strong>.</p>
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

router.get("/profile", (req, res) => {
  const zohoConnected = Boolean(memoryProfile.zohoApiKey || config.zohoDirectApiUrl);
  const zohoState = zohoConnected ? "configured" : "not configured";
  const walletConnected = Boolean(memoryProfile.walletAddress);

  res.json({
    ok: true,
    profile: {
      businessName: memoryProfile.businessName,
      userName: memoryProfile.userName,
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
        getCoreWalletIntegrationSummary()
      ]
    },
    now: new Date().toISOString()
  });
});

router.post("/profile", (req, res) => {
  const { userName, businessName, zohoApiKey, walletAddress } = req.body || {};
  if (userName) memoryProfile.userName = userName;
  if (businessName) memoryProfile.businessName = businessName;
  if (zohoApiKey) memoryProfile.zohoApiKey = zohoApiKey;
  if (walletAddress !== undefined) memoryProfile.walletAddress = walletAddress;
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

    res.json({
      ok: true,
      report,
      followUp,
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

router.post("/chat", async (req, res) => {
  try {
    const { message, activeMonth, history } = req.body || {};

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
    const response = buildChatResponse(intent, analysis, targetMonth);

    res.json({
      ok: true,
      intent,
      text: response.text,
      html: response.html,
      suggestions: response.suggestions,
      hint: "Ask me about cash flow, risks, anomalies, or expenses.",
      context: {
        month: targetMonth
      }
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

module.exports = router;
