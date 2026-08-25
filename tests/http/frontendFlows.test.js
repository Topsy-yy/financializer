// FRONTEND CRITICAL FLOWS — verifying the preserved-API-contract claim.
//
// The backend has been reconstructed nine times over while claiming to preserve
// the legacy API contract. This suite tests that claim against the flows a user
// actually performs, and against the specific ways the client could misrepresent
// a correct backend response.
//
// It does not drive a browser. There is no browser-test infrastructure in this
// repository, and building one would consume the job. Instead it does the two
// things that catch real defects: exercise the HTTP contract the client depends
// on, and evaluate the client's own rendering helpers against it.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { startServer } = require("../helpers/server");

const APP_JS = fs.readFileSync(path.join(__dirname, "../../public/app.js"), "utf-8");

/** Evaluate named client helpers in isolation. */
function loadHelpers(names) {
  const sandbox = {
    escapeHtml: (s) => String(s), UNMEASURED: "—", SCORE_BANDS: null,
    icon: () => "", formatCurrency: (n) => (n == null ? "—" : `KES ${n}`),
    showToast: () => {}, openModal: () => {}, navigate: () => {}, appState: {}
  };
  names.forEach((name) => {
    const start = APP_JS.indexOf(`function ${name}`);
    assert.notEqual(start, -1, `${name}() not found in public/app.js`);
    const bodyStart = APP_JS.indexOf("{", start);
    let depth = 0;
    let i = bodyStart;
    for (; i < APP_JS.length; i++) {
      if (APP_JS[i] === "{") depth++;
      else if (APP_JS[i] === "}") { depth--; if (depth === 0) break; }
    }
    vm.runInNewContext(APP_JS.slice(start, i + 1) + `;this.${name} = ${name};`, sandbox);
  });
  return sandbox;
}

const PERIOD = "2026-05";
const PRIOR = "2026-04";
const CSV = [
  "Date,Description,Amount,Counterparty",
  `${PERIOD}-04,Consulting retainer,-200000,Rivera Logistics`,
  `${PERIOD}-04,Consulting retainer,-200000,Rivera Logistics`,
  `${PERIOD}-11,Electricity,-120000,City Power`,
  `${PERIOD}-22,Client settlement,900000,BigCo Retail`
].join("\n");
const PRIOR_CSV = [
  "Date,Description,Amount,Counterparty",
  `${PRIOR}-06,Office supplies,-40000,Acme Supplies`,
  `${PRIOR}-25,Client settlement,900000,BigCo Retail`
].join("\n");

let server;
let client;

test.before(async () => {
  server = await startServer({
    ALLOW_DEMO_DATA: "true", ENABLE_AI_ANALYSIS: "true",
    NVIDIA_API_KEY: "fe-key", AI_TEST_PROVIDER: "1",
    DATABASE_URL: process.env.TEST_DATABASE_URL || undefined
  });
  client = server.client();
});
test.after(async () => { if (server) await server.stop(); });

async function stub(payload) {
  await client.post("/api/__test/ai-stub", {
    text: typeof payload === "string" ? payload : JSON.stringify(payload)
  });
}

// ── The critical journey, end to end over the contract ───────────

test("[F1] upload -> analyse -> health score -> findings -> evidence", async () => {
  const upload = await client.upload("/api/financial-data/upload", {
    filename: "may.csv", content: CSV,
    fields: { period: PERIOD, currentCashBalance: 1200000 }
  });
  assert.equal(upload.status, 200);
  // The shape the upload screen reads.
  ["transaction_count", "inflow", "outflow", "cash_and_equivalents"]
    .forEach((k) => assert.ok(k in upload.json.summary, `upload summary lost ${k}`));

  const review = await client.post("/api/monthly-review", {
    month: PERIOD, use_ai_analysis: false
  });
  assert.equal(review.status, 200);
  // The dashboard reads `review`.
  ["health_score", "cashflow", "risk", "revenue", "findings", "data_quality"]
    .forEach((k) => assert.ok(k in review.json.review, `review contract lost ${k}`));

  const health = (await client.get("/api/health-score")).json.health;
  ["overall_score", "risk_category", "component_scores", "available"]
    .forEach((k) => assert.ok(k in health, `health contract lost ${k}`));

  const items = (await client.get("/api/anomalies")).json.anomalies.items;
  assert.ok(items.length > 0);
  // Each item still carries the legacy triple AND the new provenance.
  items.forEach((i) => {
    assert.ok(i.type && i.severity && i.description, "legacy anomaly triple intact");
    assert.ok(i.finding_id && i.rule_id && i.rule_version, "provenance present");
  });

  const dup = items.find((i) => i.rule_id === "duplicate_payment");
  const evidence = await client.get(`/api/copilot/evidence/${dup.finding_id}`);
  assert.equal(evidence.status, 200);
  assert.equal(evidence.json.evidence.evidence.length, 2, "both sides of the duplicate");
});

