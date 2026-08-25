// Subscription entitlements + AI credits + plan-based AI provider routing.
//
// ARCHITECTURE
//   This module is the SINGLE SOURCE OF TRUTH for every feature restriction in
//   the application. Nothing else -- no route, no UI component -- may decide
//   access by testing a plan name. The contract is:
//
//       plan  ->  capabilities  ->  behaviour (backend gates + UI state)
//
//   Callers ask `can(profile, "what_if_simulator")`, never `plan === "growth"`.
//   Adding a plan therefore cannot silently change behaviour anywhere else, and
//   the docs can be generated from the same table the code enforces.
//
// PRODUCT MODEL — "Monetize the intelligence, not the detection."
//   - Deterministic analysis, dashboards, reports (incl. PDF), forecast maths,
//     and the entire Avalanche/on-chain suite are available on EVERY plan.
//   - Paid plans unlock strategic AI guidance, automation, collaboration and
//     decision support.
//   - AI provider routing: own key -> Custom AI (unmetered); Growth -> managed
//     Mistral; Starter -> managed NVIDIA. Both managed tiers are credit-metered.

/**
 * THE AUTHORITATIVE PLAN CATALOG.
 *
 * One definition drives entitlements, backend enforcement, the capability API,
 * the frontend's locked/unlocked rendering AND checkout pricing. Nothing may
 * define a plan, a price or a capability anywhere else — a second definition is
 * a second source of truth, and billing is the last place that can survive one.
 *
 * PRICE IS SERVER-SIDE AND ONLY SERVER-SIDE. The client selects a plan KEY; the
 * amount, currency and period are read from here. A client that sends an amount
 * is ignored.
 *
 * `sellable` IS A HONESTY GATE. A plan is offered for money only when it adds
 * capabilities that are actually BUILT. See the audit note on `workspace`.
 */
const PLANS = {
  starter: {
    label: "Starter",
    allowance: 100,
    managedProvider: "nvidia",
    // Free forever. Deliberately a complete deterministic controller: the
    // product's value has to be experienced before there is a reason to pay.
    priceKes: 0,
    periodDays: null,
    sellable: false,          // nothing to buy
    isDefault: true
  },
  growth: {
    label: "Growth",
    allowance: 2000,
    managedProvider: "mistral",
    /* KES 2,500/month. The main paid tier: AI depth, automation, forecasting
       advice, scenarios, collaboration and custom rules — all verified as
       implemented and enforced before being priced. */
    priceKes: 2500,
    periodDays: 30,
    sellable: true
  },
  custom: {
    label: "Custom AI",
    allowance: 0,
    managedProvider: null,
    /* KES 1,500/month. Cheaper than Growth ON PURPOSE: the subscriber brings
       their own AI key, so we carry no provider cost. Everything Growth has,
       plus provider ownership and unmetered usage. */
    priceKes: 1500,
    periodDays: 30,
    sellable: true
  },
  workspace: {
    label: "Accountant Workspace",
    allowance: 5000,
    managedProvider: "mistral",
    /* NOT SELLABLE, and this is the audit finding that matters most in this
       catalog. Workspace adds exactly four capabilities beyond Growth —
       ai_model_selection, ai_provider_diagnostics, multi_business,
       portfolio_dashboard — and ALL FOUR are in PLANNED_CAPABILITIES. It is
       entirely unbuilt, so charging for it would be charging for nothing.
       The tier is kept (existing profiles carry it, and it configures the
       gating for when the features land) but it cannot be bought. */
    priceKes: null,
    periodDays: 30,
    sellable: false,
    unsellableReason: "Every capability this tier adds is still in development."
  }
};

/** Currency for all pricing. Single market for now; not a client input. */
const BILLING_CURRENCY = "KES";

/** The plans a user may actually purchase, in display order. */
function sellablePlans() {
  return Object.entries(PLANS)
    .filter(([, p]) => p.sellable)
    .map(([key, p]) => ({
      key,
      label: p.label,
      price: p.priceKes,
      currency: BILLING_CURRENCY,
      period_days: p.periodDays,
      allowance: p.allowance
    }));
}

/**
 * The server's own price for a plan. THE ONLY source used at checkout.
 * Returns null for anything not purchasable, which the caller must refuse.
 */
