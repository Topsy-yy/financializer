// HTTP INTEGRATION — the real API path, asserted on NUMBERS.
//
// THE GAP THIS CLOSES. JOB 6 shipped extensive engine tests and a pipeline test
// that checked response SHAPE, but nothing proved that the numbers a client
// actually receives over HTTP are the numbers the deterministic engine
// computed. Every layer between them — the route, the legacy adapter, the
// session store, JSON serialisation — was unverified against a known value.
//
// These tests upload a dataset whose correct answers can be worked out by hand,
// then assert those exact figures come back through:
//
//   HTTP -> auth/session -> tenant resolution -> ingestion -> engine
//        -> risk score -> findings -> API response
//
// Every expected value below is derived from the registry, not copied from a
// previous run, so a threshold change makes these fail loudly rather than
// silently re-baselining.

const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("../helpers/server");
const registry = require("../../src/domain/rules/registry");
const { computeCashflowRisk } = require("../../src/domain/calculators/cashflow");
const { weightedScore, categoryFor } = require("../../src/domain/analysis/riskAggregation");

let server;
let client;

// A month with hand-checkable arithmetic. Amounts follow the BANK-STATEMENT
// convention the CSV importer declares: money out is negative, money in
// positive.
//
//   inflow 900,000  outflow 600,000  cash 1,200,000 (supplied with the upload)
//   net = +300,000, burn = 0 (surplus), so the runway never depletes
//   vendor spend: Rivera 400,000 + City Power 120,000 + Metro 80,000 = 600,000
//     -> top vendor share = 400,000 / 600,000 = 66.7%  (HIGH concentration)
//   one duplicated payment to Rivera (2 x 200,000 on the same day)
const PERIOD = "2026-05";
const CSV = [
  "Date,Description,Amount,Counterparty",
  `${PERIOD}-04,Consulting retainer,-200000,Rivera Logistics`,
  `${PERIOD}-04,Consulting retainer,-200000,Rivera Logistics`,
  `${PERIOD}-11,Electricity,-120000,City Power`,
  `${PERIOD}-18,Freight,-80000,Metro Freight`,
  `${PERIOD}-22,Client settlement,900000,BigCo Retail`
].join("\n");

test.before(async () => {
  server = await startServer({ ALLOW_DEMO_DATA: "true" });
  client = server.client();
});

test.after(async () => { if (server) await server.stop(); });

/**
 * Upload the dataset and run a review, exactly as a browser client would:
 * multipart CSV upload, then a review request.
 *
 * The statements are DERIVED by the importer from the CSV, so the inflow /
 * outflow / cash figures asserted below are the importer's own arithmetic over
 * the rows above — not values handed to it.
 */
async function runReview(period = PERIOD, csv = CSV, cash = 1200000) {
  const upload = await client.upload("/api/financial-data/upload", {
    filename: "month.csv",
    content: csv,
    fields: { period, currentCashBalance: cash }
  });
  const review = await client.post("/api/monthly-review", { month: period, use_ai_analysis: false });
  return { upload, review };
}

test("[H1] the API returns the exact cash-flow numbers the engine computed", async () => {
  const { review } = await runReview();
  assert.equal(review.status, 200, JSON.stringify(review.json));
  const cf = (await client.get('/api/cashflow')).json.cashflow;

  // Worked by hand from the uploaded statements.
  assert.equal(cf.net_cash_flow, 300000, "900,000 in - 600,000 out");
  assert.equal(cf.monthly_burn, 0, "a surplus month burns nothing");
  assert.equal(cf.cash_on_hand, 1200000);
  assert.equal(cf.never_depletes, true, "a growing balance has no runway limit");
  assert.equal(cf.cash_runway_months, null, "null, NOT a number — there is no limit");
  assert.equal(cf.runway_days, null);

  // The risk score is the registry's additive formula, recomputed here from the
  // registry rather than hardcoded, so changing a weight fails this test.
  const expected = computeCashflowRisk({
    netCashFlow: 300000, monthlyBurn: 0, runwayMonths: Infinity,
    overdueReceivables: null, inflow: 900000
  });
  assert.equal(cf.risk_score, expected.risk_score);
  assert.equal(cf.risk_score, registry.CASHFLOW_RISK.baseline, "baseline only: nothing else fired");
  assert.equal(cf.risk_level, "low");
});

test("[H2] the API returns the exact concentration numbers", async () => {
  const { review } = await runReview();
  const vendors = (await client.get('/api/vendors')).json.vendors;

  assert.equal(vendors.available, true);
  assert.equal(vendors.top_vendor.name, "Rivera Logistics");
  // 400,000 of 600,000 total outflow.
  assert.equal(vendors.top_vendor_share, 66.7);
  assert.equal(vendors.concentration.total_spend, 600000);
  assert.equal(vendors.concentration.total_vendors, 3);
  // The risk score IS the measured share, rounded.
  assert.equal(vendors.vendor_risk_score, 67);

  // Customers: a single payer of the whole 900,000 inflow.
  const customers = (await client.get('/api/customers')).json.customers;
  assert.equal(customers.available, true);
  assert.equal(customers.top_customer.name, "BigCo Retail");
  assert.equal(customers.top_customer_share, 100);
});

