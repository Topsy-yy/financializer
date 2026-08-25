// THE FINANCIAL COPILOT.
//
//   question
//      -> intent + reference resolution      (deterministic, no model call)
//      -> authoritative capabilities         (deterministic data retrieval)
//      -> redaction policy                   (identity only if needed AND allowed)
//      -> bounded context + knowledge
//      -> provider
//      -> claim validation                   (fact / inference / recommendation)
//      -> rehydrate identities
//      -> audit
//
// WHAT MAKES THIS A COPILOT RATHER THAN A CHAT ENDPOINT. The model is not asked
// to find the answer inside a large blob. The question is routed to a NAMED
// capability that returns exactly the authoritative data required, and the model
// is asked only to explain that data. When no capability fits, it falls back to
// the JOB 8 general path — still bounded, still validated.
//
// EVERY JOB 8 INVARIANT HOLDS HERE. No database access from this layer; all
// retrieval goes through capabilities, which go through the domain. The model
// never computes an authoritative value, never overrides a finding, and a
// failed validation is never billed.

const crypto = require("crypto");
const capabilities = require("../capabilities");
const conversationStore = require("./conversation");
const redaction = require("../context/redaction");
const claimValidator = require("../validation/claimValidator");
const { buildAiContext, TenantMismatchError } = require("../context/contextBuilder");
const providerRouter = require("../providers/router");
const adapter = require("../providers/adapter");
const { createRetriever } = require("../knowledge/retriever");
const aiAudit = require("../../db/repositories/aiAuditRepository");
const billing = require("../billing");
const { logger } = require("../../services/logger");
const log = logger.child({ component: "copilot" });

const retriever = createRetriever("lexical");

/** The suggested actions the UI offers, each mapped to a capability. */
const SUGGESTIONS = Object.freeze([
  { label: "Why did my score change?", intent: "compare" },
  { label: "What needs attention first?", intent: "top_risks" },
  { label: "Show me risky transactions", intent: "transactions" },
  { label: "Explain this finding", intent: "explain_finding" },
  { label: "Compare with previous period", intent: "compare" },
  { label: "What should I do next?", intent: "top_risks" }
]);

/**
 * Route a question to a capability. Deterministic keyword routing: choosing the
 * retrieval strategy must not itself require a model call, and a wrong guess
 * should widen the context rather than fabricate.
 */
function classifyIntent(message) {
  const q = String(message || "").toLowerCase();
  const has = (...w) => w.some((x) => q.includes(x));

  /* ORDER MATTERS. "What happens if revenue drops by 20%?" contains "drop", so
     a compare-first ordering routed a scenario question to the comparison
     capability and answered the wrong question entirely. The more specific
     intent is tested first. */
  if (has("what if", "what happens if", "simulate", "scenario", "suppose",
    "if revenue", "if i hire", "if we hire", "drops by", "drop by",
    "increases by", "increase by")) return "what_if";
  if (has("compare", "last month", "previous", "versus", " vs ", "changed", "dropped",
    "worse than", "better than", "improve", "why did my", "since last")) return "compare";
  if (has("evidence", "which transaction", "what transactions", "show me the record",
    "back this up", "prove")) return "evidence";
  if (has("explain this", "why was this", "why did you flag", "what does this mean",
    "this finding")) return "explain_finding";
  /* Methodology before risk_score: "how is the health score calculated?" is a
     question about the METHOD, not about this business's score, and answering
     it with the score would answer the wrong question. */
  if (has("how do you", "how is it calculated", "how is the health score calculated",
    "methodology", "threshold", "what rule", "how does the", "how are.*calculated"))
    return "methodology";
  if (has("score", "health", "rating", "how are we doing", "how am i doing")) return "risk_score";
  if (has("biggest risk", "top risk", "what needs attention", "what should i",
    "investigate first", "priorit", "risks this month")) return "top_risks";
  if (has("vendor", "supplier", "customer", "client", "concentration",
    "who do we")) return "counterparty";
  if (has("transaction", "payment", "spent", "paid", "line item")) return "transactions";
  return "general";
}

