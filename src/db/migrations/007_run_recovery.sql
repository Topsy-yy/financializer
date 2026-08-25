-- JOB 11 — COMPLETE PERSISTENCE AND RESTART RECOVERY.
--
-- THE DEFECT. `saveRun` wrote a great deal: the run row, its findings, its
-- evidence, the methodology it applied, and flattened metric rows. What it did
-- NOT write was enough to REBUILD the completed analysis, so after a restart
-- the rows were all present and the application could not answer from them.
--
-- Three things were missing, and each of them is load-bearing:
--
--   1. THE AUTHORITATIVE METRIC SET. `analysis_run.metrics` is misleadingly
--      named: it holds `run.calculations`, the legacy intermediate arithmetic.
--      The authoritative `run.metrics` — the typed MetricSet carrying
--      `available`, `reason`, `unit`, `currency`, `computedBy` — was never
--      stored at all. Worse, `metric_value` FILTERED OUT every non-finite
--      value, so a metric that was genuinely unavailable simply vanished. On
--      reload "unavailable" would have been indistinguishable from "absent",
--      and an absent metric renders as zero. That is the single most dangerous
--      way this system can lie.
--
--   2. THE PERIOD INPUTS. `currentCashBalance` is supplied at upload time and
--      consumed by the cash-runway calculation. It lived only in the uploaded
--      envelope in process memory. Without it a reloaded run could not be shown
--      to be the same run, and recomputing would silently produce a DIFFERENT
--      answer (runway unavailable) while claiming to be the original.
--
--   3. THE RUN SUMMARY AND QUALITY. Counts and severities the API returns.
--
-- WHY COLUMNS AND NOT A TABLE PER CONCERN. These are per-run, written once,
-- read as a unit, and never queried across runs. A child table would add joins
-- and a second failure mode for no gain. The metric SET is additionally
-- projected into `metric_value` (below) for querying, so the JSON is the record
-- of truth and the rows are the index — not two competing sources.
--
-- WHY JSON IS THE RIGHT BOUNDARY HERE. The MetricSet is a variable-length list
-- of typed values whose members differ by unit and availability, and the
-- methodology is a nested policy snapshot. Flattening either into fixed columns
-- would encode today's metric list into the schema and require a migration
-- every time a rule is added. The shape is therefore VALIDATED IN CODE on the
-- way in and on the way out (see analysisRunRepository.assertRecoverable), so
-- "it is JSON" never means "it is unchecked".

ALTER TABLE analysis_run
  -- The authoritative MetricSet exactly as the engine emitted it: every metric,
  -- available or not, with its reason, unit, currency and computedBy.
  ADD COLUMN IF NOT EXISTS metric_set jsonb,

  -- The authoritative period-level INPUTS the run was computed from:
  -- currentCashBalance (with an explicit provided/absent distinction),
  -- ingestion metadata, source provenance, currencies and transaction count.
  ADD COLUMN IF NOT EXISTS period_inputs jsonb,

  -- Counts, worst severities and the data-quality summary the API returns.
  ADD COLUMN IF NOT EXISTS run_summary jsonb,

  /* WHICH RECOVERY CONTRACT THIS ROW WAS WRITTEN UNDER.
     NULL means the row predates this migration: it is a real historical run,
     but it does NOT carry enough state to be rebuilt faithfully. That is
     recorded as a fact rather than papered over — a legacy row is reported as
     legacy, never as recoverable, and never silently recomputed into something
     that would differ from what the user originally saw. */
  ADD COLUMN IF NOT EXISTS recovery_schema_version integer;

COMMENT ON COLUMN analysis_run.recovery_schema_version IS
  'Recovery contract version. NULL = pre-JOB-11 row: historical and readable, but not faithfully recoverable.';

/* A COMPLETED RUN MUST CARRY ITS RECOVERABLE STATE.
   This is the database refusing to hold the state the bug depended on: a run
   marked `completed` that cannot be rebuilt. Enforcing it here rather than only
   in the repository means a future writer — a migration, a backfill, a second
   code path — cannot reintroduce it.

   NOT VALID so existing pre-migration rows are left alone (they are legitimately
   legacy and are reported as such); the constraint applies to every INSERT and
   UPDATE from now on. */
ALTER TABLE analysis_run
  DROP CONSTRAINT IF EXISTS analysis_run_completed_is_recoverable;

ALTER TABLE analysis_run
  ADD CONSTRAINT analysis_run_completed_is_recoverable
  CHECK (
    status <> 'completed'
    OR (
      recovery_schema_version IS NOT NULL
      AND metric_set   IS NOT NULL
      AND period_inputs IS NOT NULL
      AND run_summary  IS NOT NULL
      AND health       IS NOT NULL
      AND methodology  IS NOT NULL
    )
  ) NOT VALID;

-- Finding the latest COMPLETED run for a period is the hot path on every
-- recovery; the existing index is not filtered on status.
CREATE INDEX IF NOT EXISTS analysis_run_completed_idx
  ON analysis_run (tenant_id, period, started_at DESC)
  WHERE status = 'completed';

/* ── metric_value: STOP DROPPING THE UNAVAILABLE ONES ─────────────
   The projection previously stored only finite numbers. A metric that could not
   be calculated was therefore absent, and absent reads as zero to anything
   scanning this table. Unavailable metrics are now stored as rows with a NULL
   value and an explicit reason, so the three states stay distinct:

     available with value 0   -> numeric_value = 0,    available = true
     genuinely unavailable    -> numeric_value = NULL, available = false, reason set
     never produced at all    -> no row

   `numeric_value` must therefore become nullable. */
ALTER TABLE metric_value
  ALTER COLUMN numeric_value DROP NOT NULL;

ALTER TABLE metric_value
  ADD COLUMN IF NOT EXISTS available boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS unavailable_reason text,
  ADD COLUMN IF NOT EXISTS unit text,
  ADD COLUMN IF NOT EXISTS currency text,
  -- Which engine version computed it — an authority marker, so a value is never
  -- mistaken for something a model produced.
  ADD COLUMN IF NOT EXISTS computed_by text;

-- The two states must stay coherent: an available metric has a value, an
-- unavailable one has a reason and no value.
ALTER TABLE metric_value
  DROP CONSTRAINT IF EXISTS metric_value_availability_coherent;

ALTER TABLE metric_value
  ADD CONSTRAINT metric_value_availability_coherent
  CHECK (
    (available = true  AND numeric_value IS NOT NULL)
    OR
    (available = false AND numeric_value IS NULL AND unavailable_reason IS NOT NULL)
  ) NOT VALID;

GRANT SELECT, INSERT, UPDATE, DELETE ON analysis_run TO PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON metric_value TO PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON finding TO PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON finding_evidence TO PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON financial_transaction TO PUBLIC;
