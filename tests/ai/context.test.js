// CONTEXT BUILDING AND KNOWLEDGE RETRIEVAL.
//
// Two properties are under test:
//   1. the model receives what the question needs and NOT the whole month;
//   2. it cannot receive another tenant's data, by construction rather than by
//      the caller remembering to filter.

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildAiContext, classifyTopics, TenantMismatchError, LIMITS } =
  require("../../src/ai/context/contextBuilder");
const { createRetriever } = require("../../src/ai/knowledge/retriever");
const { loadKnowledge, DOC_KIND } = require("../../src/ai/knowledge/knowledgeBase");
const registry = require("../../src/domain/rules/registry");
const engine = require("../../src/domain/analysis/engine");
const { scenarios } = require("../helpers/fixtures");

const NOW = Date.parse("2026-06-15T00:00:00Z");
const runFor = (name, tenantId = "t1", period = "2026-05") =>
  engine.analyze(scenarios[name], { tenantId, period, now: NOW });

// ── Tenant isolation ─────────────────────────────────────────────

test("[C1] a context cannot be built from ANOTHER tenant's analysis run", () => {
  const runA = runFor("duplicatePayment", "tenant-A");
  assert.throws(
    () => buildAiContext({ run: runA, tenantId: "tenant-B", message: "what happened?" }),
    TenantMismatchError,
    "tenant B must not be able to narrate tenant A's analysis");
});

test("[C2] the matching tenant CAN build a context, and it is stamped with the tenant", () => {
  const run = runFor("duplicatePayment", "tenant-A");
  const ctx = buildAiContext({ run, tenantId: "tenant-A", message: "what happened?" });
  assert.equal(ctx.meta.tenantId, "tenant-A");
  assert.equal(ctx.meta.analysisRunId, run.analysisRunId);
});

test("[C3] refusing to build without a run is what stops an ungrounded answer", () => {
  // A model asked about finances with no data will produce finances.
  assert.throws(() => buildAiContext({ tenantId: "t1", message: "how are we doing?" }),
    /without an analysis run/);
});

test("[C4] knowledge retrieval carries NO tenant data at all", () => {
  // The knowledge base is shared across tenants, so it must contain nothing
  // about any of them. This is what makes sharing it safe.
  const knowledge = loadKnowledge();
  const tenantish = /tenant|customer name|BigCo|Rivera|Monolith|Acme|Halden/i;
  knowledge.chunks.forEach((chunk) => {
    assert.doesNotMatch(chunk.text, tenantish,
      `knowledge chunk ${chunk.chunkId} appears to contain business-specific data`);
  });
});

// ── Bounded, relevant context ────────────────────────────────────

test("[C5] the whole month is NOT sent by default", () => {
  const run = runFor("cashflowStress");
  const ctx = buildAiContext({ run, tenantId: "t1", message: "what is my runway?" });

  assert.equal(ctx.payload.financial_data.line_items, null,
    "an aggregate question gets no line items");
  assert.ok(ctx.meta.approxPromptChars < 30000,
    `context is ${ctx.meta.approxPromptChars} chars; it must stay bounded`);
});

test("[C6] line items are included only on request, and are capped", () => {
  const many = {
    period: "2026-05",
    transactions: Array.from({ length: 400 }, (_, i) => ({
      date: "2026-05-01", amount: -(1000 + i), counterparty: `Vendor ${i}`, description: "x"
    })),
    journalEntries: [], reconciliations: [],
    statements: { cashFlow: { inflow: 0, outflow: 500000 }, profitAndLoss: {}, balanceSheet: {} }
  };
  const run = engine.analyze(many, { tenantId: "t1", period: "2026-05", now: NOW });

  const without = buildAiContext({ run, tenantId: "t1", message: "how are we doing?", monthlyData: many });
  assert.equal(without.payload.financial_data.line_items, null);

  const withItems = buildAiContext({
    run, tenantId: "t1", message: "show me the payments to Vendor 3",
    monthlyData: many, includeLineItems: true
  });
  assert.ok(withItems.payload.financial_data.line_items.rows.length <= LIMITS.lineItems,
    "line items are capped");
});

