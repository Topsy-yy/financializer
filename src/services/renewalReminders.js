// RENEWAL REMINDERS.
//
// A paid period ends and the customer has to renew by hand — M-Pesa has no
// merchant-initiated auto-debit. The in-app banner covers anyone who logs in;
// this covers the person who does not, who is precisely the person about to
// lose access without noticing.
//
// THE GUARANTEES, and how each is obtained:
//
//   IDEMPOTENT        a UNIQUE (subscription_id, milestone) index. The row is
//                     claimed by INSERT before the mail is sent, so two
//                     instances racing produce one send and one conflict.
//   RESTART-SAFE      that claim is in PostgreSQL, not in memory. A redeploy
//                     re-reads it instead of re-sending everything.
//   NON-DESTRUCTIVE   a mail failure is recorded on the reminder row and
//                     changes NOTHING about the subscription. Billing state is
//                     never a function of whether an email was delivered.
//   AUTHORITATIVE     deadlines come from `subscription.expires_at`, never from
//                     a client or a cached copy.
//   PAID ONLY         a tenant with no active paid subscription is never
//                     reminded. Starter has nothing to renew, and telling a
//                     free user their plan is expiring is simply false.
//   NO SECRETS        the mailer redacts SMTP credentials; nothing here logs a
//                     recipient address or a message body.

const { withTenant, withAdmin } = require("../db/pool");
const mailer = require("./mailer");
const entitlements = require("./entitlements");
const { logger } = require("./logger");

const log = logger.child({ component: "renewal-reminders" });

/** Days before expiry at which a reminder is due. 0 means expiry itself. */
const MILESTONES = [7, 3, 1, 0];

/**
 * Which milestone a subscription is currently at, or null.
 *
 * Picks the SMALLEST milestone already reached, so a subscription first seen
 * two days out gets the "3 day" notice rather than silently skipping to "1".
 * Anything already expired maps to 0.
 */
function milestoneFor(expiresAt, now = Date.now()) {
  if (!expiresAt) return null;
  const days = Math.ceil((new Date(expiresAt).getTime() - now) / 86400000);
  if (days <= 0) return 0;
  const reached = MILESTONES.filter((m) => m > 0 && days <= m);
  return reached.length ? Math.min(...reached) : null;
}

/** The message for each milestone. Plain, specific, and never alarming. */
function messageFor(milestone, planLabel, expiresAt) {
  const when = new Date(expiresAt).toISOString().slice(0, 10);
  if (milestone === 0) {
    return {
      subject: `Your FinGuard ${planLabel} plan has expired`,
      /* THE FIRST THING A USER FEARS is that their books are gone. One
         explicit sentence prevents that, and it is true. */
      text: [
        `Your ${planLabel} plan expired on ${when}.`,
        "",
        "Your financial data and every past analysis are still there — nothing",
        "has been deleted. You are back on the free Starter plan, so forecasting,",
        "what-if scenarios and the advanced AI features are locked until you renew.",
        "",
        "Renew from Settings → Plan & Credits."
      ].join("\n")
    };
  }
  const noun = milestone === 1 ? "tomorrow" : `in ${milestone} days`;
  return {
    subject: `Your FinGuard ${planLabel} plan expires ${noun}`,
    text: [
      `Your ${planLabel} plan expires ${noun}, on ${when}.`,
      "",
      "Renew to keep forecasting, what-if scenarios, custom rules and your",
      `${planLabel} AI credit allowance.`,
      "",
      "Renew from Settings → Plan & Credits.",
      "",
      "If you do nothing you move to the free Starter plan. Your financial data",
      "and past analyses stay exactly where they are."
    ].join("\n")
  };
}

/**
 * Claim a reminder before sending it.
 *
 * The INSERT is the lock. A conflict means someone else already claimed this
 * milestone — another instance, or this one before a restart — so the caller
 * must not send.
 *
 * @returns {object|null} the claimed row, or null if already claimed.
 */
