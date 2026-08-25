# FinGuard AI — Paid Features Implementation Plan

_Last updated: 2026-08-02_

## 0. Guiding principles
1. **Monetize the intelligence, not the detection.** The deterministic analysis engine (health score, duplicate/receipt/round-number detection, cash-flow, concentration, on-chain ledger) is cheap and stays free. AI narration, prediction, advice, automation, and scale are the paid product.
2. **Numbers are always free; AI and depth are paid.** Free users always see the computed dashboard. Paywall gates AI narration, advanced analytics depth, automation, and multi-tenant scale.
3. **Product promise vs. implementation.** Sell tiers + AI credits. Keep provider routing (NVIDIA/Mistral/BYOK) internal so it can change without touching pricing.
4. **Server-side enforcement.** Entitlements, credit metering, and provider keys never live in the browser.
5. **Capability-first, never plan-name-first.** The chain is always
   `plan -> capabilities -> behaviour`. Backend routes call
   `entitlements.can(profile, "<capability>")`; the frontend renders from the
   `features` map returned by `GET /api/entitlement`. Neither layer may branch on
   a plan name. Adding or renaming a plan therefore cannot change behaviour
   anywhere except in `src/services/entitlements.js`.
6. **Never delete customer work on downgrade.** Losing a capability disables
   functionality; it never destroys data. See §2.5.

---

## 1. Current state (Phase 0 — DONE ✅)
The monetization foundation and the first premium feature already ship:

- ✅ **Entitlement model** — `plan` (free/pro/custom) + monthly AI credits, auto-refill per calendar month. (`src/services/entitlements.js`)
- ✅ **Plan-based AI routing** — BYOK → Custom AI (unmetered); Pro → managed Mistral; Free → managed NVIDIA. Never exposed to the client.
- ✅ **Credit metering + gating** — charged only on successful AI calls; out-of-credits shows an upgrade prompt but the free dashboard still renders. Costs: chat 2 · action plan 10 · review 15 · forecast 25 · what-if 25. (PDF export is not charged.)
- ✅ **Endpoints** — `GET /api/entitlement`, `POST /api/plan` (TEST STUB — replace with payment webhook).
- ✅ **Credits UI** — header chip + Settings "Plan & Credits" tab (meter + plan toggle).
- ✅ **Cash-flow forecasting** — deterministic 30/60/90-day projection + "runs out in N days" (free on every plan); the AI interpretation is a Growth capability (25 credits). (`src/services/cashflowForecast.js`, `POST /api/forecast`)

**Reusable assets already in the codebase:** AI chat (own page, credit-metered), `executive-report-generator`, `recommendation-engine` + `followup-orchestrator`, risk thresholds in Settings, on-chain ledger + escrow + contracts, multi-provider AI client.

---

## 2. Tiers & pricing

**Authoritative plan names** — these four, exactly, everywhere in code, UI and docs:

| Plan key | Label | Who | Billing |
|---|---|---|---|
| `starter` | **Starter** | Individual SMEs | Free — 100 AI credits/mo |
| `growth` | **Growth** (~KES 1,500–3,000/mo, TBD) | Growing SMEs | Subscription — 2,000 AI credits/mo |
| `custom` | **Custom AI** | Accountants / devs / technical founders | Subscription; AI unmetered on their own key |
| `workspace` | **Accountant Workspace** | Firms managing many SMEs | Per-seat / per-client — 5,000 credits/mo |

The former label "Growth" is retired. Legacy persisted plan keys (`free`,
`pro`, `professional`) are transparently mapped to `starter`/`growth` by
`LEGACY_PLAN_ALIASES`, so existing profiles keep working without migration.

Capabilities are defined by **inheritance**, so a higher tier can never
accidentally offer less than the tier below it:

```
STARTER_CAPABILITIES
  └─ GROWTH_CAPABILITIES   = Starter + AI CFO, automation, collaboration, customization
       ├─ CUSTOM_CAPABILITIES    = Growth + Bring Your Own AI (unmetered, own key)
       └─ WORKSPACE_CAPABILITIES = Growth + multi_business, portfolio_dashboard
```

### 2.1 Starter (Free) — the authoritative definition

Starter is a **complete financial monitoring product for a single business**, not a
restricted demo. A founder can connect their books, analyze their finances every
day, generate reports, deploy contracts, and understand their financial health.

