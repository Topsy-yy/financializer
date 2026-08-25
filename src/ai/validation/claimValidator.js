// FACT vs INFERENCE vs RECOMMENDATION.
//
// THE GAP THIS CLOSES. JOB 8's validator checks NUMBERS. It cannot catch a
// fabricated QUALITATIVE claim — "your largest supplier is financially
// unstable", "this pattern suggests employee fraud", "your revenue is
// seasonal" — because none of those contain a figure. Presented in the same
// voice as a detected finding, they are indistinguishable from one.
//
// THE APPROACH. The model returns STRUCTURED output that separates three kinds
// of statement, and each is held to a different standard:
//
//   FACT            must cite an authoritative reference (finding, metric,
//                   evidence record, analysis run) that EXISTS in the context.
//                   An uncited or wrongly-cited fact is downgraded or dropped.
//
//   INFERENCE       an interpretation. It must name the facts it rests on, but
//                   it is not itself required to be in the data — that is what
//                   makes it an inference. It is LABELLED, so a reader can tell
//                   it apart from a detection.
//
//   RECOMMENDATION  advice. It requires no evidential support at all, because
//                   it does not claim anything was detected. It only has to
//                   avoid asserting a fact inside itself.
//
// CRITICALLY: THE MODEL'S OWN LABELS ARE NOT TRUSTED. Asking a model to mark
// its own claims and believing it just moves the fabrication one level up — it
// will happily label an invention as a FACT. Every citation is checked against
// the context index, and a "fact" that does not survive that check is demoted
// to an inference or removed. The label the user sees is the one this module
// assigns, not the one the model asked for.

const { validateAnswer } = require("./outputValidator");

const CLAIM = Object.freeze({
  FACT: "fact",
  INFERENCE: "inference",
  RECOMMENDATION: "recommendation"
});

const ACTION = Object.freeze({
  ACCEPTED: "accepted",
  DOWNGRADED: "downgraded",   // claimed as fact, kept as inference
  REJECTED: "rejected"        // no support and not presentable
});

/**
 * Language that ASSERTS a detection. A claim using these words is stating that
 * the system found something, which is checkable; hedged language is not.
 */
const ASSERTIVE = /\b(is|are|was|were|has|have|shows?|indicates?|confirms?|proves?|detected|found|flagged|identified)\b/i;
const HEDGED = /\b(may|might|could|likely|appears?|suggests?|seems?|possibly|potentially|consider|probably|worth)\b/i;

/**
 * A citation is valid if it names something that exists in the context.
 *
 * Accepted forms:
 *   finding:fnd_...        a finding in this analysis
 *   metric:<key>           a metric the engine published
 *   record:<sourceId>      a source record cited by a finding in the context
 *   rule:<id>[@version]    a rule in the registry that FIRED here
 *   analysis_run:<id>      the run itself
 *   capability:<name>      a capability result included in the context
 */
function checkCitation(citation, index) {
  const raw = String(citation || "").trim();
  const [kind, ...rest] = raw.split(":");
  const value = rest.join(":");
  if (!kind || !value) return { valid: false, reason: "malformed_citation", citation: raw };

  switch (kind) {
    case "finding":
      return { valid: index.findingIds.includes(value), reason: "unknown_finding", citation: raw };
    case "metric":
      return { valid: index.metricKeys.includes(value), reason: "unknown_metric", citation: raw };
    case "record":
      return { valid: (index.recordIds || []).includes(value), reason: "unknown_record", citation: raw };
    case "rule": {
      const id = value.split("@")[0];
      // A rule that exists but did NOT fire cannot support a fact about this
      // period — that is the "unsupported rule claim" case, one level up.
      return { valid: index.ruleIds.includes(id), reason: "rule_did_not_fire", citation: raw };
    }
    case "analysis_run":
      return { valid: value === index.analysisRunId, reason: "unknown_run", citation: raw };
    case "capability":
      return { valid: (index.capabilities || []).includes(value), reason: "capability_not_run", citation: raw };
    default:
      return { valid: false, reason: "unknown_citation_kind", citation: raw };
  }
}

