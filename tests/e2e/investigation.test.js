// FINDING INVESTIGATION + RENEWAL REMINDERS.
//
// Two closures, both of the same kind: a backend capability that existed and
// had nothing calling it.
//
//   The evidence endpoints have been able to answer "which two payments?" since
//   JOB 12 and no screen ever asked.
//
//   The subscription lifecycle knew exactly when a plan would lapse and never
//   told anyone who was not already looking at the dashboard.

const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { startServer } = require("../helpers/server");

const TEST_DB = process.env.TEST_DATABASE_URL || "";
const ADMIN_DB = process.env.TEST_ADMIN_DATABASE_URL || TEST_DB;
const SKIP = !TEST_DB;

if (SKIP) console.warn("\n*** SKIPPING INVESTIGATION TESTS: TEST_DATABASE_URL not set ***\n");

/* The reminder tests call the service IN THIS PROCESS, so this process needs a
   pool of its own. Set before any require() of the service below. */
if (TEST_DB && !process.env.DATABASE_URL) process.env.DATABASE_URL = TEST_DB;

async function admin(fn) {
  const c = new Client({ connectionString: ADMIN_DB });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

const PERIOD = "2026-05";
/* A duplicated payment, so there is a finding that genuinely cites two
   specific transactions — the exact case a user needs to investigate. */
const CSV = [
  "Date,Description,Amount,Counterparty",
  `${PERIOD}-04,Consulting retainer,-200000,Rivera Logistics`,
  `${PERIOD}-04,Consulting retainer,-200000,Rivera Logistics`,
  `${PERIOD}-22,Client settlement,900000,BigCo Retail`
].join("\n");

const ENV = {
  DATABASE_URL: TEST_DB, ALLOW_DEMO_DATA: "true",
  AI_TEST_PROVIDER: "1", NVIDIA_API_KEY: "inv-test-key"
};

let server, client, duplicateKey;

test.before(async () => {
  if (SKIP) return;
  await admin((c) => c.query(
    `TRUNCATE renewal_reminder, subscription, payment, finding_evidence, finding,
              metric_value, analysis_run, financial_transaction, credit_balance,
              credit_transaction, membership, tenant, app_user
     RESTART IDENTITY CASCADE`));
  server = await startServer(ENV);
  client = server.client();

  await client.upload("/api/financial-data/upload", {
    filename: "may.csv", content: CSV,
    fields: { period: PERIOD, currentCashBalance: 1200000 }
  });
  await client.post("/api/monthly-review", { month: PERIOD, use_ai_analysis: false });

  const anomalies = await client.get(`/api/anomalies?month=${PERIOD}`);
  const dup = (anomalies.json.anomalies.items || [])
    .find((i) => i.rule_id === "duplicate_payment");
  assert.ok(dup, "precondition: the duplicate finding exists");
  duplicateKey = dup.finding_id || dup.id;
  assert.ok(duplicateKey, "and it has an id the UI can investigate with");
});

test.after(async () => { if (server) await server.stop(); });

// ══════════════════════════════════════════════════════════════════
// PART A — investigating a finding
// ══════════════════════════════════════════════════════════════════

test("[IV1] a finding resolves to the transactions it cites", { skip: SKIP }, async () => {
  const res = await client.get(
    `/api/findings/${encodeURIComponent(duplicateKey)}/records`);
  assert.equal(res.status, 200, JSON.stringify(res.json).slice(0, 200));
  assert.equal(res.json.complete, true, "every citation resolved");
  assert.ok(res.json.records.length >= 2,
    "the duplicate finding shows BOTH payments — the user's actual question");

  // PROVENANCE on every record, which is what makes it evidence.
  res.json.records.forEach((r) => {
    assert.ok(r.sourceSystem, "each record names the system it came from");
    assert.ok(r.sourceRecordId, "and its id in that system");
    assert.ok(r.date, "with a date");
    assert.equal(typeof r.amount, "number", "and an amount");
  });

  const dupes = res.json.records.filter((r) => r.counterparty === "Rivera Logistics");
  assert.ok(dupes.length >= 2, "and they are the two Rivera payments");
});

test("[IV2] an unresolvable citation is NAMED, never shown as no evidence",
  { skip: SKIP }, async () => {
    /* THE DISTINCTION THE UI DEPENDS ON. `records: []` with `unresolved: [...]`
       means the evidence exists and could not be retrieved. Rendering that as an
       empty list would tell the user the finding rests on nothing — which about
       a duplicate-payment alert is a false statement about their books. */
    const tenant = await admin(async (c) =>
      (await c.query("SELECT tenant_id FROM financial_transaction LIMIT 1")).rows[0].tenant_id);
    const runId = await admin(async (c) =>
      (await c.query(
        "SELECT id FROM analysis_run WHERE status='completed' LIMIT 1")).rows[0].id);

    await admin(async (c) => {
      const f = (await c.query(
        `INSERT INTO finding (tenant_id, analysis_run_id, finding_key, period, rule_id,
                              rule_version, category, severity, title, authority_scope)
         VALUES ($1,$2,'fnd_iv_broken',$3,'duplicate_payment','1.0.0','duplicate',
                 'high','Broken evidence','engine')
         ON CONFLICT (analysis_run_id, finding_key) DO NOTHING RETURNING id`,
        [tenant, runId, PERIOD])).rows[0];
      if (f) {
        await c.query(
          `INSERT INTO finding_evidence (tenant_id, finding_id, label, source_system, source_record_id)
           VALUES ($1,$2,'Vanished','csv-upload','csv:gone-forever')`, [tenant, f.id]);
      }
    });

    const res = await client.get("/api/findings/fnd_iv_broken/records");
    assert.equal(res.status, 200);
    assert.equal(res.json.complete, false, "reported as INCOMPLETE");
    assert.deepEqual(res.json.unresolved, ["csv:gone-forever"],
      "and the missing citation is named");
    assert.equal(res.json.evidence_count, 1,
      "the finding still knows how much evidence it claimed");
  });

test("[IV2b] a recovered date is the calendar day that was stored",
  { skip: SKIP }, async () => {
    /* `pg` parses a DATE into a JS Date at LOCAL midnight. Reading it back with
       toISOString() re-projects it through UTC and moves it a day earlier
       anywhere east of Greenwich — so in Nairobi a payment stored as the 4th
       was shown as evidence dated the 3rd, contradicting the finding that
       named the 4th. The whole suite ran in UTC and never saw it. */
    const stored = await admin(async (c) =>
      (await c.query(
        `SELECT source_record_id, to_char(txn_date, 'YYYY-MM-DD') AS day
           FROM financial_transaction ORDER BY source_record_id`)).rows);

    const res = await client.get(
      `/api/findings/${encodeURIComponent(duplicateKey)}/records`);

    res.json.records.forEach((r) => {
      const row = stored.find((s) => s.source_record_id === r.sourceRecordId);
      assert.ok(row, `stored row for ${r.sourceRecordId}`);
      assert.equal(r.date, row.day,
        `${r.sourceRecordId}: served ${r.date}, database holds ${row.day}`);
    });

    // And it agrees with the finding's own description of the day.
    const anomalies = await client.get(`/api/anomalies?month=${PERIOD}`);
    const dup = anomalies.json.anomalies.items.find((i) => i.rule_id === "duplicate_payment");
    res.json.records.forEach((r) => {
      assert.ok(dup.description.includes(r.date),
        `the finding says "${dup.description}" but the evidence is dated ${r.date}`);
    });
  });

test("[IV3] a cited record resolves to what it caused", { skip: SKIP }, async () => {
  const records = await client.get(
    `/api/findings/${encodeURIComponent(duplicateKey)}/records`);
  const id = records.json.records[0].sourceRecordId;

  const res = await client.get(`/api/records/${encodeURIComponent(id)}`);
  assert.equal(res.status, 200);
  assert.equal(res.json.record.sourceRecordId, id);
  assert.ok(res.json.finding_count > 0, "and which findings cite it");
});

test("[IV4] a note can be added and is read back from the server",
  { skip: SKIP }, async () => {
    const added = await client.post("/api/findings/comment", {
      fingerprint: duplicateKey, text: "Checked with the bank — one was reversed."
    });
    assert.equal(added.status, 200, JSON.stringify(added.json).slice(0, 200));
    assert.equal(added.json.ok, true);
    assert.ok(added.json.thread.comments.length >= 1);

    // The UI refreshes from the SERVER's thread, not from what was typed.
    const thread = await client.get(
      `/api/findings/thread?fingerprint=${encodeURIComponent(duplicateKey)}`);
    assert.equal(thread.json.ok, true);
    assert.ok(thread.json.thread.comments.some(
      (c) => /reversed/.test(c.text)), "the note persisted");
  });

test("[IV5] a finding can be resolved and reopened", { skip: SKIP }, async () => {
  const resolved = await client.post("/api/findings/resolve",
    { fingerprint: duplicateKey, resolved: true });
  assert.equal(resolved.json.ok, true);
  assert.equal(resolved.json.thread.resolved, true);
  assert.ok(resolved.json.thread.resolved_at, "with a timestamp");

  const reopened = await client.post("/api/findings/resolve",
    { fingerprint: duplicateKey, resolved: false });
  assert.equal(reopened.json.thread.resolved, false,
    "resolving is reversible — a wrong call is not permanent");
});

test("[IV6] investigation stays inside the tenant boundary", { skip: SKIP }, async () => {
  const stranger = server.client();
  await stranger.get("/api/health/live");

  const records = await stranger.get(
    `/api/findings/${encodeURIComponent(duplicateKey)}/records`);
  assert.notEqual(records.status, 200,
    "another tenant cannot read the evidence behind this finding");
  assert.equal(records.json.records, undefined, "and no records leak in the body");

  /* 404 SPECIFICALLY, not 403. A finding belonging to another tenant answers
     exactly as one that never existed, so this cannot be used to discover
     which finding ids are real. */
  if (records.status !== 503) assert.equal(records.status, 404);

  const byRecord = await stranger.get("/api/records/csv:anything");
  assert.notEqual(byRecord.status, 200);
});

// ══════════════════════════════════════════════════════════════════
// PART B — renewal reminders
// ══════════════════════════════════════════════════════════════════

const reminders = require("../../src/services/renewalReminders");

test("[RR1] the milestone is chosen from the authoritative expiry", { skip: SKIP }, () => {
  const at = (days) => new Date(Date.now() + days * 86400000).toISOString();
  assert.equal(reminders.milestoneFor(at(8)), null, "outside the window: nothing");
  assert.equal(reminders.milestoneFor(at(7)), 7);
  assert.equal(reminders.milestoneFor(at(6.5)), 7, "first seen at 6.5 days gets the 7-day notice");
  assert.equal(reminders.milestoneFor(at(3)), 3);
  assert.equal(reminders.milestoneFor(at(1)), 1);
  assert.equal(reminders.milestoneFor(at(-1)), 0, "already lapsed is the expiry notice");
  assert.equal(reminders.milestoneFor(null), null, "no expiry, no reminder");
});

test("[RR2] a reminder is claimed exactly once, even concurrently",
  { skip: SKIP }, async () => {
    /* Idempotency is decided by the UNIQUE index, before any mail is sent, so
       two instances racing produce one send and one conflict. */
    const tenant = await admin(async (c) =>
      (await c.query("SELECT tenant_id FROM financial_transaction LIMIT 1")).rows[0].tenant_id);
    const subId = await admin(async (c) =>
      (await c.query(
        `INSERT INTO subscription (tenant_id, plan, status, activated_at, expires_at,
                                   amount, currency)
         VALUES ($1,'growth','active', now(), now() + interval '3 days', 2500,'KES')
         RETURNING id`, [tenant])).rows[0].id);

    const claims = await Promise.all(
      Array.from({ length: 6 }, () => reminders.claim(tenant, subId, 3)));
    const won = claims.filter(Boolean);
    assert.equal(won.length, 1,
      `exactly one claim succeeded, got ${won.length}`);

    const rows = await admin(async (c) =>
      (await c.query(
        "SELECT count(*)::int n FROM renewal_reminder WHERE subscription_id = $1",
        [subId])).rows[0].n);
    assert.equal(rows, 1, "and one row exists");

    // A RESTART changes nothing: the claim is in PostgreSQL.
    const afterRestart = await reminders.claim(tenant, subId, 3);
    assert.equal(afterRestart, null,
      "re-running after a restart does not re-send");
  });

test("[RR3] a mail failure never changes subscription state", { skip: SKIP }, async () => {
  const tenant = await admin(async (c) =>
    (await c.query("SELECT tenant_id FROM financial_transaction LIMIT 1")).rows[0].tenant_id);
  const sub = await admin(async (c) =>
    (await c.query(
      `SELECT id, status, plan, expires_at FROM subscription
        WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`, [tenant])).rows[0]);

  await reminders.recordOutcome(tenant, (await reminders.claim(tenant, sub.id, 1)).id,
    { delivered: false, failureReason: "smtp unreachable" });

  const after = await admin(async (c) =>
    (await c.query("SELECT status, plan, expires_at FROM subscription WHERE id = $1",
      [sub.id])).rows[0]);
  assert.equal(after.status, sub.status, "status untouched");
  assert.equal(after.plan, sub.plan, "plan untouched");
  assert.equal(String(after.expires_at), String(sub.expires_at), "expiry untouched");

  // The failure is RETAINED — support needs to know we tried.
  const rec = await admin(async (c) =>
    (await c.query(
      `SELECT delivered, failure_reason FROM renewal_reminder
        WHERE subscription_id = $1 AND milestone = 1`, [sub.id])).rows[0]);
  assert.equal(rec.delivered, false);
  assert.match(rec.failure_reason, /smtp/);
});

test("[RR4] Starter users are never reminded", { skip: SKIP }, async () => {
  /* Telling a free user their plan is expiring would simply be false — Starter
     has no expiry and nothing to renew. The sweep selects only active PAID
     subscriptions, so a tenant without one is never considered. */
  const freeTenant = await admin(async (c) =>
    (await c.query(
      "INSERT INTO tenant (name) VALUES ('Free Co') RETURNING id")).rows[0].id);

  const due = await admin(async (c) =>
    (await c.query(
      `SELECT count(*)::int n FROM subscription
        WHERE tenant_id = $1 AND status = 'active'`, [freeTenant])).rows[0].n);
  assert.equal(due, 0, "a free tenant has no subscription to remind about");

  const sent = await admin(async (c) =>
    (await c.query(
      "SELECT count(*)::int n FROM renewal_reminder WHERE tenant_id = $1",
      [freeTenant])).rows[0].n);
  assert.equal(sent, 0, "and no reminder was ever recorded for them");
});

test("[RR5] nothing is claimed when mail is not configured", { skip: SKIP }, async () => {
  /* Claiming first would burn the milestone and the customer would never be
     told. With no mailer the run is a no-op. */
  const before = await admin(async (c) =>
    (await c.query("SELECT count(*)::int n FROM renewal_reminder")).rows[0].n);

  const KEYS = ["SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD"];
  const saved = KEYS.map((k) => [k, process.env[k]]);
  KEYS.forEach((k) => { delete process.env[k]; });
  const mailer = require("../../src/services/mailer");
  mailer.reset();
  try {
    const result = await reminders.run({ now: Date.now() });
    assert.equal(result.reason, "mail_not_configured");
    assert.equal(result.sent, 0);

    // AND NOTHING WAS CLAIMED — the milestones are still available to send.
    const claimed = await admin(async (c) =>
      (await c.query("SELECT count(*)::int n FROM renewal_reminder")).rows[0].n);
    assert.equal(claimed, before,
      "an unconfigured mailer does not burn a milestone");
  } finally {
    saved.forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; });
    mailer.reset();
  }
});