**Starter stops at monitoring and understanding.** It does not provide strategic
planning, automation, or AI CFO capabilities.

| Area | Starter gets |
|---|---|
| Account | Registration, login, company profile & settings |
| Zoho | Connect Zoho Books, sync, manual re-sync |
| **Avalanche** | **Everything** — wallet, contract deployment, escrow create/manage, contract interaction, on-chain ledger, transaction verification, audit trail, contract history |
| Dashboard | Full access — health score, risk score, revenue, expenses, cash balance, KPIs, historical charts, recent transactions, outstanding invoices, risk summary |
| Financial analysis | **Unlimited deterministic analysis** — duplicates, missing receipts, mixed personal/business, round numbers, vendor concentration, cash flow, fraud indicators, missing-info checklist, health & risk scoring |
| AI | AI chat, monthly review, transaction explanation, risk explanation — governed **only** by the existing monthly credit system |
| Reports | Generate, view, **download PDF**, report history |
| Monitoring | Daily **manual** analysis, unlimited manual refresh |
| Forecast | Deterministic 30/60/90-day forecast, cash runway, cash-flow risk |
| Alerts | In-app notifications, monthly email summary |
| Settings | All normal account settings |

**Not on Starter** (shown locked in the UI with an explanation, never hidden):

| Category | Locked |
|---|---|
| AI CFO | What-If Simulator, AI forecast interpretation & recommendations, AI action plans, historical AI memory, AI decision support |
| Automation | Automatic/scheduled monitoring, scheduled analysis, scheduled reports, scheduled AI reviews |
| Communication | WhatsApp, SMS, Slack, Teams, Google Sheets sync |
| Collaboration | Team members, roles, accountant collaboration, task assignment, portfolio management |
| Advanced analytics | Tax readiness, benchmarking, multi-business & investor dashboards |
| Customization | Custom financial rules |

**Enforcement:** every gate resolves through `entitlements.can(profile, capability)`
against the capability lists in `src/services/entitlements.js` — the single
source of truth. Routes must not test plan strings inline.

### 2.2 Growth — the authoritative definition

**Purpose.** Growth turns FinGuard from a monitoring platform into an AI-powered
financial advisor.

> Starter answers **"What is happening in my business?"**
> Growth answers **"What should I do next?"**

Growth users get AI intelligence, automation, strategic guidance, collaboration
and advanced analytics. They do **not** get enterprise/multi-client scale — that
is Accountant Workspace.

**The boundary — Starter explains, Growth recommends.**

| | Starter | Growth |
|---|---|---|
| Answers | *What is happening in my business?* | *What should I do next?* |
| AI verb | **Explains** | **Recommends** |
| Time frame | Current state | Future decisions |
| Product role | Monitoring | AI CFO |
| Example | "Payroll increased because two new hires started in June." | "Delay the next hire until receivables clear, or runway drops below 60 days." |

This contrast is defined once in code as `PRODUCT_BOUNDARY`
(`src/services/entitlements.js`) and served to the client, so every upgrade
prompt is an instance of it and copy cannot drift.

**Where Starter ends and Growth begins**

| Area | Starter (keeps) | Growth (adds) |
|---|---|---|
| **AI narrative** | **AI Financial Summary** (`ai_monthly_review`) — concise, plain language, current month, explains findings and risks | **AI Executive Report** (`ai_executive_reports`) — executive summary, financial trends, charts, risk analysis, AI recommendations, action plans, forecast interpretation, board-ready formatting |
| **Reports** | Generate/view/download **all existing report templates** incl. `board_summary` and `investor_summary`, PDF export, report history | **AI Executive Report Pro** (`ai_executive_report_pro`) — branding, advanced charts, executive KPIs, investor commentary, recommendations, board formatting |
| **Email** | **Monthly summary email** (`email_monthly_summary`) | **Immediate alerts** (`email_alerts`) — suspected fraud, cash threshold breached, duplicate payments, overdue invoices |
| **Forecast** | **Cash Flow Forecast** — the calculation | **AI Cash Flow Advisor** — the interpretation and the recommendation |
| **Decisions** | — | What-If Simulator, AI Action Plans, Smart Recommendations |

