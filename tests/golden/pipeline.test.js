// BASELINE — the composed analysis pipeline over HTTP.
//
// This exercises the SEVEN financial functions that currently live inside
// src/routes/api.js (buildAnomalies, buildHealthSummary, buildCashFlowSummary,
// buildVendorSummary, buildCustomerSummary, buildRevenueSummary, buildContext).
// They are not exported, so HTTP is the only way to pin them before JOB 6 moves
// them into the domain layer.
//
// See tests/golden/engine.test.js for the [KNOWN-BAD] convention.

const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("../helpers/server");

let server;
let client;

test.before(async () => {
  // Demo data is now an EXPLICIT opt-in. Without it the app refuses to analyse
  // (proved by [NF] below) — so these analysis tests enable it deliberately.
  server = await startServer({ ALLOW_DEMO_DATA: "true" });
  client = server.client();
  // Establish a deterministic month of analysis for the whole file.
  const res = await client.post("/api/monthly-review", { month: "2026-05", use_ai_analysis: false });
  assert.equal(res.status, 200, "baseline analysis must succeed");
});

test.after(async () => { if (server) await server.stop(); });

// ── 5. Vendor concentration ──────────────────────────────────────
test("[5] vendor concentration is computed from actual transaction data", async () => {
  const { json } = await client.get("/api/vendors");
  const v = json.vendors;
  assert.ok(Array.isArray(v.vendor_list) && v.vendor_list.length > 0);
  const total = v.vendor_list.reduce((s, r) => s + r.percentage, 0);
  assert.ok(Math.abs(total - 100) < 1.5, `shares sum to ~100% (got ${total})`);
  assert.equal(typeof v.vendor_risk_score, "number");
  assert.ok(v.top_vendor && typeof v.top_vendor.amount === "number");
});

test("[5b][KNOWN-BAD] unattributed spend is bucketed as a vendor named 'Unknown Vendor'", async () => {
  const { json } = await client.get("/api/vendors");
  const names = json.vendors.vendor_list.map((r) => r.name);
  assert.ok(names.includes("Unknown Vendor"),
    "missing counterparty data becomes a concentration signal instead of a data-quality signal");
});

// ── 6. Customer concentration ────────────────────────────────────
test("[6][FIXED in JOB 3] unattributed revenue is reported honestly, never fabricated", async () => {
  // WAS: invented "BlueTech"/"Nova Retail"/"Eastline Logistics", a hardcoded
  // risk score of 72 and a HIGH finding about a nonexistent relationship.
  const { json, text } = await client.get("/api/customers");
  const c = json.customers;
  assert.deepEqual(c.customer_list, [], "no invented customers");
  assert.equal(c.customer_risk_score, null, "no fabricated score");
  assert.equal(c.available, false);
  assert.ok(c.unavailable_reason, `states WHY it is unavailable (${c.unavailable_reason})`);
  ["BlueTech", "Nova Retail", "Eastline Logistics"].forEach((n) =>
    assert.equal(text.includes(n), false, `${n} must never be returned`));
});

test("[6b][FIXED in JOB 3] an unmeasurable component is excluded, not invented", async () => {
  // WAS: the fabricated 72 became customer_risk = 28 at 15% weight.
  const { json } = await client.get("/api/health-score");
  assert.equal(json.health.component_scores.customer_risk, null, "unmeasured, not guessed");
  assert.ok(!json.health.measured_components.includes("customer_risk"));
  assert.ok(json.health.weakest_component, "the score still explains itself");
});

// ── Health score composition ─────────────────────────────────────
test("[H] health score exposes component scores and a category", async () => {
  const { json } = await client.get("/api/health-score");
  const h = json.health;
  assert.equal(typeof h.overall_score, "number");
  assert.ok(h.overall_score >= 0 && h.overall_score <= 100);
  assert.deepEqual(Object.keys(h.component_scores).sort(),
    ["cash_flow", "customer_risk", "fraud_indicators", "revenue_stability", "vendor_risk"]);
  assert.ok(["Excellent", "Good", "Fair", "Poor", "Critical"].includes(h.risk_category));
});