function priceFor(planKeyName) {
  const plan = PLANS[String(planKeyName || "").toLowerCase()];
  if (!plan || !plan.sellable || !Number.isFinite(plan.priceKes)) return null;
  return {
    plan: String(planKeyName).toLowerCase(),
    label: plan.label,
    amount: plan.priceKes,
    currency: BILLING_CURRENCY,
    periodDays: plan.periodDays
  };
}

// Plan keys persisted before the Starter/Growth rename. Profiles on disk still
// carry these, so they are transparently mapped rather than reset to default.
const LEGACY_PLAN_ALIASES = {
  free: "starter",
  pro: "growth",
  professional: "growth"
};

// Credits per AI action. Only "intelligence" is metered: deterministic analysis
// and document rendering (PDF export) are never charged and are not listed here.
const CREDIT_COSTS = {
  explain: 1,
  chat: 2,
  "action-plan": 10,
  "monthly-review": 15,
  forecast: 25,
  "what-if": 25
};

/**
 * Capabilities, defined by inheritance so a tier can never accidentally offer
 * less than the tier below it. Each list states only what that tier ADDS.
 */

// Available on every plan, Starter included: a complete monitoring product.
const STARTER_CAPABILITIES = [
  "deterministic_analysis",   // the 11 risk skills, unlimited
  "dashboard",
  "zoho_sync",
  "onchain",                  // full Avalanche suite -- product differentiation
  "reports",
  "pdf_reports",              // rendering a document is not intelligence
  "forecast_numbers",         // 30/60/90-day maths, runway, cash-flow risk
  "manual_analysis",          // unlimited manual refresh
  "in_app_alerts",
  "email_monthly_summary",
  "ai_chat",                  // credit-metered
  "ai_monthly_review",        // credit-metered
  "ai_explain"                // credit-metered
];

// Growth turns monitoring into advice: Starter answers "what is happening?",
// Growth answers "what should I do next?". It adds AI intelligence, automation,
// strategic guidance, collaboration and advanced analytics -- but NOT
// enterprise/multi-client scale, which belongs to Accountant Workspace.
const GROWTH_CAPABILITIES = STARTER_CAPABILITIES.concat([
  // --- AI CFO -----------------------------------------------------------
  "ai_forecast_advisory",     // AI Cash Flow Advisor (interprets the free forecast)
  "what_if_simulator",
  "ai_action_plan",
  "smart_recommendations",
  "historical_ai_memory",
  "ai_trend_analysis",

  // --- Automation --------------------------------------------------------
  "automatic_monitoring",     // scheduled daily/weekly analysis
  "ai_followup_workflow",
  "scheduled_reports",

  // --- Alerts ------------------------------------------------------------
  "email_alerts",             // instant email, beyond Starter's monthly summary
  "external_alert_channels",  // WhatsApp / SMS / Slack / Teams

  // --- Reporting ---------------------------------------------------------
  "ai_executive_reports",      // "AI Executive Report" -- recommends, not just explains
  "ai_executive_report_pro",   // "AI Executive Report Pro" -- branded, board-ready

  // --- Collaboration -----------------------------------------------------
  "team_collaboration",       // members, roles & permissions, accountant access
  "task_assignment",

  // --- Customization -----------------------------------------------------
  "custom_rules",             // unlimited rule execution + rule history

  // --- Advanced analytics ------------------------------------------------
  "tax_readiness",
  "benchmarking"
]);

// Custom AI = every Growth capability, plus ownership of the AI itself.
// It adds NO financial functionality -- the difference is AI routing, provider
// choice and unmetered usage on the customer's own key.
const CUSTOM_CAPABILITIES = GROWTH_CAPABILITIES.concat([
  "bring_your_own_ai",        // the subscription right to use your own key
  "ai_provider_selection",
  "ai_model_selection",
  "ai_provider_diagnostics",  // connection status / test
  "api_key_management",       // add, remove, rotate, view configured provider
  "unmetered_ai"              // no managed AI credit metering
]);

// Accountant Workspace adds multi-client scale on top of Growth.
const WORKSPACE_CAPABILITIES = GROWTH_CAPABILITIES.concat([
  "ai_model_selection",        // no model picker yet -- provider default is used
  "ai_provider_diagnostics",   // no connectivity test endpoint yet
  "multi_business",
  "portfolio_dashboard"
]);

