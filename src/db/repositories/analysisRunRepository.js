// Persistence for an AnalysisRun and its findings/evidence.
//
// The whole run is written in ONE transaction: a partially-saved analysis (a run
// with some of its findings) would be worse than none, because it would look
// complete. Findings and evidence are stored with the rule + version that
// produced them, so a historical result stays explainable after thresholds move.
const { withTenant } = require("../pool");
const crypto = require("crypto");

/**
 * THE ANALYSIS-RUN LIFECYCLE.
 *
 *   PENDING -> INGESTING -> ANALYZING -> COMPLETED
 *   PENDING -> INGESTING -> FAILED
 *   PENDING -> ANALYZING -> FAILED
 *
 * WHAT WAS WRONG. `saveRun` wrote `run.status || "completed"` and was only ever
 * called AFTER a successful analysis. A run that failed during ingestion or
 * analysis was never persisted at all — so a failure looked exactly like "no
 * analysis has been run yet", and a partially-ingested period could not be
 * explained after the fact.
 *
 * A failed run is now a STORED FACT with a stage and a reason. It can never be
 * mistaken for a successful analysis that happened to find nothing, because its
 * status is `failed` and it carries no findings.
 */
const LIFECYCLE = Object.freeze({
  PENDING: "pending",
  INGESTING: "ingesting",
  ANALYZING: "analyzing",
  COMPLETED: "completed",
  FAILED: "failed"
});

/** Which stage a failure happened in — the first question in any investigation. */
const STAGE = Object.freeze({
  INGESTION: "ingestion",
  ANALYSIS: "analysis",
  PERSISTENCE: "persistence"
});

/**
 * The recovery contract version this code writes and understands.
 *
 * A row stamped with this can be rebuilt into the completed analysis it
 * represents. A row with NULL predates JOB 11 and cannot — that is reported as
 * legacy, never recomputed into something that would differ from what the user
 * originally saw.
 */
const RECOVERY_SCHEMA_VERSION = 1;

/**
 * Refuse to store a `completed` run that could not be recovered.
 *
 * THE INVARIANT. A completed run and its recoverable state are the same fact.
 * Storing one without the other is what produced the original defect: rows that
 * looked like finished analyses and could not be loaded. The database enforces
 * this too (analysis_run_completed_is_recoverable), but failing HERE gives a
 * usable message instead of a constraint violation, and keeps the rule visible
 * at the point a future writer would break it.
 *
 * This also validates the SHAPE of the JSON being stored, so "it is a jsonb
 * column" never becomes "nobody checks what goes in it".
 */
function assertRecoverable(run) {
  const problems = [];
  if (!Array.isArray(run.metrics)) {
    problems.push("metrics must be the authoritative MetricSet array");
  } else {
    run.metrics.forEach((m, i) => {
      if (!m || typeof m !== "object") { problems.push(`metrics[${i}] is not an object`); return; }
      if (!m.key) problems.push(`metrics[${i}] has no key`);
      if (typeof m.available !== "boolean") problems.push(`metrics[${i}] has no boolean 'available'`);
      // The distinction this whole migration exists to preserve.
      if (m.available === false && !m.reason) {
        problems.push(`metrics[${i}] (${m.key}) is unavailable with no reason`);
      }
      if (m.available === true && (m.value == null)) {
        problems.push(`metrics[${i}] (${m.key}) is available with a null value`);
      }
      if (!m.computedBy) problems.push(`metrics[${i}] (${m.key}) has no computedBy authority marker`);
    });
  }
  if (!run.riskScore || typeof run.riskScore !== "object") problems.push("riskScore is required");
  if (!run.methodology || typeof run.methodology !== "object") problems.push("methodology is required");
  if (!run.period) problems.push("period is required");
  if (!run.engineVersion) problems.push("engineVersion is required");

  if (problems.length) {
    const err = new Error(
      `refusing to persist a completed run that could not be recovered: ${problems.join("; ")}`);
    err.code = "run_not_recoverable";
    err.problems = problems;
    throw err;
  }
}

