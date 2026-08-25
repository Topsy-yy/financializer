// Continuous Financial Monitoring — scheduled, automatic re-analysis of a user's
// books with de-duplicated alerts on NEW issues only.
//
// Design:
//  - Pure, testable core: due calculation, plan-based frequency, issue
//    fingerprinting, new-issue detection, notification de-duplication.
//  - The heavy lifting (fetching data, running the risk engine) is injected via
//    `deps` so this module stays engine-agnostic and unit-testable, and so it
//    REUSES the existing analysis engine rather than re-implementing detection.
//  - Duplicate prevention is two-layered: a per-user set of seen issue
//    fingerprints (an issue never alerts twice across runs) plus a guard against
//    adding a notification whose fingerprint already exists.

const FREQ_DAYS = { daily: 1, weekly: 7, monthly: 30 };
const DAY_MS = 24 * 60 * 60 * 1000;

// This module deliberately knows nothing about plans. Callers resolve the
// `automatic_monitoring` capability through the entitlement service and pass the
// answer in, so scheduling rules live in exactly one place.
const ALL_FREQUENCIES = ["daily", "weekly", "monthly"];

// Frequencies that may be SCHEDULED. Without the capability there are none --
// but manual analysis remains unlimited, so nothing is actually lost.
function allowedFrequencies(canSchedule) {
  return canSchedule ? ALL_FREQUENCIES.slice() : [];
}
function defaultFrequency(canSchedule) {
  return canSchedule ? "daily" : "monthly";
}

/**
 * Clamp a requested frequency to what is schedulable.
 *
 * DOWNGRADE POLICY: when scheduling is not available the stored frequency is
 * PRESERVED, never rewritten. A Growth user on "daily" who downgrades keeps
 * "daily" on record; it simply stops firing. Re-upgrading restores their exact
 * previous cadence with no reconfiguration.
 */
function resolveFrequency(canSchedule, requested) {
  const current = String(requested || "");
  if (!canSchedule) {
    return ALL_FREQUENCIES.indexOf(current) !== -1 ? current : defaultFrequency(false);
  }
  return ALL_FREQUENCIES.indexOf(current) !== -1 ? current : defaultFrequency(true);
}
function intervalMs(frequency) {
  return (FREQ_DAYS[frequency] || 30) * DAY_MS;
}

// A default monitoring config for a new/legacy profile.
function defaultMonitoring() {
  return {
    enabled: false,
    frequency: "monthly",
    lastRunAt: null,
    nextDueAt: null,
    lastStatus: null,
    lastError: null,
    lastNewIssues: 0
  };
}

function isDue(monitoring, now) {
  if (!monitoring || !monitoring.enabled) return false;
  if (!monitoring.lastRunAt) return true; // never run -> due immediately
  const last = Date.parse(monitoring.lastRunAt);
  if (!Number.isFinite(last)) return true;
  return now - last >= intervalMs(monitoring.frequency);
}

// Period-independent identity of an issue. The description carries the specifics
// (amount, counterparty, date), so identical issues in consecutive syncs collapse
// to one fingerprint and never re-alert.
function issueFingerprint(item) {
  const type = (item && item.type) || "issue";
  const desc = (item && item.description) || "";
  return (type + "|" + desc).toLowerCase().replace(/\s+/g, " ").trim();
}

// Split issues into those never seen before (fresh) vs. already known.
function detectNewIssues(items, seen) {
  const seenSet = new Set(seen || []);
  const fresh = [];
  (items || []).forEach((item) => {
    const fp = issueFingerprint(item);
    if (!seenSet.has(fp)) {
      seenSet.add(fp);
      fresh.push(Object.assign({ fingerprint: fp }, item));
    }
  });
  return { fresh, seen: Array.from(seenSet) };
}

const TYPE_TITLES = {
  duplicate_transaction: "Possible duplicate payment",
  duplicate_payment: "Possible duplicate payment",
  outlier: "Unusual transaction",
  round_payment: "Round-number payment",
  mixed_funds: "Personal/business mix",
  unreconciled_account: "Unreconciled account",
  missing_fields: "Incomplete transaction record",
  missing_references: "Missing journal references",
  overdue_receivable: "Overdue receivable",
  overdue_payable: "Overdue payable",
  missing_documentation: "Missing receipt/documentation"
};
function titleForType(type) {
  return TYPE_TITLES[type] || "New financial issue";
}
function levelForSeverity(sev) {
  return sev === "high" ? "high" : sev === "low" ? "low" : "medium";
}

