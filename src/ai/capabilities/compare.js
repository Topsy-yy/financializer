// DETERMINISTIC COMPARISON OF TWO ANALYSIS RUNS.
//
// WHY THIS IS CODE AND NOT A PROMPT. "Why is this month worse than last month?"
// is the question most likely to produce a fabricated answer, because handing a
// model two large JSON documents and asking what changed invites it to compute
// differences — and a computed difference is a new financial number the engine
// never produced.
//
// So the DIFF is computed here, from stored authoritative values, and the model
// receives the result. It explains a comparison; it does not perform one.
//
// WHAT IS COMPARED
//   * the overall risk score and every component
//   * each headline metric, by key
//   * findings, matched by RULE (not by finding id, which is period-scoped):
//     resolved / new / persisting
//   * data-quality grade
//
// WHAT IS DELIBERATELY NOT COMPARED
//   Anything whose two sides are not measured on the same basis. A metric that
//   is unavailable in one period is reported as a CHANGE IN MEASURABILITY, not
//   as a movement to or from zero — the mistake that made "we stopped receiving
//   data" look like "revenue collapsed".

const registry = require("../../domain/rules/registry");

/** Direction of a change, from the business's point of view. */
const DIRECTION = Object.freeze({
  IMPROVED: "improved",
  WORSENED: "worsened",
  UNCHANGED: "unchanged",
  // One side could not be measured, so no comparison is possible.
  NOT_COMPARABLE: "not_comparable"
});

/** Metrics where a HIGHER number is worse. */
const HIGHER_IS_WORSE = new Set([
  "cashflow.risk_score", "cashflow.monthly_burn",
  "vendor.top_share_pct", "customer.top_share_pct",
  "findings.duplicate_count"
]);

function compareNumber(key, before, after) {
  if (before == null || after == null) {
    return {
      key, before, after,
      delta: null, delta_pct: null,
      direction: DIRECTION.NOT_COMPARABLE,
      // The distinction that matters: this is a measurement gap, not a movement.
      note: before == null && after == null ? "Not measured in either period."
        : before == null ? "Not measured in the earlier period, so there is nothing to compare against."
          : "Not measured in the later period, so no comparison is possible."
    };
  }
  const delta = after - before;
  const deltaPct = before !== 0 ? Number(((delta / Math.abs(before)) * 100).toFixed(1)) : null;
  let direction = DIRECTION.UNCHANGED;
  if (delta !== 0) {
    const worse = HIGHER_IS_WORSE.has(key) ? delta > 0 : delta < 0;
    direction = worse ? DIRECTION.WORSENED : DIRECTION.IMPROVED;
  }
  return { key, before, after, delta: Number(delta.toFixed(2)), delta_pct: deltaPct, direction };
}

/**
 * Compare two analysis runs.
 *
 * @param {object} args
 *   run         the LATER run (the one being asked about)
 *   previousRun the EARLIER run
 * @returns the standard capability envelope
 */
