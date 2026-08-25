// AUTHORITATIVE COPILOT CAPABILITIES.
//
// WHY THESE EXIST. Natural-language prompting alone makes the model the
// retrieval mechanism: it is handed a blob and asked to find the answer in it.
// That fails in two directions — the blob has to be large enough to contain
// anything the user might ask (so it is always too large), and when the answer
// is not in it the model is under pressure to produce one anyway.
//
// A capability is a NAMED, DETERMINISTIC lookup against authoritative data. The
// model may request one; the RESULT always comes from the domain layer. It is
// the difference between "here is your whole month, find the duplicate" and
// "get_finding_evidence(finding_id) -> these two records".
//
// THE RULES, enforced by every capability below:
//   1. Data comes from the analysis run, the repositories or the deterministic
//      simulators. Never from the model, never from the knowledge base.
//   2. Tenant scope is checked before anything is read.
//   3. When the requested thing does not exist, the capability says so. It never
//      returns a plausible substitute, and it never returns an empty result
//      dressed as an answer.
//
// The model does not execute these. It names one; the orchestrator runs it.

const { computeCashflowForecast } = require("../../services/cashflowForecast");
const whatIfSimulator = require("../../services/whatIfSimulator");
const methodology = require("../../domain/rules/methodology");
const registry = require("../../domain/rules/registry");
const redaction = require("../context/redaction");
const { compareRuns } = require("./compare");

/** Every capability the copilot may invoke, with what it needs. */
const CAPABILITIES = Object.freeze({
  explain_risk_score: { needs: ["run"], describe: "Explain how the risk score was computed." },
  explain_finding: { needs: ["run", "findingId"], describe: "Explain one finding and why it fired." },
  get_finding_evidence: { needs: ["run", "findingId"], describe: "The source records behind a finding." },
  get_related_transactions: { needs: ["run", "monthlyData"], describe: "Transactions matching a filter." },
  compare_analysis_runs: { needs: ["run", "previousRun"], describe: "Deterministic comparison of two periods." },
  get_top_risks: { needs: ["run"], describe: "The most significant findings, ranked." },
  get_counterparty_summary: { needs: ["run"], describe: "Concentration by counterparty." },
  run_authoritative_what_if: { needs: ["run"], describe: "Run the deterministic what-if simulator." },
  get_methodology_explanation: { needs: [], describe: "How a rule or the scoring model works." }
});

/** The shape every capability returns. */
function ok(name, data, citations = []) {
  return Object.freeze({ ok: true, capability: name, data, citations: Object.freeze(citations) });
}
function unavailable(name, reason, detail = null) {
  // An honest "no" — never an empty object that reads like an answer.
  return Object.freeze({ ok: false, capability: name, reason, detail, data: null });
}

// ─────────────────────────────────────────────────────────────────

/** How the risk score was computed, component by component. */
function explain_risk_score({ run }) {
  const score = run.riskScore;
  if (!score.available) {
    return ok("explain_risk_score", {
      available: false,
      reason: score.unavailableReason,
      explanation: score.summary,
      weight_covered: score.weightCovered,
      measured_components: score.measuredComponents,
      // WHY each unmeasured component could not be measured.
      unmeasured: Object.entries(score.components)
        .filter(([, v]) => v == null).map(([k]) => k)
    }, [`analysis_run:${run.analysisRunId}`]);
  }
  return ok("explain_risk_score", {
    available: true,
    overall: score.overall,
    category: score.category,
    components: score.components,
    weights: score.weights,
    weight_covered: score.weightCovered,
    weakest_component: score.weakestComponent,
    strongest_component: score.strongestComponent,
    calculation: score.calculation,
    scoring_version: score.scoringVersion,
    business_findings: score.businessFindings,
    data_quality_findings: score.dataQualityFindings
  }, [`analysis_run:${run.analysisRunId}`]);
}

