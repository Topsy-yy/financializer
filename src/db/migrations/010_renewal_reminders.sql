-- JOB — RENEWAL REMINDERS.
--
-- A paid period genuinely ends: M-Pesa has no merchant-initiated auto-debit, so
-- the customer has to be told before their access lapses. The in-app banner
-- already does that for someone who logs in; this covers the person who does
-- not, which is exactly the person about to lose access without noticing.
--
-- WHY A TABLE RATHER THAN IN-MEMORY STATE. "Have we already emailed this
-- customer about this deadline?" must survive a restart, and must be true across
-- however many instances are running. Held in memory, a redeploy re-sends every
-- reminder — and a billing email arriving twice reads as a billing error.
--
-- The UNIQUE constraint is the mechanism, not the convention: two instances
-- racing on the same subscription both try to insert, one wins, the loser's
-- conflict is the signal not to send. Idempotency is decided by the database,
-- before the mail is dispatched.

CREATE TABLE IF NOT EXISTS renewal_reminder (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL REFERENCES subscription(id) ON DELETE CASCADE,

  /* Which deadline this reminder is for: 7, 3, 1 or 0 days before expiry.
     Part of the uniqueness key, so a customer gets each milestone once and
     only once for a given subscription. */
  milestone       integer NOT NULL CHECK (milestone IN (7, 3, 1, 0)),

  -- Recorded BEFORE the send is attempted; see below.
  sent_at         timestamptz NOT NULL DEFAULT now(),
  -- Whether the mail actually went out. A failure is retained, not deleted:
  -- support needs to know we tried and could not reach them.
  delivered       boolean NOT NULL DEFAULT false,
  failure_reason  text,

  created_at      timestamptz NOT NULL DEFAULT now()
);

/* ONE REMINDER PER SUBSCRIPTION PER MILESTONE.
   Claimed by INSERT before the email is sent, so a crash between the claim and
   the send costs at most one missed reminder — never a duplicate. Losing a
   reminder is a smaller harm than sending a customer three copies of the same
   billing warning. */
CREATE UNIQUE INDEX IF NOT EXISTS renewal_reminder_once
  ON renewal_reminder (subscription_id, milestone);

CREATE INDEX IF NOT EXISTS renewal_reminder_tenant_idx
  ON renewal_reminder (tenant_id, created_at DESC);

-- Tenant data, confined like the rest.
ALTER TABLE renewal_reminder ENABLE ROW LEVEL SECURITY;
ALTER TABLE renewal_reminder FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS renewal_reminder_tenant_isolation ON renewal_reminder;
CREATE POLICY renewal_reminder_tenant_isolation ON renewal_reminder
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