/**
 * Capabilities that are ENTITLED but NOT YET BUILT.
 *
 * Declaring a capability configures gating, docs and upgrade messaging ahead of
 * the implementation. Listing it here keeps the product honest: the UI can label
 * it "coming soon" instead of sending a paying user hunting for a screen that
 * does not exist, and upsells never advertise vapourware.
 *
 * Remove an entry the moment the feature actually ships.
 */
const PLANNED_CAPABILITIES = new Set([
  "email_monthly_summary",   // Starter: no mailer yet
  "email_alerts",
  "external_alert_channels", // WhatsApp/SMS/Slack/Teams
  "historical_ai_memory",
  "ai_trend_analysis",
  "scheduled_reports",
  // NOTE: the basic board_summary / investor_summary report TEMPLATES already
  // exist and stay free on every plan (Starter's definition grants report
  // generation). "Pro" reserves only the branded, board-formatted upgrade, so no
  // gate is applied that would remove existing Starter behaviour.
  "ai_executive_report_pro",
  "task_assignment",
  "tax_readiness",
  "benchmarking",
  "ai_model_selection",        // no model picker yet -- provider default is used
  "ai_provider_diagnostics",   // no connectivity test endpoint yet
  "multi_business",
  "portfolio_dashboard"
]);

function isPlanned(feature) {
  return PLANNED_CAPABILITIES.has(feature);
}

const PLAN_CAPABILITIES = {
  starter:   new Set(STARTER_CAPABILITIES),
  growth:    new Set(GROWTH_CAPABILITIES),
  custom:    new Set(CUSTOM_CAPABILITIES),
  workspace: new Set(WORKSPACE_CAPABILITIES)
};

// Every capability the product knows about (union of all tiers), so the UI can
// render a complete locked/unlocked map without hardcoding its own list.
const ALL_CAPABILITIES = Array.from(new Set([].concat(
  STARTER_CAPABILITIES, GROWTH_CAPABILITIES, CUSTOM_CAPABILITIES, WORKSPACE_CAPABILITIES
)));

/**
 * User-facing description of each capability.
 *
 * THE BOUNDARY, in one line: **Starter explains. Growth recommends.**
 *   Starter  -> "Payroll increased because two new hires started in June."
 *   Growth   -> "Delay the next hire until receivables clear, or runway drops
 *                below 60 days."
 *
 * Copy must never blur that line: Starter capabilities describe the CURRENT
 * state; Growth capabilities drive a FUTURE decision.
 */
const FEATURE_COPY = {
  // --- Custom AI: own the AI itself --------------------------------------
  bring_your_own_ai: "Bring Your Own AI — run FinGuard on your own provider and API key",
  ai_provider_selection: "Choose your AI provider",
  ai_model_selection: "Choose which model to run (where the provider supports it)",
  ai_provider_diagnostics: "Provider connection status and connectivity testing",
  api_key_management: "Add, rotate and manage your API keys",
  unmetered_ai: "Unlimited AI usage — no managed credit metering, you pay your provider directly",

  // --- Starter: understand what is happening -----------------------------
  ai_monthly_review: "The AI Financial Summary — a concise, plain-language explanation of this month's findings and risks",
  ai_explain: "Plain-language explanations of individual transactions",
  ai_chat: "Ask questions about your finances and get grounded answers",
  forecast_numbers: "The Cash Flow Forecast — 30/60/90-day balances, runway and cash-flow risk",
  email_monthly_summary: "A monthly summary email of your financial health",
  reports: "Generate, view and download reports, including PDF export",
  pdf_reports: "Branded PDF export of any report",
  deterministic_analysis: "Unlimited financial analysis — duplicates, missing receipts, personal/business mixing, round numbers, concentration and fraud indicators",
  dashboard: "The full dashboard — health score, risk, revenue, expenses, cash balance, KPIs and charts",
  zoho_sync: "Connect Zoho Books and sync your accounting data",
  onchain: "The full Avalanche suite — wallet, contracts, escrow, on-chain ledger, transaction verification and audit trail",
  manual_analysis: "Unlimited manual analysis, run whenever you want",
  in_app_alerts: "In-app alerts for new findings",

  ai_forecast_advisory: "The AI Cash Flow Advisor, which reads your forecast and tells you what to do about it",
  what_if_simulator: "The What-If Simulator for testing decisions before you make them",
  ai_action_plan: "AI-written action plans",
  smart_recommendations: "Smart recommendations that name the specific payment, vendor or invoice to act on",
  ai_trend_analysis: "AI trend analysis across your trading history",
  ai_followup_workflow: "AI-generated follow-up workflows",
  email_alerts: "Immediate email alerts the moment a risk appears — suspected fraud, a cash threshold breach, a duplicate payment or an overdue invoice",
  ai_executive_reports: "The AI Executive Report — trends, risk analysis, recommendations, action plans and forecast interpretation in one board-ready document",
  ai_executive_report_pro: "AI Executive Report Pro — your branding, advanced charts, executive KPIs, investor commentary and board formatting",
  task_assignment: "Assigning findings and action-plan tasks to teammates",
  historical_ai_memory: "Trend-aware AI that remembers previous months",
  automatic_monitoring: "Automatic scheduled monitoring (daily/weekly)",
  scheduled_reports: "Scheduled reports",
  team_collaboration: "Team members, roles and accountant collaboration",
  custom_rules: "Custom financial rules",
  tax_readiness: "Tax readiness scoring",
  benchmarking: "Benchmarking against similar businesses",
  multi_business: "Multi-business dashboards for managing many SMEs",
  portfolio_dashboard: "Investor and portfolio dashboards",
  external_alert_channels: "WhatsApp, SMS, Slack and Teams alerts"
};

