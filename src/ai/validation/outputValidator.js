// OUTPUT VALIDATION — the check that an answer's financial claims are real.
//
// THE PROBLEM. A language model asked about money will produce numbers. Most
// will be copied correctly from the context; some will be arithmetic it decided
// to do ("that's about 40% of your spend"); a few will be invented outright.
// All three look identical in the output. Before JOB 8 nothing distinguished
// them: `generateAiChatResponse` returned `{ok, text}` and the route rendered
// the text.
//
// THE APPROACH. The context builder produces a CITABLE INDEX of every value the
// model was actually given. This module extracts the numbers from the answer and
// checks each one against that index. A number that is not traceable to the
// authoritative data is an unsupported claim, regardless of how plausible it is.
//
// WHAT THIS IS NOT. It is not a truth oracle and does not attempt to judge
// prose. It answers one narrow, mechanical question — "does every financial
// figure in this answer trace to a value the deterministic engine computed?" —
// and that question turns out to catch the failure that matters.
//
// FAILURE POLICY. A failed validation NEVER produces a corrected answer, and
// never falls through to a different model. It returns a safe response that says
// the answer could not be verified. Silently repairing a fabricated figure would
// leave the user trusting a number nobody checked.

/** How the answer was judged. */
const VERDICT = Object.freeze({
  OK: "ok",                       // every claim traces to authoritative data
  UNSUPPORTED_NUMBERS: "unsupported_numbers",
  UNSUPPORTED_FINDING: "unsupported_finding",
  CONTRADICTS_METRIC: "contradicts_metric",
  MALFORMED: "malformed",
  FABRICATED_SCORE: "fabricated_score",
  EMPTY: "empty"
});

/**
 * Numbers a model may legitimately use without them coming from the data:
 * small integers used in prose ("3 steps", "the top 5"), years, and percentages
 * of speech ("100%"). Flagging these would make validation useless.
 */
const AMBIENT_MAX = 12;
const YEAR_MIN = 1990;
const YEAR_MAX = 2100;

/** Values that carry no financial meaning on their own. */
function isAmbient(n) {
  if (!Number.isFinite(n)) return true;
  if (n <= AMBIENT_MAX) return true;                 // counts, rankings, list sizes
  if (n >= YEAR_MIN && n <= YEAR_MAX && Number.isInteger(n)) return true; // years
  if (n === 100) return true;                        // "100%", a whole
  return false;
}

/**
 * Pull candidate financial figures out of prose.
 *
 * Handles "KES 1,234,567", "1.2m", "45%", "4.5 months", bare "250000".
 * Deliberately over-collects: a false positive is inspected against the index
 * and dismissed, whereas a missed number would go unchecked.
 */
function extractNumbers(text) {
  const found = [];
  const src = String(text || "");

  // Numbers with optional thousands separators and decimals, plus an optional
  // magnitude suffix.
  const re = /(-?\d[\d,]*(?:\.\d+)?)\s*(%|m\b|k\b|bn\b|million|thousand|billion)?/gi;
  let match;
  while ((match = re.exec(src)) !== null) {
    const raw = match[1].replace(/,/g, "");
    let value = Number(raw);
    if (!Number.isFinite(value)) continue;
    const suffix = (match[2] || "").toLowerCase();
    if (suffix === "k" || suffix === "thousand") value *= 1e3;
    else if (suffix === "m" || suffix === "million") value *= 1e6;
    else if (suffix === "bn" || suffix === "billion") value *= 1e9;
    found.push({
      value: Math.abs(value),
      raw: match[0].trim(),
      isPercent: suffix === "%",
      index: match.index
    });
  }
  return found;
}

/**
 * Is this number supported by the authoritative data?
 *
 * Tolerance exists because the model legitimately rounds: a runway of 4.2
 * months narrated as "about 4 months" is correct, not fabricated. The tolerance
 * is RELATIVE so it stays proportionate across magnitudes, with an absolute
 * floor so small values are not matched too eagerly.
 */
function isSupported(value, citableNumbers, { relativeTolerance = 0.01 } = {}) {
  if (isAmbient(value)) return true;
  for (const known of citableNumbers) {
    if (known === value) return true;
    const tolerance = Math.max(0.5, Math.abs(known) * relativeTolerance);
    if (Math.abs(known - value) <= tolerance) return true;
    // The model may state a rounded form of a large figure.
    if (Math.abs(known) >= 1000) {
      const roundings = [
        Math.round(known / 1000) * 1000,
        Math.round(known / 100) * 100,
        Math.round(known / 1e6 * 10) / 10 * 1e6
      ];
      if (roundings.some((r) => Math.abs(r - value) <= Math.max(0.5, Math.abs(r) * 0.005))) return true;
    }
  }
  return false;
}

/** Finding ids and rule ids the answer refers to. */
function extractReferences(text) {
  const src = String(text || "");
  return {
    findingIds: Array.from(new Set((src.match(/\bfnd_[0-9a-f]{24}\b/g) || []))),
    ruleIds: Array.from(new Set((src.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) || [])))
  };
}

/**
 * Validate a free-text answer against the context it was given.
 *
 * @param {object} args
 *   text     {string} the model's answer
 *   citable  {object} the index from contextBuilder
 *   strict   {boolean} fail on ANY unsupported number (default true)
 * @returns {object} { valid, verdict, issues, checked, unsupported }
 */
