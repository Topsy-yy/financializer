// THE CONTEXT BUILDER — the only door between authoritative financial data and
// the language model.
//
// WHAT THIS REPLACES. The previous prompt did `JSON.stringify(contextPayload)`
// over the whole legacy context object plus the concatenated text of eleven
// skill.md files, for every question. That had three problems:
//
//   1. SIZE. The model received the entire month regardless of what was asked,
//      so a question about one vendor arrived alongside every metric, every
//      finding and ~1,500 lines of documentation.
//   2. NO PROVENANCE. Numbers arrived as bare JSON values. Nothing tied a
//      figure to the Finding or Metric it came from, so nothing downstream
//      could check whether an answer's numbers were real.
//   3. NO BOUNDARY. Whatever happened to be on the context object went to the
//      provider. Adding a field anywhere silently widened what left the system.
//
// WHAT THIS DOES INSTEAD. It selects — from authoritative sources only — the
// subset relevant to the question, and returns it as a CITABLE structure: every
// fact carries the id of the Finding, Metric or AnalysisRun it came from. That
// index is what makes output validation possible at all.
//
// INVARIANTS THIS ENFORCES
//   * Financial values come from the deterministic run. Never from knowledge,
//     never from conversation history, never from the model.
//   * Tenant scoping is explicit: a run whose tenantId does not match the
//     caller's is refused, loudly, rather than quietly narrated.
//   * Line items are bounded and opt-in. Aggregate questions get none.
//   * Knowledge is retrieved, not concatenated, and is clearly separated from
//     the business's own data in the payload.

const { createRetriever } = require("../knowledge/retriever");
const transactionRetrieval = require("../../services/transactionRetrieval");
const registry = require("../../domain/rules/registry");

const retriever = createRetriever("lexical");

/** Hard ceilings. The prompt has a budget; exceeding it degrades every answer. */
const LIMITS = Object.freeze({
  findings: 12,
  lineItems: 25,
  counterparties: 8,
  knowledgeChunks: 4,
  historyPeriods: 6
});

class TenantMismatchError extends Error {
  constructor(expected, actual) {
    super(`context requested for tenant ${expected} but the analysis run belongs to ${actual}`);
    this.name = "TenantMismatchError";
    this.code = "tenant_mismatch";
  }
}

/**
 * Which parts of the financial picture the question is about.
 *
 * Deliberately keyword-based and deterministic: routing must not itself require
 * a model call, and a wrong guess should widen the context slightly rather than
 * fabricate anything.
 */
function classifyTopics(message) {
  const q = String(message || "").toLowerCase();
  const has = (...words) => words.some((w) => q.includes(w));
  const topics = [];

  if (has("runway", "burn", "cash", "liquid", "solvent", "run out")) topics.push("cashflow");
  if (has("revenue", "sales", "income", "growth", "turnover")) topics.push("revenue");
  if (has("vendor", "supplier", "spend", "procurement")) topics.push("vendors");
  if (has("customer", "client", "payer", "buyer")) topics.push("customers");
  if (has("expense", "cost", "spending", "paid", "payment")) topics.push("expenses");
  if (has("risk", "score", "health", "rating", "how are we", "how am i")) topics.push("risk");
  if (has("duplicate", "fraud", "anomaly", "unusual", "suspicious", "flag")) topics.push("findings");
  if (has("data quality", "missing", "incomplete", "reconcil", "receipt")) topics.push("dataQuality");
  if (has("rule", "why", "how do you", "methodology", "calculate", "threshold")) topics.push("methodology");

  // Nothing matched: the question is general, so give the headline picture.
  return topics.length ? topics : ["risk", "cashflow"];
}

/**
 * Rank findings by relevance to the question.
 *
 * Severity is the tie-breaker, not the primary key: a user asking about vendors
 * should get the vendor finding even if a cash-flow finding is more severe.
 */
function selectFindings(findings, { message, topics, limit }) {
  const q = String(message || "").toLowerCase();
  const rank = { high: 3, medium: 2, low: 1 };

  const topicRules = {
    cashflow: ["cashflow_runway", "overdue_receivable", "overdue_payable"],
    vendors: ["vendor_concentration"],
    customers: ["customer_concentration"],
    findings: ["duplicate_payment", "round_number_payment", "statistical_outlier",
      "mixed_personal_business"],
    dataQuality: ["missing_transaction_fields", "missing_journal_references",
      "missing_receipt", "unreconciled_account"]
  };
  const wanted = new Set(topics.flatMap((t) => topicRules[t] || []));

  return (findings || [])
    .map((f) => {
      let score = rank[f.severity] || 1;
      if (wanted.has(f.ruleId)) score += 10;
      // The question naming a counterparty or a rule outranks everything.
      if (f.ruleId && q.includes(f.ruleId.replace(/_/g, " "))) score += 8;
      (f.evidence || []).forEach((e) => {
        const party = e.fields && e.fields.counterparty;
        if (party && q.includes(String(party).toLowerCase())) score += 12;
      });
      return { f, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ f }) => f);
}

