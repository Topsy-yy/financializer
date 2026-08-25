// PERSISTENT COPILOT CONVERSATIONS.
//
// WHAT THIS REPLACES. JOB 9 held conversations in a per-process Map. That was a
// deliberate privacy choice — a transcript is the one thing in this system that
// is free text about a business's finances and has no authoritative value, so
// keeping it out of storage kept it out of a second place at rest.
//
// It was also unshippable: conversations died on restart, a second instance
// could not see them, and continuity required sticky sessions.
//
// THE RESOLUTION. Conversations persist, but the privacy reasoning is preserved
// as CONSTRAINTS rather than abandoned:
//
//   * Only what is necessary is stored: the text of each turn and the IDs it
//     referred to. No figures, no findings, no metrics.
//   * Entity references are IDs. "That finding" resolves against the analysis
//     run each time, so the transcript can never become a stale second copy.
//   * Retention is first-class: every conversation has an expiry, and deletion
//     is an operation rather than something support has to hand-write SQL for.
//   * Tenant-scoped under FORCE ROW LEVEL SECURITY, like every other tenant
//     table.
//
// THE INVARIANT FROM JOB 9 IS UNCHANGED: conversation history is not
// authoritative financial truth. It resolves what the user is REFERRING to;
// every figure is re-read from the run.

const crypto = require("crypto");
const { withTenant, isConfigured } = require("../pool");

/** Matches the in-memory bounds, so behaviour does not change with the store. */
const LIMITS = Object.freeze({
  turnsInPrompt: 6,
  charsPerTurn: 500,
  maxTurnsStored: 50,
  maxEntities: 20
});

const DEFAULT_RETENTION_DAYS = 90;

class ConversationAccessError extends Error {
  constructor(conversationId) {
    super(`conversation ${conversationId} does not belong to this tenant`);
    this.name = "ConversationAccessError";
    this.code = "conversation_access_denied";
  }
}

function newId() {
  return "cnv_" + crypto.randomBytes(9).toString("hex");
}

/**
 * Open a conversation, creating it if necessary.
 *
 * A conversationId that exists but belongs to ANOTHER tenant is not found here
 * — RLS makes it invisible — so this creates a new conversation rather than
 * throwing. That is the correct outcome for an isolation boundary: the caller
 * learns nothing about whether the id exists elsewhere.
 */
async function open(tenantId, { conversationId = null, userId = null, analysisRunId = null,
  period = null, retentionDays = DEFAULT_RETENTION_DAYS } = {}) {
  if (!tenantId) throw new Error("a conversation requires a tenant");

  return withTenant(tenantId, async (client) => {
    if (conversationId) {
      const { rows } = await client.query(
        "SELECT * FROM conversation WHERE id = $1", [conversationId]);
      if (rows.length) {
        const existing = rows[0];
        // The analysis may have moved on since the conversation started. Record
        // WHERE, so earlier turns are not read as describing the current run.
        if (analysisRunId && existing.analysis_run_id !== analysisRunId) {
          const { rows: counted } = await client.query(
            "SELECT count(*)::int AS n FROM conversation_turn WHERE conversation_id = $1",
            [conversationId]);
          await client.query(
            `UPDATE conversation
                SET analysis_run_id = $2, period = COALESCE($3, period),
                    run_changed_at_turn = $4, updated_at = now()
              WHERE id = $1`,
            [conversationId, analysisRunId, period, counted[0].n]);
          existing.analysis_run_id = analysisRunId;
          existing.run_changed_at_turn = counted[0].n;
        }
        return existing;
      }
    }

    /* CREATING THE ROW, and closing an existence oracle.
     *
     * RLS hides another tenant's conversation from the SELECT above, but the
     * PRIMARY KEY is global — so inserting with a foreign tenant's id raised a
     * unique-violation, and that error told the caller the id exists. A
     * conversation id is not a secret, but "does this id exist in some other
     * tenant?" is exactly the kind of question an isolation boundary should not
     * answer.
     *
     * ON CONFLICT DO NOTHING makes the collision silent; a fresh id is then
     * minted, so the caller simply gets a new conversation and learns nothing.
     */
    const requested = conversationId || newId();
    const insert = (id) => client.query(
      `INSERT INTO conversation (id, tenant_id, user_id, analysis_run_id, period, expires_at)
       VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' days')::interval)
       ON CONFLICT (id) DO NOTHING
       RETURNING *`,
      [id, tenantId, userId, analysisRunId, period, String(retentionDays)]);

    let { rows } = await insert(requested);
    if (!rows.length) {
      // The id is taken by a tenant we cannot see. Mint a new one.
      ({ rows } = await insert(newId()));
    }
    return rows[0];
  });
}

/** Read a conversation, or null when it does not exist FOR THIS TENANT. */
async function get(tenantId, conversationId) {
  if (!tenantId || !conversationId) return null;
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      "SELECT * FROM conversation WHERE id = $1", [conversationId]);
    return rows[0] || null;
  });
}

/**
 * Append a turn, trimming the oldest beyond the bound.
 *
 * Trimming DROPS rather than summarises. A summary of financial statements
 * would be a lossy copy of authoritative data and would become a competing
 * source of truth; `dropped_turns` keeps the count honest instead.
 */