test("[C7] a partial view of the records SAYS it is partial", () => {
  const many = {
    period: "2026-05",
    transactions: Array.from({ length: 200 }, (_, i) => ({
      date: "2026-05-01", amount: -5000, counterparty: "Acme", description: "payment"
    })),
    journalEntries: [], reconciliations: [],
    statements: { cashFlow: { inflow: 0, outflow: 1000000 }, profitAndLoss: {}, balanceSheet: {} }
  };
  const run = engine.analyze(many, { tenantId: "t1", period: "2026-05", now: NOW });
  const ctx = buildAiContext({
    run, tenantId: "t1", message: "list the payments to Acme",
    monthlyData: many, includeLineItems: true
  });
  const items = ctx.payload.financial_data.line_items;
  assert.ok(items.matched_count > items.returned);
  assert.match(items.note, /partial/i,
    "the model must know its view is incomplete, or it will imply completeness");
});

test("[C8] findings are SELECTED by relevance, not truncated arbitrarily", () => {
  const run = runFor("vendorConcentration");
  const vendorCtx = buildAiContext({ run, tenantId: "t1", message: "tell me about my vendors" });
  const vendorRules = vendorCtx.payload.financial_data.findings.map((f) => f.rule_id);
  assert.ok(vendorRules.includes("vendor_concentration"),
    "a vendor question must surface the vendor finding");
  assert.equal(vendorCtx.meta.topics.includes("vendors"), true);
});

test("[C9] naming a counterparty pulls that counterparty's findings to the front", () => {
  const run = runFor("vendorConcentration");
  const ctx = buildAiContext({ run, tenantId: "t1", message: "what did we pay Monolith Supplies?" });
  const first = ctx.payload.financial_data.findings[0];
  const mentions = (first.calculation || "") + (first.description || "");
  assert.match(mentions, /Monolith/i, "the named party's finding ranks first");
});

test("[C10] every finding sent to the model carries its identity and provenance", () => {
  const run = runFor("duplicatePayment");
  const ctx = buildAiContext({ run, tenantId: "t1", message: "explain the flagged items" });
  ctx.payload.financial_data.findings.forEach((f) => {
    assert.ok(f.finding_id, "a citable id");
    assert.ok(f.rule_id && f.rule_version, "the rule and version that produced it");
    assert.ok(f.calculation, "the arithmetic, so the model explains rather than guesses");
    assert.ok(f.authority, "whose rule it was");
    assert.ok(f.confidence_basis, "WHY it is that confident");
  });
});

test("[C11] authorityScope survives into the AI context (JOB 7 carry-forward)", () => {
  const customRules = require("../../src/domain/rules/customRules");
  const rule = customRules.validateRule({
    name: "Large expense", severity: "high",
    condition: { type: "expense_over", amount: 1000 }, action: "flag"
  }).rule;
  rule.id = "r1";

  const data = scenarios.customRuleData;
  const run = engine.analyze(data, { tenantId: "t1", period: "2026-05", now: NOW });
  const custom = customRules.evaluateCustomRules([rule], data, {},
    { tenantId: "t1", period: "2026-05" }).findings;
  assert.ok(custom.length > 0);

  const merged = Object.assign({}, run, { findings: run.findings.concat(custom) });
  const ctx = buildAiContext({ run: merged, tenantId: "t1", message: "what did my own rules find?" });
  const tenantFindings = ctx.payload.financial_data.findings.filter((f) => f.authority === "tenant");
  assert.ok(tenantFindings.length > 0,
    "a tenant-authored finding reaches the model MARKED as tenant-authored");
  assert.ok(tenantFindings.every((f) => f.rule_id.startsWith("custom:")));
});

test("[C12] confidence in the context is FINDING confidence, never model confidence", () => {
  const run = runFor("duplicatePayment");
  const ctx = buildAiContext({ run, tenantId: "t1", message: "explain the duplicate" });
  ctx.payload.financial_data.findings.forEach((f) => {
    assert.equal(typeof f.confidence, "number");
    assert.ok(Object.values(registry.CONFIDENCE_BASIS).includes(f.confidence_basis),
      `confidence_basis "${f.confidence_basis}" is not one of the registry's evidential bases`);
    assert.doesNotMatch(String(f.confidence_basis), /ai|llm|model/i);
  });
});

test("[C13] a withheld risk score reaches the model as withheld, with the reason", () => {
  const run = runFor("emptyResponse");
  const ctx = buildAiContext({ run, tenantId: "t1", message: "how healthy are we?" });
  const risk = ctx.payload.financial_data.risk_score;
  assert.equal(risk.overall, null, "null, never a number");
  assert.equal(risk.available, false);
  assert.ok(risk.unavailable_reason, "the model can explain WHY");
  assert.ok(risk.explanation);
});