/**
 * The authoritative period-level INPUTS, captured so the run can be shown to be
 * the same run without recomputing it.
 *
 * `currentCashBalance` matters most: it is supplied at upload and consumed by
 * the runway calculation, and it lived only in the uploaded envelope in memory.
 * PROVIDED-AND-ZERO is preserved as distinct from NOT-PROVIDED, because a
 * business with no cash and a business that did not tell us are different
 * answers and must not collapse into one.
 */
function buildPeriodInputs(run, inputs = {}) {
  /* THE CASH BALANCE, WITH ITS PROVENANCE.
   *
   * Three states, and collapsing any two of them changes what the analysis
   * means:
   *
   *   observed  — the uploader gave us this figure.
   *   derived   — nobody gave us one, so ingestion inferred it from net income
   *               (clamped at zero). It is an estimate, and the cash-runway
   *               calculation built on it inherits that.
   *   absent    — no figure at all.
   *
   * `provided` used to be computed from the POST-derivation value, which meant
   * a derived estimate was recorded as though the user had supplied it — the
   * "derived becomes observed" collapse. The basis now comes from ingestion,
   * which is the only place that knows which happened.
   */
  const meta = inputs.ingestionMeta || {};
  const cashMeta = meta.cashBalance || null;
  const rawCash = inputs.currentCashBalance;
  const basis = cashMeta ? cashMeta.basis : null;

  let currentCashBalance;
  if (basis === "observed") {
    currentCashBalance = {
      provided: true, basis: "observed",
      value: cashMeta.providedValue != null ? Number(cashMeta.providedValue) : Number(rawCash)
    };
  } else if (basis) {
    // Derived. The VALUE used is recorded so the run is reproducible, but it is
    // labelled, and `provided` stays false because nobody provided it.
    currentCashBalance = {
      provided: false, basis,
      value: cashMeta.value == null ? null : Number(cashMeta.value)
    };
  } else if (rawCash != null && rawCash !== "" && Number.isFinite(Number(rawCash))) {
    // A source that reports no basis (Zoho, demo) but did supply a figure.
    currentCashBalance = { provided: true, basis: "observed", value: Number(rawCash) };
  } else {
    currentCashBalance = { provided: false, basis: "absent", value: null };
  }

  return {
    currentCashBalance,
    transactionCount: Number.isInteger(run.transactionCount) ? run.transactionCount : null,
    // Currencies present, so a reloaded run is interpreted in the same terms.
    currencies: run.methodology && run.methodology.currency
      ? {
        currency: run.methodology.currency.currency || null,
        aggregatable: Boolean(run.methodology.currency.aggregatable),
        byCurrency: run.methodology.currency.byCurrency || []
      }
      : null,
    // Where the records came from, and what ingestion had to say about them.
    provenance: {
      dataSource: run.dataSource || null,
      inputHash: run.inputHash || null,
      businessName: inputs.businessName || null
    },
    ingestion: inputs.ingestionMeta
      ? {
        skippedRows: inputs.ingestionMeta.skippedRows == null
          ? null : Number(inputs.ingestionMeta.skippedRows),
        warnings: Array.isArray(inputs.ingestionMeta.warnings)
          ? inputs.ingestionMeta.warnings : [],
        sourceFilename: inputs.ingestionMeta.sourceFilename || null
      }
      : null
  };
}

/**
 * Persist a domain AnalysisRun (output of src/domain/analysis/engine.analyze).
 *
 * ONE TRANSACTION covers the run row, its findings, its evidence and its metric
 * projection, so a completed run never exists alongside a missing part of
 * itself. `withTenant` opens the transaction; a throw anywhere below rolls the
 * whole thing back and the run simply never appears.
 *
 * @param inputs the authoritative period-level inputs (currentCashBalance,
 *               ingestion metadata) that are NOT part of the engine's output
 *               but are required to represent the completed analysis.
 * Returns the stored run id and counts.
 */
