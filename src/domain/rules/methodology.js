// Human-readable methodology, GENERATED from the authoritative registry.
//
// WHY THIS EXISTS. Before JOB 7 the methodology was documented by hand in
// eleven skill.md files that are loaded into the LLM's system prompt at runtime.
// They had drifted from the code, and because they are fed to the model as
// instructions, the drift was not cosmetic — the model was being told:
//
//   * anomaly weights of 10/5/2, when the engine uses 12/6/2;
//   * a runway is critical under 30 days, when the engine uses 90;
//   * an uncomputable runway defaults to 12 months — the exact fallback that
//     was deleted for making an empty dataset look solvent;
//   * a score of 61 is "Fair", when the engine's own bands make it "Good".
//
// A document that is maintained by hand alongside executable rules will always
// drift. So this module RENDERS the documentation from the rules themselves.
// There is one source of truth and the prose is a projection of it.
//
// Nothing here is authoritative. This module reads the registry; the registry
// never reads this module.

const registry = require("./registry");
const materiality = require("./materiality");
const evidenceCoverage = require("./evidenceCoverage");

/** One rule, rendered. */
function describeRule(rule) {
  const severity = rule.severity.fixed
    ? `Always ${rule.severity.fixed}. ${rule.severity.reason}`
    : rule.severity.bands.map((b) => {
      const cond = b.above != null ? `above ${b.above}`
        : b.atOrAbove != null ? `at or above ${b.atOrAbove}`
          : b.below != null ? `below ${b.below}`
            : b.atOrBelow != null ? `at or below ${b.atOrBelow}` : "otherwise";
      return `${cond} → ${b.severity} (${b.reason})`;
    }).join("; ");

  const modifiers = (rule.confidence.modifiers || [])
    .map((m) => `raised to ${m.to} when ${m.label}`);

  return {
    ruleId: rule.id,
    version: rule.version,
    name: rule.title,
    category: rule.category,
    enabled: rule.enabled,
    summary: rule.summary,
    rationale: rule.rationale,
    methodology: rule.methodology,
    parameters: rule.params,
    applicability: {
      requiresData: rule.applicability.requires,
      minimumRecords: rule.applicability.minRecords,
      safeAcrossCurrencies: rule.applicability.currencySafe
    },
    severity: { policy: severity, basis: rule.severity.basis },
    confidence: {
      base: rule.confidence.base,
      basis: rule.confidence.basis,
      rationale: rule.confidence.rationale,
      modifiers
    },
    evidenceRequirements: {
      mustCiteSourceRecords: rule.evidence.mustCiteRecords,
      minimumRecordsCited: rule.evidence.minRecords
    }
  };
}

/** The complete methodology, as data. */
function describeMethodology() {
  return {
    engineVersion: registry.ENGINE_VERSION,
    generatedFrom: "src/domain/rules/registry.js",
    note: "Generated from the authoritative rules registry. Do not edit by hand — "
      + "edit the registry and this regenerates.",

    rules: registry.allRules().map(describeRule),

    scoring: {
      version: registry.HEALTH_SCORE.version,
      weights: registry.HEALTH_SCORE.weights,
      categories: registry.HEALTH_SCORE.categories.map((c) => ({
        atOrAbove: Number.isFinite(c.minScore) ? c.minScore : null,
        label: c.label
      })),
      anomalyPoints: registry.HEALTH_SCORE.anomalyPoints,
      revenueBands: registry.HEALTH_SCORE.revenueBands.map((b) => ({
        growthAtOrAbovePct: Number.isFinite(b.minGrowthPct) ? b.minGrowthPct : null,
        score: b.score
      })),
      unmeasuredComponents:
        "A component with no measurable input is null, is EXCLUDED from the weighted "
        + "average, and the remaining weights are renormalised. It is never defaulted "
        + "to a number.",
      cashFlowRisk: registry.CASHFLOW_RISK
    },

    evidenceCoverage: {
      version: evidenceCoverage.COVERAGE_POLICY_VERSION,
      minimumWeightCovered: evidenceCoverage.DEFAULT_POLICY.minWeightCovered,
      principle: "Absence of data must never improve a business's score.",
      components: evidenceCoverage.COMPONENT_EVIDENCE,
      insufficientReasons: evidenceCoverage.INSUFFICIENT
    },

    materiality: {
      version: materiality.MATERIALITY_VERSION,
      method:
        "The larger of an absolute per-currency floor and a relative floor of "
        + `${materiality.RELATIVE.significantPctOfOutflow}% of the period's outflow; `
        + "a business-configured override replaces both.",
      absoluteFloors: materiality.ABSOLUTE_FLOORS,
      relative: materiality.RELATIVE,
      defaultCurrency: materiality.DEFAULT_CURRENCY,
      configuredCurrencies: materiality.configuredCurrencies()
    },

    currency: {
      principle:
        "Amounts in different currencies are never added, compared or averaged. "
        + "There is no exchange-rate source, so a mixed-currency aggregate is "
        + "reported UNAVAILABLE with a per-currency breakdown rather than converted.",
      bases: registry.currency.BASIS
    },

    confidenceScale: {
      note: "Confidence is confidence in the FINDING — how likely it is to be real. "
        + "It is not a confidence in any language model, and no AI output "
        + "contributes to it.",
      levels: registry.CONFIDENCE,
      bases: registry.CONFIDENCE_BASIS
    },

    severityScale: {
      note: "Severity is how much a finding matters IF it is real, which is a "
        + "different question from how likely it is to be real.",
      levels: registry.SEVERITY,
      bases: registry.SEVERITY_BASIS
    }
  };
}