/**
 * Which finding is "this"?
 *
 * In order: an explicit id from the client (the user clicked a finding), then a
 * reference resolved from the conversation, then — when the period has exactly
 * ONE business finding — that finding, because "why was this flagged?" is
 * unambiguous in that case.
 */
function resolveFindingReference({ findingId, message, snapshot, run }) {
  if (findingId) return findingId;
  const fromConversation = conversationStore.resolveReference(message, snapshot, "finding");
  if (fromConversation) return fromConversation.id;

  const business = (run.findings || []).filter((f) => !f.isDataQuality);
  if (business.length === 1) return business[0].findingId;

  // Several findings and no reference: do not guess which one the user meant.
  return null;
}

/** Which capabilities an intent needs. */
const INTENT_CAPABILITIES = Object.freeze({
  compare: ["compare_analysis_runs", "explain_risk_score"],
  what_if: ["run_authoritative_what_if"],
  evidence: ["get_finding_evidence"],
  explain_finding: ["explain_finding", "get_finding_evidence"],
  risk_score: ["explain_risk_score"],
  top_risks: ["get_top_risks"],
  counterparty: ["get_counterparty_summary"],
  methodology: ["get_methodology_explanation"],
  transactions: ["get_related_transactions"],
  general: ["get_top_risks", "explain_risk_score"]
});

const SYSTEM_RULES = [
  "You are FinGuard AI, the financial copilot for an SME.",
  "",
  "A deterministic rules engine computed every financial figure you are given.",
  "You explain that data. You never recompute it and never supply a figure of your own.",
  "",
  "RETURN STRICT JSON with exactly this shape:",
  "{",
  '  "summary": "2-3 sentences answering the question directly",',
  '  "facts": [{"claim": "...", "citations": ["finding:fnd_...", "metric:cashflow.net"]}],',
  '  "inferences": [{"claim": "...", "supportingReferences": ["finding:fnd_..."]}],',
  '  "recommendations": [{"claim": "..."}],',
  '  "limitations": ["..."]',
  "}",
  "",
  "RULES FOR EACH SECTION:",
  "- facts: ONLY statements taken directly from the data below. Every fact MUST cite",
  "  the finding, metric, record or analysis run it came from, using the exact ids",
  "  shown. A statement you cannot cite is NOT a fact — put it in inferences.",
  "- inferences: your interpretation of those facts. Clearly an interpretation.",
  "- recommendations: what the owner could do or investigate. No figures unless",
  "  they appear in the data.",
  "- limitations: what you could not determine, and why.",
  "",
  "Never state a figure that is not in the data. Never claim a rule found something",
  "unless a finding for that rule is present. If the score is unavailable, explain",
  "why rather than estimating one.",
  "",
  "Counterparties may appear as 'Vendor A' or 'Customer B'. Use those labels exactly",
  "as given; do not guess real names."
].join("\n");

/**
 * Answer a copilot question.
 *
 * @returns a structured, validated response, or an honest failure.
 */
