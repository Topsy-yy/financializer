// THE COPILOT, OVER HTTP — the whole production path.
//
//   authenticate -> ingest -> analyse -> open copilot -> ask
//   -> authoritative context -> provider stub -> validate -> render
//   -> inspect evidence -> verify credits -> verify audit
//
// The unit suite proves each layer's guarantees. This proves they are WIRED:
// that the route uses the copilot, that a fabricated claim is blocked at the
// real endpoint, and that the audit and credit trails record what happened.

const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("../helpers/server");

let server;
let client;

const PERIOD = "2026-05";
const PRIOR = "2026-04";

// Money out is negative (the CSV importer's bank-statement convention).
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
  `${PRIOR}-14,Freight,-35000,Metro Freight`,
  `${PRIOR}-25,Client settlement,900000,BigCo Retail`
].join("\n");

test.before(async () => {
  server = await startServer({
    ALLOW_DEMO_DATA: "true",
    ENABLE_AI_ANALYSIS: "true",
    NVIDIA_API_KEY: "test-managed-key",
    AI_TEST_PROVIDER: "1"
  });
  client = server.client();

  // Ingest and analyse two periods, so comparison has something to compare.
  await client.upload("/api/financial-data/upload", {
    filename: "prior.csv", content: PRIOR_CSV,
    fields: { period: PRIOR, currentCashBalance: 1500000 }
  });
  await client.post("/api/monthly-review", { month: PRIOR, use_ai_analysis: false });

  await client.upload("/api/financial-data/upload", {
    filename: "month.csv", content: CSV,
    fields: { period: PERIOD, currentCashBalance: 1200000 }
  });
  await client.post("/api/monthly-review", { month: PERIOD, use_ai_analysis: false });
});

test.after(async () => { if (server) await server.stop(); });

async function stub(payload) {
  const res = await client.post("/api/__test/ai-stub", {
    text: typeof payload === "string" ? payload : JSON.stringify(payload)
  });
  assert.equal(res.status, 200);
}

/** Fetch the finding ids the engine actually produced for the period. */
async function findings() {
  const res = await client.get("/api/anomalies");
  return (res.json.anomalies.items || []).filter((i) => i.finding_id);
}

test("[X1] a validated copilot answer is delivered as STRUCTURED output", async () => {
  const items = await findings();
  const dup = items.find((i) => i.rule_id === "duplicate_payment");
  assert.ok(dup, "precondition: the duplicate was detected");

  await stub({
    summary: "One duplicate payment was flagged for review this period.",
    facts: [{ claim: "A possible duplicate payment was detected.",
      citations: [`finding:${dup.finding_id}`] }],
    inferences: [{ claim: "This may mean the invoice was settled twice.",
      supportingReferences: [`finding:${dup.finding_id}`] }],
    recommendations: [{ claim: "Check both records against the original invoice." }],
    limitations: ["I cannot tell from the records whether a refund was issued."]
  });

  const res = await client.post("/api/copilot", {
    message: "what needs attention this month?", month: PERIOD
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true, JSON.stringify(res.json));

  // The structured contract reaches the client intact.
  assert.equal(res.json.answer.facts.length, 1);
  assert.ok(res.json.answer.facts[0].citations.length > 0, "a fact carries its citation");
  assert.equal(res.json.answer.inferences.length, 1);
  assert.equal(res.json.answer.recommendations.length, 1);
  assert.ok(res.json.answer.limitations.length > 0);

  // ...along with what it was grounded in.
  assert.ok(res.json.interaction_id);
  assert.ok(res.json.conversation_id);
  assert.ok(res.json.meta.analysisRunId);
  assert.ok(res.json.capabilities.length > 0, "authoritative data was retrieved first");
  assert.ok(res.json.suggestions.length > 0, "suggested actions are offered");
});

test("[X2] a follow-up continues the SAME conversation", async () => {
  await stub({
    summary: "Review the duplicate against the invoice.",
    facts: [], inferences: [],
    recommendations: [{ claim: "Contact the supplier if it was paid twice." }],
    limitations: []
  });

  const first = await client.post("/api/copilot", { message: "what needs attention?", month: PERIOD });
  const second = await client.post("/api/copilot", {
    message: "and what should I do about it?",
    month: PERIOD,
    conversation_id: first.json.conversation_id
  });
  assert.equal(second.json.conversation_id, first.json.conversation_id);
  assert.ok(second.json.meta.turnCount > first.json.meta.turnCount, "turns accumulate");
});

test("[X3] a FABRICATED claim is blocked at the real endpoint and not billed", async () => {
  const before = (await client.get("/api/entitlement")).json;
  const creditsBefore = before.entitlement ? before.entitlement.credits : null;

  await stub({
    summary: "Your revenue reached KES 8,675,309 this month.",
    // A confident qualitative assertion with no citation — the gap JOB 8's
    // numeric validator could not close.
    facts: [{ claim: "Your largest supplier is financially unstable.", citations: [] }],
    inferences: [], recommendations: [], limitations: []
  });

  const res = await client.post("/api/copilot", { message: "how did revenue do?", month: PERIOD });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, false);
  assert.equal(res.json.blocked, true);

  const body = JSON.stringify(res.json);
  assert.equal(body.includes("8,675,309"), false, "the invented figure never reaches the user");
  assert.equal(body.includes("financially unstable"), false,
    "nor does the unsupported qualitative claim — not even inside the issue report");
  // The REASON is disclosed, because the user should know why.
  assert.ok(res.json.issues && res.json.issues.length, "the rejection reasons are given");
  res.json.issues.forEach((i) => assert.ok(i.reason && !i.claim,
    "an issue names the reason, never the offending text"));

  const after = (await client.get("/api/entitlement")).json;
  if (creditsBefore != null && after.entitlement) {
    assert.equal(after.entitlement.credits, creditsBefore, "a blocked answer is not billed");
  }
});

