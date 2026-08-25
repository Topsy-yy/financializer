// THE ENTITLEMENT RESOLVER — where a tenant's plan actually comes from.
//
// THE DEFECT THIS CLOSES. `entitlements.planKey()` read `profile.plan`, a field
// in a JSON file on the instance's local disk. That made the plan:
//
//   SELF-GRANTABLE   `POST /api/plan` wrote it directly. Verified in the audit:
//                    a visitor awarded themselves the top tier and immediately
//                    used a paid feature.
//   PERISHABLE       a redeploy onto fresh storage downgraded every paying
//                    customer, and two instances disagreed about who had paid.
//
// THE PLAN IS NOW A DERIVED FACT: it comes from an `active`, unexpired
// subscription row in PostgreSQL, and from nowhere else. No subscription means
// Starter — the free tier is the floor, never a grant.
//
// WHY THE PROFILE IS STILL WRITTEN. Nine capability gates already call
// `entitlements.can(profile, …)` and are covered by tests. Rather than rewrite
// every call site — and risk missing one, which is a paid feature given away —
// the resolver SYNCHRONISES `profile.plan` from the subscription on each
// request. The profile becomes a per-request cache of an authoritative value
// instead of the value itself. `can()` keeps working; what it reads is now true.

const billingRepository = require("../db/repositories/billingRepository");
const entitlements = require("./entitlements");
const dbPool = require("../db/pool");
const { logger } = require("./logger");

const log = logger.child({ component: "subscription" });

/** How many days ahead of expiry the user starts being reminded. */
const REMINDER_DAYS = 7;

/** Days remaining, rounded up: 0.2 days left is still "1 day", never "0". */
function daysUntil(when) {
  if (!when) return null;
  const ms = new Date(when).getTime() - Date.now();
  return Math.ceil(ms / 86400000);
}

/**
 * Where this tenant is in its billing period.
 *
 * M-Pesa has no merchant-initiated auto-debit, so a paid period genuinely ends
 * and the customer genuinely has to renew. Saying "expiring" a week ahead is
 * the honest minimum; calling it a subscription that renews itself would not be.
 *
 *   none | active | expiring_soon | expired
 */
function renewalState(sub) {
  if (!sub) return { state: "none", days_remaining: null, expires_at: null };

  const days = daysUntil(sub.expires_at);
  if (sub.lapsed || sub.status === "expired" || sub.status === "cancelled"
      || sub.status !== "active" || (days != null && days <= 0)) {
    return {
      state: "expired",
      days_remaining: 0,
      expires_at: sub.expires_at || null,
      plan: sub.plan,
      /* Said explicitly because it is the first thing a user fears. Expiry
         locks paid FEATURES; it never touches financial data. */
      data_retained: true
    };
  }
  return {
    state: days != null && days <= REMINDER_DAYS ? "expiring_soon" : "active",
    days_remaining: days,
    expires_at: sub.expires_at || null,
    plan: sub.plan
  };
}

/** The floor. Every tenant has at least this, and it is never sold. */
const DEFAULT_PLAN = "starter";

/**
 * The plan this tenant is actually entitled to, right now.
 *
 * @returns {object} { plan, source, subscription, expiresAt }
 *   source: "subscription" | "default" | "unavailable"
 */