test("[H3] the overall risk score returned over HTTP equals the registry's own "
  + "weighted calculation of the components it returned", async () => {
  const { review } = await runReview();
  const health = (await client.get('/api/health-score')).json.health;

  assert.equal(health.available, true);
  assert.equal(typeof health.overall_score, "number");

  // Recompute from the components the API itself returned. If the transport
  // layer altered a number, or the score were produced anywhere other than the
  // authoritative aggregation, these diverge.
  const recomputed = weightedScore(health.component_scores);
  assert.equal(health.overall_score, recomputed.score,
    "the published score is the weighted average of the published components");
  assert.equal(health.risk_category, categoryFor(health.overall_score));
  assert.equal(health.weight_covered, recomputed.covered);

  // And the components themselves are the inverses of the published risks.
  assert.equal(health.component_scores.cash_flow, 100 - (await client.get('/api/cashflow')).json.cashflow.risk_score);
  assert.equal(health.component_scores.vendor_risk, 100 - (await client.get('/api/vendors')).json.vendors.vendor_risk_score);
});

test("[H4] a duplicate payment reaches the client with its rule id, version, "
  + "confidence and both source records", async () => {
  const { review } = await runReview();
  const items = (await client.get('/api/anomalies')).json.anomalies.items;
  const dup = items.find((i) => i.rule_id === "duplicate_payment");
  assert.ok(dup, `no duplicate finding in: ${items.map((i) => i.rule_id).join(", ")}`);

  assert.equal(dup.rule_version, registry.getRule("duplicate_payment").version);
  assert.equal(dup.severity, "high");
  assert.equal(dup.observed_value, 2, "two matching transactions");
  assert.equal(dup.confidence, registry.CONFIDENCE.STRONG,
    "date+amount+counterparty+account matched, so the registry raises confidence");
  assert.equal(dup.source_record_ids.length, 2, "both sides are cited");
  assert.ok(dup.finding_id, "a stable id the client can acknowledge");
  assert.ok(dup.calculation, "the arithmetic, not an LLM's paraphrase");
  assert.deepEqual(dup.match_criteria.fields.slice(0, 3), ["date", "amount", "counterparty"]);
});

test("[H5] every finding delivered over HTTP names the rule and version that "
  + "produced it, and the rule exists in the registry", async () => {
  const { review } = await runReview();
  const items = (await client.get('/api/anomalies')).json.anomalies.items;
  assert.ok(items.length > 0);

  items.forEach((item) => {
    assert.ok(item.rule_id, "a finding with no rule id reached the client");
    assert.ok(item.rule_version, `${item.rule_id} has no version`);
    // Custom rules are namespaced; built-ins must resolve in the registry.
    if (!String(item.rule_id).startsWith("custom:")) {
      const rule = registry.getRule(item.rule_id);
      assert.equal(item.rule_version, rule.version,
        `${item.rule_id} was delivered at v${item.rule_version} but the registry says v${rule.version}`);
    }
    assert.ok(Array.isArray(item.evidence), `${item.rule_id} delivered no evidence array`);
  });
});

test("[H6] the run is reproducible: the response carries the engine version, "
  + "rule versions and the input hash", async () => {
  const { review } = await runReview();
  const ctx = review.json.review;

  assert.equal(ctx.engine_version, registry.ENGINE_VERSION);
  assert.ok(ctx.analysis_run_id, "the run identifies itself");
  assert.ok(ctx.input_hash, "the exact dataset is identified");
  assert.equal(ctx.rule_versions.duplicate_payment, registry.getRule("duplicate_payment").version);
  assert.equal(ctx.rule_versions.health_score, registry.HEALTH_SCORE.version);

  // Re-running the same month yields the same hash and the same score.
  const again = await client.post("/api/monthly-review", { month: PERIOD, use_ai_analysis: false });
  assert.equal(again.json.review.input_hash, ctx.input_hash);
  assert.equal(again.json.review.health_score, ctx.health_score);
});

test("[H7] the deterministic score is produced with AI disabled — the AI path is "
  + "narration only", async () => {
  const { review } = await runReview();
  // The server runs with ENABLE_AI_ANALYSIS=false, so any score present here was
  // produced by the engine alone.
  assert.equal((await client.get('/api/health-score')).json.health.available, true);
  assert.equal(typeof (await client.get('/api/health-score')).json.health.overall_score, "number");
  const ai = review.json.ai_analysis || {};
  assert.notEqual(ai.ok, true, "AI is disabled in this harness");
  // ...and the numbers are unaffected by that.
  assert.ok((await client.get('/api/cashflow')).json.cashflow.risk_score > 0);
});