/**
 * The product boundary, stated once so UI copy and docs cannot drift apart.
 * Every upgrade prompt should be an instance of this contrast.
 */
const PRODUCT_BOUNDARY = {
  starter: {
    question: "What is happening in my business?",
    verb: "Explains",
    scope: "Current state",
    role: "Monitoring",
    example: "Payroll increased because two new hires started in June."
  },
  growth: {
    question: "What should I do next?",
    verb: "Recommends",
    scope: "Future decisions",
    role: "AI CFO",
    example: "Delay the next hire until receivables clear, or runway drops below 60 days."
  }
};

/**
 * What a capability actually contains. Used for locked-feature bullets and the
 * plan comparison, so the promise shown to users is defined in ONE place
 * alongside the gate that enforces it.
 */
const CAPABILITY_DETAILS = {
  // Starter — explain the current month
  ai_monthly_review: [
    "Concise, plain-language summary of the current month",
    "Explains the findings the engine detected",
    "Explains what each risk means for your business"
  ],
  email_monthly_summary: [
    "One monthly email summarising your financial health"
  ],

  // Growth — recommend the next decision
  ai_executive_reports: [
    "Executive summary",
    "Financial trends over time",
    "Charts",
    "Risk analysis",
    "AI recommendations",
    "Action plans",
    "Forecast interpretation",
    "Board-ready formatting"
  ],
  ai_executive_report_pro: [
    "Your branding",
    "Advanced charts",
    "Executive KPIs",
    "Investor commentary",
    "Recommendations",
    "Board formatting"
  ],
  email_alerts: [
    "Suspected fraud",
    "Cash threshold breached",
    "Duplicate payments",
    "Overdue invoices"
  ],
  bring_your_own_ai: [
    "Your own provider and API key",
    "Unlimited AI usage — nothing metered by FinGuard",
    "You pay your AI provider directly",
    "Every Growth capability included"
  ],

  ai_forecast_advisory: [
    "Reads your Cash Flow Forecast and explains the outlook",
    "Prioritises the risks that actually threaten your runway",
    "Recommends concrete next actions"
  ],
  what_if_simulator: [
    "Model hiring, payroll, rent, purchases, loans or a revenue drop",
    "Before → after cash flow, runway, health score and risk",
    "An AI recommendation on whether the decision is affordable"
  ],
  team_collaboration: [
    "5 roles: Founder, Finance Officer, Accountant, Auditor, Investor",
    "Granular permissions: view, edit, approve, comment, resolve",
    "Comment on and resolve findings together"
  ],
  automatic_monitoring: [
    "Daily, weekly or monthly scheduled analysis",
    "Automatic alerts on new issues — no duplicate notifications",
    "Runs even when you are not signed in"
  ]
};