async function saveRun(tenantId, run, inputs = {}) {
  const status = run.status || LIFECYCLE.COMPLETED;
  // Checked BEFORE the transaction opens: nothing is written for a run we
  // already know we could not load back.
  if (status === LIFECYCLE.COMPLETED) assertRecoverable(run);

  return withTenant(tenantId, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO analysis_run
        (tenant_id, period, status, engine_version, rule_versions, input_hash, data_source,
         data_quality_level, data_quality, metrics, health, started_at, completed_at,
         methodology, coverage_policy_version, materiality_version,
         metric_set, period_inputs, run_summary, recovery_schema_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING id`,
      [
        tenantId, run.period, status, run.engineVersion,
        JSON.stringify(run.ruleVersions || {}), run.inputHash || null, run.dataSource || null,
        run.dataQuality ? run.dataQuality.level : null,
        JSON.stringify(run.dataQuality || {}), JSON.stringify(run.calculations || {}),
        JSON.stringify(run.riskScore || {}), run.startedAt || new Date().toISOString(),
        run.completedAt || new Date().toISOString(),
        // The methodology this run actually applied, so a historical analysis is
        // still explainable after the registry moves on.
        JSON.stringify(run.methodology || {}),
        run.methodology && run.methodology.coveragePolicy
          ? run.methodology.coveragePolicy.version : null,
        run.methodology && run.methodology.materiality
          ? run.methodology.materiality.version : null,
        /* THE RECOVERABLE STATE (JOB 11). The authoritative MetricSet — every
           metric including the unavailable ones — the period inputs, and the
           summary. Without these three a `completed` row is unloadable, which
           is why the CHECK constraint refuses to store it. */
        JSON.stringify(run.metrics || []),
        JSON.stringify(buildPeriodInputs(run, inputs)),
        JSON.stringify({
          summary: run.summary || {},
          quality: run.quality || null,
          transactionCount: run.transactionCount == null ? null : run.transactionCount
        }),
        status === LIFECYCLE.COMPLETED ? RECOVERY_SCHEMA_VERSION : null
      ]
    );
    const runId = rows[0].id;

    let findings = 0, evidence = 0;
    for (const f of run.findings || []) {
      const res = await c.query(
        `INSERT INTO finding
          (tenant_id, analysis_run_id, finding_key, period, rule_id, rule_version, category,
           severity, title, description, metric, value, threshold, comparator, confidence,
           calculation, is_data_quality, match_criteria,
           severity_basis, severity_reason, confidence_basis, confidence_reason,
           currency, authority_scope)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
                 $19,$20,$21,$22,$23,$24)
         ON CONFLICT (analysis_run_id, finding_key) DO NOTHING
         RETURNING id`,
        [
          tenantId, runId, f.findingId, f.period || run.period, f.ruleId, f.ruleVersion, f.category,
          f.severity, f.title, f.description || null, f.metric || null,
          f.observedValue == null ? null : String(f.observedValue),
          f.threshold == null ? null : String(f.threshold),
          f.comparator || null, f.confidence == null ? null : f.confidence,
          f.calculation || null, Boolean(f.isDataQuality),
          f.matchCriteria ? JSON.stringify(f.matchCriteria) : null,
          f.severityBasis || null, f.severityReason || null,
          f.confidenceBasis || null, f.confidenceReason || null,
          f.currency || null, f.authorityScope || "engine"
        ]
      );
      if (!res.rows.length) continue;
      findings++;
      const findingId = res.rows[0].id;
      for (const e of f.evidence || []) {
        await c.query(
          `INSERT INTO finding_evidence
             (tenant_id, finding_id, label, source_system, source_record_id,
              record_type, relationship, field_name, field_value, fields)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [tenantId, findingId, e.label, e.sourceSystem || null, e.sourceRecordId || null,
           e.recordType || null, e.relationship || null, e.field || null,
           e.value == null ? null : String(e.value),
           JSON.stringify(e.fields || {})]
        );
        evidence++;
      }
    }

    /* PROJECT THE AUTHORITATIVE METRIC SET FOR QUERYING.
     *
     * WHAT WAS WRONG. This used to flatten a hand-picked list out of
     * `run.calculations` and then `.filter()` away everything non-finite. Two
     * separate defects in one line: it queried the LEGACY shape rather than the
     * authoritative MetricSet, and it DELETED the unavailable metrics. A metric
     * that could not be calculated left no row, and a missing row reads as zero
     * to anything scanning this table — turning "we could not measure your
     * runway" into "your runway is 0 months", which is a far worse statement
     * than saying nothing.
     *
     * Every metric is now projected, available or not. The unavailable ones
     * carry their reason and a NULL value, so the three states stay distinct.
     * The jsonb `metric_set` remains the record of truth; these rows are its
     * queryable index, not a competing copy.
     */
    const metricSet = Array.isArray(run.metrics) ? run.metrics : [];
    for (const metric of metricSet) {
      await c.query(
        `INSERT INTO metric_value
           (tenant_id, analysis_run_id, period, metric_key, numeric_value,
            available, unavailable_reason, unit, currency, computed_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (analysis_run_id, metric_key) DO NOTHING`,
        [
          tenantId, runId, run.period, metric.key,
          // Numeric only when it IS one: a percent or score is numeric, but a
          // metric could carry a non-numeric value, and forcing Number() on it
          // would store NaN as though it were measured.
          metric.available && Number.isFinite(Number(metric.value))
            ? Number(metric.value) : null,
          Boolean(metric.available && Number.isFinite(Number(metric.value))),
          metric.available ? null : (metric.reason || "unknown"),
          metric.unit || null,
          metric.currency || null,
          metric.computedBy || null
        ]
      );
    }

    return {
      runId,
      findings,
      evidence,
      metrics: metricSet.length,
      // How many were genuinely unmeasurable — surfaced so a caller can see the
      // difference between "no metrics" and "metrics that could not be taken".
      metricsUnavailable: metricSet.filter((m) => !m.available).length,
      recoverable: status === LIFECYCLE.COMPLETED
    };
  });
}