function compareRuns({ run, previousRun, tenantId = null } = {}) {
  const name = "compare_analysis_runs";
  if (!run) return fail(name, "no_analysis_run");
  if (!previousRun) {
    return fail(name, "no_previous_analysis",
      "There is only one analysis on record, so there is nothing to compare it with.");
  }
  // Both runs must belong to the caller. A comparison is a two-sided read and
  // is exactly where a cross-tenant leak would hide.
  if (tenantId) {
    if (run.tenantId && run.tenantId !== tenantId) return fail(name, "tenant_mismatch");
    if (previousRun.tenantId && previousRun.tenantId !== tenantId) return fail(name, "tenant_mismatch");
  }
  if (run.period === previousRun.period) {
    return fail(name, "same_period",
      "Both analyses cover the same period; there is no change to describe.");
  }

  // ── Risk score ──
  const score = compareNumber(
    "risk.overall",
    previousRun.riskScore.available ? previousRun.riskScore.overall : null,
    run.riskScore.available ? run.riskScore.overall : null);
  score.before_category = previousRun.riskScore.category;
  score.after_category = run.riskScore.category;
  if (score.direction === DIRECTION.NOT_COMPARABLE) {
    // Say WHY, using the engine's own reason rather than a guess.
    score.before_reason = previousRun.riskScore.available ? null : previousRun.riskScore.unavailableReason;
    score.after_reason = run.riskScore.available ? null : run.riskScore.unavailableReason;
  }

  // ── Components ──
  const componentKeys = Object.keys(registry.HEALTH_SCORE.weights);
  const components = componentKeys.map((key) => Object.assign(
    compareNumber(`component.${key}`,
      previousRun.riskScore.components ? previousRun.riskScore.components[key] : null,
      run.riskScore.components ? run.riskScore.components[key] : null),
    { weight: registry.HEALTH_SCORE.weights[key] }));

  // ── Metrics, by key ──
  const beforeMetrics = indexMetrics(previousRun);
  const afterMetrics = indexMetrics(run);
  const metricKeys = Array.from(new Set(
    Object.keys(beforeMetrics).concat(Object.keys(afterMetrics))));
  const metrics = metricKeys
    .map((key) => compareNumber(key, beforeMetrics[key], afterMetrics[key]))
    .filter((m) => m.direction !== DIRECTION.UNCHANGED || m.before != null);

  // ── Findings, matched by RULE ──
  // Finding ids embed the period, so they never match across runs. The
  // meaningful question is which RULES stopped or started firing.
  const beforeRules = countByRule(previousRun);
  const afterRules = countByRule(run);
  const allRules = Array.from(new Set(
    Object.keys(beforeRules).concat(Object.keys(afterRules))));

  const findings = {
    resolved: allRules.filter((r) => beforeRules[r] && !afterRules[r])
      .map((r) => ({ rule_id: r, was: beforeRules[r].count, severity: beforeRules[r].severity })),
    new: allRules.filter((r) => !beforeRules[r] && afterRules[r])
      .map((r) => ({ rule_id: r, now: afterRules[r].count, severity: afterRules[r].severity })),
    persisting: allRules.filter((r) => beforeRules[r] && afterRules[r])
      .map((r) => ({
        rule_id: r,
        was: beforeRules[r].count,
        now: afterRules[r].count,
        direction: afterRules[r].count === beforeRules[r].count ? DIRECTION.UNCHANGED
          : afterRules[r].count > beforeRules[r].count ? DIRECTION.WORSENED : DIRECTION.IMPROVED
      }))
  };

  // ── The single biggest mover, so the answer can lead with it ──
  const movers = components
    .concat(metrics)
    .filter((c) => c.direction === DIRECTION.WORSENED && c.delta != null)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return {
    ok: true,
    capability: name,
    data: {
      from: { period: previousRun.period, analysis_run_id: previousRun.analysisRunId,
        engine_version: previousRun.engineVersion },
      to: { period: run.period, analysis_run_id: run.analysisRunId,
        engine_version: run.engineVersion },
      // A change in the ENGINE between runs can move a score without the
      // business changing at all. The comparison must say so.
      engine_changed: previousRun.engineVersion !== run.engineVersion,
      engine_note: previousRun.engineVersion !== run.engineVersion
        ? `These periods were analysed by different engine versions `
          + `(${previousRun.engineVersion} then ${run.engineVersion}); some of the change `
          + "may reflect a methodology update rather than the business."
        : null,
      score,
      components,
      metrics,
      findings,
      biggest_worsening: movers[0] || null,
      data_quality: {
        before: previousRun.quality ? previousRun.quality.level : null,
        after: run.quality ? run.quality.level : null
      }
    },
    citations: [
      `analysis_run:${previousRun.analysisRunId}`,
      `analysis_run:${run.analysisRunId}`
    ]
  };
}

function indexMetrics(run) {
  const out = {};
  (run.metrics || []).forEach((m) => {
    out[m.key] = m.available && typeof m.value === "number" ? m.value : null;
  });
  return out;
}

function countByRule(run) {
  const out = {};
  (run.findings || []).filter((f) => !f.isDataQuality).forEach((f) => {
    if (!out[f.ruleId]) out[f.ruleId] = { count: 0, severity: f.severity };
    out[f.ruleId].count += 1;
  });
  return out;
}

function fail(capability, reason, detail = null) {
  return Object.freeze({ ok: false, capability, reason, detail, data: null });
}

module.exports = { compareRuns, compareNumber, DIRECTION, HIGHER_IS_WORSE };