/**
 * Validate one claim.
 *
 * @param {object} claim  { type, claim, citations[] }
 * @param {object} index  the citable index, extended with recordIds/capabilities
 */
function validateClaim(claim, index) {
  const text = String((claim && claim.claim) || "").trim();
  const declared = String((claim && claim.type) || "").toLowerCase();
  const citations = Array.isArray(claim && claim.citations) ? claim.citations
    : Array.isArray(claim && claim.supportingReferences) ? claim.supportingReferences : [];

  if (!text) return { action: ACTION.REJECTED, reason: "empty_claim", type: declared, text };

  // Numbers inside ANY claim type must still be real. A recommendation saying
  // "collect the 450,000 outstanding" asserts a figure.
  const numeric = validateAnswer({ text, citable: index, strict: true });
  if (!numeric.valid && numeric.verdict === "unsupported_numbers") {
    return {
      action: ACTION.REJECTED,
      reason: "unsupported_numbers",
      detail: numeric.unsupported,
      type: declared, text
    };
  }

  const checked = citations.map((c) => checkCitation(c, index));
  const valid = checked.filter((c) => c.valid);
  const invalid = checked.filter((c) => !c.valid);

  if (declared === CLAIM.RECOMMENDATION) {
    // Advice needs no support. But it must not smuggle in an assertion about
    // what was detected — "you have a duplicate payment, so pay it back" is a
    // fact wearing a recommendation's clothes.
    return {
      action: ACTION.ACCEPTED, type: CLAIM.RECOMMENDATION, text,
      citations: valid.map((c) => c.citation),
      invalidCitations: invalid.map((c) => c.citation)
    };
  }

  if (declared === CLAIM.FACT) {
    if (!citations.length) {
      // An uncited fact is exactly the qualitative hallucination this module
      // exists for. It is not shown as a fact.
      return demoteOrReject(text, [], invalid, "fact_without_citation");
    }
    if (!valid.length) {
      return demoteOrReject(text, [], invalid, "fact_with_no_valid_citation");
    }
    return {
      action: ACTION.ACCEPTED, type: CLAIM.FACT, text,
      citations: valid.map((c) => c.citation),
      invalidCitations: invalid.map((c) => c.citation)
    };
  }

  // INFERENCE (or an unrecognised label, treated as one — the safer default).
  return {
    action: ACTION.ACCEPTED, type: CLAIM.INFERENCE, text,
    citations: valid.map((c) => c.citation),
    invalidCitations: invalid.map((c) => c.citation),
    reason: declared && declared !== CLAIM.INFERENCE ? "unrecognised_type_treated_as_inference" : null
  };
}

/**
 * A fact that cannot be supported is DOWNGRADED to an inference when it is
 * hedged, and REJECTED when it asserts.
 *
 * The distinction matters: "this may indicate supplier concentration risk" is a
 * reasonable interpretation to show with a label. "Your supplier is insolvent"
 * with no support is not showable at any label.
 */
function demoteOrReject(text, valid, invalid, reason) {
  const asserts = ASSERTIVE.test(text) && !HEDGED.test(text);
  if (asserts) {
    return {
      action: ACTION.REJECTED, reason, type: CLAIM.FACT, text,
      invalidCitations: invalid.map((c) => c.citation),
      detail: "Stated as a detected fact with no authoritative support."
    };
  }
  return {
    action: ACTION.DOWNGRADED, reason, type: CLAIM.INFERENCE, text,
    citations: [], invalidCitations: invalid.map((c) => c.citation),
    detail: "Presented as an interpretation because it is not supported by a finding or metric."
  };
}

/**
 * Validate a full structured copilot response.
 *
 * @param {object} response  { summary, facts[], inferences[], recommendations[], limitations[] }
 * @param {object} index     the citable index
 * @returns {object} the SANITISED response plus a report of what changed
 */