async function ask({
  run,
  previousRun = null,
  tenantId = null,
  userId = null,
  userRole = null,
  profile = null,
  config = null,
  message = "",
  conversationId = null,
  store,
  monthlyData = null,
  operation = "chat",
  assistant = null,
  scenario = null,
  scenarioParams = {},
  findingId = null
} = {}) {
  const startedAt = Date.now();
  const interactionId = "ai_" + crypto.randomBytes(12).toString("hex");
  const audit = {
    id: interactionId, userId, conversationId, tenantId,
    outcome: aiAudit.OUTCOME.FAILED
  };

  if (!run) {
    return finish(failure("no_analysis_run",
      "There is no analysis for this period yet, so I have nothing authoritative to answer from."),
    audit, startedAt, tenantId);
  }
  if (tenantId && run.tenantId && run.tenantId !== tenantId) {
    return finish(failure("tenant_mismatch", "That analysis belongs to a different workspace.",
      { fatal: true }), audit, startedAt, tenantId);
  }

  /* ── 1. CONVERSATION. Bounded, durable where a database exists, and never a
     source of figures. `store` is an adapter (see copilot/store.js) so the same
     code path works against PostgreSQL or the in-memory development store. ── */
  const conversation = await store.open({
    tenantId, conversationId, analysisRunId: run.analysisRunId, period: run.period
  });
  const snapshot = await store.snapshot(conversation);
  audit.conversationId = conversation.id;
  audit.turnIndex = snapshot.turnCount;

  // ── 2. INTENT + REFERENCE RESOLUTION, deterministically. ──
  const intent = classifyIntent(message);
  const resolvedFinding = resolveFindingReference({ findingId, message, snapshot, run });

  // ── 3. REDACTION. Identity only where necessary AND authorized. ──
  const conc = run.calculations || {};
  const vendorNames = (conc.vendors && conc.vendors.parties || []).map((p) => p.name);
  const customerNames = (conc.customers && conc.customers.parties || []).map((p) => p.name);
  const policy = redaction.resolveLevel({
    role: userRole, message, knownParties: vendorNames.concat(customerNames)
  });
  const aliases = redaction.buildAliasMap({
    tenantId, period: run.period,
    vendors: vendorNames, customers: customerNames,
    namedParties: policy.namedParties
  });
  audit.redactionLevel = policy.level;

  // ── 4. CAPABILITIES. Authoritative retrieval, before any model call. ──
  /* An intent that needs a specific finding, with none resolved, falls back to
     the general risk view rather than failing. "Why was this flagged?" with
     nothing selected is a reasonable question — the honest answer is to show
     what WAS flagged, not to refuse. */
  const needsFinding = ["explain_finding", "evidence"].includes(intent);
  const wanted = (needsFinding && !resolvedFinding)
    ? ["get_top_risks"]
    : (INTENT_CAPABILITIES[intent] || INTENT_CAPABILITIES.general);
  const results = [];
  wanted.forEach((name) => {
    const result = capabilities.invoke(name, {
      run, previousRun, tenantId, monthlyData,
      findingId: resolvedFinding, aliases, level: policy.level,
      scenario: scenario || inferScenario(message),
      params: scenarioParams,
      filter: null
    });
    results.push(result);
  });
  const usable = results.filter((r) => r.ok);
  audit.capabilitiesUsed = results.map((r) => r.capability);

  /* THE PRIMARY capability is the one the question actually asked for; the rest
     are supporting context. If the primary is unavailable, say so — even when a
     supporting capability succeeded.

     Answering "why is this month worse than last month?" with an explanation of
     THIS month's score, because the comparison was impossible, answers a
     question the user did not ask and hides the fact that there is nothing to
     compare against. */
  const primary = results[0];
  if (!primary || !primary.ok) {
    return finish(failure("data_unavailable", describeUnavailable(primary || {}), {
      capability: primary && primary.capability,
      capabilityReason: primary && primary.reason,
      detail: primary && primary.detail
    }), audit, startedAt, tenantId);
  }
  if (!usable.length) {
    return finish(failure("data_unavailable", describeUnavailable(results[0] || {})),
      audit, startedAt, tenantId);
  }

  // ── 5. CONTEXT. Bounded, and redacted to the resolved level. ──
  let context;
  try {
    context = buildAiContext({
      run, tenantId, message, monthlyData,
      includeLineItems: intent === "transactions" || intent === "evidence"
    });
  } catch (err) {
    if (err instanceof TenantMismatchError) {
      return finish(failure("tenant_mismatch", err.message, { fatal: true }),
        audit, startedAt, tenantId);
    }
    return finish(failure(err.code || "context_unavailable", err.message),
      audit, startedAt, tenantId);
  }

  const redactedFinancial = redactPayload(context.payload.financial_data, policy.level, aliases);
  const knowledge = retriever.retrieve(message, {
    limit: 3,
    boostIds: (run.findings || []).map((f) => f.ruleId)
  });

  audit.analysisRunId = run.analysisRunId;
  audit.period = run.period;
  audit.engineVersion = run.engineVersion;
  audit.findingIds = context.citable.findingIds;
  audit.metricKeys = context.citable.metricKeys;
  audit.knowledgeChunks = knowledge.chunks.map((c) => c.chunkId);
  audit.lineItemsCount = context.meta.lineItemsIncluded;

  // ── 6. ROUTING. ──
  const routing = providerRouter.route({ profile, config, operation });
  if (!routing.allowed) {
    audit.outcome = aiAudit.OUTCOME.DENIED;
    return finish(failure(routing.reason, describeDenial(routing), { routing }),
      audit, startedAt, tenantId);
  }
  audit.provider = routing.provider;
  audit.routingMode = routing.mode;

  /* BILLING PREFLIGHT, before the provider. In production an unavailable ledger
     fails closed here — we decline rather than serve a request we cannot
     account for, and no provider tokens are spent finding that out. */
  const billable = billing.preflight({ tenantId, profile, operation });
  if (!billable.ok) {
    audit.outcome = aiAudit.OUTCOME.DENIED;
    audit.failureReason = billable.reason;
    return finish(failure(billable.reason,
      billable.message || "Billing is unavailable, so AI requests are paused."),
    audit, startedAt, tenantId);
  }

  // ── 7. PROVIDER. ──
  const prompt = buildPrompt({
    message, snapshot, intent, financial: redactedFinancial,
    capabilityResults: usable, knowledge, period: run.period
  });
  audit.prompt = prompt;

  const completion = await adapter.complete({
    provider: routing.provider, apiKey: routing.apiKey, prompt,
    temperature: 0.2, assistant, policy: routing.policy, maxTokens: 2048
  });
  audit.model = completion.model;

  if (!completion.ok) {
    audit.outcome = aiAudit.OUTCOME.FAILED;
    audit.failureReason = completion.reason;
    return finish(failure(completion.reason || "ai_request_failed",
      describeProviderFailure(completion),
      { provider: completion.provider, detail: completion.detail }),
    audit, startedAt, tenantId);
  }
  audit.response = completion.text;

  // ── 8. CLAIM VALIDATION. ──
  const index = claimValidator.buildClaimIndex(
    Object.assign({}, context.citable, { riskScoreAvailable: run.riskScore.available }),
    { run, capabilities: usable.map((r) => r.capability) });

  let parsed;
  try {
    parsed = JSON.parse(extractJson(completion.text));
  } catch (err) {
    audit.outcome = aiAudit.OUTCOME.BLOCKED;
    audit.validationVerdict = "malformed";
    return finish(blocked("malformed",
      "The response could not be read as a structured answer.", []),
    audit, startedAt, tenantId);
  }

  const validated = claimValidator.validateResponse(parsed, index);
  audit.validationVerdict = validated.valid ? "ok" : "rejected";
  audit.validationIssues = validated.report.issues;

  if (!validated.valid) {
    audit.outcome = aiAudit.OUTCOME.BLOCKED;
    /* The issues are recorded in the AUDIT trail, which is tenant-scoped and
       exists for exactly this investigation. They are NOT returned to the
       client: `issues` carries the offending claim text, so echoing it would
       show the user the very fabrication that was blocked. Only the reason
       for each rejection crosses the boundary. */
    return finish(blocked("unsupported_claims",
      "I could not trace that answer back to your analysis, so I have held it.",
      validated.report.issues.map((i) => ({ type: i.type, reason: i.reason }))),
    audit, startedAt, tenantId);
  }

  // ── 9. REHYDRATE. After validation, so a real name cannot be used to slip a
  //      figure past the checks. ──
  const answer = rehydrateResponse(validated.response, policy.level, aliases);

  // ── 10. CHARGE. Only now, after a validated answer exists. ──
  let charged = 0;
  if (routing.managed) {
    const result = await billing.charge({ tenantId, profile, operation, interactionId });
    if (!result.ok) {
      audit.outcome = aiAudit.OUTCOME.DENIED;
      audit.failureReason = result.reason;
      /* TWO DEFECTS were closed here.
       *
       * 1. ONE MESSAGE FOR EVERY REASON. `charge()` can fail because the
       *    balance is too low, because the billing ledger is unreachable, or
       *    because the workspace has no tenant. All three produced "costs more
       *    credits than the balance allows" -- telling a user they are out of
       *    credits when in fact OUR ledger was down, which sends them to buy
       *    something they do not need and hides an outage from us.
       *
       * 2. A DEAD END. The out-of-credits reply listed follow-up questions the
       *    user could not afford to ask, and never said how to continue. On a
       *    metered product the exhaustion path has to name the way forward. */
      return finish(failure(result.reason, chargeFailureText(result), {
        // What it cost, what is left, and how to proceed -- the same shape the
        // forecast / what-if / action-plan routes already return.
        cost: result.cost || null,
        credits_remaining: result.remaining != null ? result.remaining : null,
        upgrade_path: result.reason === billing.REASON.INSUFFICIENT_CREDITS
          ? "Upgrade your plan, or add your own AI key in Settings to run "
            + "unmetered. Your financial analysis is unaffected either way."
          : null
      }), audit, startedAt, tenantId);
    }
    charged = result.cost;
  }
  audit.creditsCharged = charged;
  audit.outcome = aiAudit.OUTCOME.DELIVERED;

  // ── 11. RECORD THE TURN. Ids only — never the figures. ──
  await store.append(conversation, { role: "user", text: message });
  await store.append(conversation, {
    role: "assistant", text: answer.summary || "", interactionId
  });
  for (const f of (run.findings || []).slice(0, 5)) {
    await store.remember(conversation, "finding", f.findingId, f.title);
  }
  if (resolvedFinding) await store.remember(conversation, "finding", resolvedFinding);

  return finish(Object.freeze({
    ok: true,
    interactionId,
    conversationId: conversation.id,
    intent,
    answer,
    capabilities: usable.map((r) => ({ name: r.capability, citations: r.citations })),
    provider: completion.provider,
    model: completion.model,
    creditsCharged: charged,
    redaction: { level: policy.level, reason: policy.reason },
    meta: {
      analysisRunId: run.analysisRunId,
      period: run.period,
      knowledgeChunks: knowledge.chunks.map((c) => c.chunkId),
      claimsAccepted: validated.report.accepted,
      claimsDowngraded: validated.report.downgraded,
      claimsRejected: validated.report.rejected,
      turnCount: snapshot.turnCount + 2
    },
    suggestions: SUGGESTIONS
  }), audit, startedAt, tenantId);
}

