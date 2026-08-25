// AI INTERACTION AUDIT.
//
// THE QUESTION THIS EXISTS TO ANSWER:
//   "Why did this user receive this answer, and what authoritative context was
//    available to the model?"
//
// PRIVACY POSTURE, stated once and enforced below.
//
// Raw prompts and raw responses are NOT persisted by default. A prompt for this
// product contains the tenant's transactions, counterparty names and balances.
// Storing it creates a SECOND copy of that data, in a table with a different
// access path from the records themselves, retained on a different schedule —
// a disclosure surface the audit purpose does not require.
//
// What is stored is the interaction's SHAPE: which analysis run grounded it,
// which findings and metrics were offered, which knowledge chunks were
// retrieved, which capabilities ran, what the validator decided, what it cost.
// That reconstructs what the model could have known and why the answer was
// allowed or blocked — without duplicating the financial data.
//
// Content INTEGRITY without content RETENTION: sha256 of the prompt and the
// response are recorded, so an investigator holding a copy (from the user, or
// from an explicit opt-in capture) can prove it is the exact text involved.
//
// `redacted_excerpt` is opt-in, bounded, and written only after counterparty
// pseudonymisation, for support cases where wording genuinely matters.

const crypto = require("crypto");
const { withTenant, isConfigured } = require("../pool");
const { logger } = require("../../services/logger");
const log = logger.child({ component: "ai-audit" });

/** Bound on any retained excerpt. Long enough to be useful, short enough to be safe. */
const MAX_EXCERPT_CHARS = 500;

const OUTCOME = Object.freeze({
  DELIVERED: "delivered",   // validated and shown to the user
  BLOCKED: "blocked",       // the model answered; validation rejected it
  FAILED: "failed",         // the provider errored or timed out
  DENIED: "denied"          // routing refused: no key, no credits, not entitled
});