Starter's AI is **not removed or narrowed** by any of the above. Growth is
additive: a deeper document, a faster channel, and forward-looking judgement.

**Included capabilities** (all Starter capabilities, plus):

| Group | Capability | Built? |
|---|---|---|
| **AI CFO** | `ai_forecast_advisory` — AI Cash Flow Advisor | ✅ |
| | `what_if_simulator` | ✅ |
| | `ai_action_plan` | ✅ |
| | `smart_recommendations` | ✅ |
| | `historical_ai_memory` | ⏳ planned |
| | `ai_trend_analysis` | ⏳ planned |
| **Automation** | `automatic_monitoring` — scheduled daily/weekly analysis | ✅ |
| | `ai_followup_workflow` | ✅ |
| | `scheduled_reports` | ⏳ planned |
| **Alerts** | `in_app_alerts` (also on Starter) | ✅ |
| | `email_alerts` — instant, beyond Starter's monthly summary | ⏳ planned |
| | `external_alert_channels` — WhatsApp / SMS / Slack / Teams | ⏳ planned |
| **Reporting** | `ai_executive_reports` — AI-written narrative | ✅ |
| | `ai_executive_report_pro` — branded, board-formatted upgrade | ⏳ planned¹ |
| **Collaboration** | `team_collaboration` — members, roles & permissions, accountant access | ✅ |
| | `task_assignment` | ⏳ planned |
| **Customization** | `custom_rules` — unlimited execution + rule history | ✅ |
| **Advanced analytics** | `tax_readiness` | ⏳ planned |
| | `benchmarking` | ⏳ planned |

¹ The **basic** `board_summary` and `investor_summary` report templates already
exist and remain **free on every plan** — Starter's definition grants report
generation, so no gate is applied that would remove them. `ai_executive_report_pro`
reserves only the branded, board-formatted upgrade.

⏳ **planned** = the entitlement, documentation and upgrade messaging are
configured, but the feature is not built. These are listed in
`PLANNED_CAPABILITIES` in `src/services/entitlements.js`, exposed to the client
as `feature_requirements[key].planned` and `planned_features`, and rendered as
"coming soon". Two rules follow from this:
- The upsell card never advertises a planned capability (no vapourware selling).
- A Growth user is told a capability is still building rather than hunting for
  a screen that does not exist.

**Excluded from Growth** (Accountant Workspace only):

| Capability | Why |
|---|---|
| `multi_business` | Managing many client businesses is enterprise scale |
| `portfolio_dashboard` | Investor/portfolio *view across many businesses* — distinct from Growth's AI Executive Report Pro, which is a document about the user's own business |

Also outside Growth and not yet modelled as capabilities: white-label and
enterprise administration (they have no implementation or entitlement yet).

**Reuse constraints honoured:** Growth adds no new forecasting logic — the
What-If Simulator and AI Cash Flow Advisor both run the existing
`cashflowForecast` engine, and follow-ups reuse `followUpWorkflow`.

### 2.3 Custom AI — the authoritative definition

**Purpose.** Custom AI is **Growth + Bring Your Own AI**. It adds no financial
functionality; it is differentiated purely by AI *ownership, routing and
flexibility*.

> **Product decision:** Custom AI is a paid subscription. It is **not** a mode
> that switches on because a user pasted an API key. Owning a key never changes
> a subscription — a Growth subscriber with a valid key stays on Growth and keeps
> using managed AI. Only an active Custom AI subscription unlocks BYOK.

**Inherits:** every Growth capability, by construction
(`CUSTOM_CAPABILITIES = GROWTH_CAPABILITIES.concat([...])`). No capability is
redefined or duplicated.

**Adds:**

| Capability | Meaning | Built? |
|---|---|---|
| `bring_your_own_ai` | The subscription right to run on your own provider/key | ✅ |
| `ai_provider_selection` | Choose the AI provider | ✅ |
| `api_key_management` | Add, rotate and view your configured key | ✅¹ |
| `unmetered_ai` | No managed credit metering | ✅ |
| `ai_model_selection` | Pick a specific model where supported | ⏳ planned |
| `ai_provider_diagnostics` | Connection status / connectivity test | ⏳ planned |

¹ Add, rotate and view are implemented. **Explicit key removal is not** — see
"remaining gaps" below.

**AI routing**