async function resolvePlan(tenantId) {
  if (!tenantId || !dbPool.isConfigured()) {
    /* No tenant or no database: the free tier. Deliberately NOT the profile's
       stored value — falling back to it would restore the self-grant hole
       exactly when the authoritative check is unavailable. */
    return { plan: DEFAULT_PLAN, source: "default", subscription: null };
  }

  try {
    const sub = await billingRepository.currentSubscription(tenantId);

    if (!sub || sub.lapsed || sub.status !== "active") {
      /* An expired subscription is a downgrade, immediately. The lapse is also
         recorded so the row stops being reported as active, but entitlement
         does not wait for that write to succeed. */
      if (sub && sub.lapsed) {
        billingRepository.expireLapsed(tenantId).catch((err) =>
          log.warn("subscription.expire_write_failed", { error: err.message }));
        log.info("subscription.lapsed", { plan: sub.plan });
      }
      return { plan: DEFAULT_PLAN, source: "default", subscription: sub || null };
    }

    // A plan that has since been removed from the catalog falls back rather
    // than throwing — the tenant keeps working, at the floor.
    const plan = entitlements.PLANS[sub.plan] ? sub.plan : DEFAULT_PLAN;
    return {
      plan,
      source: "subscription",
      subscription: sub,
      expiresAt: sub.expires_at || null
    };
  } catch (err) {
    /* FAIL CLOSED, to the FREE tier. If entitlement cannot be confirmed we
       grant the minimum, never the maximum — the opposite choice would turn a
       database blip into a free upgrade for everyone. */
    log.error("subscription.resolve_failed", { error: err.message });
    return { plan: DEFAULT_PLAN, source: "unavailable", subscription: null };
  }
}

/**
 * Bring a user store's profile in line with the authoritative subscription.
 *
 * Called per request by the entitlement middleware. Returns the resolution so a
 * caller can report the plan's provenance.
 */
async function syncProfilePlan(store) {
  const resolved = await resolvePlan(store && store.tenantId);
  if (store && store.profile) {
    const current = String(store.profile.plan || "").toLowerCase();
    if (current !== resolved.plan) {
      /* setPlan resets the credit period so the new allowance applies at once —
         which is what an upgrade must do, and what a downgrade must also do. */
      entitlements.setPlan(store.profile, resolved.plan);
      log.info("subscription.plan_synced", {
        from: current || null, to: resolved.plan, source: resolved.source
      });
    }
    store.planSource = resolved.source;
    store.subscription = resolved.subscription;
  }
  return resolved;
}

/**
 * The capability metadata the frontend renders from.
 *
 * ONE authority: the same catalog the backend enforces with. The client uses
 * this to decide what to show as locked; it never decides what is ALLOWED,
 * which is checked independently on every gated route.
 */
async function accountEntitlements(store) {
  const resolved = await resolvePlan(store && store.tenantId);
  const profile = (store && store.profile) || {};
  const ent = entitlements.getEntitlement(profile);

  /* RENEWAL REPORTING USES THE LATEST SUBSCRIPTION OF ANY STATUS.
     `resolved.subscription` is the ACTIVE one, and is correctly null once a
     lapse has been recorded — which meant the expired banner appeared for
     exactly one request and then vanished, leaving the user with silently
     missing features and no way to understand why. */
  let sub = resolved.subscription;
  if (!sub && store && store.tenantId && dbPool.isConfigured()) {
    try {
      sub = await billingRepository.latestSubscription(store.tenantId);
    } catch (err) {
      log.warn("subscription.latest_lookup_failed", { error: err.message });
    }
  }

  return {
    plan: resolved.plan,
    plan_label: entitlements.planLabel(resolved.plan),
    // Where the plan came from, so the UI can distinguish a paid subscription
    // from the free floor without guessing.
    source: resolved.source,
    status: sub && !sub.lapsed ? sub.status : (sub ? "expired" : "none"),
    activated_at: sub ? sub.activated_at : null,
    expires_at: sub && !sub.lapsed ? sub.expires_at : null,

    /* RENEWAL STATE, computed server-side from the authoritative expiry.
       The client renders a reminder from this rather than doing its own date
       arithmetic on a value it was told — which would drift, and would be
       trivially editable. */
    renewal: renewalState(sub),

    credits: ent.credits,
    allowance: ent.allowance,
    credit_costs: ent.credit_costs,
    byok: ent.byok,

    // The complete locked/unlocked map, from the catalog.
    features: entitlements.featureMap(profile),
    // Plans that can actually be bought, with SERVER-side prices.
    upgrade_options: entitlements.sellablePlans()
      .filter((p) => p.key !== resolved.plan)
  };
}

module.exports = {
  resolvePlan, syncProfilePlan, accountEntitlements, DEFAULT_PLAN,
  renewalState, REMINDER_DAYS
};