test("[RR6] the message says plainly that no data was deleted", { skip: SKIP }, () => {
  /* The first thing a user fears on reading "expired" is that their books are
     gone. One explicit sentence prevents that, and it is true. */
  const expiry = new Date(Date.now() - 86400000).toISOString();
  const expired = reminders.messageFor(0, "Growth", expiry);
  assert.match(expired.subject, /expired/i);
  assert.match(expired.text, /nothing\s*\n?\s*has been deleted|still there/i);
  assert.match(expired.text, /Starter/, "and says what plan they are on now");

  const soon = reminders.messageFor(3, "Growth", new Date(Date.now() + 3 * 86400000).toISOString());
  assert.match(soon.subject, /in 3 days/);
  assert.match(soon.text, /stay exactly where they are/i,
    "the pre-expiry notice reassures too — it is a renewal prompt, not a threat");

  const tomorrow = reminders.messageFor(1, "Growth", new Date(Date.now() + 86400000).toISOString());
  assert.match(tomorrow.subject, /tomorrow/, "1 day reads as 'tomorrow', not 'in 1 days'");
});

test("[RR7] no credential material appears in a reminder", { skip: SKIP }, () => {
  const msg = reminders.messageFor(7, "Growth", new Date().toISOString());
  const body = msg.subject + msg.text;
  assert.equal(/password|secret|sk_|api[_-]?key/i.test(body), false,
    "the message carries nothing sensitive");
});