async function claim(tenantId, subscriptionId, milestone) {
  return withTenant(tenantId, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO renewal_reminder (tenant_id, subscription_id, milestone)
       VALUES ($1, $2, $3)
       ON CONFLICT (subscription_id, milestone) DO NOTHING
       RETURNING id`,
      [tenantId, subscriptionId, milestone]
    );
    return rows[0] || null;
  });
}

/** Record the outcome. A failure is kept, never deleted. */
async function recordOutcome(tenantId, reminderId, { delivered, failureReason = null }) {
  return withTenant(tenantId, async (c) => {
    await c.query(
      `UPDATE renewal_reminder
          SET delivered = $2, failure_reason = $3
        WHERE id = $1`,
      [reminderId, delivered, failureReason ? String(failureReason).slice(0, 300) : null]
    );
  });
}

/**
 * Subscriptions that may need a reminder.
 *
 * Runs with admin scope because it sweeps every tenant; each tenant's own rows
 * are then written under `withTenant`, so RLS still governs the writes.
 * Deliberately only `active` PAID subscriptions — Starter has no expiry and
 * nothing to renew.
 */
async function dueSubscriptions({ now = new Date() } = {}) {
  return withAdmin(async (c) => {
    const { rows } = await c.query(
      `SELECT s.id, s.tenant_id, s.plan, s.expires_at
         FROM subscription s
        WHERE s.status = 'active'
          AND s.expires_at IS NOT NULL
          -- Inside the widest reminder window, or already lapsed but recent
          -- enough that an expiry notice is still worth sending.
          AND s.expires_at <= $1::timestamptz + interval '7 days'
          AND s.expires_at >= $1::timestamptz - interval '3 days'`,
      [now.toISOString()]
    );
    return rows;
  });
}

/**
 * Who to bill-notify for a tenant: the founder.
 *
 * A tenant can have several members, but only one of them owns the
 * subscription, and mailing an auditor about someone else's renewal would
 * disclose billing state to a role that has no claim on it. Falls back to any
 * active member ONLY if no founder is on record — an unreachable tenant is
 * recorded as `no_recipient_on_file` rather than guessed at.
 */
async function defaultLookupEmail(tenantId) {
  return withAdmin(async (c) => {
    const { rows } = await c.query(
      `SELECT u.email
         FROM membership m JOIN app_user u ON u.id = m.user_id
        WHERE m.tenant_id = $1 AND m.status = 'active' AND u.email IS NOT NULL
        ORDER BY (m.role = 'founder') DESC, m.created_at ASC
        LIMIT 1`,
      [tenantId]
    );
    return rows.length ? rows[0].email : null;
  });
}

/**
 * Send whatever reminders are due, once each.
 *
 * @returns {object} counts, for a scheduler log or a test.
 */
async function run({ now = Date.now(), lookupEmail = defaultLookupEmail } = {}) {
  if (!mailer.isConfigured()) {
    /* Nothing is claimed when mail cannot be sent. Claiming first would burn
       the milestone and the customer would never be told. */
    log.info("renewal.skipped_mail_unconfigured");
    return { considered: 0, sent: 0, skipped: 0, failed: 0, reason: "mail_not_configured" };
  }

  const due = await dueSubscriptions({ now: new Date(now) });
  let sent = 0, skipped = 0, failed = 0;

  for (const sub of due) {
    const milestone = milestoneFor(sub.expires_at, now);
    if (milestone === null) { skipped += 1; continue; }

    const claimed = await claim(sub.tenant_id, sub.id, milestone);
    if (!claimed) {
      // Already sent — by this process before a restart, or another instance.
      skipped += 1;
      continue;
    }

    const email = lookupEmail ? await lookupEmail(sub.tenant_id) : null;
    if (!email) {
      await recordOutcome(sub.tenant_id, claimed.id, {
        delivered: false, failureReason: "no_recipient_on_file"
      });
      failed += 1;
      continue;
    }

    const planLabel = entitlements.planLabel(sub.plan);
    const message = messageFor(milestone, planLabel, sub.expires_at);
    const result = await mailer.sendReport({
      to: [email], subject: message.subject, text: message.text
    });

    await recordOutcome(sub.tenant_id, claimed.id, {
      delivered: Boolean(result.ok),
      failureReason: result.ok ? null : result.detail
    });

    if (result.ok) sent += 1; else failed += 1;

    /* THE SUBSCRIPTION IS NOT TOUCHED, on success or failure. Entitlement is a
       function of payment and time, never of whether an email was delivered. */
    log.info("renewal.reminder", {
      milestone, plan: sub.plan, delivered: Boolean(result.ok)
    });
  }

  return { considered: due.length, sent, skipped, failed };
}

module.exports = {
  run, milestoneFor, messageFor, claim, recordOutcome, dueSubscriptions,
  defaultLookupEmail, MILESTONES
};