| Plan | Routes to | Metered? |
|---|---|---|
| Starter | Managed **NVIDIA** | Yes — 100 credits/mo |
| Growth | Managed **Mistral** | Yes — 2,000 credits/mo |
| **Custom AI** | **The user's selected provider, on their own key** | **No** |
| Accountant Workspace | Managed Mistral | Yes — 5,000 credits/mo |

**No silent fallback.** A Custom AI account with no key configured resolves to
`{ mode: "byok", apiKey: "", setup_required: true }`. Callers surface this as a
**setup prompt**; the request is never quietly re-routed to managed AI. The
customer chose to own their AI, and spending the platform's managed quota would
contradict both that choice and their billing.

**Billing model.** FinGuard charges the subscription; the customer pays their AI
provider directly for usage. `credits` and `allowance` are reported as `null`,
and `charge()` is a no-op for any plan holding `unmetered_ai`.

**Differences from Growth**

| | Growth | Custom AI |
|---|---|---|
| Financial capabilities | Full | **Identical** |
| AI provider | Managed Mistral | Yours |
| AI cost | Included, credit-metered | You pay your provider |
| Usage limit | 2,000 credits/mo | Unmetered |
| Provider/model choice | No | Yes |
| Key management in Settings | Hidden | Exposed |

**Downgrade behaviour.** A stored API key is **never deleted** when a customer
leaves Custom AI. It is retained and simply unused (`own_key_stored: true`), and
the UI explains why it is being ignored. Re-subscribing restores BYOK with the
key already in place. This follows §2.5.

**Excluded** (Accountant Workspace only): `multi_business`,
`portfolio_dashboard`, enterprise administration and white-label — Custom AI is a
single-business plan.

### 2.4 Capability matrix (exactly what the code enforces)

| Capability | Starter | Growth | Custom AI | Workspace |
|---|:-:|:-:|:-:|:-:|
| `deterministic_analysis` | ✅ | ✅ | ✅ | ✅ |
| `dashboard` | ✅ | ✅ | ✅ | ✅ |
| `zoho_sync` | ✅ | ✅ | ✅ | ✅ |
| `onchain` (full Avalanche suite) | ✅ | ✅ | ✅ | ✅ |
| `reports` / `pdf_reports` | ✅ | ✅ | ✅ | ✅ |
| `forecast_numbers` (Cash Flow Forecast) | ✅ | ✅ | ✅ | ✅ |
| `manual_analysis` (unlimited) | ✅ | ✅ | ✅ | ✅ |
| `in_app_alerts` / `email_monthly_summary` | ✅ | ✅ | ✅ | ✅ |
| `ai_chat` / `ai_monthly_review` / `ai_explain` | ✅¹ | ✅¹ | ✅ | ✅¹ |
| `ai_forecast_advisory` (AI Cash Flow Advisor) | ❌ | ✅ | ✅ | ✅ |
| `what_if_simulator` | ❌ | ✅ | ✅ | ✅ |
| `ai_action_plan` | ❌ | ✅ | ✅ | ✅ |
| `smart_recommendations` | ❌ | ✅ | ✅ | ✅ |
| `historical_ai_memory` ⏳ | ❌ | ✅ | ✅ | ✅ |
| `ai_trend_analysis` ⏳ | ❌ | ✅ | ✅ | ✅ |
| `automatic_monitoring` | ❌ | ✅ | ✅ | ✅ |
| `ai_followup_workflow` | ❌ | ✅ | ✅ | ✅ |
| `scheduled_reports` ⏳ | ❌ | ✅ | ✅ | ✅ |
| `email_alerts` ⏳ | ❌ | ✅ | ✅ | ✅ |
| `external_alert_channels` ⏳ | ❌ | ✅ | ✅ | ✅ |
| `ai_executive_reports` | ❌ | ✅ | ✅ | ✅ |
| `ai_executive_report_pro` ⏳ | ❌ | ✅ | ✅ | ✅ |
| `team_collaboration` | ❌ | ✅ | ✅ | ✅ |
| `task_assignment` ⏳ | ❌ | ✅ | ✅ | ✅ |
| `custom_rules` | ❌ | ✅ | ✅ | ✅ |
| `tax_readiness` ⏳ / `benchmarking` ⏳ | ❌ | ✅ | ✅ | ✅ |
| `bring_your_own_ai` | ❌ | ❌ | ✅ | ❌ |
| `ai_provider_selection` / `api_key_management` | ❌ | ❌ | ✅ | ❌ |
| `unmetered_ai` | ❌ | ❌ | ✅ | ❌ |
| `ai_model_selection` ⏳ / `ai_provider_diagnostics` ⏳ | ❌ | ❌ | ✅ | ❌ |
| `multi_business` ⏳ / `portfolio_dashboard` ⏳ | ❌ | ❌ | ❌ | ✅ |