/** One finding, in full, with the rule behind it. */
function explain_finding({ run, findingId, aliases, level }) {
  const finding = (run.findings || []).find((f) => f.findingId === findingId);
  if (!finding) {
    return unavailable("explain_finding", "finding_not_found",
      `No finding ${findingId} exists in analysis run ${run.analysisRunId}.`);
  }
  let rule = null;
  try { rule = registry.getRule(finding.ruleId); } catch { /* a custom rule */ }

  return ok("explain_finding", {
    finding_id: finding.findingId,
    rule_id: finding.ruleId,
    rule_version: finding.ruleVersion,
    authority: finding.authorityScope || "engine",
    category: finding.category,
    severity: finding.severity,
    severity_reason: finding.severityReason,
    confidence: finding.confidence,
    confidence_basis: finding.confidenceBasis,
    confidence_reason: finding.confidenceReason,
    title: finding.title,
    description: applyIdentity(finding.description, level, aliases, run),
    metric: finding.metric,
    observed_value: finding.observedValue,
    threshold: finding.threshold,
    currency: finding.currency,
    calculation: finding.calculation,
    rule_rationale: rule ? rule.rationale : null,
    rule_methodology: rule ? rule.methodology : null,
    evidence_count: (finding.evidence || []).length
  }, [`finding:${finding.findingId}`, `rule:${finding.ruleId}@${finding.ruleVersion}`]);
}

/** The records that made a finding fire. */
function get_finding_evidence({ run, findingId, aliases, level }) {
  const finding = (run.findings || []).find((f) => f.findingId === findingId);
  if (!finding) {
    return unavailable("get_finding_evidence", "finding_not_found",
      `No finding ${findingId} exists in this analysis.`);
  }
  const evidence = (finding.evidence || []).map((e) => ({
    label: e.label,
    relationship: e.relationship,
    source_system: e.sourceSystem,
    source_record_id: e.sourceRecordId,
    record_type: e.recordType,
    fields: Object.assign({}, e.fields, {
      counterparty: redaction.applyToName(e.fields && e.fields.counterparty, level, aliases)
    })
  }));
  return ok("get_finding_evidence", {
    finding_id: finding.findingId,
    rule_id: finding.ruleId,
    match_criteria: finding.matchCriteria,
    calculation: finding.calculation,
    evidence
  }, [`finding:${finding.findingId}`].concat(
    (finding.sourceRecordIds || []).map((id) => `record:${id}`)));
}

/** Transactions matching a deterministic filter. */
function get_related_transactions({ monthlyData, filter, aliases, level, limit = 25 }) {
  if (!monthlyData) {
    return unavailable("get_related_transactions", "no_transaction_data",
      "The period's individual records are not loaded for this request.");
  }
  const transactionRetrieval = require("../../services/transactionRetrieval");
  const result = filter && Object.keys(filter).length
    ? transactionRetrieval.applyFilter(monthlyData, filter)
    : transactionRetrieval.applyFilter(monthlyData, { limit });

  const rows = (result.transactions || result.items || []).slice(0, limit);
  if (!rows.length) {
    return unavailable("get_related_transactions", "no_matching_records",
      "No records in this period match that description.");
  }
  return ok("get_related_transactions", {
    matched_count: result.matchedCount != null ? result.matchedCount : rows.length,
    returned: rows.length,
    partial: (result.matchedCount || 0) > rows.length,
    rows: rows.map((t) => ({
      date: t.date, amount: t.amount, currency: t.currency || null,
      description: t.description,
      counterparty: redaction.applyToName(t.counterparty, level, aliases),
      source_record_id: t.sourceRecordId || null
    }))
  }, rows.map((t) => `record:${t.sourceRecordId || "unknown"}`));
}

/** The findings that matter most, ranked by the registry's own severity model. */
function get_top_risks({ run, limit = 5, aliases, level }) {
  const rank = { high: 3, medium: 2, low: 1 };
  const business = (run.findings || []).filter((f) => !f.isDataQuality);
  if (!business.length) {
    return ok("get_top_risks", {
      count: 0,
      note: "No business-risk findings were raised for this period. Data-quality "
        + "findings, if any, are reported separately and do not indicate business risk.",
      data_quality_count: (run.findings || []).filter((f) => f.isDataQuality).length,
      risks: []
    }, [`analysis_run:${run.analysisRunId}`]);
  }
  const ranked = business
    .slice()
    .sort((a, b) => (rank[b.severity] - rank[a.severity])
      || ((b.confidence || 0) - (a.confidence || 0)))
    .slice(0, limit);

  return ok("get_top_risks", {
    count: ranked.length,
    total_business_findings: business.length,
    risks: ranked.map((f) => ({
      finding_id: f.findingId, rule_id: f.ruleId, severity: f.severity,
      confidence: f.confidence, authority: f.authorityScope || "engine",
      title: f.title,
      description: applyIdentity(f.description, level, aliases, run),
      observed_value: f.observedValue, threshold: f.threshold, currency: f.currency
    }))
  }, ranked.map((f) => `finding:${f.findingId}`));
}

