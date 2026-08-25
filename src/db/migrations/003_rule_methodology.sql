-- JOB 7 — persist the methodology that produced each finding.
--
-- WHY. A finding is only re-explainable if the reasoning behind it survives
-- storage. After JOB 7 a finding carries WHY it has its severity, WHY it has its
-- confidence, what currency its observed value is denominated in, and whether
-- the rule behind it was authored by the engine or by the tenant. None of that
-- was persisted, so a finding read back from the database was less explainable
-- than the same finding in memory.
--
-- The `authority_scope` column is the important one: it is what stops a
-- tenant-authored rule from being mistaken for an engine rule when findings are
-- re-read for scoring, reporting or export.

ALTER TABLE finding
  ADD COLUMN IF NOT EXISTS severity_basis   text,
  ADD COLUMN IF NOT EXISTS severity_reason  text,
  ADD COLUMN IF NOT EXISTS confidence_basis text,
  ADD COLUMN IF NOT EXISTS confidence_reason text,
  -- The unit `value` is denominated in. NULL means the records carried no
  -- currency (a CSV upload), which is different from "no currency applies".
  ADD COLUMN IF NOT EXISTS currency         text,
  -- 'engine' = a rule in the authoritative registry
  -- 'tenant' = a rule the business defined for itself; EXCLUDED from the
  --            deterministic risk score so a user cannot move their own score.
  ADD COLUMN IF NOT EXISTS authority_scope  text NOT NULL DEFAULT 'engine';

ALTER TABLE finding
  DROP CONSTRAINT IF EXISTS finding_authority_scope_check;
ALTER TABLE finding
  ADD CONSTRAINT finding_authority_scope_check
  CHECK (authority_scope IN ('engine', 'tenant'));

-- Rule ids are namespaced (`custom:<id>`), so this index answers "show me
-- everything this tenant's own rules found" without a scan.
CREATE INDEX IF NOT EXISTS finding_authority_idx
  ON finding (tenant_id, authority_scope, period);

-- The methodology configuration a run was executed under, so a historical
-- analysis stays explainable after the registry changes. Stored as JSON because
-- it is read as a whole (never queried field-by-field) and its shape is owned by
-- the registry, not by the schema.
ALTER TABLE analysis_run
  ADD COLUMN IF NOT EXISTS methodology jsonb,
  ADD COLUMN IF NOT EXISTS coverage_policy_version text,
  ADD COLUMN IF NOT EXISTS materiality_version text;
