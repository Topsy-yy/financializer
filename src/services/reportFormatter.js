// Formatting layer: turn the already-computed review context + AI insights into
// a normalized "report model" the PDF renderer consumes. This does NOT generate
// analysis — it reuses whatever getContext()/buildStructuredReport already produced.

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function buildReportModel(context, profile, opts) {
  opts = opts || {};
  const c = context || {};
  const report = (c.reports && c.reports.report) || {};
  const health = c.health || {};
  const cash = c.cashflow || {};
  const anomalies = (c.anomalies && c.anomalies.items) || [];
  const actions = (c.actions && c.actions.actions) || [];
  const ai = (c.aiInsights && c.aiInsights.executive_report) || {};
  const checklist = report.checklist || [];
  const company = report.company || {};
  const summary = report.summary || {};

  const executiveSummary =
    ai.executive_summary ||
    summary.headline ||
    (Array.isArray(summary.founderSummary) ? summary.founderSummary.join(" ") : "") ||
    health.summary ||
    "No executive summary is available yet. Run a monthly review to populate this report.";

  const keyFindings = (ai.key_insights && ai.key_insights.length)
    ? ai.key_insights.slice(0, 8)
    : anomalies.slice(0, 6).map((a) => a.description).filter(Boolean);

  const fraudIndicators = anomalies
    .filter((a) => /duplicat|round[- ]?number|fraud|outlier|personal|unreconcil/i.test(a.description || ""))
    .map((a) => a.description)
    .filter(Boolean);

  const recommendations = (ai.priority_actions && ai.priority_actions.length)
    ? ai.priority_actions.map((p) => (p.rank ? p.rank + ". " : "") + p.action + (p.why ? " — " + p.why : ""))
    : (cash.recommendations || []);

  return {
    brand: "FinGuard AI",
    title: opts.title || "Executive Financial Report",
    company: company.name || (profile && profile.businessName) || "Your Business",
    address: company.address || "",
    period: c.period || "Current period",
    generatedAt: new Date(),

    healthScore: toNum(health.overall_score),
    healthCategory: health.risk_category || "",
    riskLevel: cash.risk_level || health.risk_category || "Unknown",

    executiveSummary,
    keyFindings,
    riskBreakdown: [
      { label: "Cash-flow risk", value: (cash.risk_level || "—") },
      { label: "Anomalies flagged", value: String(anomalies.length) },
      { label: "Cash runway", value: (cash.runway_days != null ? cash.runway_days + " days" : "—") },
      { label: "Health category", value: (health.risk_category || "—") }
    ],
    cashflow: {
      net_cash_flow: toNum(cash.net_cash_flow),
      monthly_burn: toNum(cash.monthly_burn),
      runway_days: cash.runway_days != null ? cash.runway_days : null,
      overdue_receivables: toNum(cash.overdue_receivables)
    },
    fraudIndicators,
    checklist: checklist.map((ci) => ({ item: ci.item, count: ci.count, status: ci.status })),
    recommendations,
    whatWorking: ai.what_is_working || [],
    whatNeedsAttention: ai.what_needs_attention || [],
    followUpTasks: actions.map((a) => ({
      task: a.task, owner: a.owner, due: a.due, priority: a.priority, status: a.status
    }))
  };
}

module.exports = { buildReportModel };