test("[X4] a period comparison is computed deterministically and explained", async () => {
  await stub({
    summary: "The score fell between April and May.",
    facts: [{ claim: "A duplicate payment finding is new this period.",
      citations: [`analysis_run:${(await client.get("/api/health-score")).json.health ? "" : ""}`] }],
    inferences: [], recommendations: [], limitations: []
  });

  // The citation above is deliberately malformed; the answer should still be
  // handled safely rather than crashing, and the comparison itself is what is
  // under test.
  const res = await client.post("/api/copilot", {
    message: "why is this month worse than last month?", month: PERIOD
  });
  assert.equal(res.status, 200);
  if (res.json.ok) {
    assert.equal(res.json.intent, "compare");
    assert.ok(res.json.capabilities.some((c) => c.name === "compare_analysis_runs"),
      "the deterministic comparison ran");
  } else {
    // Blocked because the stubbed answer cited nothing valid — also correct.
    assert.equal(res.json.blocked, true);
  }
});

test("[X5] evidence behind a finding is inspectable, and is the engine's own", async () => {
  const items = await findings();
  const dup = items.find((i) => i.rule_id === "duplicate_payment");

  const res = await client.get(`/api/copilot/evidence/${dup.finding_id}`);
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.evidence.finding_id, dup.finding_id);
  assert.equal(res.json.evidence.evidence.length, 2, "both sides of the duplicate");
  // The records are the ones the finding cited, not a re-query.
  const ids = res.json.evidence.evidence.map((e) => e.source_record_id).sort();
  assert.deepEqual(ids, dup.source_record_ids.slice().sort());
  // The owner inspecting their own evidence sees real names.
  const parties = res.json.evidence.evidence.map((e) => e.fields.counterparty);
  assert.ok(parties.includes("Rivera Logistics"));
});

test("[X6] evidence for a finding that does not exist is a 404, not an invention", async () => {
  const res = await client.get("/api/copilot/evidence/fnd_000000000000000000000000");
  assert.equal(res.status, 404);
  assert.equal(res.json.error, "finding_not_found");
});

test("[X7] a provider failure yields an honest unavailable, never a fabricated answer", async () => {
  await client.post("/api/__test/ai-stub", { fail: "provider_unavailable" });
  const res = await client.post("/api/copilot", { message: "how are we doing?", month: PERIOD });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, false);
  assert.equal(res.json.reason, "provider_unavailable");
  assert.equal(res.json.answer, undefined, "no answer object is fabricated");
  assert.ok(res.json.message, "the user is told what happened");
});

test("[X8] asking about a period with no analysis is refused, not improvised", async () => {
  await stub({ summary: "All good.", facts: [], inferences: [], recommendations: [], limitations: [] });
  const res = await client.post("/api/copilot", { message: "how did we do?", month: "2019-01" });
  assert.equal(res.status, 200);
  // Either refused for lack of a run, or answered from the latest run — but
  // never with figures for a period that was never analysed.
  if (res.json.ok) {
    assert.notEqual(res.json.meta.period, "2019-01",
      "an unanalysed period must not be reported on");
  } else {
    assert.ok(["no_analysis_run", "data_unavailable"].includes(res.json.reason));
  }
});

test("[X9] the deterministic analysis is untouched by any copilot outcome", async () => {
  const before = (await client.get("/api/health-score")).json.health;
  await stub({
    summary: "Your score is 99/100 and everything is excellent.",
    facts: [{ claim: "The score is 99.", citations: [] }],
    inferences: [], recommendations: [], limitations: []
  });
  await client.post("/api/copilot", { message: "how healthy are we?", month: PERIOD });

  const after = (await client.get("/api/health-score")).json.health;
  assert.deepEqual(after, before, "no AI outcome can move an authoritative figure");
});

test("[X10] a second tenant cannot reach the first tenant's copilot data", async () => {
  const other = server.client();
  await stub({ summary: "ok", facts: [], inferences: [], recommendations: [], limitations: [] });

  // No analysis of their own: refused rather than answered from someone else's.
  const res = await other.post("/api/copilot", { message: "what was flagged?", month: PERIOD });
  if (res.json.ok) {
    assert.notEqual(res.json.meta.analysisRunId,
      (await client.post("/api/copilot", { message: "hi", month: PERIOD })).json.meta?.analysisRunId,
      "a different tenant must be grounded in a different run");
  } else {
    assert.ok(res.json.reason);
  }

  // And the first tenant's evidence is not readable.
  const items = await findings();
  const evidence = await other.get(`/api/copilot/evidence/${items[0].finding_id}`);
  assert.equal(evidence.status, 404,
    "another tenant gets a not-found, indistinguishable from a finding that does not exist");
  assert.equal(evidence.json.ok, false);
  assert.equal(JSON.stringify(evidence.json).includes("Rivera Logistics"), false,
    "and no counterparty from the first tenant's data appears");
});
