-- 002 — align the persisted Finding/Evidence with the JOB 5 domain contract.
--
--  * `possible_duplicate` -> `duplicate`. The category key is now neutral; the
--    cautious wording ("Possible duplicate payment") lives in the finding TITLE,
--    which is where users read it.
--  * Evidence gains the machine-readable provenance fields the contract
--    requires: record_type, relationship and the specific field/value that
--    mattered. Previously only a label + an opaque JSON blob were stored.
--  * Findings gain match_criteria so "which fields were compared" is queryable
--    rather than buried in prose.

BEGIN;

-- ── Category rename ─────────────────────────────────────────────
ALTER TABLE finding DROP CONSTRAINT IF EXISTS finding_category_check;

UPDATE finding SET category = 'duplicate' WHERE category = 'possible_duplicate';

ALTER TABLE finding ADD CONSTRAINT finding_category_check
  CHECK (category IN ('anomaly','data_quality','business_risk','control_weakness','duplicate','fraud_indicator'));

-- ── Finding: structured match criteria ──────────────────────────
ALTER TABLE finding ADD COLUMN IF NOT EXISTS match_criteria jsonb;

COMMENT ON COLUMN finding.match_criteria IS
  'Which fields were compared to produce this finding, e.g. {"fields":["date","amount","counterparty"],"comparison":"equals"}.';
COMMENT ON COLUMN finding.value IS
  'The observed value (domain: observedValue) that was compared against threshold.';

-- ── Evidence: machine-readable provenance ───────────────────────
ALTER TABLE finding_evidence ADD COLUMN IF NOT EXISTS record_type text;
ALTER TABLE finding_evidence ADD COLUMN IF NOT EXISTS relationship text;
ALTER TABLE finding_evidence ADD COLUMN IF NOT EXISTS field_name text;
ALTER TABLE finding_evidence ADD COLUMN IF NOT EXISTS field_value text;

COMMENT ON COLUMN finding_evidence.relationship IS
  'Why this record is evidence: matched | exceeded_threshold | statistical_outlier | keyword_match | missing_field | contributes_to_total.';
COMMENT ON COLUMN finding_evidence.fields IS
  'Minimal captured snapshot for auditability. Never a full copy of the source transaction.';

-- Answer "which findings cite this source record?" without a table scan.
CREATE INDEX IF NOT EXISTS finding_evidence_record_lookup_idx
  ON finding_evidence(tenant_id, source_system, source_record_id);

-- ── Link findings to the transactions they cite ─────────────────
-- The join is by (tenant, source_system, source_record_id) rather than a hard FK
-- so a finding survives re-ingestion replacing a transaction row, and evidence
-- remains readable even if the underlying record is later removed.
CREATE INDEX IF NOT EXISTS txn_source_lookup_idx
  ON financial_transaction(tenant_id, source_system, source_record_id);

COMMIT;
