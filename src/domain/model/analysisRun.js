// AnalysisRun — the contract for one execution of the deterministic engine.
//
// SCOPE (JOB 5): establish the contract so findings, metrics and scores have
// somewhere to attach. The full reproducibility infrastructure (input snapshots,
// prompt versions, AI invocation records) belongs to JOB 8; the fields that
// exist here are the ones already produced and persisted today.

const STATUS = Object.freeze({
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed"
});

function createAnalysisRun({
  analysisRunId,
  tenantId,
  financialPeriod,
  status = STATUS.COMPLETED,
  engineVersion,
  ruleVersions,
  dataQuality = null,
  dataSource = null,
  inputHash = null,
  startedAt,
  completedAt = null,
  error = null
}) {
  if (!analysisRunId) throw new Error("analysis run requires an analysisRunId");
  if (!engineVersion) throw new Error("analysis run requires an engineVersion");
  if (!Object.values(STATUS).includes(status)) {
    throw new Error(`analysis run has unknown status: ${status}`);
  }
  if (status === STATUS.FAILED && !error) {
    throw new Error("a failed analysis run must record an error");
  }
  return Object.freeze({
    analysisRunId: String(analysisRunId),
    tenantId: tenantId || null,
    financialPeriod: financialPeriod || null,
    status,
    // Which code and which rules produced this result — so a historical run
    // stays explainable after thresholds change.
    engineVersion,
    ruleVersions: Object.freeze(Object.assign({}, ruleVersions || {})),
    // Analysis is only as trustworthy as its inputs.
    dataQuality,
    dataSource,
    inputHash,
    startedAt: startedAt || new Date().toISOString(),
    completedAt,
    error
  });
}

module.exports = { STATUS, createAnalysisRun };