/* ═══════════════════════════════════════════════════════════════
   THE READ PATH — loading a completed run back.

   This is the half that never existed. saveRun wrote; nothing read. The
   functions below are what make a persisted analysis usable again, and they are
   wired into the production routes (see routes/api.js loadPersistedRun).

   NOTHING HERE RECOMPUTES. A recovered run is assembled from stored rows only.
   If the stored state is insufficient — a legacy row — that is reported as
   `legacy`, never repaired by re-running the engine behind the user's back,
   because a re-run against today's rules and today's missing inputs would
   produce a DIFFERENT answer while claiming to be the original.
   ═══════════════════════════════════════════════════════════════ */

/** Reasons a run could not be handed back as a completed analysis. */
const RECOVERY = Object.freeze({
  OK: "recovered",
  NOT_FOUND: "not_found",
  LEGACY: "legacy_unrecoverable",
  NOT_COMPLETED: "not_completed"
});

/** Postgres `numeric` arrives as a string; keep null as null, never 0. */
function num(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Rebuild the domain run object from its stored row plus findings and evidence.
 *
 * The returned shape matches what `engine.analyze` emits, so every consumer —
 * routes, capabilities, the copilot — reads a recovered run exactly as it reads
 * a fresh one, with no branch for "this came from the database".
 */
function hydrateRun(row, findingRows) {
  const findings = findingRows.map((f) => Object.freeze({
    findingId: f.finding_key,
    period: (f.period || "").trim(),
    ruleId: f.rule_id,
    ruleVersion: f.rule_version,
    category: f.category,
    severity: f.severity,
    title: f.title,
    description: f.description,
    metric: f.metric,
    // Stored as text to preserve exactness; null stays null, never 0.
    observedValue: num(f.value),
    threshold: num(f.threshold),
    comparator: f.comparator,
    confidence: num(f.confidence),
    calculation: f.calculation,
    isDataQuality: Boolean(f.is_data_quality),
    matchCriteria: f.match_criteria || null,
    severityBasis: f.severity_basis,
    severityReason: f.severity_reason,
    confidenceBasis: f.confidence_basis,
    confidenceReason: f.confidence_reason,
    currency: f.currency,
    // The authority marker survives the round trip: a stored finding is still
    // an ENGINE finding, and can never come back looking like an AI claim.
    authorityScope: f.authority_scope || "engine",
    evidence: (f.evidence || []).map((e) => Object.freeze({
      label: e.label,
      sourceSystem: e.sourceSystem,
      sourceRecordId: e.sourceRecordId,
      recordType: e.recordType,
      relationship: e.relationship,
      field: e.field,
      value: e.value,
      fields: e.fields || {}
    }))
  }));

  const metrics = Array.isArray(row.metric_set) ? row.metric_set.map(Object.freeze) : [];
  const summaryBlock = row.run_summary || {};

  return Object.freeze({
    analysisRunId: row.id,
    tenantId: row.tenant_id,
    period: (row.period || "").trim(),
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    engineVersion: row.engine_version,
    ruleVersions: row.rule_versions || {},
    inputHash: row.input_hash,
    dataSource: row.data_source,

    dataQuality: row.data_quality || null,
    quality: summaryBlock.quality || null,
    transactionCount: summaryBlock.transactionCount == null
      ? null : summaryBlock.transactionCount,

    // The authoritative representations, exactly as stored.
    metrics,
    metricsByKey: metrics.reduce((acc, m) => { acc[m.key] = m; return acc; }, {}),
    riskScore: row.health || null,
    findings,
    methodology: row.methodology || {},
    calculations: row.metrics || {},   // legacy column name; see migration 007
    summary: summaryBlock.summary || {},

    // The inputs the run was computed from, so the result is interpretable
    // without guessing what was supplied.
    periodInputs: row.period_inputs || null,

    /* MARKED AS RECOVERED. Consumers must be able to tell a loaded run from a
       freshly computed one — for display, for support, and so a test can prove
       recovery did not quietly re-run the engine. The VALUES are identical;
       only this provenance flag differs. */
    recovered: true,
    recoverySchemaVersion: row.recovery_schema_version
  });
}

/**
 * Load the most recent COMPLETED, RECOVERABLE run for a period.
 *
 * Failed and in-progress runs are ignored: "the latest completed analysis" must
 * never be answered with one that failed, which would present a failure as a
 * result. Their existence is still queryable via latestRunAnyStatus/failedRuns.
 *
 * @returns {object} { ok, reason, run }
 */
async function loadCompletedRun(tenantId, period) {
  return withTenant(tenantId, async (c) => {
    const { rows } = await c.query(
      `SELECT * FROM analysis_run
        WHERE period = $1 AND status = 'completed'
        ORDER BY started_at DESC LIMIT 1`,
      [period]
    );
    if (!rows.length) return { ok: false, reason: RECOVERY.NOT_FOUND, run: null };
    return hydrateOrExplain(c, rows[0]);
  });
}

/** Load a specific run by id — tenant-scoped, so an id from another tenant simply is not found. */
async function loadRunById(tenantId, runId) {
  return withTenant(tenantId, async (c) => {
    const { rows } = await c.query("SELECT * FROM analysis_run WHERE id = $1", [runId]);
    /* RLS already confines this to the tenant. A miss is reported as NOT_FOUND
       with no other detail, so the response cannot be used to discover whether
       a run id exists under a different tenant. */
    if (!rows.length) return { ok: false, reason: RECOVERY.NOT_FOUND, run: null };
    if (rows[0].status !== LIFECYCLE.COMPLETED) {
      return { ok: false, reason: RECOVERY.NOT_COMPLETED, run: null, status: rows[0].status };
    }
    return hydrateOrExplain(c, rows[0]);
  });
}

/** Shared tail: a row is either recoverable, or honestly legacy. */
async function hydrateOrExplain(c, row) {
  if (row.recovery_schema_version == null || !row.metric_set) {
    /* A REAL HISTORICAL RUN THAT CANNOT BE REBUILT. Written before JOB 11, so
       its authoritative metrics and period inputs were never stored. Reported
       as legacy rather than reconstructed: a rebuild would have to invent the
       missing inputs, and an invented figure presented as a stored one is the
       exact failure this work exists to prevent. */
    return {
      ok: false,
      reason: RECOVERY.LEGACY,
      run: null,
      runId: row.id,
      period: (row.period || "").trim(),
      completedAt: row.completed_at
    };
  }

  const { rows: findingRows } = await c.query(
    `SELECT f.*,
            COALESCE(json_agg(json_build_object(
              'label', e.label, 'sourceSystem', e.source_system,
              'sourceRecordId', e.source_record_id, 'recordType', e.record_type,
              'relationship', e.relationship, 'field', e.field_name,
              'value', e.field_value, 'fields', e.fields
            ) ORDER BY e.id) FILTER (WHERE e.id IS NOT NULL), '[]') AS evidence
       FROM finding f
       LEFT JOIN finding_evidence e ON e.finding_id = f.id
      WHERE f.analysis_run_id = $1
      GROUP BY f.id
      ORDER BY f.severity DESC, f.rule_id`,
    [row.id]
  );

  return { ok: true, reason: RECOVERY.OK, run: hydrateRun(row, findingRows) };
}

/**
 * The persisted metric projection for a run.
 * Unavailable metrics are INCLUDED, with their reason and a null value.
 */
async function metricsForRun(tenantId, runId) {
  return withTenant(tenantId, async (c) => {
    const { rows } = await c.query(
      `SELECT metric_key, numeric_value, available, unavailable_reason,
              unit, currency, computed_by
         FROM metric_value WHERE analysis_run_id = $1 ORDER BY metric_key`,
      [runId]
    );
    return rows.map((r) => ({
      key: r.metric_key,
      available: r.available,
      value: r.available ? num(r.numeric_value) : null,
      reason: r.available ? null : r.unavailable_reason,
      unit: r.unit,
      currency: r.currency,
      computedBy: r.computed_by
    }));
  });
}

/** Which periods this tenant has a completed, recoverable analysis for. */
async function completedPeriods(tenantId, { limit = 24 } = {}) {
  return withTenant(tenantId, async (c) => {
    const { rows } = await c.query(
      `SELECT DISTINCT ON (period) period, id, started_at, completed_at,
              recovery_schema_version
         FROM analysis_run
        WHERE status = 'completed'
        ORDER BY period DESC, started_at DESC
        LIMIT $1`,
      [limit]
    );
    return rows.map((r) => ({
      period: (r.period || "").trim(),
      runId: r.id,
      completedAt: r.completed_at,
      recoverable: r.recovery_schema_version != null
    }));
  });
}

async function latestRun(tenantId, period) {
  return withTenant(tenantId, async (c) => {
    const { rows } = await c.query(
      `SELECT * FROM analysis_run WHERE period = $1 ORDER BY started_at DESC LIMIT 1`, [period]);
    return rows[0] || null;
  });
}

/** A finding with its evidence — the "why did you flag this?" query. */
async function findingWithEvidence(tenantId, findingKey) {
  return withTenant(tenantId, async (c) => {
    const { rows } = await c.query(
      `SELECT f.*, r.engine_version,
              COALESCE(json_agg(json_build_object(
                'label', e.label, 'sourceSystem', e.source_system,
                'sourceRecordId', e.source_record_id, 'recordType', e.record_type,
                'relationship', e.relationship, 'field', e.field_name,
                'value', e.field_value, 'fields', e.fields
              )) FILTER (WHERE e.id IS NOT NULL), '[]') AS evidence
       FROM finding f
       JOIN analysis_run r ON r.id = f.analysis_run_id
       LEFT JOIN finding_evidence e ON e.finding_id = f.id
       WHERE f.finding_key = $1
       GROUP BY f.id, r.engine_version
       ORDER BY f.created_at DESC LIMIT 1`,
      [findingKey]
    );
    return rows[0] || null;
  });
}

async function findingsForRun(tenantId, runId) {
  return withTenant(tenantId, async (c) => {
    const { rows } = await c.query(
      "SELECT * FROM finding WHERE analysis_run_id = $1 ORDER BY severity DESC, rule_id", [runId]);
    return rows;
  });
}

/**
 * Every finding that cites a given source record.
 * This is the reverse of findingWithEvidence: "what did this transaction cause?"
 */
async function findingsCitingRecord(tenantId, sourceSystem, sourceRecordId) {
  return withTenant(tenantId, async (c) => {
    const { rows } = await c.query(
      `SELECT DISTINCT f.finding_key, f.rule_id, f.rule_version, f.category, f.severity, f.title
       FROM finding f
       JOIN finding_evidence e ON e.finding_id = f.id
       WHERE e.source_system = $1 AND e.source_record_id = $2
       ORDER BY f.severity DESC, f.rule_id`,
      [sourceSystem, sourceRecordId]
    );
    return rows;
  });
}

/**
 * Open a run BEFORE any work begins.
 *
 * Creating the row first is what makes a failure recordable: if the process
 * dies during ingestion, the row already exists in a non-completed state and
 * says so, rather than there being nothing at all.
 */
async function beginRun(tenantId, { period, source = null, runId = null }) {
  const id = runId || ("run_" + crypto.randomBytes(8).toString("hex"));
  return withTenant(tenantId, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO analysis_run
         (tenant_id, period, status, engine_version, rule_versions, ingest_source,
          started_at, completed_at, data_quality, metrics, health)
       VALUES ($1,$2,$3,$4,$5,$6, now(), now(), '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)
       RETURNING id`,
      [tenantId, period, LIFECYCLE.PENDING, "pending", JSON.stringify({}), source]);
    return { runId: rows[0].id, externalId: id, status: LIFECYCLE.PENDING };
  });
}

/** Advance a run through the lifecycle. */
async function markStatus(tenantId, runId, status, extra = {}) {
  if (!Object.values(LIFECYCLE).includes(status)) {
    throw new Error(`unknown analysis run status: ${status}`);
  }
  return withTenant(tenantId, async (c) => {
    const { rowCount } = await c.query(
      `UPDATE analysis_run
          SET status = $2, updated_at = now(),
              ingest_source = COALESCE($3, ingest_source),
              data_quality_level = COALESCE($4, data_quality_level)
        WHERE id = $1`,
      [runId, status, extra.source || null, extra.dataQualityLevel || null]);
    return { updated: rowCount > 0 };
  });
}

/**
 * Record a FAILURE.
 *
 * `reason` is a classification (a stable, safe string). `detail` is a short
 * human message — never a stack trace, never a raw provider error, because this
 * row is read back into a user-facing explanation.
 */
async function failRun(tenantId, runId, { stage, reason, detail = null }) {
  return withTenant(tenantId, async (c) => {
    const { rowCount } = await c.query(
      `UPDATE analysis_run
          SET status = $2, failure_stage = $3, failure_reason = $4,
              failure_detail = $5, completed_at = now(), updated_at = now()
        WHERE id = $1`,
      [runId, LIFECYCLE.FAILED, stage, reason, detail ? String(detail).slice(0, 500) : null]);
    return { failed: rowCount > 0 };
  });
}

/** The most recent run for a period, whatever its status. */
async function latestRunAnyStatus(tenantId, period) {
  return withTenant(tenantId, async (c) => {
    const { rows } = await c.query(
      "SELECT * FROM analysis_run WHERE period = $1 ORDER BY started_at DESC LIMIT 1",
      [period]);
    return rows[0] || null;
  });
}

/** Runs that failed — recoverable and explainable, not silently absent. */
async function failedRuns(tenantId, { limit = 20 } = {}) {
  return withTenant(tenantId, async (c) => {
    const { rows } = await c.query(
      `SELECT id, period, status, failure_stage, failure_reason, failure_detail,
              ingest_source, started_at, completed_at
         FROM analysis_run
        WHERE status = $1
        ORDER BY started_at DESC
        LIMIT $2`,
      [LIFECYCLE.FAILED, Math.min(limit, 100)]);
    return rows;
  });
}

module.exports = {
  LIFECYCLE, STAGE, RECOVERY, RECOVERY_SCHEMA_VERSION,
  saveRun, latestRun, findingWithEvidence, findingsForRun, findingsCitingRecord,
  beginRun, markStatus, failRun, latestRunAnyStatus, failedRuns,
  // JOB 11 read path — the half that previously did not exist.
  loadCompletedRun, loadRunById, metricsForRun, completedPeriods,
  // Exported so the guards can assert on them directly.
  assertRecoverable, buildPeriodInputs, hydrateRun
};