/** Concentration by counterparty, at the caller's redaction level. */
function get_counterparty_summary({ run, kind = "vendor", aliases, level }) {
  const conc = (run.calculations || {})[kind === "vendor" ? "vendors" : "customers"];
  if (!conc) return unavailable("get_counterparty_summary", "not_computed");
  if (!conc.available) {
    return ok("get_counterparty_summary", {
      kind, available: false, reason: conc.reason,
      unattributed_amount: conc.unattributed_amount,
      by_currency: conc.by_currency || null,
      note: conc.reason === "mixed_currency"
        ? "Shares cannot be combined across currencies; per-currency totals are given."
        : "Concentration could not be measured for this period."
    }, [`analysis_run:${run.analysisRunId}`]);
  }
  return ok("get_counterparty_summary", {
    kind,
    available: true,
    currency: conc.currency,
    total: conc.total,
    top_share_pct: conc.top_share_pct,
    top_three_share_pct: conc.top_three_share_pct,
    risk_score: conc.risk_score,
    parties: (conc.parties || []).slice(0, 8).map((p) => ({
      name: redaction.applyToName(p.name, level, aliases),
      amount: p.amount, percentage: p.percentage
    }))
  }, [`analysis_run:${run.analysisRunId}`]);
}

/**
 * Run the DETERMINISTIC what-if simulator.
 *
 * The model does not compute the scenario; it names one, and this executes the
 * same simulator the What-If page uses. The result carries its assumptions and
 * limitations so the answer can state them.
 */
function run_authoritative_what_if({ run, scenario, params = {} }) {
  const known = whatIfSimulator.SCENARIOS || {};
  if (!scenario || !known[scenario]) {
    return unavailable("run_authoritative_what_if", "unknown_scenario",
      `Available scenarios: ${Object.keys(known).join(", ")}.`);
  }
  const cash = (run.calculations || {}).cashflow || {};
  const revenue = (run.calculations || {}).revenue || {};
  const riskScore = run.riskScore;

  /* EVERY BASELINE INPUT MUST BE MEASURED, and the check comes FIRST.
   *
   * THE DEFECT. The baseline object was built with `x != null ? x : 0` for all
   * five financial inputs, and the guard below it checked only two of them. So
   * an unmeasured monthly burn, overdue receivables figure or revenue total
   * silently became ZERO and was projected forward as fact — a scenario would
   * report "you can absorb this" on the strength of a burn rate nobody
   * measured. The substitution also sat ABOVE its own guard, so a reordering
   * would have made the cash and net-flow cases live too.
   *
   * A projection is the last place a missing value may become a zero: the
   * output is a claim about what happens to this business next quarter.
   * Nothing is defaulted now — a missing input names itself and the scenario
   * is refused. */
  const REQUIRED = [
    ["startingCash", cash.cash_on_hand, "a measured cash position"],
    ["monthlyNet", cash.net_cash_flow, "net cash flow"],
    ["monthlyBurn", cash.monthly_burn, "a monthly burn rate"],
    ["monthlyRevenue", revenue.total_revenue, "total revenue"]
  ];
  const missing = REQUIRED.filter(([, value]) => value == null);
  if (missing.length) {
    return unavailable("run_authoritative_what_if", "insufficient_baseline",
      "A scenario cannot be projected without " + missing.map((m) => m[2]).join(", ")
      + ". This period does not have "
      + (missing.length === 1 ? "that measurement." : "those measurements.")
      + " Values that were not measured are not substituted with zero.");
  }

  const baseline = {
    startingCash: cash.cash_on_hand,
    monthlyNet: cash.net_cash_flow,
    monthlyBurn: cash.monthly_burn,
    /* Overdue receivables are OPTIONAL and genuinely zero when measured-and-none.
       `overdue_receivables_measured` is what distinguishes that from unmeasured,
       so the zero here is only ever used when the engine actually measured it. */
    overdueReceivables: cash.overdue_receivables_measured
      ? (cash.overdue_receivables || 0)
      : 0,
    overdueReceivablesMeasured: Boolean(cash.overdue_receivables_measured),
    monthlyRevenue: revenue.total_revenue,
    componentScores: riskScore.components || {}
  };

  let result;
  try {
    result = whatIfSimulator.simulate({ type: scenario, params, baseline });
  } catch (err) {
    return unavailable("run_authoritative_what_if", "simulation_failed", err.message);
  }

  /* The simulator refuses on its own account when a baseline input was not
     measured. The REQUIRED check above should already have caught it; honouring
     this keeps the capability correct if the two ever drift. */
  if (result.available === false) {
    return unavailable("run_authoritative_what_if", result.reason, result.detail);
  }

  return ok("run_authoritative_what_if", {
    scenario,
    // The assumptions are stated so the answer can state them, rather than
    // presenting a projection as a prediction.
    assumptions: {
      basis: "The current period's measured cash position and run-rate, held constant.",
      method: "linear_run_rate",
      starting_cash: baseline.startingCash,
      monthly_net: baseline.monthlyNet,
      monthly_revenue: baseline.monthlyRevenue,
      inputs: params
    },
    result,
    limitations: [
      "A linear projection: it assumes the current monthly net repeats unchanged.",
      "It does not model seasonality, one-off items, or a behavioural response to the change.",
      "Components the engine could not measure are excluded from the projected score, "
        + "not estimated."
    ]
  }, [`analysis_run:${run.analysisRunId}`, "methodology:forecast"]);
}

