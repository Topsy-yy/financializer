-- JOB 10 — the schema production needs: durable conversations, durable
-- sessions, an honest analysis-run lifecycle, and job locking.
--
-- Everything here is tenant-scoped under FORCE ROW LEVEL SECURITY, on the same
-- terms as every other tenant table: the policy reads the transaction-local
-- app.tenant_id set by pool.withTenant().

-- ─────────────────────────────────────────────────────────────────
-- 1. COPILOT CONVERSATIONS
-- ─────────────────────────────────────────────────────────────────
-- WHAT WAS WRONG. Conversations lived in a per-process Map. They vanished on
-- restart, were invisible to a second instance, and forced sticky sessions.
--
-- WHAT IS STORED, AND WHAT DELIBERATELY IS NOT. A turn holds the TEXT of what
-- was said and the IDs of what it referred to. It does NOT hold figures,
-- findings or metrics: the rule from JOB 9 stands, that conversation history is
-- not authoritative financial truth. An entity reference is an id, resolved
-- against the analysis run when it is next needed — so a conversation can never
-- become a stale second copy of the financial data.
--
-- RETENTION. Conversations are the one part of this system holding free text a
-- user wrote about their finances, and they have no authoritative value.
-- `expires_at` gives them a default lifetime, and delete_conversation() /
-- purge_expired_conversations() make deletion a first-class operation rather
-- than something a support engineer has to write SQL for.

CREATE TABLE IF NOT EXISTS conversation (
  id            text        PRIMARY KEY,
  tenant_id     uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  user_id       uuid        REFERENCES app_user(id) ON DELETE SET NULL,
  -- The analysis the conversation is currently grounded in. It may move as the
  -- user re-analyses; `run_changed_at_turn` records where, so earlier turns are
  -- not read as describing the current run.
  analysis_run_id     text,
  period              text,
  run_changed_at_turn integer,
  -- Turns dropped from the visible window, so "turn 7 of 63" stays truthful
  -- after trimming.
  dropped_turns integer     NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- Default retention. NULL means "keep until explicitly deleted".
  expires_at    timestamptz DEFAULT (now() + interval '90 days')
);

CREATE TABLE IF NOT EXISTS conversation_turn (
  id              bigserial   PRIMARY KEY,
  conversation_id text        NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  -- Denormalised so RLS can be enforced on this table directly, without a join
  -- to conversation. A turn is only ever readable by its own tenant.
  tenant_id       uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  turn_index      integer     NOT NULL,
  role            text        NOT NULL CHECK (role IN ('user', 'assistant')),
  -- What was SAID. Bounded at the application layer; never a place figures are
  -- read back from.
  text            text        NOT NULL,
  -- The interaction that produced an assistant turn, tying a conversation to
  -- the AI audit trail.
  interaction_id  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, turn_index)
);

-- Resolved references — IDs ONLY. "that finding" survives beyond the visible
-- turn window without the value travelling with it.
CREATE TABLE IF NOT EXISTS conversation_entity (
  conversation_id text        NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  tenant_id       uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  kind            text        NOT NULL,          -- 'finding', 'metric', ...
  entity_id       text        NOT NULL,
  label           text,
  at_turn         integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, kind, entity_id)
);