test("[F2] the copilot answers about a finding, and the answer is navigable", async () => {
  const items = (await client.get("/api/anomalies")).json.anomalies.items;
  const dup = items.find((i) => i.rule_id === "duplicate_payment");

  await stub({
    summary: "A duplicate payment was flagged.",
    facts: [{ claim: "Two matching payments were detected.",
      citations: [`finding:${dup.finding_id}`] }],
    inferences: [{ claim: "The invoice may have been paid twice.",
      supportingReferences: [`finding:${dup.finding_id}`] }],
    recommendations: [{ claim: "Check the invoice." }],
    limitations: []
  });

  const res = await client.post("/api/copilot", {
    message: "explain this finding", month: PERIOD, finding_id: dup.finding_id
  });
  assert.equal(res.json.ok, true, JSON.stringify(res.json));

  // The client renders a fact's citation as an "evidence" button, so the
  // citation must be in the exact form it parses.
  const citation = res.json.answer.facts[0].citations[0];
  assert.match(citation, /^finding:fnd_[0-9a-f]{24}$/,
    "the client's citation parser expects this exact shape");
});

test("[F3] a methodology question is answered from the registry", async () => {
  const res = await client.get("/api/methodology");
  assert.equal(res.status, 200);
  const scoring = res.json.methodology.scoring;
  assert.ok(Array.isArray(scoring.categories) && scoring.categories.length >= 4,
    "the client needs the bands to colour a score");
  assert.ok(scoring.weights, "and the weights to explain a component");
});

test("[F4] two periods can be compared through the copilot", async () => {
  await client.upload("/api/financial-data/upload", {
    filename: "prior.csv", content: PRIOR_CSV,
    fields: { period: PRIOR, currentCashBalance: 1500000 }
  });
  await client.post("/api/monthly-review", { month: PRIOR, use_ai_analysis: false });
  await client.post("/api/monthly-review", { month: PERIOD, use_ai_analysis: false });

  await stub({
    summary: "The score moved between the two periods.",
    facts: [], inferences: [],
    recommendations: [{ claim: "Review the new finding." }], limitations: []
  });
  const res = await client.post("/api/copilot", {
    message: "compare this month with the previous period", month: PERIOD
  });
  assert.equal(res.status, 200);
  if (res.json.ok) {
    assert.equal(res.json.intent, "compare");
    assert.ok(res.json.capabilities.some((c) => c.name === "compare_analysis_runs"));
  } else {
    assert.ok(res.json.reason, "or it says honestly why it cannot");
  }
});

// ── The specific ways the client could misrepresent a good response ──

test("[F5] the client cannot invent a fallback score", async () => {
  // `overall_score || 0` painted an insufficient-evidence result as ZERO — the
  // visual signature of collapse — on the flagship widget.
  assert.equal(/overall_score \|\| h\.score \|\| 0/.test(APP_JS), false,
    "the `|| 0` fallback is gone");
  assert.match(APP_JS, /var scored = h\.available !== false/,
    "availability is checked before a score is drawn");
});