function buildPrompt({ message, snapshot, intent, financial, capabilityResults, knowledge, period }) {
  const lines = [SYSTEM_RULES, ""];

  if (snapshot.recentTurns.length) {
    lines.push(
      "=== RECENT CONVERSATION (for resolving what the user means, NOT for figures) ===",
      snapshot.recentTurns.map((t) =>
        `${t.role === "assistant" ? "You" : "User"}: ${t.text}`).join("\n"),
      snapshot.droppedTurns
        ? `(${snapshot.droppedTurns} earlier turns are no longer in view.)` : "",
      snapshot.runChanged
        ? "NOTE: the analysis changed during this conversation. Do not carry figures "
          + "from earlier turns." : "",
      "");
  }

  lines.push(
    `Period under discussion: ${period}. Question intent: ${intent}.`,
    "",
    "=== AUTHORITATIVE RESULTS (retrieved deterministically for this question) ===",
    capabilityResults.map((r) =>
      `## ${r.capability}\n${JSON.stringify(r.data)}\nCitations available: ${r.citations.join(", ")}`)
      .join("\n\n"),
    "",
    "=== SUPPORTING FINANCIAL DATA ===",
    JSON.stringify(financial),
    "",
    "=== GENERAL KNOWLEDGE (explanatory; not about this business) ===",
    knowledge.chunks.map((c) => `[${c.kind}] ${c.title}\n${c.text}`).join("\n\n"),
    "",
    "USER QUESTION:",
    String(message || ""),
    "",
    "Respond with the JSON structure described above and nothing else."
  );
  return lines.join("\n");
}