/**
 * A finding, reduced to what the model needs and NOTHING more.
 *
 * `findingId` is the citation handle: the validator uses it to check that a
 * claim the model makes about a finding refers to one that exists.
 */
function projectFinding(f) {
  return {
    finding_id: f.findingId,
    rule_id: f.ruleId,
    rule_version: f.ruleVersion,
    category: f.category,
    severity: f.severity,
    // WHY it is that severe / that confident — so the model explains rather
    // than asserts, and cannot substitute its own judgement.
    severity_reason: f.severityReason || null,
    confidence: f.confidence,
    confidence_basis: f.confidenceBasis || null,
    title: f.title,
    description: f.description,
    metric: f.metric,
    observed_value: f.observedValue,
    threshold: f.threshold,
    currency: f.currency || null,
    calculation: f.calculation,
    // JOB 7 carry-forward: whose rule produced this. A tenant-authored finding
    // must never be narrated as an engine judgement.
    authority: f.authorityScope || "engine",
    source_record_ids: f.sourceRecordIds || []
  };
}

/** A metric, with its provenance and unit intact. */
function projectMetric(m) {
  return m.available
    ? {
      key: m.key, value: m.value, unit: m.unit, currency: m.currency,
      computed_by: m.computedBy, calculation: m.calculation || null
    }
    : { key: m.key, value: null, available: false, reason: m.reason, computed_by: m.computedBy };
}

/**
 * Build the AI context.
 *
 * @param {object} args
 *   run       {object} the authoritative engine run (REQUIRED — no run, no numbers)
 *   tenantId  {string} the caller's tenant; must match the run's
 *   message   {string} the user's question
 *   monthlyData {object} normalized records, for line-item retrieval
 *   history   {array}  prior AnalysisRun summaries
 *   retrieval {object} a pre-computed transaction retrieval result, if any
 *   includeLineItems {boolean}
 * @returns {object} { payload, citable, meta }
 */
function buildAiContext({
  run,
  tenantId = null,
  message = "",
  monthlyData = null,
  history = [],
  retrieval = null,
  includeLineItems = false,
  knowledgeLimit = LIMITS.knowledgeChunks
} = {}) {
  if (!run) {
    // Without an authoritative run there are no authoritative numbers, and a
    // model asked to discuss finances with no data will invent them. Refusing
    // is the only safe answer.
    const err = new Error("cannot build AI context without an analysis run");
    err.code = "no_analysis_run";
    throw err;
  }
  // TENANT ISOLATION, enforced here because this is the last point before data
  // leaves the system.
  if (tenantId && run.tenantId && run.tenantId !== tenantId) {
    throw new TenantMismatchError(tenantId, run.tenantId);
  }

  const topics = classifyTopics(message);
  const findings = selectFindings(run.findings, { message, topics, limit: LIMITS.findings });

  // ── Metrics: the authoritative values, keyed for citation. ──
  const metrics = run.metrics.map(projectMetric);

  // ── Risk score: published only if the engine published it. ──
  const risk = run.riskScore.available
    ? {
      overall: run.riskScore.overall,
      category: run.riskScore.category,
      components: run.riskScore.components,
      measured_components: run.riskScore.measuredComponents,
      weight_covered: run.riskScore.weightCovered,
      calculation: run.riskScore.calculation,
      scoring_version: run.riskScore.scoringVersion
    }
    : {
      overall: null,
      available: false,
      category: run.riskScore.category,
      // The model must be able to explain WHY there is no score, and must not
      // be able to supply one.
      unavailable_reason: run.riskScore.unavailableReason,
      explanation: run.riskScore.summary,
      weight_covered: run.riskScore.weightCovered
    };

  // ── Line items: bounded, and only when the question needs them. ──
  let lineItems = null;
  if (includeLineItems && monthlyData) {
    const result = retrieval || transactionRetrieval.retrieve(monthlyData, message);
    const rows = (result.transactions || result.items || []).slice(0, LIMITS.lineItems);
    lineItems = {
      matched_count: result.matchedCount != null ? result.matchedCount : rows.length,
      returned: rows.length,
      note: (result.matchedCount || 0) > rows.length
        ? `Showing ${rows.length} of ${result.matchedCount} matching records; this view is partial.`
        : null,
      filter: result.filter || null,
      rows: rows.map((t) => ({
        date: t.date || null,
        description: t.description || null,
        counterparty: t.counterparty || null,
        amount: t.amount,
        currency: t.currency || null,
        source_record_id: t.sourceRecordId || null
      }))
    };
  }

  // ── Counterparties: from the authoritative concentration calculation. ──
  const conc = run.calculations || {};
  const counterparties = {
    vendors: conc.vendors && conc.vendors.available
      ? conc.vendors.parties.slice(0, LIMITS.counterparties)
      : [],
    customers: conc.customers && conc.customers.available
      ? conc.customers.parties.slice(0, LIMITS.counterparties)
      : [],
    vendors_unavailable_reason: conc.vendors && !conc.vendors.available ? conc.vendors.reason : null,
    customers_unavailable_reason: conc.customers && !conc.customers.available ? conc.customers.reason : null
  };

  // ── Knowledge: RETRIEVED, not concatenated, and boosted toward the rules the
  //    selected findings actually came from. ──
  const knowledge = retriever.retrieve(message, {
    limit: knowledgeLimit,
    boostIds: Array.from(new Set(findings.map((f) => f.ruleId)))
  });

  const payload = {
    // Everything under `financial_data` is authoritative and computed.
    financial_data: {
      period: run.period,
      analysis_run_id: run.analysisRunId,
      engine_version: run.engineVersion,
      currency: (run.methodology && run.methodology.currency)
        ? run.methodology.currency.currency : null,
      risk_score: risk,
      metrics,
      findings: findings.map(projectFinding),
      findings_total: (run.findings || []).length,
      findings_shown: findings.length,
      counterparties,
      data_quality: run.quality,
      line_items: lineItems
    },
    // Prior periods, as SUMMARIES only — enough for "is this getting worse?"
    // without inviting the model to recompute a trend.
    history: (history || []).slice(-LIMITS.historyPeriods).map((h) => ({
      period: h.period,
      score: h.score != null ? h.score : (h.health_score != null ? h.health_score : null),
      revenue: h.revenue != null ? h.revenue : null
    })),
    // Explanatory material. Clearly separated so the model can tell the
    // difference between what is true of finance and what is true of THIS
    // business.
    knowledge: knowledge.chunks.map((c) => ({
      title: c.title, kind: c.kind, source: c.source, text: c.text
    })),
    methodology: {
      engine_version: run.engineVersion,
      rule_versions: run.ruleVersions,
      note: "Thresholds, weights and severities come from the rules registry. "
        + "They are not open to interpretation."
    }
  };

  return Object.freeze({
    payload,
    // The citation index the validator checks answers against.
    citable: buildCitableIndex(run, findings, lineItems),
    meta: Object.freeze({
      tenantId: tenantId || run.tenantId || null,
      period: run.period,
      analysisRunId: run.analysisRunId,
      topics,
      findingsSelected: findings.length,
      findingsTotal: (run.findings || []).length,
      lineItemsIncluded: lineItems ? lineItems.returned : 0,
      knowledgeChunks: knowledge.chunks.map((c) => c.chunkId),
      knowledgeStrategy: knowledge.strategy,
      approxPromptChars: JSON.stringify(payload).length
    })
  });
}