// Add notifications to the front of the feed, skipping any whose fingerprint is
// already present (second de-dup layer), and cap the stored history.
function pushNotifications(profile, notes, cap) {
  if (!Array.isArray(profile.notifications)) profile.notifications = [];
  const existing = new Set(profile.notifications.map((n) => n.fingerprint).filter(Boolean));
  const toAdd = notes.filter((n) => !n.fingerprint || !existing.has(n.fingerprint));
  profile.notifications = toAdd.concat(profile.notifications).slice(0, cap || 100);
  return toAdd.length;
}

/**
 * Run monitoring for a single user store if it is due.
 * @param {object} store  { profile, ... } — the per-user store.
 * @param {object} deps
 *   resolveMonthlyData(store) -> Promise<monthlyData>   (may throw; retried)
 *   analyze(monthlyData) -> analysis
 *   buildContext({month, monthlyData, analysis}) -> ctx (with ctx.anomalies.items)
 *   periodOf(now) -> "YYYY-MM"
 *   persist(store)  (optional)
 *   maxRetries (optional, default 2)
 * @param {number} now  epoch ms.
 */
async function runForStore(store, deps, now) {
  const profile = store.profile;
  const mon = profile.monitoring || (profile.monitoring = defaultMonitoring());
  if (!isDue(mon, now)) return { ran: false, reason: "not_due" };

  const maxRetries = deps.maxRetries != null ? deps.maxRetries : 2;

  // Transient data fetch (e.g. Zoho) is retried; the local risk engine is not.
  let monthlyData = null;
  let lastError = null;
  let attempts = 0;
  for (let i = 0; i <= maxRetries; i++) {
    attempts++;
    try {
      monthlyData = await deps.resolveMonthlyData(store);
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      monthlyData = null;
    }
  }

  const stamp = new Date(now).toISOString();
  mon.lastRunAt = stamp;
  mon.nextDueAt = new Date(now + intervalMs(mon.frequency)).toISOString();

  if (!monthlyData) {
    mon.lastStatus = "error";
    mon.lastError = (lastError && lastError.message) || "sync_failed";
    mon.lastNewIssues = 0;
    if (deps.persist) deps.persist(store);
    return { ran: true, ok: false, attempts, error: mon.lastError };
  }

  const period = deps.periodOf(now);
  const analysis = deps.analyze(monthlyData);
  // reportsDir keeps tenant-scoped side data (e.g. the on-chain ledger) scoped.
  const ctx = deps.buildContext({ month: period, monthlyData, analysis, reportsDir: store.reportsDir });
  const items = (ctx && ctx.anomalies && ctx.anomalies.items) || [];

  const { fresh, seen } = detectNewIssues(items, profile.seenIssueFingerprints);
  profile.seenIssueFingerprints = seen.slice(-1000); // bound growth

  const notes = fresh.map((item, i) => ({
    id: "mon-" + now + "-" + i,
    ts: stamp,
    level: levelForSeverity(item.severity),
    title: titleForType(item.type),
    body: item.description || "",
    period,
    fingerprint: item.fingerprint,
    read: false,
    source: "monitor"
  }));
  const added = pushNotifications(profile, notes, 100);

  mon.lastStatus = "ok";
  mon.lastError = null;
  mon.lastNewIssues = added;
  if (deps.persist) deps.persist(store);

  return { ran: true, ok: true, attempts, newIssues: added, total_issues: items.length, notifications: notes };
}

/**
 * Run monitoring across many stores; only due ones actually sync.
 * @param {Array} stores
 * @param {object} deps  same as runForStore.
 * @param {number} now
 */
async function runCycle(stores, deps, now) {
  const summary = { checked: 0, ran: 0, ok: 0, failed: 0, newIssues: 0 };
  for (const store of stores || []) {
    summary.checked++;
    let result;
    try {
      result = await runForStore(store, deps, now);
    } catch (err) {
      summary.failed++;
      continue;
    }
    if (!result.ran) continue;
    summary.ran++;
    if (result.ok) {
      summary.ok++;
      summary.newIssues += result.newIssues || 0;
    } else {
      summary.failed++;
    }
  }
  return summary;
}

module.exports = {
  FREQ_DAYS,
  ALL_FREQUENCIES,
  allowedFrequencies,
  defaultFrequency,
  resolveFrequency,
  intervalMs,
  defaultMonitoring,
  isDue,
  issueFingerprint,
  detectNewIssues,
  titleForType,
  levelForSeverity,
  pushNotifications,
  runForStore,
  runCycle
};