/**
 * Apply the redaction level to the context payload.
 *
 * STRUCTURAL, not field-by-field. An earlier version enumerated the places a
 * counterparty name appears — counterparties, finding descriptions, line items —
 * and missed `metrics[].calculation`, which contains strings like
 * "top vendor Monolith Supplies: 900000 of 1000000 = 90%". A real supplier name
 * reached the model through a field nobody thought to list.
 *
 * So this walks the WHOLE payload and rewrites every string. A new field cannot
 * leak an identity by being forgotten, because nothing is enumerated.
 */
function redactPayload(financial, level, aliases) {
  if (level === redaction.LEVEL.FULL) return financial;

  const replacements = aliases
    ? aliases.entries()
      .filter(([name, alias]) => name !== alias)
      // Longest first, so "Acme Holdings" is not partly replaced by "Acme".
      .sort((a, b) => b[0].length - a[0].length)
    : [];

  const scrubString = (text) => {
    let out = String(text);
    replacements.forEach(([name, alias]) => { out = out.split(name).join(alias); });
    return out;
  };

  const walk = (value, key = null) => {
    if (value == null) return value;
    if (typeof value === "string") return scrubString(value);
    if (Array.isArray(value)) return value.map((v) => walk(v));
    if (typeof value === "object") {
      const out = {};
      Object.entries(value).forEach(([k, v]) => {
        // AGGREGATE removes identity entirely rather than pseudonymising it.
        if (level === redaction.LEVEL.AGGREGATE
            && (k === "name" || k === "counterparty" || k === "party")) {
          out[k] = null;
          return;
        }
        out[k] = walk(v, k);
      });
      return out;
    }
    return value;
  };

  return walk(JSON.parse(JSON.stringify(financial)));
}