/**
 * Every number and identifier the model is ALLOWED to state, indexed for
 * validation.
 *
 * This is what makes "did the model invent this figure?" an answerable
 * question rather than a matter of trust.
 */
function buildCitableIndex(run, findings, lineItems) {
  const numbers = new Set();
  const addNumber = (v) => {
    const n = Number(v);
    if (Number.isFinite(n)) numbers.add(Math.abs(n));
  };

  run.metrics.forEach((m) => { if (m.available) addNumber(m.value); });
  if (run.riskScore.available) {
    addNumber(run.riskScore.overall);
    Object.values(run.riskScore.components || {}).forEach(addNumber);
  }
  const c = run.calculations || {};
  [c.cashflow, c.revenue, c.expenses, c.vendors, c.customers].forEach((block) => {
    if (!block) return;
    Object.values(block).forEach((v) => { if (typeof v === "number") addNumber(v); });
  });
  (c.vendors && c.vendors.parties || []).forEach((p) => { addNumber(p.amount); addNumber(p.percentage); });
  (c.customers && c.customers.parties || []).forEach((p) => { addNumber(p.amount); addNumber(p.percentage); });

  findings.forEach((f) => {
    addNumber(f.observedValue);
    addNumber(f.threshold);
    (f.evidence || []).forEach((e) => {
      if (e.fields) Object.values(e.fields).forEach((v) => { if (typeof v === "number") addNumber(v); });
    });
  });
  (lineItems ? lineItems.rows : []).forEach((r) => addNumber(r.amount));

  return Object.freeze({
    numbers: Object.freeze(Array.from(numbers).sort((a, b) => a - b)),
    findingIds: Object.freeze(findings.map((f) => f.findingId)),
    ruleIds: Object.freeze(Array.from(new Set(findings.map((f) => f.ruleId)))),
    metricKeys: Object.freeze(run.metrics.map((m) => m.key)),
    analysisRunId: run.analysisRunId,
    period: run.period,
    // Rules that exist but produced no finding — a claim citing one of these is
    // a claim about something the engine did NOT find.
    allKnownRuleIds: Object.freeze(registry.allRules().map((r) => r.id))
  });
}

module.exports = {
  buildAiContext,
  classifyTopics,
  selectFindings,
  buildCitableIndex,
  TenantMismatchError,
  LIMITS
};