⏳ = entitled but not yet built (see `PLANNED_CAPABILITIES`).

¹ Credit-metered. The capability is offered; affordability is a separate check
(`canAfford`). Custom AI is unmetered because the user supplies the key.

### 2.5 Downgrade policy (authoritative)

> **Never delete customer work because of a downgrade.**
> Losing a capability disables premium *functionality* while every artefact the
> customer created is preserved and restored automatically on re-upgrade.

| Area | On downgrade | On re-upgrade |
|---|---|---|
| **Custom Rules** | Every rule is retained. Execution is skipped during analysis; the UI shows them read-only with an upgrade prompt. | Evaluation resumes immediately — no reconfiguration. |
| **Team Members** | Invitations and memberships are preserved. Teammate access is **suspended** (`team_access_suspended`, HTTP 403) rather than revoked; comments and resolutions remain stored. | Access is restored automatically for all existing members. |
| **Automatic Monitoring** | Scheduling pauses. The stored cadence (e.g. `daily`) is **preserved, never rewritten**; the scheduler skips the account. Manual analysis remains unlimited. | The exact previous cadence resumes. |
| **Historical AI Memory** | Stored `reviewHistory` is preserved; only premium AI access to it is disabled. | Full history is available to the AI again. |
| **Credits** | Allowance changes with the plan at the next monthly refill. | — |

Implementation notes: `resolveFrequency(canSchedule, requested)` preserves the
stored cadence when scheduling is unavailable; rule execution is gated in
`POST /api/monthly-review`; teammate suspension is resolved in
`resolveCollabWorkspace()`.

### 2.6 Forecast positioning

Two distinct products that must never be conflated in copy:

| | **Cash Flow Forecast** | **AI Cash Flow Advisor** |
|---|---|---|
| What it is | The calculation — 30/60/90-day balances, runway, cash-flow risk | The interpretation — what it means and what to do |
| Plan | **Every plan, always free** | **Growth** / Custom AI (`ai_forecast_advisory`, 25 credits) |
| Capability | `forecast_numbers` | `ai_forecast_advisory` |

Growth unlocks **intelligence, not calculations**. UI copy must reinforce that a
Starter user's forecast is complete, not a limited preview.

**Credit costs:** explain-transaction 1 · AI chat 2 · action plan 10 · monthly
review 15 · forecast 25 · what-if 25.
PDF export is **not** charged and **not** plan-gated: rendering a document from
already-computed numbers is deterministic work, not intelligence.


---

## 3. Feature backlog → tier / credits / status / effort

