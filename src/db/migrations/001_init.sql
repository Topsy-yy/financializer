-- 001_init — multi-tenant financial schema.
--
-- Principles enforced here:
--   * every business-owned row carries tenant_id and is covered by RLS;
--   * source provenance (source_system, source_record_id, source_updated_at) is
--     mandatory on ingested records so findings can be traced to Zoho;
--   * currency is EXPLICIT on every monetary column pair (the audit found the
--     engine summing KES and USD as one unit);
--   * no plaintext credentials — only references to an external secret store;
--   * analysis runs and findings record the engine/rule versions that produced
--     them, so historical results stay explainable after thresholds change.
--
-- Money: numeric(20,4) + a currency code. Never floats.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Identity and tenancy ────────────────────────────────────────
CREATE TABLE app_user (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text UNIQUE,
  google_sub    text UNIQUE,
  display_name  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- A tenant IS a business. All financial data hangs off this.
CREATE TABLE tenant (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  base_currency   char(3) NOT NULL DEFAULT 'KES',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE membership (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('founder','finance_officer','accountant','auditor','investor')),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','suspended','removed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);
CREATE INDEX membership_user_idx ON membership(user_id) WHERE status = 'active';

-- Credentials are NEVER stored here. `secret_ref` is a handle resolved by an
-- external secret manager; the database holds no usable credential.
CREATE TABLE zoho_connection (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  organization_id    text,
  api_domain         text,
  secret_ref         text NOT NULL,
  scopes             text[],
  status             text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','expired','revoked','error')),
  connected_at       timestamptz NOT NULL DEFAULT now(),
  last_sync_at       timestamptz,
  last_sync_status   text,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id)
);

-- ── Accounting reference data ───────────────────────────────────
CREATE TABLE financial_period (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  period       char(7) NOT NULL,               -- YYYY-MM
  starts_on    date NOT NULL,
  ends_on      date NOT NULL,
  currency     char(3) NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period),
  CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  CHECK (ends_on >= starts_on)
);

CREATE TABLE account (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  source_system      text NOT NULL,
  source_record_id   text NOT NULL,
  name               text NOT NULL,
  account_type       text,
  currency           char(3) NOT NULL,
  source_updated_at  timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_system, source_record_id)
);

CREATE TABLE counterparty (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  kind               text NOT NULL CHECK (kind IN ('customer','vendor','other')),
  source_system      text NOT NULL,
  source_record_id   text NOT NULL,
  name               text NOT NULL,
  source_updated_at  timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_system, source_record_id)
);
CREATE INDEX counterparty_tenant_kind_idx ON counterparty(tenant_id, kind);

-- ── Financial records ───────────────────────────────────────────
-- One table per document type keeps the domain explicit (the audit found
-- everything collapsed into an untyped `transactions` blob).

CREATE TABLE financial_transaction (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  period             char(7) NOT NULL,
  source_system      text NOT NULL,
  source_record_id   text NOT NULL,
  txn_type           text NOT NULL CHECK (txn_type IN ('invoice','bill','expense','payment','bank_transaction','journal_entry','other')),
  txn_date           date NOT NULL,
  amount             numeric(20,4) NOT NULL,
  currency           char(3) NOT NULL,
  base_amount        numeric(20,4),             -- converted to tenant base currency
  base_currency      char(3),
  exchange_rate      numeric(20,10),
  direction          text NOT NULL CHECK (direction IN ('inflow','outflow')),
  counterparty_id    uuid REFERENCES counterparty(id) ON DELETE SET NULL,
  counterparty_name  text,
  account_id         uuid REFERENCES account(id) ON DELETE SET NULL,
  description        text,
  reference          text,
  has_receipt        boolean,                   -- NULL = source does not report it
  is_reconciled      boolean,                   -- NULL = unknown, NOT "reconciled"
  due_date           date,
  balance            numeric(20,4),
  source_updated_at  timestamptz,
  ingested_at        timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- Idempotent ingestion: re-fetching a period cannot duplicate rows.
  UNIQUE (tenant_id, source_system, source_record_id)
);
CREATE INDEX txn_tenant_period_idx ON financial_transaction(tenant_id, period);
CREATE INDEX txn_tenant_date_idx ON financial_transaction(tenant_id, txn_date);
CREATE INDEX txn_counterparty_idx ON financial_transaction(tenant_id, counterparty_id);
CREATE INDEX txn_due_idx ON financial_transaction(tenant_id, due_date) WHERE balance > 0;

-- Period-level statement figures, stored explicitly rather than derived on read.
CREATE TABLE financial_statement (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  period         char(7) NOT NULL,
  statement_type text NOT NULL CHECK (statement_type IN ('cash_flow','profit_and_loss','balance_sheet')),
  currency       char(3) NOT NULL,
  figures        jsonb NOT NULL,
  source_system  text NOT NULL,
  is_derived     boolean NOT NULL DEFAULT false,  -- true when computed, not fetched
  ingested_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period, statement_type)
);

