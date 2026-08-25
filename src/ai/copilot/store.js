// THE CONVERSATION STORE ADAPTER.
//
// One interface, two backings:
//
//   PostgreSQL   used whenever a database is configured. Conversations survive
//                restart and are shared across instances, so no sticky sessions.
//
//   in-memory    development and test only. Explicitly marked `durable: false`
//                so nothing downstream can mistake it for the real thing.
//
// The copilot does not know which it has. That is the point: the durability
// decision belongs to the deployment, not to the conversation logic.
//
// THE JOB 9 INVARIANT IS UNCHANGED by persistence: a conversation resolves what
// the user is REFERRING to, and never supplies a figure. Both backings store
// turn text and entity IDs; neither stores financial values.

const conversationRepository = require("../../db/repositories/conversationRepository");
const memory = require("./conversation");

/** A durable store backed by PostgreSQL. */
function postgresStore(tenantId) {
  return Object.freeze({
    kind: "postgres",
    durable: true,
    async open({ conversationId, analysisRunId, period, userId }) {
      const row = await conversationRepository.open(tenantId, {
        conversationId, analysisRunId, period, userId
      });
      return { id: row.id, tenantId };
    },
    async snapshot(conversation) {
      const snap = await conversationRepository.snapshot(tenantId, conversation.id);
      // A conversation that vanished (expired, or deleted) behaves as a new one
      // rather than throwing into the user's question.
      return snap || Object.freeze({
        conversationId: conversation.id, analysisRunId: null, period: null,
        turnCount: 0, droppedTurns: 0, recentTurns: [], entities: [], runChanged: false
      });
    },
    async append(conversation, turn) {
      return conversationRepository.appendTurn(tenantId, conversation.id, turn);
    },
    async remember(conversation, kind, entityId, label) {
      return conversationRepository.rememberEntity(tenantId, conversation.id, {
        kind, entityId, label
      });
    }
  });
}

/** The development store: the JOB 9 in-memory implementation, async-wrapped. */
function memoryStore(tenantId, backing) {
  const inner = backing || memory.createStore();
  return Object.freeze({
    kind: "memory",
    durable: false,
    inner,
    async open(args) { return inner.open(Object.assign({ tenantId }, args)); },
    async snapshot(conversation) { return inner.snapshot(conversation); },
    async append(conversation, turn) { return inner.append(conversation, turn); },
    async remember(conversation, kind, id, label) {
      return inner.remember(conversation, kind, id, label);
    }
  });
}

/**
 * Choose a store for this tenant.
 *
 * A tenant with no database (or no tenant id at all — a guest before
 * provisioning) gets the in-memory store, and the caller can see that from
 * `durable`.
 */
function createStore(tenantId, { fallback = null } = {}) {
  if (tenantId && conversationRepository.available()) return postgresStore(tenantId);
  return memoryStore(tenantId, fallback);
}

module.exports = { createStore, postgresStore, memoryStore };