async function appendTurn(tenantId, conversationId, { role, text, interactionId = null }) {
  return withTenant(tenantId, async (client) => {
    const { rows: idx } = await client.query(
      `SELECT COALESCE(MAX(turn_index), -1) + 1 AS next
         FROM conversation_turn WHERE conversation_id = $1`, [conversationId]);
    const turnIndex = idx[0].next;

    await client.query(
      `INSERT INTO conversation_turn
         (conversation_id, tenant_id, turn_index, role, text, interaction_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [conversationId, tenantId, turnIndex, role,
        String(text || "").slice(0, 4000), interactionId]);

    // Trim beyond the bound, and record how many were dropped.
    const { rows: excess } = await client.query(
      `SELECT count(*)::int AS n FROM conversation_turn WHERE conversation_id = $1`,
      [conversationId]);
    if (excess[0].n > LIMITS.maxTurnsStored) {
      const toDrop = excess[0].n - LIMITS.maxTurnsStored;
      await client.query(
        `DELETE FROM conversation_turn
          WHERE ctid IN (
            SELECT ctid FROM conversation_turn
             WHERE conversation_id = $1 ORDER BY turn_index LIMIT $2)`,
        [conversationId, toDrop]);
      await client.query(
        "UPDATE conversation SET dropped_turns = dropped_turns + $2, updated_at = now() WHERE id = $1",
        [conversationId, toDrop]);
    } else {
      await client.query(
        "UPDATE conversation SET updated_at = now() WHERE id = $1", [conversationId]);
    }
    return { turnIndex };
  });
}

/**
 * Remember a reference the conversation established.
 * IDs ONLY — never a value. This is what stops the transcript becoming a
 * competing source of financial truth.
 */
async function rememberEntity(tenantId, conversationId, { kind, entityId, label = null, atTurn = 0 }) {
  if (!entityId) return;
  return withTenant(tenantId, async (client) => {
    await client.query(
      `INSERT INTO conversation_entity
         (conversation_id, tenant_id, kind, entity_id, label, at_turn)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (conversation_id, kind, entity_id)
         DO UPDATE SET at_turn = EXCLUDED.at_turn, label = COALESCE(EXCLUDED.label, conversation_entity.label)`,
      [conversationId, tenantId, kind, entityId, label, atTurn]);

    // Bound the reference set, oldest first.
    await client.query(
      `DELETE FROM conversation_entity
        WHERE conversation_id = $1
          AND (kind, entity_id) NOT IN (
            SELECT kind, entity_id FROM conversation_entity
             WHERE conversation_id = $1 ORDER BY at_turn DESC LIMIT $2)`,
      [conversationId, LIMITS.maxEntities]);
  });
}

/** Everything the copilot needs, bounded — the same shape as the in-memory store. */
async function snapshot(tenantId, conversationId) {
  return withTenant(tenantId, async (client) => {
    const { rows: convs } = await client.query(
      "SELECT * FROM conversation WHERE id = $1", [conversationId]);
    if (!convs.length) return null;
    const conversation = convs[0];

    const { rows: turns } = await client.query(
      `SELECT role, text, turn_index FROM conversation_turn
        WHERE conversation_id = $1 ORDER BY turn_index DESC LIMIT $2`,
      [conversationId, LIMITS.turnsInPrompt]);

    const { rows: total } = await client.query(
      "SELECT count(*)::int AS n FROM conversation_turn WHERE conversation_id = $1",
      [conversationId]);

    const { rows: entities } = await client.query(
      `SELECT kind, entity_id AS id, label, at_turn FROM conversation_entity
        WHERE conversation_id = $1 ORDER BY at_turn`,
      [conversationId]);

    return Object.freeze({
      conversationId: conversation.id,
      analysisRunId: conversation.analysis_run_id,
      period: conversation.period,
      turnCount: total[0].n + conversation.dropped_turns,
      droppedTurns: conversation.dropped_turns,
      recentTurns: turns.reverse().map((t) => ({
        role: t.role, text: String(t.text || "").slice(0, LIMITS.charsPerTurn)
      })),
      entities: entities.map((e) => ({
        kind: e.kind, id: e.id, label: e.label, at: e.at_turn
      })),
      runChanged: conversation.run_changed_at_turn != null
    });
  });
}

/** A tenant's conversations, most recent first. */
async function list(tenantId, { limit = 20 } = {}) {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT c.id, c.period, c.analysis_run_id, c.created_at, c.updated_at,
              (SELECT count(*)::int FROM conversation_turn t WHERE t.conversation_id = c.id) AS turns
         FROM conversation c
        ORDER BY c.updated_at DESC
        LIMIT $1`, [Math.min(limit, 100)]);
    return rows;
  });
}

/**
 * Delete a conversation and everything in it.
 * Retention is a first-class operation, not a support ticket.
 */
async function remove(tenantId, conversationId) {
  return withTenant(tenantId, async (client) => {
    const { rowCount } = await client.query(
      "DELETE FROM conversation WHERE id = $1", [conversationId]);
    return { deleted: rowCount > 0 };
  });
}

/** Delete everything past its retention date, for a scheduled sweep. */
async function purgeExpired(tenantId) {
  return withTenant(tenantId, async (client) => {
    const { rowCount } = await client.query(
      "DELETE FROM conversation WHERE expires_at IS NOT NULL AND expires_at < now()");
    return { purged: rowCount };
  });
}

function available() { return isConfigured(); }

module.exports = {
  LIMITS, DEFAULT_RETENTION_DAYS, ConversationAccessError,
  open, get, appendTurn, rememberEntity, snapshot, list, remove, purgeExpired,
  available, newId
};