/** Put the real names back, for the user's eyes only. */
function rehydrateResponse(response, level, aliases) {
  if (level === redaction.LEVEL.FULL || !aliases || !aliases.size) return response;
  const fix = (text) => redaction.rehydrate(text, aliases);
  return {
    summary: response.summary ? fix(response.summary) : null,
    facts: response.facts.map((f) => Object.assign({}, f, { claim: fix(f.claim) })),
    inferences: response.inferences.map((i) => Object.assign({}, i, { claim: fix(i.claim) })),
    recommendations: response.recommendations.map((r) => ({ claim: fix(r.claim) })),
    limitations: response.limitations.map(fix)
  };
}

function inferScenario(message) {
  const q = String(message || "").toLowerCase();
  if (q.includes("revenue") && (q.includes("drop") || q.includes("fall") || q.includes("lose"))) {
    return "reduce_revenue";
  }
  if (q.includes("hire") || q.includes("headcount")) return "hire_employees";
  if (q.includes("rent")) return "increase_rent";
  if (q.includes("payroll") || q.includes("salar")) return "increase_payroll";
  if (q.includes("loan") || q.includes("repay")) return "loan_repayment";
  if (q.includes("buy") || q.includes("purchase")) return "large_purchase";
  return null;
}

function describeUnavailable(result) {
  switch (result.reason) {
    case "no_previous_analysis":
      return "I only have one analysis on record, so there is nothing to compare this "
        + "period against yet.";
    case "finding_not_found":
      return "I could not find that finding in this period's analysis.";
    case "no_matching_records":
      return "No records in this period match that description.";
    case "insufficient_baseline":
      return "I cannot run that scenario: this period has no measured cash position "
        + "to project from.";
    case "unknown_scenario":
      return `I do not have a scenario for that. ${result.detail || ""}`.trim();
    case "no_transaction_data":
      return "The individual records for this period are not loaded, so I cannot look "
        + "them up.";
    default:
      return result.detail || "The data needed to answer that is not available.";
  }
}