function validateResponse(response, index) {
  const source = response || {};
  const report = { accepted: 0, downgraded: 0, rejected: 0, issues: [] };

  const run = (list, type) => (Array.isArray(list) ? list : [])
    .map((c) => validateClaim(Object.assign({ type }, normalizeClaim(c)), index));

  const results = []
    .concat(run(source.facts, CLAIM.FACT))
    .concat(run(source.inferences, CLAIM.INFERENCE))
    .concat(run(source.recommendations, CLAIM.RECOMMENDATION));

  const facts = [];
  const inferences = [];
  const recommendations = [];

  results.forEach((r) => {
    if (r.action === ACTION.REJECTED) {
      report.rejected += 1;
      report.issues.push({ type: r.type, reason: r.reason, claim: truncate(r.text), detail: r.detail });
      return;
    }
    if (r.action === ACTION.DOWNGRADED) {
      report.downgraded += 1;
      report.issues.push({ type: "fact", reason: r.reason, claim: truncate(r.text), detail: r.detail });
    } else {
      report.accepted += 1;
    }
    const entry = { claim: r.text, citations: r.citations || [] };
    if (r.type === CLAIM.FACT) facts.push(entry);
    else if (r.type === CLAIM.RECOMMENDATION) recommendations.push({ claim: r.text });
    else inferences.push(Object.assign(entry, { supportingReferences: r.citations || [] }));
  });

  // The summary is prose and gets the numeric check, since it usually repeats
  // the headline figure.
  const summary = String(source.summary || "").trim();
  const summaryCheck = validateAnswer({ text: summary, citable: index, strict: true });
  const summarySafe = summaryCheck.valid;
  if (!summarySafe) {
    report.issues.push({
      type: "summary", reason: summaryCheck.verdict,
      claim: truncate(summary), detail: summaryCheck.unsupported
    });
  }

  const limitations = (Array.isArray(source.limitations) ? source.limitations : [])
    .map((l) => String(typeof l === "string" ? l : (l && l.claim) || "")).filter(Boolean);

  // A response with NO surviving content is not a response.
  const empty = !facts.length && !inferences.length && !recommendations.length && !summarySafe;

  return {
    valid: !empty,
    response: {
      summary: summarySafe ? summary : null,
      facts, inferences, recommendations,
      limitations: limitations.concat(derivedLimitations(report, summarySafe))
    },
    report
  };
}

/** Tell the user what was removed, rather than silently shortening the answer. */
function derivedLimitations(report, summarySafe) {
  const out = [];
  if (!summarySafe) {
    out.push("The summary was withheld because it contained a figure that does not "
      + "match the analysis.");
  }
  if (report.rejected) {
    out.push(`${report.rejected} statement(s) were removed because they asserted something `
      + "the analysis does not support.");
  }
  if (report.downgraded) {
    out.push(`${report.downgraded} statement(s) are shown as interpretation rather than `
      + "detected fact, because no finding or metric supports them.");
  }
  return out;
}

function normalizeClaim(c) {
  if (typeof c === "string") return { claim: c, citations: [] };
  return {
    claim: (c && (c.claim || c.text || c.statement)) || "",
    citations: (c && (c.citations || c.supportingReferences || c.references)) || []
  };
}

function truncate(text, n = 160) {
  const s = String(text || "");
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

/** Extend the JOB 8 citable index with what claim citations may reference. */
function buildClaimIndex(citable, { run, capabilities = [] } = {}) {
  const recordIds = new Set();
  (run && run.findings ? run.findings : []).forEach((f) => {
    (f.sourceRecordIds || []).forEach((id) => recordIds.add(id));
  });
  return Object.freeze(Object.assign({}, citable, {
    recordIds: Object.freeze(Array.from(recordIds)),
    capabilities: Object.freeze([...capabilities])
  }));
}

module.exports = {
  CLAIM, ACTION,
  validateResponse, validateClaim, checkCitation, buildClaimIndex,
  ASSERTIVE, HEDGED
};