function validateAnswer({ text, citable, strict = true } = {}) {
  const answer = String(text || "").trim();
  const issues = [];

  if (!answer) {
    return result(false, VERDICT.EMPTY, [{
      kind: VERDICT.EMPTY, detail: "The provider returned no answer."
    }], 0, []);
  }
  if (!citable) {
    // Without an index we cannot verify anything, so we must not claim we did.
    return result(false, VERDICT.MALFORMED, [{
      kind: VERDICT.MALFORMED,
      detail: "No citable index was supplied, so the answer's figures could not be checked."
    }], 0, []);
  }

  // ── 1. Every financial figure must trace to authoritative data. ──
  const numbers = extractNumbers(answer);
  const unsupported = numbers.filter((n) => !isSupported(n.value, citable.numbers));
  if (unsupported.length) {
    issues.push({
      kind: VERDICT.UNSUPPORTED_NUMBERS,
      detail: `${unsupported.length} figure(s) in the answer do not match any value the `
        + "deterministic engine computed for this period.",
      values: unsupported.slice(0, 8).map((n) => n.raw)
    });
  }

  // ── 2. A cited finding must exist. ──
  const refs = extractReferences(answer);
  const unknownFindings = refs.findingIds.filter((id) => !citable.findingIds.includes(id));
  if (unknownFindings.length) {
    issues.push({
      kind: VERDICT.UNSUPPORTED_FINDING,
      detail: "The answer cites finding ids that are not in this analysis.",
      values: unknownFindings.slice(0, 5)
    });
  }

  // ── 3. A rule may only be discussed as FOUND if it produced a finding. ──
  // Naming a real rule is fine ("we also check for duplicates"); asserting it
  // fired when it did not is not.
  const assertedRules = refs.ruleIds.filter((id) =>
    citable.allKnownRuleIds.includes(id) && !citable.ruleIds.includes(id));
  assertedRules.forEach((ruleId) => {
    const claimed = new RegExp(
      `(?:found|detected|flagged|identified|shows?|indicates?)[^.]{0,60}${ruleId}`, "i");
    if (claimed.test(answer)) {
      issues.push({
        kind: VERDICT.UNSUPPORTED_FINDING,
        detail: `The answer claims rule "${ruleId}" produced a finding, but it did not `
          + "fire for this period.",
        values: [ruleId]
      });
    }
  });

  // ── 4. A withheld risk score must not be supplied by the model. ──
  if (citable.riskScoreAvailable === false) {
    const scoreClaim = /(?:score|health|rating)\D{0,24}(\d{1,3})\s*(?:\/\s*100|out of 100|points)?/i;
    const m = answer.match(scoreClaim);
    if (m && Number(m[1]) > 0 && !isAmbient(Number(m[1]))) {
      issues.push({
        kind: VERDICT.FABRICATED_SCORE,
        detail: "The engine withheld a risk score for insufficient evidence, but the "
          + "answer states one.",
        values: [m[0]]
      });
    }
  }

  const verdict = issues.length ? issues[0].kind : VERDICT.OK;
  const valid = !issues.length || (!strict && verdict === VERDICT.UNSUPPORTED_NUMBERS
    && unsupported.length <= 1);
  return result(valid, valid ? VERDICT.OK : verdict, issues, numbers.length, unsupported);
}

/**
 * Validate STRUCTURED output (the interpretation/report path), which must parse
 * and must not carry numbers of its own.
 */
function validateStructured({ raw, citable, requiredKeys = [] } = {}) {
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(extractJson(raw)) : raw;
  } catch (err) {
    return result(false, VERDICT.MALFORMED, [{
      kind: VERDICT.MALFORMED,
      detail: `The provider's structured output could not be parsed: ${err.message}`
    }], 0, []);
  }
  if (!parsed || typeof parsed !== "object") {
    return result(false, VERDICT.MALFORMED, [{
      kind: VERDICT.MALFORMED, detail: "Structured output was not an object."
    }], 0, []);
  }
  const missing = requiredKeys.filter((k) => parsed[k] === undefined);
  if (missing.length) {
    return result(false, VERDICT.MALFORMED, [{
      kind: VERDICT.MALFORMED,
      detail: `Structured output is missing required keys: ${missing.join(", ")}.`
    }], 0, []);
  }

  // The narrative fields are prose, and prose can contain fabricated figures.
  const prose = JSON.stringify(parsed);
  const textCheck = validateAnswer({ text: prose, citable, strict: true });
  return Object.freeze(Object.assign({}, textCheck, { parsed }));
}

/** Providers often wrap JSON in prose or a fenced block. */
function extractJson(text) {
  const src = String(text || "").trim();
  const fenced = src.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const first = src.indexOf("{");
  const last = src.lastIndexOf("}");
  if (first !== -1 && last > first) return src.slice(first, last + 1);
  return src;
}

function result(valid, verdict, issues, checked, unsupported) {
  return Object.freeze({
    valid,
    verdict,
    issues: Object.freeze(issues),
    checked,
    unsupported: Object.freeze(unsupported.map((u) => u.raw))
  });
}

/**
 * The response returned INSTEAD of an answer that failed validation.
 *
 * It is deliberately plain and does not attempt to answer the question: the
 * point is that the user learns the answer could not be verified, not that they
 * receive a slightly different unverified answer.
 */
function safeResponse({ verdict, issues = [], period } = {}) {
  const reason = issues[0] ? issues[0].detail : "The answer could not be verified.";
  return Object.freeze({
    ok: false,
    safe: true,
    verdict,
    reason,
    text:
      "I could not give you an answer I can stand behind for this question.\n\n"
      + `${reason}\n\n`
      + "Rather than show you figures I cannot trace back to your data, I have held "
      + "the response. The analysis itself is unaffected — the findings and scores on "
      + `your dashboard${period ? ` for ${period}` : ""} are computed by the rules engine `
      + "and remain accurate. Try asking about a specific finding, vendor or period."
  });
}

module.exports = {
  VERDICT,
  validateAnswer,
  validateStructured,
  extractNumbers,
  extractReferences,
  isSupported,
  isAmbient,
  extractJson,
  safeResponse
};