/** Honest, human copy for a provider failure. Never a substitute answer. */
function describeProviderFailure(completion) {
  switch (completion.reason) {
    case "timeout":
      return "The AI provider did not respond in time. Your analysis is unaffected — "
        + "the findings and scores on your dashboard are computed by the rules engine.";
    case "rate_limited":
      return "The AI provider is rate-limiting requests right now. Try again shortly.";
    case "invalid_api_key":
      return "The configured AI key was rejected by the provider.";
    case "insufficient_balance":
      return "The AI provider reports no remaining balance on the configured account.";
    case "provider_unavailable":
      return "The AI provider is unavailable right now. Your analysis is unaffected.";
    default:
      return "I could not reach the AI provider. Your analysis is unaffected — the "
        + "findings and scores on your dashboard are computed by the rules engine.";
  }
}

function describeDenial(routing) {
  switch (routing.reason) {
    case providerRouter.DENIED.NO_KEY_BYOK: return "No AI key is configured for this workspace.";
    case providerRouter.DENIED.NO_KEY_MANAGED: return "The managed AI provider is unavailable.";
    case providerRouter.DENIED.INSUFFICIENT_CREDITS:
      return `This costs ${routing.cost} credits and the balance is too low.`;
    case providerRouter.DENIED.NOT_ENTITLED: return "This plan does not include that feature.";
    case providerRouter.DENIED.DISABLED: return "AI is disabled on this deployment.";
    default: return "The AI request could not be made.";
  }
}

function extractJson(text) {
  const src = String(text || "").trim();
  const fenced = src.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const first = src.indexOf("{");
  const last = src.lastIndexOf("}");
  if (first !== -1 && last > first) return src.slice(first, last + 1);
  return src;
}

/**
 * The honest sentence for each way a charge can fail.
 *
 * The distinction matters to the user: "you are out of credits" is an action
 * they can take, "our billing is down" is not — and conflating them bills the
 * blame to the wrong party.
 */
function chargeFailureText(result) {
  switch (result.reason) {
    case billing.REASON.INSUFFICIENT_CREDITS:
      return "This answer costs more AI credits than your balance allows.";
    case billing.REASON.BILLING_UNAVAILABLE:
      return "AI requests are paused because billing is temporarily unavailable "
        + "on our side. Your financial analysis is unaffected.";
    case billing.REASON.NO_TENANT:
      return "This workspace is not fully provisioned for metered AI use yet.";
    default:
      return result.message
        || "This AI request could not be billed, so it was not completed.";
  }
}

function failure(reason, text, extra = {}) {
  return Object.freeze(Object.assign({
    ok: false, blocked: false, reason, answer: null, text, creditsCharged: 0
  }, extra));
}

function blocked(reason, text, issues) {
  return Object.freeze({
    ok: false, blocked: true, reason, creditsCharged: 0,
    text,
    issues,
    answer: null
  });
}

/** Write the audit row and stamp latency. Never blocks the user's answer. */
async function finish(result, audit, startedAt, tenantId) {
  audit.latencyMs = Date.now() - startedAt;
  if (result.ok) audit.outcome = aiAudit.OUTCOME.DELIVERED;
  else if (result.blocked) audit.outcome = aiAudit.OUTCOME.BLOCKED;
  else if (!audit.outcome || audit.outcome === aiAudit.OUTCOME.FAILED) {
    audit.outcome = audit.failureReason ? aiAudit.OUTCOME.FAILED : (audit.outcome || aiAudit.OUTCOME.FAILED);
  }
  if (!audit.failureReason && !result.ok) audit.failureReason = result.reason;

  try {
    await aiAudit.record(tenantId, audit);
  } catch (err) {
    log.error("audit write failed", { error: err.message });
  }
  return Object.freeze(Object.assign({}, result, { interactionId: audit.id }));
}

module.exports = {
  ask, classifyIntent, buildPrompt, redactPayload, rehydrateResponse,
  SUGGESTIONS, SYSTEM_RULES, INTENT_CAPABILITIES
};