test("[H2][FIXED in JOB 3] the cash-flow component uses the real 0-100 score", async () => {
  // WAS: a dead read of `cashflow.risk_score` confined the 30%-weighted
  // component to 20/45/75.
  const health = (await client.get("/api/health-score")).json.health;
  const cash = (await client.get("/api/cashflow")).json.cashflow;
  assert.equal(typeof cash.risk_score, "number", "risk_score is now populated");
  assert.equal(health.component_scores.cash_flow, 100 - cash.risk_score,
    "the component derives from the engine's actual score");
});

test("[H3][FIXED in JOB 3] the health summary is derived from the weakest component", async () => {
  // WAS: "strongest pressure from cashflow and concentration risk", asserted
  // unconditionally regardless of the actual component scores.
  const { json } = await client.get("/api/health-score");
  const h = json.health;
  assert.doesNotMatch(h.summary, /strongest pressure from cashflow and concentration risk/);
  assert.ok(h.weakest_component, "names the weakest component");
  assert.ok(h.summary.includes(String(h.overall_score)), "quotes the actual score");
  assert.ok(h.calculation, "the arithmetic is available for inspection");
});

// ── Findings shape ───────────────────────────────────────────────
test("[F][FIXED in JOB 3] findings carry evidence, rule provenance and a calculation", async () => {
  // WAS: {type, severity, description} prose triples with nothing else.
  const { json } = await client.get("/api/anomalies");
  const items = (json.anomalies && json.anomalies.items) || [];
  assert.ok(items.length > 0, "the month produces findings");
  items.forEach((f) => {
    assert.ok(f.id, "stable finding id");
    assert.ok(f.rule_id && f.rule_version, "rule provenance");
    assert.ok(f.calculation, "explains its own arithmetic");
    assert.ok(Array.isArray(f.evidence), "evidence array present");
    assert.equal(typeof f.is_data_quality, "boolean", "data-quality is distinguished");
    // Legacy contract preserved for the existing frontend.
    assert.ok(f.type && f.severity && f.description);
  });
  const withSource = items.filter((f) => (f.source_record_ids || []).length > 0);
  assert.ok(withSource.length > 0, "at least one finding cites source records");
});

// ── AI-independence (mandate §17) ────────────────────────────────
test("[AI-FREE] the full deterministic pipeline runs with AI disabled", async () => {
  // The server for this suite runs with ENABLE_AI_ANALYSIS=false.
  for (const path of ["/api/health-score", "/api/cashflow", "/api/anomalies", "/api/vendors", "/api/customers", "/api/revenue"]) {
    const res = await client.get(path);
    assert.equal(res.status, 200, `${path} must not require AI`);
  }
  const forecast = await client.post("/api/forecast", {});
  assert.equal(forecast.status, 200);
  assert.equal(forecast.json.ok, true, "forecast numbers are produced without AI");
});

test("[AI-FREE-2] credits do not gate deterministic analysis", async () => {
  // Deterministic analysis completes before any entitlement/credit check.
  const res = await client.post("/api/monthly-review", { month: "2026-04", use_ai_analysis: false });
  assert.equal(res.status, 200);
  assert.ok(res.json.review, "review is returned regardless of AI credit state");
});

// ── No silent fabrication (JOB 4) ────────────────────────────────
test("[NF] with no data source and demo disabled, analysis is REFUSED", async () => {
  const bare = await startServer({ ALLOW_DEMO_DATA: "false" });
  try {
    const c = bare.client();
    const res = await c.post("/api/monthly-review", { month: "2026-05", use_ai_analysis: false });
    assert.equal(res.status, 409, "no fabricated analysis is produced");
    assert.equal(res.json.error, "no_data_source");
    assert.match(res.json.message, /Connect Zoho Books or upload a CSV/);
  } finally {
    await bare.stop();
  }
});

test("[NF2] an invalid period is rejected, never silently swapped", async () => {
  const c = server.client();
  const res = await c.post("/api/monthly-review", { month: "2026-99", use_ai_analysis: false });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, "invalid_period");
});

test("[NF3] demo-sourced analysis is labelled in the response", async () => {
  const c = server.client();
  const res = await c.post("/api/monthly-review", { month: "2026-05", use_ai_analysis: false });
  assert.equal(res.status, 200);
  assert.ok(res.json.data_quality, "every analysis carries a data-quality report");
  assert.ok(
    (res.json.ingestion_warnings || []).some((w) => w.code === "demo_data"),
    "the caller is told this is demo data"
  );
});