function capabilityDetails(feature) {
  return CAPABILITY_DETAILS[feature] || [];
}

// The plan a locked capability first becomes available on -- used for accurate
// upgrade prompts ("available on Growth") instead of a hardcoded plan name.
function requiredPlanFor(feature) {
  const order = ["starter", "growth", "workspace"];
  for (const key of order) {
    if (PLAN_CAPABILITIES[key].has(feature)) return key;
  }
  return "growth";
}

function currentPeriod() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

function planKey(profile) {
  const raw = String((profile && profile.plan) || "starter").toLowerCase();
  const resolved = LEGACY_PLAN_ALIASES[raw] || raw;
  return PLANS[resolved] ? resolved : "starter";
}

/**
 * Does this account have a key stored? Storage is independent of entitlement --
 * a key is kept (never deleted) even when the plan cannot use it, so a
 * downgrade loses functionality but not the customer's configuration.
 */
function hasOwnKey(profile) {
  return Boolean(profile && profile.aiApiKey);
}

/**
 * Is this account on Bring Your Own AI?
 *
 * PRODUCT DECISION: BYOK is a paid subscription capability, NOT a mode that
 * switches on because someone pasted a key. A Growth subscriber with a valid
 * API key stays on Growth and keeps using managed AI; only a Custom AI
 * subscription routes to their own provider.
 */
function isByok(profile) {
  return can(profile, "bring_your_own_ai");
}

// BYOK subscribed AND actually configured with a usable key.
function byokReady(profile) {
  return isByok(profile) && hasOwnKey(profile);
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
  if (can(profile, "unmetered_ai")) return true;
  ensurePeriod(profile);
  return (profile.credits || 0) >= creditCost(action);
}

// Decrement credits for a managed AI action. BYOK is never charged.
// Call this ONLY after the AI request actually succeeded.
function charge(profile, action) {
  // Custom AI pays their provider directly; nothing is metered here.
  if (can(profile, "unmetered_ai")) return { ok: true, byok: true, remaining: null, cost: 0 };
  ensurePeriod(profile);
  const cost = creditCost(action);
  if ((profile.credits || 0) < cost) {
    return { ok: false, reason: "insufficient_credits", remaining: profile.credits || 0, cost };
  }
  profile.credits -= cost;
  return { ok: true, remaining: profile.credits, cost };
}

// Which provider + key should an AI call use for this user?
/**
 * Which provider and key should an AI call use?
 *
 *   Starter    -> managed NVIDIA   (credit-metered)
 *   Growth     -> managed Mistral  (credit-metered)
 *   Custom AI  -> the user's own provider and key (unmetered)
 *
 * A Custom AI account with no key configured returns an EMPTY key in byok mode,
 * which callers surface as a setup prompt. It deliberately does NOT fall back to
 * managed AI: the customer chose to own their AI, and silently spending the
 * platform's managed quota would contradict both that choice and their billing.
 */
function resolveAiRouting(profile, config) {
  if (isByok(profile)) {
    return {
      mode: "byok",
      plan: effectivePlan(profile),
      provider: (profile && profile.aiProvider) || "openai",
      apiKey: (profile && profile.aiApiKey) || "",
      managed: false,
      setup_required: !hasOwnKey(profile)
    };
  }
  const key = planKey(profile);
  const managedProvider = PLANS[key].managedProvider || "nvidia";
  const apiKey = managedProvider === "mistral"
    ? (config && config.mistralAppKey) || ""
    : (config && config.nvidiaApiKey) || "";
  return { mode: "managed", plan: key, provider: managedProvider, apiKey, managed: true };
}

// The plan used for feature resolution. This is the SUBSCRIPTION and nothing
// else -- owning an API key never changes it.
function effectivePlan(profile) {
  return planKey(profile);
}

/**
 * Single source of truth for "is this capability offered on this plan?".
 * An unrecognised capability defaults to allowed, so introducing a feature
 * never silently locks it out before it is declared in the tier lists.
 */
function can(profile, feature) {
  if (ALL_CAPABILITIES.indexOf(feature) === -1) return true;
  const caps = PLAN_CAPABILITIES[effectivePlan(profile)];
  return Boolean(caps && caps.has(feature));
}