test("[H8] /api/methodology publishes the registry, and it matches the engine", async () => {
  const res = await client.get("/api/methodology");
  assert.equal(res.status, 200);
  const m = res.json.methodology;

  assert.equal(m.engineVersion, registry.ENGINE_VERSION);
  assert.equal(m.rules.length, registry.allRules().length);
  assert.deepEqual(m.scoring.weights, registry.HEALTH_SCORE.weights);
  assert.equal(m.evidenceCoverage.minimumWeightCovered, registry.HEALTH_SCORE.minWeightCovered);

  // Every published rule resolves, at the version published.
  m.rules.forEach((r) => {
    assert.equal(registry.getRule(r.ruleId).version, r.version);
    assert.ok(r.rationale, `${r.ruleId} published without a rationale`);
    assert.ok(r.methodology, `${r.ruleId} published without a method`);
  });

  const md = await client.get("/api/methodology?format=markdown");
  assert.equal(md.status, 200);
  assert.match(md.text, /FinGuard Financial Methodology/);
  assert.match(md.text, /duplicate_payment/);
});

test("[H9] an unmeasurable figure is delivered as null with a reason, never as zero", async () => {
  // A month whose only spend cannot be attributed to any counterparty. The
  // concentration metric is genuinely unmeasurable — and the client must be
  // told that, not handed a 0 it would render as "perfectly diversified".
  const sparsePeriod = "2026-07";
  await client.upload("/api/financial-data/upload", {
    filename: "sparse.csv",
    content: [
      "Date,Description,Amount,Counterparty",
      `${sparsePeriod}-03,Unattributed debit,-50000,`,
      `${sparsePeriod}-09,Unattributed debit,-25000,`,
      `${sparsePeriod}-20,Client settlement,120000,BigCo Retail`
    ].join("\n"),
    fields: { period: sparsePeriod, currentCashBalance: 400000 }
  });
  const res = await client.post("/api/monthly-review", { month: sparsePeriod, use_ai_analysis: false });
  assert.equal(res.status, 200, JSON.stringify(res.json));

  const vendors = (await client.get("/api/vendors")).json.vendors;
  assert.equal(vendors.available, false, "no spend could be attributed to a vendor");
  assert.equal(vendors.vendor_risk_score, null, "null, NEVER 0 — 0 reads as perfectly diversified");
  assert.equal(vendors.unavailable_reason, "unattributed_transactions", "the client is told WHY");
  assert.equal(vendors.unattributed_amount, 75000, "and HOW MUCH could not be attributed");
  assert.deepEqual(vendors.vendor_list, [], "no invented counterparties");

  // The overall score is honest about how much of the model it covers.
  const health = (await client.get("/api/health-score")).json.health;
  assert.equal(health.component_scores.vendor_risk, null, "the component is unmeasured, not zero");
  assert.ok(!health.measured_components.includes("vendor_risk"));
  assert.ok(health.weight_covered < 1, "and the response says the model is only partly covered");
  if (health.overall_score != null) {
    assert.equal(health.available, true);
    assert.ok(health.calculation.includes("renormalised"),
      "a partial score states that it was renormalised over what was measured");
  }
});

test("[H10] a mixed-currency period refuses to publish a combined concentration "
  + "figure and returns the per-currency breakdown instead", async () => {
  const mixedPeriod = "2026-08";
  const mixedCsv = [
    "Date,Description,Amount,Counterparty,Currency",
    `${mixedPeriod}-04,Local supplier,-100000,Local Vendor,KES`,
    `${mixedPeriod}-11,Overseas supplier,-1000,Overseas Vendor,USD`,
    `${mixedPeriod}-18,EU supplier,-900,EU Vendor,EUR`
  ].join("\n");

  await client.upload("/api/financial-data/upload", {
    filename: "mixed.csv", content: mixedCsv,
    fields: { period: mixedPeriod, currentCashBalance: 400000 }
  });
  const res = await client.post("/api/monthly-review", { month: mixedPeriod, use_ai_analysis: false });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const vendors = (await client.get('/api/vendors')).json.vendors;

  // The critical assertion: NO combined number is published.
  assert.equal(vendors.available, false, "a share of incompatible currencies is not computable");
  assert.equal(vendors.unavailable_reason, "mixed_currency");
  assert.equal(vendors.vendor_risk_score, null, "not 0, and not a converted guess");
  assert.equal(vendors.top_vendor, null);

  // ...and nothing is lost: the parts are still there.
  assert.ok(Array.isArray(vendors.by_currency), "the per-currency breakdown is preserved");
  const byCode = Object.fromEntries(vendors.by_currency.map((b) => [b.currency, b.total]));
  assert.equal(byCode.KES, 100000);
  assert.equal(byCode.USD, 1000);
  assert.equal(byCode.EUR, 900);
  // 101,900 is the number the old engine produced. It must not appear.
  assert.notEqual(vendors.concentration && vendors.concentration.total_spend, 101900);
});