/** How a rule or the scoring model works — generated from the registry. */
function get_methodology_explanation({ ruleId = null }) {
  if (ruleId) {
    let rule;
    try { rule = registry.getRule(ruleId); }
    catch {
      return unavailable("get_methodology_explanation", "unknown_rule",
        `No rule "${ruleId}" is in the registry.`);
    }
    return ok("get_methodology_explanation",
      methodology.describeRule(rule), [`rule:${rule.id}@${rule.version}`]);
  }
  const doc = methodology.describeMethodology();
  return ok("get_methodology_explanation", {
    engine_version: doc.engineVersion,
    scoring: doc.scoring,
    evidence_coverage: doc.evidenceCoverage,
    materiality: doc.materiality,
    currency: doc.currency
  }, ["methodology:registry"]);
}

/** Replace a real counterparty name inside a description with its alias. */
function applyIdentity(text, level, aliases, run) {
  if (!text || level === redaction.LEVEL.FULL || !aliases) return text;
  let out = String(text);
  aliases.entries().forEach(([name, alias]) => {
    if (name !== alias) out = out.split(name).join(alias);
  });
  return out;
}

/**
 * Execute a capability by name.
 *
 * Every path through here is deterministic. The model chooses WHICH; it never
 * supplies the result.
 */
function invoke(name, args = {}) {
  const spec = CAPABILITIES[name];
  if (!spec) return unavailable(name, "unknown_capability");

  // Tenant scope is verified before anything is read.
  if (spec.needs.includes("run")) {
    if (!args.run) return unavailable(name, "no_analysis_run");
    if (args.tenantId && args.run.tenantId && args.run.tenantId !== args.tenantId) {
      return unavailable(name, "tenant_mismatch",
        "That analysis belongs to a different tenant.");
    }
  }

  switch (name) {
    case "explain_risk_score": return explain_risk_score(args);
    case "explain_finding": return explain_finding(args);
    case "get_finding_evidence": return get_finding_evidence(args);
    case "get_related_transactions": return get_related_transactions(args);
    case "compare_analysis_runs": return compareRuns(args);
    case "get_top_risks": return get_top_risks(args);
    case "get_counterparty_summary": return get_counterparty_summary(args);
    case "run_authoritative_what_if": return run_authoritative_what_if(args);
    case "get_methodology_explanation": return get_methodology_explanation(args);
    default: return unavailable(name, "unknown_capability");
  }
}

module.exports = {
  CAPABILITIES, invoke, ok, unavailable,
  explain_risk_score, explain_finding, get_finding_evidence, get_related_transactions,
  get_top_risks, get_counterparty_summary, run_authoritative_what_if,
  get_methodology_explanation
};