test("[C14] topic classification is deterministic and needs no model call", () => {
  assert.deepEqual(classifyTopics("how much runway do we have?"), ["cashflow"]);
  assert.ok(classifyTopics("which supplier do we depend on?").includes("vendors"));
  assert.ok(classifyTopics("was anything flagged as a duplicate?").includes("findings"));
  // An unrecognised question widens slightly rather than failing.
  assert.deepEqual(classifyTopics("hello"), ["risk", "cashflow"]);
});

// ── Knowledge retrieval (RAG) ────────────────────────────────────

test("[R1] the knowledge base is built from the registry, so rules cannot drift", () => {
  const knowledge = loadKnowledge({ reload: true });
  const ruleDocs = knowledge.documents.filter((d) => d.kind === DOC_KIND.RULE);
  assert.equal(ruleDocs.length, registry.allRules().length,
    "one generated document per registry rule");

  // A rule's document states the rule's CURRENT version.
  const dup = ruleDocs.find((d) => d.id === "rule:duplicate_payment");
  const text = dup.chunks.map((c) => c.text).join("\n");
  assert.match(text, new RegExp(registry.getRule("duplicate_payment").version));
});

test("[R2] retrieval returns the RIGHT document for a topical question", () => {
  const retriever = createRetriever("lexical");
  const cases = [
    ["what is cash runway?", /cashflow_runway|cash-runway/],
    ["why was this flagged as a duplicate?", /duplicate/],
    ["how is the health score calculated?", /risk-score/],
    ["what happens with multiple currencies?", /currency/],
    ["why is my score unknown?", /evidence-coverage/]
  ];
  cases.forEach(([question, expected]) => {
    const result = retriever.retrieve(question, { limit: 3 });
    assert.ok(result.chunks.length > 0, `no knowledge retrieved for "${question}"`);
    assert.match(result.chunks[0].docId, expected,
      `"${question}" retrieved ${result.chunks[0].docId} first`);
  });
});

test("[R3] retrieval is BOUNDED — it never returns the whole corpus", () => {
  const retriever = createRetriever("lexical");
  const result = retriever.retrieve("cash flow revenue vendor customer risk duplicate", { limit: 4 });
  assert.ok(result.chunks.length <= 4);
  // ...and it does not stack one document into every slot.
  const docs = new Set(result.chunks.map((c) => c.docId));
  assert.ok(docs.size >= Math.min(2, result.chunks.length),
    "one document must not monopolise the budget");
});

test("[R4] an unrelated question retrieves little or nothing rather than padding", () => {
  const retriever = createRetriever("lexical");
  const result = retriever.retrieve("zzzz qqqq wibble", { limit: 4 });
  assert.equal(result.chunks.length, 0,
    "irrelevant knowledge must not be inserted just to fill the budget");
});

test("[R5] a finding's rule pulls in that rule's explanation", () => {
  const retriever = createRetriever("lexical");
  // A vague question that names no rule, but the finding on screen does.
  const result = retriever.retrieve("why did you flag this?", {
    limit: 3, boostIds: ["unreconciled_account"]
  });
  assert.ok(result.chunks.some((c) => c.docId === "rule:unreconciled_account"),
    "the rule behind the finding is retrieved even when the question does not name it");
});

test("[R6] the retriever interface is pluggable and refuses unknown strategies", () => {
  assert.throws(() => createRetriever("embeddings"), /Only "lexical" is implemented/);
  const stats = createRetriever("lexical").stats();
  assert.ok(stats.chunks > 50, "the corpus is indexed");
  assert.ok(stats.version.startsWith(registry.ENGINE_VERSION),
    "the knowledge version tracks the engine, since rule docs are generated");
});

test("[R7] knowledge NEVER overrides the registry", () => {
  // The strongest form of this guarantee: rule knowledge is generated from the
  // registry, so it cannot contradict it. Assert the generation, not the prose.
  const knowledge = loadKnowledge({ reload: true });
  registry.allRules().forEach((rule) => {
    const doc = knowledge.documents.find((d) => d.id === `rule:${rule.id}`);
    assert.ok(doc, `no knowledge document for rule ${rule.id}`);
    assert.equal(doc.source, "src/domain/rules/registry.js",
      "a rule document must be generated from the registry, not written by hand");
    const text = doc.chunks.map((c) => c.text).join("\n");
    assert.ok(text.includes(JSON.stringify(rule.params)),
      `${rule.id}'s document does not state the registry's actual parameters`);
  });
});

