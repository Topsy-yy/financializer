// CONVERSATION STATE.
//
// THE RULE THAT SHAPES EVERYTHING HERE:
//   CONVERSATION MEMORY IS NEVER A SOURCE OF FINANCIAL TRUTH.
//
// A transcript is a record of what was SAID, not of what is true. Two turns ago
// the model may have discussed a different period, or produced an answer that
// was later blocked. So the transcript is used for ONE purpose — resolving what
// the user is referring to ("and the second one?", "what about that vendor?") —
// and every figure in every answer is re-read from the authoritative run.
//
// BOUNDING. Appending the whole conversation forever fails twice: the prompt
// grows without limit, and old turns about earlier periods start competing with
// the current one. The strategy is:
//
//   * keep the last N turns in full (recency is what follow-ups depend on);
//   * keep RESOLVED ENTITY REFERENCES for the whole conversation, because
//     "that vendor" may point at something said much earlier — but store them
//     as IDs, not as remembered values;
//   * summarise nothing by default. A summary of financial statements is a
//     lossy copy of authoritative data, and would become a competing source of
//     truth. When the turn budget is exceeded, older turns are DROPPED, and the
//     conversation says so.
//
// TENANT ISOLATION. A conversation belongs to exactly one tenant. Reading it
// with a different tenant id throws rather than returning empty, because a
// silent empty result would look like a new conversation and hide the attempt.

const crypto = require("crypto");

/** How much conversation the model sees. */
const LIMITS = Object.freeze({
  turnsInPrompt: 6,        // recent turns kept verbatim
  charsPerTurn: 500,
  maxTurnsStored: 50,      // ring buffer; older turns are dropped, never summarised
  maxEntities: 20
});

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
 * In-process conversation store.
 *
 * Deliberately NOT persisted to PostgreSQL: a transcript is the one part of
 * this system that contains free text about a business's finances and has no
 * authoritative value. Keeping it in memory, scoped to the session, means it
 * expires with the session and never becomes a second copy of financial data at
 * rest. The AUDIT trail (which is persisted) records the interaction's shape
 * without the transcript.
 */
function createStore() {
  const conversations = new Map();

  function assertTenant(conversation, tenantId) {
    if (conversation.tenantId !== tenantId) {
      throw new ConversationAccessError(conversation.id);
    }
  }

  return {
    /** Start a conversation, or return the existing one for this tenant. */
    open({ tenantId, conversationId = null, analysisRunId = null, period = null }) {
      if (conversationId && conversations.has(conversationId)) {
        const existing = conversations.get(conversationId);
        assertTenant(existing, tenantId);
        // The analysis may have moved on since the conversation started.
        if (analysisRunId && existing.analysisRunId !== analysisRunId) {
          existing.analysisRunId = analysisRunId;
          existing.period = period || existing.period;
          existing.runChangedAt = existing.turns.length;
        }
        return existing;
      }
      const conversation = {
        id: conversationId || newId(),
        tenantId,
        analysisRunId,
        period,
        turns: [],
        // Resolved references, so "that finding" survives beyond the turn window.
        entities: new Map(),
        droppedTurns: 0,
        runChangedAt: null,
        createdAt: new Date().toISOString()
      };
      conversations.set(conversation.id, conversation);
      return conversation;
    },

    get(conversationId, tenantId) {
      const conversation = conversations.get(conversationId);
      if (!conversation) return null;
      assertTenant(conversation, tenantId);
      return conversation;
    },

    /** Append a turn, dropping the oldest when the buffer is full. */
    append(conversation, turn) {
      conversation.turns.push(Object.assign({
        at: new Date().toISOString(),
        index: conversation.turns.length + conversation.droppedTurns
      }, turn));
      while (conversation.turns.length > LIMITS.maxTurnsStored) {
        conversation.turns.shift();
        conversation.droppedTurns += 1;
      }
      return conversation;
    },

    /**
     * Remember a reference the user or the answer established.
     * Stored as an ID, never as a value: "the duplicate finding" resolves to a
     * finding id, and the finding is re-read from the run each time.
     */
    remember(conversation, kind, id, label = null) {
      if (!id) return;
      conversation.entities.set(`${kind}:${id}`, {
        kind, id, label, at: conversation.turns.length
      });
      while (conversation.entities.size > LIMITS.maxEntities) {
        const oldest = conversation.entities.keys().next().value;
        conversation.entities.delete(oldest);
      }
    },

    /** Everything the copilot needs about this conversation, bounded. */
    snapshot(conversation) {
      return Object.freeze({
        conversationId: conversation.id,
        analysisRunId: conversation.analysisRunId,
        period: conversation.period,
        turnCount: conversation.turns.length + conversation.droppedTurns,
        droppedTurns: conversation.droppedTurns,
        // Only the recent window goes into a prompt.
        recentTurns: conversation.turns.slice(-LIMITS.turnsInPrompt).map((t) => ({
          role: t.role,
          text: String(t.text || "").slice(0, LIMITS.charsPerTurn)
        })),
        entities: Array.from(conversation.entities.values()),
        // The analysis changed mid-conversation: earlier turns describe a
        // different run, and the answer must not carry figures across.
        runChanged: conversation.runChangedAt != null
      });
    },

    /** For tests and for session teardown. */
    size() { return conversations.size; },
    clear() { conversations.clear(); }
  };
}

/**
 * Resolve a referring expression against the conversation's entities.
 *
 * "show me the evidence" after discussing a finding should resolve to THAT
 * finding. Deterministic and explicit — if nothing resolves, the copilot asks
 * rather than guessing.
 */
function resolveReference(message, snapshot, kind) {
  const text = String(message || "").toLowerCase();
  const candidates = snapshot.entities.filter((e) => e.kind === kind);
  if (!candidates.length) return null;

  // An explicit id in the message always wins.
  const explicit = candidates.find((e) => text.includes(String(e.id).toLowerCase()));
  if (explicit) return explicit;

  // A label the user repeated, e.g. "the duplicate payment one".
  const byLabel = candidates.find((e) =>
    e.label && text.includes(String(e.label).toLowerCase()));
  if (byLabel) return byLabel;

  // A demonstrative ("this", "that", "it") with exactly one candidate in scope.
  if (/\b(this|that|it|the)\b/.test(text) && candidates.length === 1) return candidates[0];

  // Most recently mentioned, only if the message is clearly a follow-up.
  if (/\b(this|that|it|same|above)\b/.test(text)) {
    return candidates[candidates.length - 1];
  }
  return null;
}

module.exports = {
  LIMITS, createStore, resolveReference, newId, ConversationAccessError
};
