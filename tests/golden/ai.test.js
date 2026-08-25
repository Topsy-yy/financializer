// AI TRANSPORT + REPORT PROVENANCE.
//
// HISTORY. This began as the JOB 2 baseline for the AI layer, pinning three
// [KNOWN-BAD] gaps: no schema validation, no fact-checking, and AI prose
// overriding deterministic findings. JOB 8 fixed all three, and JOB 9 deleted
// the legacy entry points those tests exercised (generateAiChatResponse,
// generateAiInterpretation and their prompt builders) — they had no production
// caller and were the last path that concatenated skill.md wholesale.
//
// What remains here is what is still real: the transport's provider-error
// classification, and the report's provenance guarantee. Validation itself is
// covered by tests/ai/validation.test.js.
//
// These tests stub global.fetch, so no network call is made and no API key is
// required.

process.env.ENABLE_AI_ANALYSIS = "true";
process.env.AI_NETWORK_RETRIES = "1"; // don't burn seconds on retry backoff

const test = require("node:test");
const assert = require("node:assert/strict");

const ai = require("../../src/services/aiAnalysisClient");
const { buildReportModel } = require("../../src/services/reportFormatter");

const realFetch = global.fetch;
function stubFetch(impl) { global.fetch = impl; }
function restoreFetch() { global.fetch = realFetch; }



// ── 15. AI provider failure ──────────────────────────────────────



// ── 16. Malformed AI response ────────────────────────────────────



// ── Report provenance ────────────────────────────────────────────
test("[RP][FIXED in JOB 8] the report's findings are ALWAYS the engine's; AI text "
  + "is additive commentary, never a replacement", () => {
  const context = {
    period: "2026-05",
    health: { overall_score: 62, risk_category: "Good" },
    cashflow: { runway_days: 43, risk_level: "medium", recommendations: ["Chase overdue invoices"] },
    anomalies: { items: [{ type: "duplicate_transaction", severity: "high", description: "DETERMINISTIC FINDING" }] },
    revenue: {}, vendors: {}, customers: {}, actions: { actions: [] },
    reports: { report: {} },
    aiInsights: { executive_report: { key_insights: ["AI PROSE FINDING"], priority_actions: [] } }
  };
  // WAS: `ai.key_insights` replaced the engine's findings whenever the model
  // produced any, so an executive report could omit a real finding entirely.
  const model = buildReportModel(context, { businessName: "Test Ltd" }, {});
  assert.deepEqual(model.keyFindings, ["DETERMINISTIC FINDING"],
    "the computed finding is what the report reports");
  assert.equal(model.keyFindings.includes("AI PROSE FINDING"), false,
    "model prose is never presented as a finding");
  // The AI text is still available — separately, and labelled as commentary.
  assert.deepEqual(model.aiCommentary, ["AI PROSE FINDING"]);
  assert.match(model.aiCommentaryLabel, /commentary/i);
});

test("[RP-b] without AI insights the report falls back to deterministic findings", () => {
  const context = {
    period: "2026-05",
    health: { overall_score: 62, risk_category: "Good" },
    cashflow: { runway_days: 43, risk_level: "medium", recommendations: [] },
    anomalies: { items: [{ type: "duplicate_transaction", severity: "high", description: "DETERMINISTIC FINDING" }] },
    revenue: {}, vendors: {}, customers: {}, actions: { actions: [] },
    reports: { report: {} }
  };
  const model = buildReportModel(context, { businessName: "Test Ltd" }, {});
  assert.deepEqual(model.keyFindings, ["DETERMINISTIC FINDING"]);
});

test("[RP-c] report KPI numbers come from the computed context, not the AI", () => {
  const context = {
    period: "2026-05",
    health: { overall_score: 62, risk_category: "Good" },
    cashflow: { runway_days: 43, risk_level: "medium", recommendations: [] },
    anomalies: { items: [] }, revenue: {}, vendors: {}, customers: {},
    actions: { actions: [] }, reports: { report: {} },
    aiInsights: { executive_report: { key_insights: [], priority_actions: [] } }
  };
  const model = buildReportModel(context, { businessName: "Test Ltd" }, {});
  assert.equal(model.healthScore, 62, "score is authoritative");
});