CREATE INDEX IF NOT EXISTS conversation_tenant_idx ON conversation (tenant_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS conversation_turn_lookup_idx
  ON conversation_turn (conversation_id, turn_index);
CREATE INDEX IF NOT EXISTS conversation_expiry_idx ON conversation (expires_at)
  WHERE expires_at IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────
-- 2. SESSIONS
-- ─────────────────────────────────────────────────────────────────
-- WHAT WAS WRONG. An in-memory session store loses every logged-in user on
-- deploy, and cannot be shared between instances.
--
-- Sessions hold an identity, not financial data. The payload is kept opaque
-- (jsonb) so the session layer does not become a second place tenant data
-- accumulates.

CREATE TABLE IF NOT EXISTS user_session (
  sid        text        PRIMARY KEY,
  -- Denormalised for the "log this user out everywhere" query, and so a session
  -- row can be attributed without decoding the payload.
  user_id    uuid        REFERENCES app_user(id) ON DELETE CASCADE,
  tenant_id  uuid        REFERENCES tenant(id) ON DELETE CASCADE,
  data       jsonb       NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_session_expiry_idx ON user_session (expires_at);
CREATE INDEX IF NOT EXISTS user_session_user_idx ON user_session (user_id);

-- Sessions are deliberately NOT under RLS: the session store is consulted
-- BEFORE a tenant is known, so a tenant-scoped policy would make it unreadable
-- at exactly the moment it is needed. Access is instead restricted to the
-- session layer, which only ever reads by primary key (the signed sid).

-- ─────────────────────────────────────────────────────────────────
-- 3. ANALYSIS-RUN LIFECYCLE
-- ─────────────────────────────────────────────────────────────────
-- WHAT WAS WRONG. `saveRun` wrote `run.status || "completed"`, and was only
-- ever called after a successful analysis. A run that failed during ingestion
-- or analysis was never persisted at all — so a failure was indistinguishable
-- from "no analysis has been run", and a partially-ingested period could not be
-- explained afterwards.
--
-- The lifecycle is now explicit, and a FAILED run is a stored fact with a
-- reason, not an absence.

ALTER TABLE analysis_run
  DROP CONSTRAINT IF EXISTS analysis_run_status_check;
ALTER TABLE analysis_run
  ADD CONSTRAINT analysis_run_status_check
  CHECK (status IN ('pending', 'ingesting', 'analyzing', 'completed', 'failed'));

ALTER TABLE analysis_run
  ADD COLUMN IF NOT EXISTS failure_stage  text,
  ADD COLUMN IF NOT EXISTS failure_reason text,
  -- Safe to surface: a classification, never a raw provider error or a stack.
  ADD COLUMN IF NOT EXISTS failure_detail text,
  ADD COLUMN IF NOT EXISTS ingest_source  text,
  ADD COLUMN IF NOT EXISTS updated_at     timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS analysis_run_status_idx
  ON analysis_run (tenant_id, status, started_at DESC);

-- ─────────────────────────────────────────────────────────────────
-- 4. JOB LOCKS
-- ─────────────────────────────────────────────────────────────────
-- Prevents two workers running the same tenant/period job. The lock is a row
-- whose PRIMARY KEY is the work identity, so acquisition is an INSERT that
-- either succeeds or violates the key — atomic, with no read-then-write window.
--
-- `expires_at` makes the lock self-healing: a worker that dies without
-- releasing does not block that tenant's job forever.

CREATE TABLE IF NOT EXISTS job_lock (
  lock_key   text        PRIMARY KEY,          -- e.g. 'analysis:<tenant>:<period>'
  tenant_id  uuid        REFERENCES tenant(id) ON DELETE CASCADE,
  owner      text        NOT NULL,             -- instance/worker identity
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS job_lock_expiry_idx ON job_lock (expires_at);

-- Notification deduplication. The key encodes what the notification is ABOUT,
-- so a repeated scheduler tick that re-derives the same finding cannot send a
-- second alert.
CREATE TABLE IF NOT EXISTS notification_dedupe (
  dedupe_key text        PRIMARY KEY,
  tenant_id  uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  period     text,
  sent_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notification_dedupe_tenant_idx
  ON notification_dedupe (tenant_id, sent_at DESC);

-- A record of every job attempt, so a failure is investigable rather than lost.
CREATE TABLE IF NOT EXISTS job_run (
  id          bigserial   PRIMARY KEY,
  tenant_id   uuid        REFERENCES tenant(id) ON DELETE CASCADE,
  job_type    text        NOT NULL,
  period      text,
  status      text        NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
  reason      text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS job_run_tenant_idx ON job_run (tenant_id, started_at DESC);

-- ─────────────────────────────────────────────────────────────────
-- 5. TENANT ISOLATION
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE conversation          ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation          FORCE  ROW LEVEL SECURITY;
ALTER TABLE conversation_turn     ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_turn     FORCE  ROW LEVEL SECURITY;
ALTER TABLE conversation_entity   ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_entity   FORCE  ROW LEVEL SECURITY;
ALTER TABLE job_lock              ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_lock              FORCE  ROW LEVEL SECURITY;
ALTER TABLE notification_dedupe   ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_dedupe   FORCE  ROW LEVEL SECURITY;
ALTER TABLE job_run               ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_run               FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conversation_tenant_isolation ON conversation;
CREATE POLICY conversation_tenant_isolation ON conversation
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

DROP POLICY IF EXISTS conversation_turn_tenant_isolation ON conversation_turn;
CREATE POLICY conversation_turn_tenant_isolation ON conversation_turn
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

DROP POLICY IF EXISTS conversation_entity_tenant_isolation ON conversation_entity;
CREATE POLICY conversation_entity_tenant_isolation ON conversation_entity
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- A lock row may be tenant-less (a global job), so the policy admits NULL.
DROP POLICY IF EXISTS job_lock_tenant_isolation ON job_lock;
CREATE POLICY job_lock_tenant_isolation ON job_lock
  USING (tenant_id IS NULL OR tenant_id = current_tenant_id())
  WITH CHECK (tenant_id IS NULL OR tenant_id = current_tenant_id());

DROP POLICY IF EXISTS notification_dedupe_tenant_isolation ON notification_dedupe;
CREATE POLICY notification_dedupe_tenant_isolation ON notification_dedupe
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

DROP POLICY IF EXISTS job_run_tenant_isolation ON job_run;
CREATE POLICY job_run_tenant_isolation ON job_run
  USING (tenant_id IS NULL OR tenant_id = current_tenant_id())
  WITH CHECK (tenant_id IS NULL OR tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON conversation TO PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON conversation_turn TO PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON conversation_entity TO PUBLIC;
GRANT USAGE, SELECT ON SEQUENCE conversation_turn_id_seq TO PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_session TO PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON job_lock TO PUBLIC;
GRANT SELECT, INSERT, DELETE ON notification_dedupe TO PUBLIC;
GRANT SELECT, INSERT, UPDATE ON job_run TO PUBLIC;
GRANT USAGE, SELECT ON SEQUENCE job_run_id_seq TO PUBLIC;