/** The same thing as markdown, for embedding in a document or a prompt. */
function renderMarkdown() {
  const m = describeMethodology();
  const lines = [];

  lines.push(`# FinGuard Financial Methodology (engine ${m.engineVersion})`, "");
  lines.push("> " + m.note, "");

  lines.push("## Principle", "");
  lines.push("The deterministic engine is the authority for every number below. "
    + "AI narrates these results; it never produces or overrides them.", "");

  lines.push("## Rules", "");
  lines.push("| Rule ID | Version | Category | Severity | Confidence | Requires |");
  lines.push("|---|---|---|---|---|---|");
  m.rules.forEach((r) => {
    lines.push(`| \`${r.ruleId}\` | ${r.version} | ${r.category} | ${r.severity.policy} `
      + `| ${r.confidence.base} (${r.confidence.basis}) | ${r.applicability.requiresData.join(", ") || "—"} |`);
  });
  lines.push("");

  m.rules.forEach((r) => {
    lines.push(`### \`${r.ruleId}\` v${r.version} — ${r.name}`, "");
    lines.push(r.summary, "");
    lines.push(`**Method.** ${r.methodology}`, "");
    lines.push(`**Why it exists.** ${r.rationale}`, "");
    lines.push(`**Parameters.** \`${JSON.stringify(r.parameters)}\``, "");
    lines.push(`**Severity.** ${r.severity.policy}`, "");
    lines.push(`**Confidence.** ${r.confidence.base} — ${r.confidence.rationale}`
      + (r.confidence.modifiers.length ? ` Modifiers: ${r.confidence.modifiers.join("; ")}.` : ""), "");
    lines.push(`**Evidence.** ${r.evidenceRequirements.mustCiteSourceRecords
      ? `Must cite at least ${r.evidenceRequirements.minimumRecordsCited} source record(s).`
      : "Cites the computed values it was derived from."}`, "");
  });

  lines.push("## Risk score", "");
  lines.push(`Weighted average, scoring methodology version ${m.scoring.version}.`, "");
  lines.push("| Component | Weight |", "|---|---|");
  Object.entries(m.scoring.weights).forEach(([k, v]) => lines.push(`| ${k} | ${v} |`));
  lines.push("");
  lines.push("| Score | Category |", "|---|---|");
  m.scoring.categories.forEach((c) =>
    lines.push(`| ${c.atOrAbove == null ? "below all bands" : `${c.atOrAbove} and above`} | ${c.label} |`));
  lines.push("");
  lines.push(m.scoring.unmeasuredComponents, "");

  lines.push("## Evidence coverage", "");
  lines.push(`**${m.evidenceCoverage.principle}**`, "");
  lines.push(`A score is published only when at least `
    + `${Math.round(m.evidenceCoverage.minimumWeightCovered * 100)}% of the model's weight was `
    + `actually measured. Below that the result is reported as insufficient evidence, `
    + `never as a low score — "we cannot tell" and "this is bad" are different answers.`, "");

  lines.push("## Materiality", "");
  lines.push(m.materiality.method, "");
  lines.push("| Currency | Significant at | Round-number unit |", "|---|---|---|");
  Object.entries(m.materiality.absoluteFloors).forEach(([code, f]) =>
    lines.push(`| ${code} | ${f.significant} | ${f.roundNumberMultiple} |`));
  lines.push("");

  lines.push("## Currency", "");
  lines.push(m.currency.principle, "");

  lines.push("## Severity and confidence", "");
  lines.push(m.severityScale.note, "");
  lines.push(m.confidenceScale.note, "");

  return lines.join("\n");
}

module.exports = { describeMethodology, describeRule, renderMarkdown };
