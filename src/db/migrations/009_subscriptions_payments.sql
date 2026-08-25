-- JOB P6 — SUBSCRIPTIONS AND PAYMENTS.
--
-- THE DEFECT THIS CLOSES. A plan lived in one place: `plan` inside
-- `profile.json`, a file on the application instance's local disk. Three
-- consequences, all of them fatal to charging money:
--
--   IT VANISHES. A redeploy onto fresh storage silently downgrades every paying
--   customer to Starter, and two instances behind a load balancer disagree
--   about who has paid.
--
--   IT IS SELF-GRANTABLE. `POST /api/plan` wrote that field directly. Outside
--   production any visitor could award themselves the top tier and immediately
--   use every paid feature — verified during the audit.
--
--   THERE IS NO PAYMENT ANYWHERE. No table, no provider, no price, no record.
--   The "Upgrade" button called the same self-grant endpoint, which is refused
--   in production — so production had no route to becoming a customer at all.
--
-- WHAT THIS ADDS. A subscription is now tenant-scoped state in PostgreSQL with
-- a lifecycle, and every activation is anchored to an independently verified
-- payment. Both tables are under RLS with the rest of the tenant data.

-- ── SUBSCRIPTION ─────────────────────────────────────────────────
-- One CURRENT subscription per tenant, plus its history. A plan change writes a
-- new row and supersedes the old one rather than mutating it: what a tenant was
-- entitled to last month is an auditable fact, not something to overwrite.
CREATE TABLE IF NOT EXISTS subscription (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,

  plan         text NOT NULL,
  /* THE LIFECYCLE. `pending_payment` exists so a checkout in flight is visible
     without granting anything; entitlement resolution counts ONLY `active`. */
  status       text NOT NULL CHECK (status IN
                 ('pending_payment','active','past_due','cancelled','expired')),

  -- Null for a subscription that never activated (abandoned checkout).
  activated_at timestamptz,
  /* When entitlement lapses. NULL means it does not expire — used by the free
     tier, never by a paid one. A paid row without an expiry would be a
     perpetual grant from a single payment. */
  expires_at   timestamptz,
  cancelled_at timestamptz,

  -- What was actually charged, captured at purchase so a later price change
  -- never rewrites history.
  amount       numeric(12,2),
  currency     char(3),

  -- The payment that bought this. Immutable once set.
  payment_id   uuid,

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

/* AT MOST ONE ACTIVE SUBSCRIPTION PER TENANT, enforced by the database.
   Two concurrent activations would otherwise both succeed and the tenant's
   effective plan would depend on row order. */
CREATE UNIQUE INDEX IF NOT EXISTS subscription_one_active_per_tenant
  ON subscription (tenant_id) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS subscription_tenant_idx
  ON subscription (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS subscription_expiry_idx
  ON subscription (expires_at) WHERE status = 'active';

-- ── PAYMENT ──────────────────────────────────────────────────────
-- One row per checkout attempt. Rows are NEVER deleted, including failures:
-- a failed or abandoned payment is exactly what an investigation needs.
CREATE TABLE IF NOT EXISTS payment (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,

  provider       text NOT NULL,          -- 'mpesa', 'test', ...
  /* The provider's own identifier for this attempt (M-Pesa
     CheckoutRequestID). UNIQUE PER PROVIDER, which is what makes a duplicated
     webhook a no-op instead of a second activation. */
  provider_ref   text,

  plan           text NOT NULL,
  /* SERVER-DETERMINED. Written from the plan catalog at checkout creation and
     never from the request body, so a client cannot choose its own price. */
  amount         numeric(12,2) NOT NULL CHECK (amount >= 0),
  currency       char(3) NOT NULL,

  status         text NOT NULL CHECK (status IN
                   ('pending','successful','failed','expired','cancelled')),

  -- Where the customer was asked to pay from. Stored for reconciliation and
  -- support; it is not an authentication factor.
  payer_reference text,

  -- The provider's verbatim confirmation, kept for audit. Never trusted on its
  -- own: activation requires our own correlation to a pending row.
  provider_result jsonb,
  failure_reason  text,

  /* A checkout is only valid for a short window. A callback arriving after it
     must not activate anything — the user has long since moved on, and a stale
     activation is indistinguishable from a replay. */
  expires_at     timestamptz NOT NULL,
  completed_at   timestamptz,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

/* IDEMPOTENCY, AT THE DATABASE. Two callbacks carrying the same provider
   reference cannot become two payments, whatever the application does. */
CREATE UNIQUE INDEX IF NOT EXISTS payment_provider_ref_key
  ON payment (provider, provider_ref) WHERE provider_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS payment_tenant_idx ON payment (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payment_pending_idx
  ON payment (status, expires_at) WHERE status = 'pending';

ALTER TABLE subscription ADD CONSTRAINT subscription_payment_fk
  FOREIGN KEY (payment_id) REFERENCES payment(id) ON DELETE SET NULL;

-- ── ROW-LEVEL SECURITY ───────────────────────────────────────────
-- Billing rows are tenant data and are confined exactly like the rest. FORCE so
-- the table owner is bound by it too.
ALTER TABLE subscription ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS subscription_tenant_isolation ON subscription;
CREATE POLICY subscription_tenant_isolation ON subscription
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE payment ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_tenant_isolation ON payment;
CREATE POLICY payment_tenant_isolation ON payment
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

/* A WEBHOOK ARRIVES WITH NO SESSION, so it cannot set app.tenant_id before it
   has found the payment — and RLS would hide the very row it needs to find.
   This function resolves a provider reference to its tenant, and nothing else:
   it returns an id, never payment data, so it cannot be used to read across
   tenants. SECURITY DEFINER because it must see past RLS to do that one job. */
CREATE OR REPLACE FUNCTION payment_tenant_for_ref(p_provider text, p_ref text)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tenant_id FROM payment
   WHERE provider = p_provider AND provider_ref = p_ref
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION payment_tenant_for_ref(text, text) FROM PUBLIC;