function sha256(text) {
  if (text == null) return null;
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

/**
 * Record one AI interaction.
 *
 * Never throws into the caller's path: an audit failure must not deny a user
 * their answer. It is logged loudly instead, because an audit trail that
 * silently stops recording is worse than none.
 *
 * @param {string} tenantId  REQUIRED — every write is tenant-scoped.
 */
async function record(tenantId, interaction) {
  if (!isConfigured()) return { recorded: false, reason: "database_not_configured" };
  if (!tenantId) {
    // An unscoped audit row would be unattributable and unreadable under RLS.
    log.error("refusing to record an interaction with no tenant");
    return { recorded: false, reason: "no_tenant" };
  }

  const row = normalize(interaction);
  try {
    return await withTenant(tenantId, async (client) => {
      await client.query(
        `INSERT INTO ai_interaction (
           id, tenant_id, user_id, conversation_id, turn_index,
           analysis_run_id, period, engine_version,
           finding_ids, metric_keys, knowledge_chunks, capabilities_used,
           line_items_count, redaction_level,
           provider, model, routing_mode,
           outcome, validation_verdict, validation_issues, failure_reason,
           credits_charged, latency_ms,
           prompt_sha256, response_sha256, prompt_chars, response_chars, redacted_excerpt
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
           $21,$22,$23,$24,$25,$26,$27,$28
         )
         ON CONFLICT (id) DO NOTHING`,
        [
          row.id, tenantId, row.userId, row.conversationId, row.turnIndex,
          row.analysisRunId, row.period, row.engineVersion,
          row.findingIds, row.metricKeys, row.knowledgeChunks, row.capabilitiesUsed,
          row.lineItemsCount, row.redactionLevel,
          row.provider, row.model, row.routingMode,
          row.outcome, row.validationVerdict,
          row.validationIssues ? JSON.stringify(row.validationIssues) : null,
          row.failureReason,
          row.creditsCharged, row.latencyMs,
          row.promptSha256, row.responseSha256, row.promptChars, row.responseChars,
          row.redactedExcerpt
        ]
      );
      return { recorded: true, id: row.id };
    });
  } catch (err) {
    log.error("failed to record interaction", { error: err.message });
    return { recorded: false, reason: "write_failed", error: err.message };
  }
}

/**
 * Shape a caller's interaction into the stored row.
 *
 * This is where the privacy posture is ENFORCED rather than merely documented:
 * the raw text never reaches a column, only its hash, its length and — if the
 * caller explicitly opted in — a bounded excerpt.
 */
function normalize(i = {}) {
  const excerpt = i.retainExcerpt && i.redactedExcerpt
    ? String(i.redactedExcerpt).slice(0, MAX_EXCERPT_CHARS)
    : null;

  return {
    id: i.id || ("ai_" + crypto.randomBytes(12).toString("hex")),
    userId: i.userId || null,
    conversationId: i.conversationId || null,
    turnIndex: Number.isInteger(i.turnIndex) ? i.turnIndex : null,
    analysisRunId: i.analysisRunId || null,
    period: i.period || null,
    engineVersion: i.engineVersion || null,
    findingIds: toTextArray(i.findingIds),
    metricKeys: toTextArray(i.metricKeys),
    knowledgeChunks: toTextArray(i.knowledgeChunks),
    capabilitiesUsed: toTextArray(i.capabilitiesUsed),
    lineItemsCount: Number.isInteger(i.lineItemsCount) ? i.lineItemsCount : 0,
    redactionLevel: i.redactionLevel || "redacted",
    provider: i.provider || null,
    model: i.model || null,
    routingMode: i.routingMode || null,
    outcome: i.outcome || OUTCOME.FAILED,
    validationVerdict: i.validationVerdict || null,
    validationIssues: i.validationIssues || null,
    failureReason: i.failureReason || null,
    creditsCharged: Number.isInteger(i.creditsCharged) ? i.creditsCharged : 0,
    latencyMs: Number.isInteger(i.latencyMs) ? i.latencyMs : null,
    // Hashes, not content.
    promptSha256: i.promptSha256 || sha256(i.prompt),
    responseSha256: i.responseSha256 || sha256(i.response),
    promptChars: i.prompt != null ? String(i.prompt).length : (i.promptChars || null),
    responseChars: i.response != null ? String(i.response).length : (i.responseChars || null),
    redactedExcerpt: excerpt
  };
}

function toTextArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => v != null).map(String).slice(0, 100);
}

/** One interaction, for "why did this user get this answer?". */
async function findById(tenantId, id) {
  if (!isConfigured()) return null;
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      "SELECT * FROM ai_interaction WHERE id = $1", [id]);
    return rows[0] || null;
  });
}

/** A conversation's interactions, in order. */
async function findByConversation(tenantId, conversationId, { limit = 50 } = {}) {
  if (!isConfigured()) return [];
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM ai_interaction
        WHERE conversation_id = $1
        ORDER BY turn_index NULLS LAST, created_at
        LIMIT $2`,
      [conversationId, Math.min(limit, 200)]);
    return rows;
  });
}

/** Every interaction grounded in a given analysis run. */
async function findByAnalysisRun(tenantId, analysisRunId) {
  if (!isConfigured()) return [];
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      "SELECT * FROM ai_interaction WHERE analysis_run_id = $1 ORDER BY created_at DESC",
      [analysisRunId]);
    return rows;
  });
}

/** Blocked answers — where a hallucination investigation starts. */
async function findBlocked(tenantId, { limit = 50 } = {}) {
  if (!isConfigured()) return [];
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT id, created_at, validation_verdict, validation_issues, provider, model,
              analysis_run_id, conversation_id
         FROM ai_interaction
        WHERE outcome = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [OUTCOME.BLOCKED, Math.min(limit, 200)]);
    return rows;
  });
}

module.exports = {
  OUTCOME, MAX_EXCERPT_CHARS,
  record, findById, findByConversation, findByAnalysisRun, findBlocked,
  sha256, normalize
};
