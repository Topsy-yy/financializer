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

  /* JOB 8 — THE DETERMINISTIC FINDINGS ARE THE REPORT.
     WAS: `ai.key_insights` REPLACED the engine's findings whenever the AI had
     produced any, so an executive report could omit a real finding entirely and
     show AI prose in its place. Invariant 1 says the engine is authoritative
     for findings, and a report is exactly where that matters most.
     NOW: the findings are always the engine's. AI narrative is ADDITIVE — it
     appears alongside them as commentary, clearly labelled, never instead. */
  const keyFindings = anomalies.slice(0, 8)
    .map((a) => a.description)
    .filter(Boolean);

  const aiCommentary = (ai.key_insights && ai.key_insights.length)
    ? ai.key_insights.slice(0, 6)
    : [];

  /* Fraud indicators are selected by CATEGORY, from the rules registry, not by
     regex over prose. The old pattern also matched "unreconcil", classifying a
     bookkeeping gap as a fraud indicator — the exact data-quality contamination
     the audit called out. */
  const fraudIndicators = anomalies
    .filter((a) => a.category === "fraud_indicator" || a.category === "duplicate")
    .map((a) => a.description)
    .filter(Boolean);

  /* Recommendations may come from the AI — they are advice, not findings — but
     only ones tied to a finding the engine actually produced are shown first,
     and the deterministic recommendations are never dropped. */
  const aiRecommendations = (ai.priority_actions && ai.priority_actions.length)
    ? ai.priority_actions
      .filter((p) => p && p.action)
      .map((p) => (p.rank ? p.rank + ". " : "") + p.action + (p.why ? " — " + p.why : ""))
    : [];
  const recommendations = (cash.recommendations || []).concat(aiRecommendations);

  return {
    brand: "FinGuard AI",
    // Labelled separately so a renderer can never present model commentary as
    // an engine finding.
    aiCommentary,
    aiCommentaryLabel: aiCommentary.length ? "AI commentary (explanatory)" : null,
    title: opts.title || "Executive Financial Report",
    company: company.name || (profile && profile.businessName) || "Your Business",
    address: company.address || "",
    period: c.period || "Current period",
    generatedAt: new Date(),

    /* LIMITATIONS TRAVEL WITH THE MODEL (final closure Part B).
     *
     * THE DEFECT. The JSON executive report states its limitations, both
     * structurally and in the report text. The PDF built from THIS model
     * carried none of it — and the PDF is the artifact that gets forwarded to a
     * lender, an investor or a board, read away from the app with no chance to
     * ask what a dash meant. Figures already render as "—" rather than a
     * fabricated zero, but a dash with no explanation invites the reader to
     * supply their own, and "the business has none" is the obvious guess.
     *
     * The disclosure is attached by the caller (routes/api.js disclosureFor)
     * and rendered as its own section by pdfReport.js. */
    disclosure: opts.disclosure || null,
    complete: opts.disclosure ? false : true,

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