function featureReason(feature) {
  return FEATURE_COPY[feature] || "This capability";
}

// Standard 403 body for a locked feature, so every route reports it identically.
function planLabel(key) {
  return (PLANS[key] && PLANS[key].label) || "Growth";
}

// Standard 403 body for a locked capability, so every route reports it
// identically and the message always names the tier that actually unlocks it.
function upgradePayload(feature) {
  const required = requiredPlanFor(feature);
  const suffix = required === "workspace"
    ? "is available on the Accountant Workspace plan."
    : "is available on the Growth and Custom AI plans.";
  return {
    ok: false,
    error: "upgrade_required",
    feature,
    required_plan: required,
    required_plan_label: planLabel(required),
    message: `${featureReason(feature)} ${suffix}`
  };
}

// The full matrix for the current user, so the UI can render locked states
// without duplicating the rules client-side.
function featureMap(profile) {
  const caps = PLAN_CAPABILITIES[effectivePlan(profile)];
  const out = {};
  ALL_CAPABILITIES.forEach((key) => { out[key] = Boolean(caps && caps.has(key)); });
  return out;
}

// Capability -> the plan key that first unlocks it, so the UI can label locks
// correctly ("Growth" vs "Accountant Workspace") without its own rules.
function featureRequirements() {
  const out = {};
  ALL_CAPABILITIES.forEach((key) => {
    const required = requiredPlanFor(key);
    out[key] = { plan: required, plan_label: planLabel(required), planned: isPlanned(key) };
  });
  return out;
}

function getEntitlement(profile) {
  ensurePeriod(profile);
  const key = planKey(profile);              // the SUBSCRIPTION -- never inferred
  const byok = isByok(profile);              // subscribed to Bring Your Own AI
  const unmetered = can(profile, "unmetered_ai");
  return {
    plan: key,
    plan_label: PLANS[key].label,
    byok,                                    // plan uses the customer's own AI
    byok_configured: byok && hasOwnKey(profile),
    byok_setup_required: byok && !hasOwnKey(profile),
    // A stored key on a managed plan is kept but unused -- surfaced so the UI can
    // explain why it is being ignored instead of silently dropping it.
    own_key_stored: hasOwnKey(profile),
    credits: unmetered ? null : profile.credits,
    allowance: unmetered ? null : PLANS[key].allowance,
    period: profile.creditsPeriod,
    credit_costs: CREDIT_COSTS,
    features: featureMap(profile),
    feature_copy: FEATURE_COPY,
    feature_details: CAPABILITY_DETAILS,
    product_boundary: PRODUCT_BOUNDARY,
    feature_requirements: featureRequirements(),
    // Entitled to this user but not yet built -- surfaced as "coming soon"
    // rather than silently missing.
    planned_features: ALL_CAPABILITIES.filter((k) => can(profile, k) && isPlanned(k))
  };
}

function setPlan(profile, plan) {
  const raw = String(plan || "").toLowerCase();
  // Accept legacy keys so older clients / stored values keep working.
  const p = LEGACY_PLAN_ALIASES[raw] || raw;
  if (!PLANS[p]) return false;
  profile.plan = p;
  // Reset the period so the new plan's allowance is granted immediately.
  profile.creditsPeriod = null;
  ensurePeriod(profile);
  return true;
}

module.exports = {
  PLANS, BILLING_CURRENCY, sellablePlans, priceFor,
  PLANS,
  CREDIT_COSTS,
  PLAN_CAPABILITIES,
  ALL_CAPABILITIES,
  PLANNED_CAPABILITIES,
  isPlanned,
  PRODUCT_BOUNDARY,
  CAPABILITY_DETAILS,
  capabilityDetails,
  LEGACY_PLAN_ALIASES,
  FEATURE_COPY,
  planLabel,
  requiredPlanFor,
  featureRequirements,
  effectivePlan,
  can,
  featureReason,
  upgradePayload,
  featureMap,
  currentPeriod,
  ensurePeriod,
  isByok,
  hasOwnKey,
  byokReady,
  creditCost,
  canAfford,
  charge,
  resolveAiRouting,
  getEntitlement,
  setPlan
};