test("[R8] knowledge and financial data are kept separate in the payload", () => {
  const run = runFor("duplicatePayment");
  const ctx = buildAiContext({ run, tenantId: "t1", message: "why was this flagged?" });

  assert.ok(ctx.payload.financial_data, "business data has its own section");
  assert.ok(Array.isArray(ctx.payload.knowledge), "knowledge has its own section");
  // No knowledge chunk carries a figure from this business.
  const figures = ctx.citable.numbers.filter((n) => n > 1000);
  const knowledgeText = ctx.payload.knowledge.map((k) => k.text).join(" ");
  figures.forEach((n) => {
    assert.equal(knowledgeText.includes(String(n)), false,
      `knowledge contains this business's figure ${n} — the sections have leaked`);
  });
});

// ── Invariants, asserted mechanically ────────────────────────────

test("[I1] the AI layer has no ARBITRARY database access (invariant 3)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.join(__dirname, "../../src/ai");
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name))
      : e.name.endsWith(".js") ? [path.join(d, e.name)] : []);

  /* The invariant is "no ARBITRARY access", not "no persistence". JOB 9 gave the
     AI layer two legitimate reasons to touch storage — writing its own audit
     trail, and consuming credits atomically — and both go through a NAMED
     repository whose queries are fixed and tenant-scoped. That is the controlled
     boundary invariant 2 requires.

     What must never appear is a raw connection, raw SQL, or a FINANCIAL-DATA
     repository: financial data reaches the AI only as an already-computed run,
     handed to the context builder. */
  /* The permitted three, and why each is NOT financial-data access:
       aiAuditRepository       the AI layer's own audit trail
       creditRepository        atomic metering of AI usage
       conversationRepository  transcripts — what was SAID, never a figure;
                               entity references are IDs, resolved against the
                               authoritative run each time they are used.
     Financial data still reaches the AI only as an already-computed run handed
     to the context builder. */
  const ALLOWED_REPOSITORIES = [
    "aiAuditRepository", "creditRepository", "conversationRepository"
  ];

  walk(dir).forEach((file) => {
    const src = fs.readFileSync(file, "utf-8");
    const name = path.basename(file);

    assert.equal(/require\(["']pg["']\)/.test(src), false, `${name} opens a raw pg client`);
    assert.equal(/require\(["'].*db\/pool["']\)/.test(src), false, `${name} uses the pool directly`);
    assert.equal(/\bSELECT\b[\s\S]{0,80}\bFROM\b/i.test(src), false, `${name} contains raw SQL`);

    // Any repository it imports must be one of the two permitted, non-financial ones.
    const imports = src.match(/require\(["'][^"']*repositories\/([A-Za-z]+)["']\)/g) || [];
    imports.forEach((imp) => {
      const repo = imp.match(/repositories\/([A-Za-z]+)/)[1];
      assert.ok(ALLOWED_REPOSITORIES.includes(repo),
        `${name} imports ${repo} — the AI layer must not read financial data directly`);
    });
  });
});

test("[I2] skill documents are RETRIEVED, never concatenated wholesale (invariant 7)", () => {
  const orchestrator = require("../../src/ai/orchestrator");
  const run = runFor("duplicatePayment");
  const ctx = buildAiContext({ run, tenantId: "t1", message: "why was this flagged?" });
  const prompt = orchestrator.buildPrompt({
    context: ctx, message: "why was this flagged?", period: "2026-05"
  });

  // The old prompt inlined ~15KB of skill.md for chat and ~40KB for the monthly
  // review, on every request.
  assert.equal(/=== SKILL DOCUMENTATION ===/.test(prompt), false,
    "the wholesale skill-doc block is gone");
  assert.ok(prompt.length < 40000,
    `prompt is ${prompt.length} chars; the whole point was to bound it`);
  assert.ok(ctx.payload.knowledge.length <= 4, "knowledge is a retrieved subset");
});

test("[I3] the deterministic engine is untouched by the AI layer (invariant 1)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const domainDir = path.join(__dirname, "../../src/domain");
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name))
      : e.name.endsWith(".js") ? [path.join(d, e.name)] : []);

  // The dependency runs one way: AI reads the domain, never the reverse.
  walk(domainDir).forEach((file) => {
    const src = fs.readFileSync(file, "utf-8");
    assert.equal(/require\(["'].*\/ai\//.test(src), false,
      `${path.basename(file)} in the domain layer imports from the AI layer`);
  });
});
