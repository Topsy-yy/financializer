// Subscription entitlements + AI credits + plan-based AI provider routing.
//
// Product model:
//  - The deterministic analysis engine is ALWAYS free (never costs credits).
//  - Only AI "intelligence" actions consume credits (chat, review, report, forecast).
//  - Routing precedence:
//      * user brought their own API key  -> "Custom AI" (their key, UNMETERED)
//      * plan = pro                       -> app-managed Mistral, metered by credits
//      * plan = free                      -> app-managed NVIDIA, metered by credits

const PLANS = {
  free:   { label: "Starter",      allowance: 100,  managedProvider: "nvidia" },
  pro:    { label: "Professional", allowance: 2000, managedProvider: "mistral" },
  custom: { label: "Custom AI",    allowance: 0,    managedProvider: null }
};

// Credits per AI action (deterministic analysis is free and not listed here).
const CREDIT_COSTS = {
  explain: 1,
  chat: 2,
  "action-plan": 10,
  "monthly-review": 15,
  "executive-report": 20,
  forecast: 25
};

function currentPeriod() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

function planKey(profile) {
  const p = String((profile && profile.plan) || "free").toLowerCase();
  return PLANS[p] ? p : "free";
}

// A user who pasted their own key is on "Custom AI": their key, no metering.
function isByok(profile) {
  return Boolean(profile && profile.aiApiKey);
}

// Refill credits at the start of each calendar month (no cron needed —
// lazily reconciled whenever the profile is touched). Returns true if changed.
function ensurePeriod(profile) {
  if (!profile) return false;
  const period = currentPeriod();
  const allowance = PLANS[planKey(profile)].allowance;
  if (profile.creditsPeriod !== period || typeof profile.credits !== "number") {
    profile.creditsPeriod = period;
    profile.credits = allowance;
    return true;
  }
  return false;
}

function creditCost(action) {
  return CREDIT_COSTS[action] || 1;
}

function canAfford(profile, action) {
  if (isByok(profile)) return true;
  ensurePeriod(profile);
  return (profile.credits || 0) >= creditCost(action);
}

// Decrement credits for a managed AI action. BYOK is never charged.
// Call this ONLY after the AI request actually succeeded.
function charge(profile, action) {
  if (isByok(profile)) return { ok: true, byok: true, remaining: null, cost: 0 };
  ensurePeriod(profile);
  const cost = creditCost(action);
  if ((profile.credits || 0) < cost) {
    return { ok: false, reason: "insufficient_credits", remaining: profile.credits || 0, cost };
  }
  profile.credits -= cost;
  return { ok: true, remaining: profile.credits, cost };
}

// Which provider + key should an AI call use for this user?
function resolveAiRouting(profile, config) {
  if (isByok(profile)) {
    return { mode: "byok", plan: "custom", provider: profile.aiProvider || "openai", apiKey: profile.aiApiKey, managed: false };
  }
  const key = planKey(profile);
  if (key === "pro") {
    return { mode: "managed", plan: "pro", provider: "mistral", apiKey: (config && config.mistralAppKey) || "", managed: true };
  }
  return { mode: "managed", plan: "free", provider: "nvidia", apiKey: (config && config.nvidiaApiKey) || "", managed: true };
}

function getEntitlement(profile) {
  ensurePeriod(profile);
  const key = planKey(profile);
  const byok = isByok(profile);
  return {
    plan: byok ? "custom" : key,
    plan_label: byok ? PLANS.custom.label : PLANS[key].label,
    byok,
    credits: byok ? null : profile.credits,
    allowance: byok ? null : PLANS[key].allowance,
    period: profile.creditsPeriod,
    credit_costs: CREDIT_COSTS
  };
}

function setPlan(profile, plan) {
  const p = String(plan || "").toLowerCase();
  if (!PLANS[p]) return false;
  profile.plan = p;
  // Reset the period so the new plan's allowance is granted immediately.
  profile.creditsPeriod = null;
  ensurePeriod(profile);
  return true;
}

module.exports = {
  PLANS,
  CREDIT_COSTS,
  currentPeriod,
  ensurePeriod,
  isByok,
  creditCost,
  canAfford,
  charge,
  resolveAiRouting,
  getEntitlement,
  setPlan
};
