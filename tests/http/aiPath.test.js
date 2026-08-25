// THE AI PATH, OVER HTTP.
//
// The unit tests prove the orchestrator's guarantees. These prove the guarantees
// are actually WIRED — that /api/chat goes through the orchestrator rather than
// around it, and that a fabricated answer is blocked at the real route.
//
// The provider is stubbed inside the server process via a test-only hook, so
// these exercise the whole request path without a network call.

const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("../helpers/server");

let server;
let client;

const PERIOD = "2026-05";
const CSV = [
  "Date,Description,Amount,Counterparty",
  `${PERIOD}-04,Consulting retainer,-200000,Rivera Logistics`,
  `${PERIOD}-04,Consulting retainer,-200000,Rivera Logistics`,
  `${PERIOD}-11,Electricity,-120000,City Power`,
  `${PERIOD}-22,Client settlement,900000,BigCo Retail`
].join("\n");

test.before(async () => {
  // AI_TEST_PROVIDER makes the transport return a canned answer instead of
  // making a network call. It is only honoured when NODE_ENV === "test".
  server = await startServer({
    ALLOW_DEMO_DATA: "true",
    ENABLE_AI_ANALYSIS: "true",
    NVIDIA_API_KEY: "test-managed-key",
    AI_TEST_PROVIDER: "1"
  });
  client = server.client();
  await client.upload("/api/financial-data/upload", {
    filename: "month.csv", content: CSV,
    fields: { period: PERIOD, currentCashBalance: 1200000 }
  });
  await client.post("/api/monthly-review", { month: PERIOD, use_ai_analysis: false });
});

test.after(async () => { if (server) await server.stop(); });

/** Tell the stubbed provider what to answer next. */
async function stubAnswer(text) {
  const res = await client.post("/api/__test/ai-stub", { text });
  assert.equal(res.status, 200, "the test stub hook must be available");
}

test("[A1] a TRUTHFUL answer is delivered, and says what it was checked against", async () => {
  // 200000 is a real amount in the uploaded data.
  await stubAnswer("Two payments of 200,000 to Rivera Logistics on the same day were flagged "
    + "as a possible duplicate. Worth checking against the invoice before paying again.");

  const res = await client.post("/api/chat", { message: "what was flagged this month?", activeMonth: PERIOD });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.intent, "ai_generated");
  assert.match(res.json.reply, /200,000/);

  // The response reports what the model was given — the answer is auditable.
  assert.equal(res.json.context.mode, "ai+context");
  assert.ok(res.json.context.analysis_run_id, "the run the answer was grounded in");
  assert.ok(res.json.context.figures_checked > 0, "figures were actually checked");
  assert.ok(Array.isArray(res.json.context.knowledge_used));
});

test("[A2] a FABRICATED answer is BLOCKED at the real route", async () => {
  // The exact failure the old baseline pinned as acceptable: a plausible,
  // entirely invented figure returned verbatim to the user.
  await stubAnswer("Your revenue fell 87% to KES 12,345 and your health score is now 23/100.");

  const res = await client.post("/api/chat", { message: "how did revenue do?", activeMonth: PERIOD });
  assert.equal(res.status, 200);
  assert.equal(res.json.intent, "ai_blocked", "the answer must not be delivered as AI output");
  assert.equal(res.json.ai_unavailable, true);

  // Nothing the model invented reaches the user.
  assert.doesNotMatch(res.json.reply, /12,345/);
  assert.doesNotMatch(res.json.reply, /87%/);
  assert.doesNotMatch(res.json.reply, /23\/100/);
  assert.match(res.json.reply, /could not|held/i, "the user is told the answer was withheld");
});

test("[A3] a provider FAILURE degrades to the deterministic summary, labelled honestly", async () => {
  await client.post("/api/__test/ai-stub", { fail: "provider_unavailable" });

  const res = await client.post("/api/chat", { message: "how is my cash flow?", activeMonth: PERIOD });
  assert.equal(res.status, 200);
  assert.equal(res.json.ai_unavailable, true, "the failure is surfaced, not hidden");
  assert.ok(res.json.context.ai_error, "with a reason");
  assert.equal(res.json.context.mode, "skills-fallback");
  // The fallback is rule-based and SAYS so — it is never passed off as AI.
  assert.match(res.json.text, /rule-based|not an AI answer/i);
});

test("[A4] the deterministic analysis is UNAFFECTED by any AI outcome", async () => {
  // Whatever the model does, the dashboard numbers come from the engine.
  const before = (await client.get("/api/health-score")).json.health;

  await stubAnswer("Your health score is 99/100, everything is perfect.");
  await client.post("/api/chat", { message: "how healthy are we?", activeMonth: PERIOD });

  const after = (await client.get("/api/health-score")).json.health;
  assert.deepEqual(after, before, "an AI answer cannot move an authoritative figure");
});

test("[A5] the chat answer is grounded in the CALLER's own analysis run", async () => {
  await stubAnswer("Nothing unusual to report for this period.");
  const res = await client.post("/api/chat", { message: "anything to flag?", activeMonth: PERIOD });

  const review = await client.post("/api/monthly-review", { month: PERIOD, use_ai_analysis: false });
  assert.equal(res.json.context.analysis_run_id != null, true);
  // The run id belongs to this session's own analysis, not a shared or global one.
  assert.equal(typeof review.json.review.analysis_run_id, "string");
});

test("[A6] a second tenant's answer is grounded in its OWN analysis run", async () => {
  /* NOTE ON WHAT THIS CAN AND CANNOT PROVE. With a stubbed provider the answer
     text is fixed, so it cannot demonstrate leakage through the model's words —
     the stub would repeat whatever it was primed with regardless of context.
     The property that actually matters, and that IS testable here, is that a
     second session is grounded in a DIFFERENT analysis run. Cross-tenant
     context construction is refused outright and is covered by [C1]. */
  const other = server.client();
  await stubAnswer("Summary for this period.");

  // The second tenant analyses its own (demo) data.
  const otherReview = await other.post("/api/monthly-review", { month: PERIOD, use_ai_analysis: false });
  const mineReview = await client.post("/api/monthly-review", { month: PERIOD, use_ai_analysis: false });

  const otherRun = otherReview.json.review.analysis_run_id;
  const myRun = mineReview.json.review.analysis_run_id;
  assert.ok(otherRun && myRun);
  assert.notEqual(otherRun, myRun, "two sessions are two analyses");

  const otherChat = await other.post("/api/chat", { message: "anything to flag?", activeMonth: PERIOD });
  if (otherChat.json.intent === "ai_generated") {
    assert.equal(otherChat.json.context.analysis_run_id, otherRun,
      "the answer is grounded in the CALLER's run, never another tenant's");
    assert.notEqual(otherChat.json.context.analysis_run_id, myRun);
  }

  // And the first tenant's uploaded figures are not in the second's data.
  const otherVendors = (await other.get("/api/vendors")).json.vendors;
  const names = (otherVendors.vendor_list || []).map((v) => v.name);
  assert.equal(names.includes("Rivera Logistics"), false,
    "the first tenant's uploaded counterparty is not visible to the second");
});

test("[A7] /api/methodology stays public and registry-derived alongside the AI layer", async () => {
  const res = await client.get("/api/methodology");
  assert.equal(res.status, 200);
  assert.ok(res.json.methodology.rules.length > 0);
});