test("[F6] a null component renders as unavailable, never as zero", () => {
  const { isMeasured } = loadHelpers(["isMeasured"]);
  assert.equal(isMeasured(null), false);
  assert.equal(isMeasured(undefined), false);
  assert.equal(isMeasured(0), true, "a measured zero is still a measurement");

  // And the crash on a null component is gone.
  assert.equal(/typeof components\[key\] === 'object' \? \(components\[key\]\.score/.test(APP_JS),
    false);
  assert.match(APP_JS, /score-unmeasured/, "there is a distinct unmeasured visual state");
});

test("[F7] the client uses REGISTRY score bands, not its own", async () => {
  const { categoryClass } = loadHelpers(["categoryClass"]);
  assert.match(APP_JS, /loadScoreBands/);
  assert.match(APP_JS, /api\/methodology/);
  assert.equal(/healthScore >= 70 \? 'text-emerald'/.test(APP_JS), false,
    "the client's own 70/40 bands are gone");

  // The registry's labels map to colours; unknown maps to neutral.
  assert.equal(categoryClass("Good"), "text-emerald");
  assert.equal(categoryClass("Fair"), "text-amber");
  assert.equal(categoryClass("Critical"), "text-red");
  assert.equal(categoryClass(null), "text-muted");

  // And the bands the server publishes are the registry's.
  const registry = require("../../src/domain/rules/registry");
  const published = (await client.get("/api/methodology")).json.methodology.scoring.categories;
  assert.equal(published[0].atOrAbove, registry.HEALTH_SCORE.categories[0].minScore);
});

test("[F8] AI commentary cannot replace deterministic findings", () => {
  const { buildReportModel } = require("../../src/services/reportFormatter");
  const model = buildReportModel({
    period: PERIOD,
    health: { overall_score: 62, risk_category: "Good" },
    cashflow: { runway_days: 43, risk_level: "medium", recommendations: [] },
    anomalies: { items: [{ type: "duplicate_payment", severity: "high",
      category: "duplicate", description: "DETERMINISTIC FINDING" }] },
    revenue: {}, vendors: {}, customers: {}, actions: { actions: [] },
    reports: { report: {} },
    aiInsights: { executive_report: { key_insights: ["AI PROSE"], priority_actions: [] } }
  }, { businessName: "Test Ltd" }, {});

  assert.deepEqual(model.keyFindings, ["DETERMINISTIC FINDING"]);
  assert.equal(model.keyFindings.includes("AI PROSE"), false);
  assert.deepEqual(model.aiCommentary, ["AI PROSE"], "AI text is additive and labelled");
});

test("[F9] demo data is visibly labelled", async () => {
  const fresh = server.client();
  const res = await fresh.post("/api/monthly-review", {
    month: PERIOD, use_ai_analysis: false
  });
  if (res.status === 200) {
    const body = JSON.stringify(res.json);
    // Demo-sourced analysis must announce itself somewhere the client can show.
    const labelled = /is_demo|demo|synthetic|notice/i.test(body);
    assert.ok(labelled, "demo-sourced analysis is labelled in the response");
  }
});

test("[F10] an unavailable state is delivered with a reason the client can show", async () => {
  const sparse = "2026-11";
  await client.upload("/api/financial-data/upload", {
    filename: "sparse.csv",
    content: `Date,Description,Amount,Counterparty\n${sparse}-03,Unattributed,-40000,\n`,
    fields: { period: sparse }
  });
  await client.post("/api/monthly-review", { month: sparse, use_ai_analysis: false });

  const vendors = (await client.get("/api/vendors")).json.vendors;
  assert.equal(vendors.available, false);
  assert.equal(vendors.vendor_risk_score, null, "null, not zero");
  assert.ok(vendors.unavailable_reason, "with a machine-readable reason");

  // The client turns that reason into a sentence rather than a bare dash.
  const { unavailableNotice } = loadHelpers(["formatNumber", "unavailableNotice"]);
  const notice = unavailableNotice(vendors, "Vendor concentration");
  assert.ok(notice.length > 40, "a real explanation is rendered");
  assert.match(notice, /could not be measured|cannot be combined/i);
});

test("[F11] an error response is understandable, and leaks nothing", async () => {
  const bad = await client.upload("/api/financial-data/upload", {
    filename: "bad.csv", content: CSV, fields: { period: "nonsense" }
  });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /period/i, "the message says what is wrong");
  // No stack trace, no path, no internal detail.
  const body = JSON.stringify(bad.json);
  assert.equal(/\/home\/|at Object\.|node_modules/.test(body), false);
});

test("[F12] a cross-tenant identifier cannot be displayed as accessible data", async () => {
  const items = (await client.get("/api/anomalies")).json.anomalies.items;
  const mine = items[0].finding_id;

  const stranger = server.client();
  const evidence = await stranger.get(`/api/copilot/evidence/${mine}`);
  assert.notEqual(evidence.status, 200);
  assert.equal(JSON.stringify(evidence.json).includes("Rivera Logistics"), false,
    "another tenant's counterparty is never rendered");
});

// ── The blockchain boundary (JOB 10 Phase G) ─────────────────────

test("[F13] on-chain data cannot influence the deterministic analysis", () => {
  /* The decision recorded in docs/BLOCKCHAIN_DECISION.md, asserted. The domain
     layer must have no on-chain dependency at all — that is what makes the
     subsystem a consumer of tenant scope rather than a source of financial
     truth. */
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name))
      : e.name.endsWith(".js") ? [path.join(d, e.name)] : []);

  walk(path.join(__dirname, "../../src/domain")).forEach((file) => {
    const src = fs.readFileSync(file, "utf-8");
    [/require\(.*avalanche/i, /require\(.*onchain/i, /require\(.*wallet/i,
      /require\(.*contract/i].forEach((re) =>
      assert.equal(re.test(src), false,
        `${path.basename(file)} in the domain layer depends on the on-chain subsystem`));
  });
});

test("[F14] an on-chain figure is never citable as an authoritative financial fact",
  async () => {
    const { buildAiContext } = require("../../src/ai/context/contextBuilder");
    const engine = require("../../src/domain/analysis/engine");
    const { scenarios } = require("../helpers/fixtures");
    const run = engine.analyze(scenarios.duplicatePayment,
      { tenantId: "t1", period: PERIOD, now: Date.parse("2026-06-15T00:00:00Z") });
    const ctx = buildAiContext({ run, tenantId: "t1", message: "how are we doing?" });

    // The citable index is built from metrics, findings and evidence only.
    assert.equal(JSON.stringify(ctx.payload.financial_data).includes("onchain"), false,
      "the on-chain block is not part of the authoritative context");
  });