-- ── Analysis ────────────────────────────────────────────────────
CREATE TABLE analysis_run (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  period              char(7) NOT NULL,
  status              text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
  engine_version      text NOT NULL,
  rule_versions       jsonb NOT NULL,
  input_hash          text,
  data_source         text,
  data_quality_level  text CHECK (data_quality_level IN ('COMPLETE','PARTIAL','STALE','FAILED','INSUFFICIENT_EVIDENCE')),
  data_quality        jsonb,
  metrics             jsonb,
  health              jsonb,
  error               text,
  started_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX analysis_run_tenant_period_idx ON analysis_run(tenant_id, period, started_at DESC);

CREATE TABLE finding (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  analysis_run_id   uuid NOT NULL REFERENCES analysis_run(id) ON DELETE CASCADE,
  finding_key       text NOT NULL,              -- stable id from the domain model
  period            char(7) NOT NULL,
  rule_id           text NOT NULL,
  rule_version      text NOT NULL,
  category          text NOT NULL CHECK (category IN ('anomaly','data_quality','business_risk','control_weakness','possible_duplicate','fraud_indicator')),
  severity          text NOT NULL CHECK (severity IN ('low','medium','high')),
  title             text NOT NULL,
  description       text,
  metric            text,
  value             text,
  threshold         text,
  comparator        text,
  confidence        numeric(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  calculation       text,
  is_data_quality   boolean NOT NULL DEFAULT false,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved','dismissed')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (analysis_run_id, finding_key)
);
CREATE INDEX finding_tenant_period_idx ON finding(tenant_id, period);
CREATE INDEX finding_tenant_open_idx ON finding(tenant_id, status) WHERE status = 'open';
CREATE INDEX finding_rule_idx ON finding(tenant_id, rule_id);

-- Field-level evidence, linked to the SOURCE record.
CREATE TABLE finding_evidence (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  finding_id        uuid NOT NULL REFERENCES finding(id) ON DELETE CASCADE,
  label             text NOT NULL,
  source_system     text,
  source_record_id  text,
  transaction_id    uuid REFERENCES financial_transaction(id) ON DELETE SET NULL,
  fields            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX finding_evidence_finding_idx ON finding_evidence(finding_id);
CREATE INDEX finding_evidence_source_idx ON finding_evidence(tenant_id, source_record_id);

-- Versioned rule definitions. Executable rules are authoritative; this table
-- records which version was in force so historical findings stay explainable.
CREATE TABLE rule_version (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id        text NOT NULL,
  version        text NOT NULL,
  title          text NOT NULL,
  description    text,
  params         jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_builtin     boolean NOT NULL DEFAULT true,
  tenant_id      uuid REFERENCES tenant(id) ON DELETE CASCADE,  -- NULL = built-in
  enabled        boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_id, version, tenant_id)
);

CREATE TABLE metric_value (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  analysis_run_id  uuid NOT NULL REFERENCES analysis_run(id) ON DELETE CASCADE,
  period           char(7) NOT NULL,
  metric_key       text NOT NULL,
  numeric_value    numeric(20,4),
  text_value       text,
  currency         char(3),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (analysis_run_id, metric_key)
);
CREATE INDEX metric_tenant_period_idx ON metric_value(tenant_id, period, metric_key);

-- ── AI accounting (usage/audit only; no prompts or provider keys) ──
CREATE TABLE ai_invocation (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  analysis_run_id  uuid REFERENCES analysis_run(id) ON DELETE SET NULL,
  purpose          text NOT NULL,
  provider         text NOT NULL,
  model            text,
  prompt_version   text,
  input_tokens     integer,
  output_tokens    integer,
  credits_used     integer,
  latency_ms       integer,
  status           text NOT NULL CHECK (status IN ('ok','failed','rejected','skipped')),
  error_category   text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_invocation_tenant_idx ON ai_invocation(tenant_id, created_at DESC);

CREATE TABLE audit_event (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid REFERENCES tenant(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES app_user(id) ON DELETE SET NULL,
  event_type   text NOT NULL,
  subject_type text,
  subject_id   text,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_event_tenant_idx ON audit_event(tenant_id, created_at DESC);

-- ── Row-Level Security ──────────────────────────────────────────
-- Defence in depth: even a repository bug cannot read across tenants, because
-- the database itself filters on app.tenant_id.
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'membership','zoho_connection','financial_period','account','counterparty',
    'financial_transaction','financial_statement','analysis_run','finding',
    'finding_evidence','metric_value','ai_invocation','audit_event'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END $$;

COMMIT;
