// JOB LOCKING, DEDUPLICATION AND OUTCOME RECORDING.
//
// WHAT WAS WRONG. The monitoring cycle's only concurrency guard was a
// process-local boolean:
//
//     let monitoringCycleRunning = false;
//
// Three defects followed from that:
//   1. It guarded ONLY the timer path. `GET /api/notifications` and
//      `POST /api/monitoring/run` called runForStore directly, so two requests
//      from the same user — or a request landing during a sweep — ran the same
//      tenant's job simultaneously.
//   2. It is per-process. Two instances both sweep, both write the same
//      profile.json, and last-write-wins loses notifications and corrupts the
//      seen-fingerprint set.
//   3. Cycle failures were swallowed by `.catch(() => {})`, so a persistently
//      failing job was invisible.
//
// THE MECHANISM. A lock is a ROW whose primary key is the work identity, so
// acquisition is an INSERT that either succeeds or violates the key. There is
// no read-then-write window. Locks carry an expiry, so a worker that dies
// without releasing does not block that tenant forever.
//
// No queue, no broker: a table and a primary key are sufficient for
// "only one worker per tenant/period", and they are already operationally
// understood here.

const { withTenant, isConfigured } = require("../pool");
const { logger } = require("../../services/logger");

const log = logger.child({ component: "jobs" });

const DEFAULT_LEASE_MS = 10 * 60 * 1000;

/**
 * Try to acquire a lock. Returns false if someone else holds it.
 *
 * `ON CONFLICT ... WHERE expires_at < now()` makes acquisition and expiry
 * reclamation the same atomic statement: a live lock blocks, a dead one is
 * taken over, and there is no moment where both are true.
 */
async function acquireLock(tenantId, lockKey, { owner, leaseMs = DEFAULT_LEASE_MS } = {}) {
  if (!isConfigured()) {
    // Without a database there is one process by definition, so the caller's
    // in-process guard is the whole truth. Say so rather than implying a
    // distributed lock was taken.
    return { acquired: true, distributed: false, reason: "no_database" };
  }
  return withTenant(tenantId, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO job_lock (lock_key, tenant_id, owner, expires_at)
       VALUES ($1, $2, $3, now() + ($4 || ' milliseconds')::interval)
       ON CONFLICT (lock_key) DO UPDATE
         SET owner = EXCLUDED.owner,
             acquired_at = now(),
             expires_at = EXCLUDED.expires_at
         WHERE job_lock.expires_at < now()
       RETURNING owner, expires_at`,
      [lockKey, tenantId, owner, String(leaseMs)]);

    if (!rows.length) {
      return { acquired: false, distributed: true, reason: "held_by_another_worker" };
    }
    return { acquired: true, distributed: true, owner: rows[0].owner, expiresAt: rows[0].expires_at };
  });
}

/** Release a lock. Only the owner may release, so a slow worker cannot free
 *  a lock another worker has since taken over. */
async function releaseLock(tenantId, lockKey, { owner } = {}) {
  if (!isConfigured()) return { released: true, distributed: false };
  return withTenant(tenantId, async (c) => {
    const { rowCount } = await c.query(
      "DELETE FROM job_lock WHERE lock_key = $1 AND owner = $2", [lockKey, owner]);
    return { released: rowCount > 0, distributed: true };
  });
}

/**
 * Run a function under a lock.
 *
 * The lock is released in `finally`, so a throw cannot strand it — and even if
 * the process dies mid-run, the lease expires.
 */
async function withLock(tenantId, lockKey, { owner, leaseMs }, fn) {
  const lock = await acquireLock(tenantId, lockKey, { owner, leaseMs });
  if (!lock.acquired) {
    log.info("job.skipped.locked", { lockKey, reason: lock.reason });
    return { ran: false, skipped: true, reason: lock.reason };
  }
  try {
    const result = await fn();
    return { ran: true, result };
  } finally {
    if (lock.distributed) {
      await releaseLock(tenantId, lockKey, { owner })
        .catch((err) => log.error("job.lock.release_failed", { lockKey, error: err.message }));
    }
  }
}

/**
 * Has this notification already been sent?
 *
 * The dedupe key encodes what the notification is ABOUT, so a repeated
 * scheduler tick that re-derives the same finding cannot send a second alert.
 * The INSERT is the claim: if it conflicts, someone already sent it.
 */
async function claimNotification(tenantId, dedupeKey, { period = null } = {}) {
  if (!isConfigured()) return { claimed: true, distributed: false };
  return withTenant(tenantId, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO notification_dedupe (dedupe_key, tenant_id, period)
       VALUES ($1, $2, $3)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING dedupe_key`,
      [dedupeKey, tenantId, period]);
    return { claimed: rows.length > 0, distributed: true };
  });
}

/** Record that a job started. Every attempt is recorded, including failures. */
async function startJob(tenantId, { jobType, period = null }) {
  if (!isConfigured()) return null;
  return withTenant(tenantId, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO job_run (tenant_id, job_type, period, status)
       VALUES ($1,$2,$3,'running') RETURNING id`,
      [tenantId, jobType, period]);
    return rows[0].id;
  });
}

/**
 * Record the outcome.
 *
 * A failure must not silently disappear — that was the third defect. `reason` is
 * a safe classification, not a stack trace.
 */
async function finishJob(tenantId, jobId, { status, reason = null }) {
  if (!isConfigured() || !jobId) return { recorded: false };
  return withTenant(tenantId, async (c) => {
    await c.query(
      `UPDATE job_run SET status = $2, reason = $3, finished_at = now() WHERE id = $1`,
      [jobId, status, reason ? String(reason).slice(0, 300) : null]);
    return { recorded: true };
  });
}

/** Recent job history, for "did the scheduler run, and did it work?". */
async function recentJobs(tenantId, { limit = 25 } = {}) {
  if (!isConfigured()) return [];
  return withTenant(tenantId, async (c) => {
    const { rows } = await c.query(
      `SELECT job_type, period, status, reason, started_at, finished_at
         FROM job_run ORDER BY started_at DESC LIMIT $1`,
      [Math.min(limit, 100)]);
    return rows;
  });
}

/** Reclaim locks whose lease expired, for a maintenance sweep. */
async function sweepExpiredLocks(tenantId) {
  if (!isConfigured()) return { swept: 0 };
  return withTenant(tenantId, async (c) => {
    const { rowCount } = await c.query("DELETE FROM job_lock WHERE expires_at < now()");
    return { swept: rowCount };
  });
}

/** The identity this process uses when it takes a lock. */
function workerId() {
  return `${process.env.HOSTNAME || "local"}:${process.pid}`;
}

module.exports = {
  DEFAULT_LEASE_MS,
  acquireLock, releaseLock, withLock,
  claimNotification, startJob, finishJob, recentJobs, sweepExpiredLocks, workerId
};