| # | Feature | Tier | Credits | Status | Effort |
|---|---|---|---|---|---|
| Foundation | Credits + entitlement + routing | — | — | ✅ done | — |
| Forecast | Numbers free on all plans; AI advisor Pro | Pro (AI only) | 25 | ✅ done | — |
| Unlimited AI Chat | Higher chat limits | Pro | 2/msg | ✅ gated | S |
| What-If Simulator | Payroll/hiring/revenue scenarios | Pro | 25 | ✅ done (fully gated) | M |
| AI Action Plans | Findings → owned, dated tasks | Pro | 10 | ✅ gated | M |
| Smart Recommendations | "Cancel payment #483…" | Pro | (part of review) | ~partial | S |
| Exec Report PDF | Branded PDF + charts | **All plans** | — | ✅ done | M |
| Custom Rules | User-defined thresholds/approvals | Pro | — | ✅ done | M |
| WhatsApp Alerts | Push on high-risk / low cash | Pro | — | ⏳ | M |
| Email Digest | Weekly summary | Pro | — | ⏳ | S |
| Continuous Monitoring | Automatic scheduled sync | Pro (manual is free) | — | ✅ done | L |
| On-chain audit/escrow | Product differentiator | **All plans** | — | ✅ done (deliberately ungated) | — |
| Payments | Paystack/M-Pesa + webhook | — | — | ⏳ | L |
| Team Members | Roles/permissions | Pro | — | ✅ done (gated) | L |
| Multi-Business / Accountant | One dashboard, many SMEs | Workspace | — | ⏳ | XL |
| Investor/Portfolio Dashboard | VC/accelerator view | Workspace | — | ⏳ | L |
| Tax Readiness Score | VAT/PAYE/compliance check | Pro | — | ⏳ | M |
| Historical AI Memory | Trend-aware narration | Pro | — | ⏳ | M |
| Benchmarking | vs. similar SMEs | Pro | — | ⛔ needs scale | L |
| Receipt OCR / M-Pesa parse | Auto-extract | Pro | 1/doc | ⛔ deferred | L |
| AI Expense Categorization | Auto-categorize | Pro | 1/batch | ⛔ deferred | M |
| Slack/Teams/Google Sheets | Extra channels | Pro | — | ⛔ deferred | M each |
| Voice Assistant | Ask by voice | — | — | ⛔ skip | L |

Legend: ✅ done · ~partial (asset exists, needs finishing) · ⏳ to build · ⛔ deferred/needs prerequisite.

---

## 4. Phased roadmap

### Phase 1 — Core premium (mostly wiring existing assets)
Goal: a compelling Pro tier that's demo-ready, minimal new engineering.
**Progress: 3 / 5 complete (60%).**
1. ✅ **Smart Recommendations + AI Action Plans** — surface `recommendation-engine`/`followup-orchestrator` output as owned, dated tasks with concrete AI-written steps. (`POST /api/action-plan`, 10 credits)
2. ✅ **Executive Report → branded PDF** — reuses the existing report context; `reportFormatter` → `pdfReport` (pdfkit) → gated download. Free = upgrade modal; Pro = 20 credits (charged on success only); BYOK = free. (`POST /api/executive-report/pdf`)
3. ✅ **Custom Financial Rules** — user-defined rules (8 condition types) evaluated per-user and merged into the risk-engine anomaly pipeline via `buildAnomalies` (no detection logic duplicated; `duplicate_payment` reuses the engine). Pro/BYOK create unlimited; Free is read-only with examples + upgrade prompt. Create/preview/toggle/delete + execution history. (`src/services/customRules.js`, `GET/POST/PUT/DELETE /api/rules`, `/api/rules/preview`, `/api/rules/history`)
4. **Email Digest** — weekly health summary (cheap; reuse report text + a mailer).
5. **On-chain audit/escrow → gate as Pro** (already built; add entitlement check + positioning).

**Acceptance:** a Free user hits credit/feature limits and sees clear upgrade prompts; a Pro user gets unlimited-ish AI, PDF reports, custom rules, and the audit trail.

### Phase 2 — AI CFO (the differentiator)
1. ✅ **What-If Simulator** — reuses `cashflowForecast` (runs the same engine twice, baseline vs adjusted) plus a deterministic health re-score mirroring `buildHealthSummary`. 7 scenarios (increase payroll, reduce revenue, hire employees, increase rent, large purchase, loan repayment, custom). Output: before→after cash flow, health score, runway, and risk changes — **all free**; the AI recommendation is gated (Free → upgrade, Pro → 25 credits, Custom AI → unmetered). Lives in the Forecast tab (Forecast → What If → Adjust → Run → Results). (`src/services/whatIfSimulator.js`, `POST /api/what-if`)
2. **Historical AI Memory** — feed prior months into narration ("improved 18% vs last month"). Uses `reviewHistory`.
3. **Tax Readiness Score** — deterministic compliance checks (VAT/PAYE/missing invoices) + AI explanation.
4. **Positioning:** rebrand the bundle as **"AI CFO"** — predicts and advises, not just reports.

**Acceptance:** a founder can ask forward-looking questions and get grounded, numbers-backed answers.

### Phase 3 — Payments (turn the stub into revenue)
1. **Provider:** Paystack or Flutterwave (M-Pesa support for Kenya).
2. **Checkout + webhook** → set `plan=pro` on success, downgrade on lapse. Replaces `POST /api/plan` stub.
3. **Billing states:** active / past-due / canceled; credit allowance keyed to plan.
4. **Trial credits** — bonus pack for new users to experience Pro-grade AI.

