-- JOB 9 — AI interaction auditing, and an atomic credit ledger.
--
-- ─────────────────────────────────────────────────────────────────
-- 1. CREDIT LEDGER — atomic under concurrency.
-- ─────────────────────────────────────────────────────────────────
-- WHAT WAS WRONG. `entitlements.charge()` read the balance, compared it, then
-- decremented it in JavaScript, against a profile held in memory and flushed to
-- a JSON file. Within one process Node's single thread happens to make that
-- sequence indivisible, but across two instances — or two workers behind a load
-- balancer — both can read the same balance and both can succeed. A tenant with
-- 10 credits could spend 20.
--
-- THE FIX. The balance lives in one row, and spending it is a single
-- conditional UPDATE:
--
--     UPDATE credit_balance SET credits = credits - $cost
--      WHERE tenant_id = $1 AND period = $2 AND credits >= $cost
--
-- PostgreSQL takes a row lock for the duration; a concurrent transaction blocks,
-- re-evaluates `credits >= $cost` against the committed value, and either
-- succeeds or matches zero rows. Zero rows IS the rejection — there is no
-- window between the check and the deduction because they are the same
-- statement. Credits cannot go negative because the WHERE clause forbids it.

CREATE TABLE IF NOT EXISTS credit_balance (
  tenant_id   uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  -- The allowance period, e.g. '2026-08'. A new period is a new row, so the
  -- monthly refill is an insert rather than a mutation of history.
  period      text        NOT NULL,
  credits     integer     NOT NULL CHECK (credits >= 0),
  allowance   integer     NOT NULL,
  plan        text        NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, period)
);

-- Every movement, so a disputed balance can be reconstructed.
CREATE TABLE IF NOT EXISTS credit_transaction (
  id           bigserial   PRIMARY KEY,
  tenant_id    uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  period       text        NOT NULL,
  operation    text        NOT NULL,          -- 'chat', 'monthly-review', ...
  cost         integer     NOT NULL,
  balance_after integer    NOT NULL,
  -- Ties the spend to the AI interaction it paid for.
  interaction_id text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS credit_transaction_tenant_idx
  ON credit_transaction (tenant_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────
-- 2. AI INTERACTION AUDIT.
-- ─────────────────────────────────────────────────────────────────
-- THE QUESTION THIS MUST ANSWER:
--   "Why did this user receive this answer, and what authoritative context was
--    available to the model?"
--
-- PRIVACY POSTURE. Raw prompts and raw responses are NOT stored by default.
-- A prompt contains the tenant's transactions, counterparties and balances;
-- retaining that indefinitely in a second place, with a different access path
-- from the records themselves, creates a disclosure surface that the audit
-- purpose does not require.
--
-- What IS stored is the SHAPE of the interaction: which run, which findings,
-- which knowledge chunks, which provider, what the validator decided. That is
-- sufficient to reconstruct what the model could have known and why an answer
-- was allowed or blocked — without a second copy of the financial data.
--
-- `prompt_sha256` / `response_sha256` let an investigator confirm that a
-- retained copy (supplied by the user, or captured under an explicit
-- retention policy) is the exact text involved, without the store holding it.
--
-- `redacted_excerpt` is opt-in and bounded, for the cases where a support
-- investigation genuinely needs wording — counterparty names are replaced with
-- their pseudonyms before it is written.

CREATE TABLE IF NOT EXISTS ai_interaction (
  id                text        PRIMARY KEY,          -- interaction id, client-visible
  tenant_id         uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  -- Who asked, where identity is available. Null for a session without a
  -- signed-in identity; the tenant is always known.
  user_id           uuid        REFERENCES app_user(id) ON DELETE SET NULL,
  conversation_id   text,
  turn_index        integer,

  -- WHAT THE ANSWER WAS GROUNDED IN.
  analysis_run_id   text,
  period            text,
  engine_version    text,

  -- WHAT THE MODEL WAS GIVEN. Ids only — the content is reconstructible from
  -- the authoritative tables, and is not duplicated here.
  finding_ids       text[]      NOT NULL DEFAULT '{}',
  metric_keys       text[]      NOT NULL DEFAULT '{}',
  knowledge_chunks  text[]      NOT NULL DEFAULT '{}',
  capabilities_used text[]      NOT NULL DEFAULT '{}',
  line_items_count  integer     NOT NULL DEFAULT 0,
  redaction_level   text        NOT NULL DEFAULT 'redacted',

  -- WHO SERVED IT.
  provider          text,
  model             text,
  routing_mode      text,                             -- 'managed' | 'byok'

  -- WHAT HAPPENED.
  outcome           text        NOT NULL,             -- delivered|blocked|failed|denied
  validation_verdict text,
  validation_issues jsonb,
  failure_reason    text,
  credits_charged   integer     NOT NULL DEFAULT 0,
  latency_ms        integer,

  -- CONTENT INTEGRITY WITHOUT CONTENT RETENTION.
  prompt_sha256     text,
  response_sha256   text,
  prompt_chars      integer,
  response_chars    integer,
  redacted_excerpt  text,

  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_interaction_tenant_idx
  ON ai_interaction (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_interaction_conversation_idx
  ON ai_interaction (tenant_id, conversation_id, turn_index);
CREATE INDEX IF NOT EXISTS ai_interaction_run_idx
  ON ai_interaction (tenant_id, analysis_run_id);
-- "Show me every blocked answer" — the query a hallucination investigation starts from.
CREATE INDEX IF NOT EXISTS ai_interaction_outcome_idx
  ON ai_interaction (tenant_id, outcome, created_at DESC);

-- ─────────────────────────────────────────────────────────────────
-- 3. TENANT ISOLATION for the new tables.
-- ─────────────────────────────────────────────────────────────────
-- Same policy as every other tenant table: FORCE ROW LEVEL SECURITY, so even
-- the table owner is subject to it, and the policy reads the transaction-local
-- app.tenant_id set by pool.withTenant().

ALTER TABLE credit_balance     ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_balance     FORCE  ROW LEVEL SECURITY;
ALTER TABLE credit_transaction ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_transaction FORCE  ROW LEVEL SECURITY;
ALTER TABLE ai_interaction     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_interaction     FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS credit_balance_tenant_isolation ON credit_balance;
CREATE POLICY credit_balance_tenant_isolation ON credit_balance
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

DROP POLICY IF EXISTS credit_transaction_tenant_isolation ON credit_transaction;
CREATE POLICY credit_transaction_tenant_isolation ON credit_transaction
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

DROP POLICY IF EXISTS ai_interaction_tenant_isolation ON ai_interaction;
CREATE POLICY ai_interaction_tenant_isolation ON ai_interaction
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON credit_balance TO PUBLIC;
GRANT SELECT, INSERT ON credit_transaction TO PUBLIC;
GRANT USAGE, SELECT ON SEQUENCE credit_transaction_id_seq TO PUBLIC;
GRANT SELECT, INSERT ON ai_interaction TO PUBLIC;