**Acceptance:** a real payment upgrades the account automatically; lapse downgrades it.

### Phase 4 — Continuous monitoring & scale
1. ✅ **Continuous Monitoring** — scheduled re-analysis that reuses the existing risk engine (via injected deps, no detection duplicated) and alerts only on **new** issues, de-duplicated two ways (per-user seen-fingerprint set + notification guard). Plan-gated cadence: Free = monthly, Pro/Custom = daily/weekly/monthly. Hourly `setInterval` scheduler (`unref`'d) **plus** an opportunistic catch-up on the `/api/notifications` request path, so it also works on a host that sleeps when idle. Fetch failures retry (2×) and record an error status without crashing. Settings panel (enable + frequency + last/next/status + "Sync now") and a header notifications bell with unread badge, popover feed, and browser notifications. Honest framing: "daily + on-visit," not "real-time." (`src/services/monitoring.js`; `GET/POST /api/monitoring`, `POST /api/monitoring/run`, `GET /api/notifications`, `POST /api/notifications/read`; scheduler started from `server.js`.)
2. **WhatsApp Alerts** — Twilio/WhatsApp Business API.
3. ✅ **Team Members** — multiple users per business with a role→permission matrix (`src/services/team.js`). Roles: Founder (owner, unremovable), Finance Officer, Accountant, Auditor, Investor. Permissions: view / edit / approve / comment / resolve. Founder-only team management. Invite by email → single-use token link → cross-user accept (global index links a different store into the workspace, matched by bound userId or email). Role changes and removal apply live. Permission-gated collaboration on findings (comment / resolve threads keyed by anomaly fingerprint) proves the matrix across users. Team settings panel (members, role dropdowns, invite + copy link, "businesses you've joined", and a rendered permission matrix). **Next increment (not in this slice):** members reading the full shared financial dashboards — the membership/workspace plumbing is in place to enable it. (`GET /api/team`, `POST /api/team/invite`, `PUT/DELETE /api/team/member/:id`, `POST /api/team/accept`; `GET /api/findings/thread`, `POST /api/findings/comment`, `POST /api/findings/resolve`.)
4. **Accountant Workspace / Multi-Business / Portfolio** — multi-tenant: one login, many SMEs, aggregate risk board. Biggest revenue, biggest build.

**Acceptance:** an accountant manages many clients from one dashboard; alerts reach users where they already are.

### Deferred (revisit with scale/justification)
Benchmarking (needs aggregated data), Receipt OCR / M-Pesa parsing, AI categorization, Slack/Teams/Google Sheets, Voice assistant.

---

## 5. Technical patterns (how each feature hooks in)
- **New AI action:** add a credit cost in `entitlements.CREDIT_COSTS`; in the route, `resolveAiRouting` → check `canAfford` → call AI → `charge` on success → `persistProfile`. (Forecast is the reference implementation.)
- **New premium *computed* feature:** compute deterministically (free), gate only the AI narration or the advanced *depth* behind the plan.
- **Feature-flag gating:** add a helper `requirePlan(profile, 'pro')` for non-credit features (PDF, custom rules, on-chain, alerts).
- **UI:** premium tabs/buttons show an upgrade state for Free users instead of hiding (discovery drives conversion).

## 6. Cross-cutting concerns
- **Abuse:** per-user credit caps double as shared-key protection; add rate limiting on managed keys; require sign-up (email) for free credits.
- **Key security:** managed keys (`NVIDIA_API_KEY`, `MISTRAL_APP_KEY`) stay server-side; never returned to the client.
- **Entitlements are authoritative server-side** — the client only reflects them.
- **Testing:** stub payments with the plan toggle; unit-test `entitlements` and `cashflowForecast`; verify Free/Pro/BYOK routing paths.

## 7. Open decisions
1. Exact Pro price (KES) and free credit allowance / trial size.
2. Payment provider: Paystack vs Flutterwave vs Stripe.
3. Is Custom AI free or a low paid tier?
4. Which advanced analytics gate as "depth" (forecast is Pro; what about concentration depth, tax score)?
5. Alert channel for V1 (recommend WhatsApp first).
