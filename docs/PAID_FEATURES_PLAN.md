# FinGuard AI — Paid Features Implementation Plan

_Last updated: 2026-07-26_

## 0. Guiding principles
1. **Monetize the intelligence, not the detection.** The deterministic analysis engine (health score, duplicate/receipt/round-number detection, cash-flow, concentration, on-chain ledger) is cheap and stays free. AI narration, prediction, advice, automation, and scale are the paid product.
2. **Numbers are always free; AI and depth are paid.** Free users always see the computed dashboard. Paywall gates AI narration, advanced analytics depth, automation, and multi-tenant scale.
3. **Product promise vs. implementation.** Sell tiers + AI credits. Keep provider routing (NVIDIA/Mistral/BYOK) internal so it can change without touching pricing.
4. **Server-side enforcement.** Entitlements, credit metering, and provider keys never live in the browser.

---

## 1. Current state (Phase 0 — DONE ✅)
The monetization foundation and the first premium feature already ship:

- ✅ **Entitlement model** — `plan` (free/pro/custom) + monthly AI credits, auto-refill per calendar month. (`src/services/entitlements.js`)
- ✅ **Plan-based AI routing** — BYOK → Custom AI (unmetered); Pro → managed Mistral; Free → managed NVIDIA. Never exposed to the client.
- ✅ **Credit metering + gating** — charged only on successful AI calls; out-of-credits shows an upgrade prompt but the free dashboard still renders. Costs: chat 2 · review 15 · exec report 20 · forecast 25.
- ✅ **Endpoints** — `GET /api/entitlement`, `POST /api/plan` (TEST STUB — replace with payment webhook).
- ✅ **Credits UI** — header chip + Settings "Plan & Credits" tab (meter + plan toggle).
- ✅ **Cash-flow forecasting** — deterministic 30/60/90-day projection + "runs out in N days" (free) with a gated AI advisor (25 credits). (`src/services/cashflowForecast.js`, `POST /api/forecast`)

**Reusable assets already in the codebase:** AI chat (drawer, now gated), `executive-report-generator`, `recommendation-engine` + `followup-orchestrator`, risk thresholds in Settings, on-chain ledger + escrow + contracts, multi-provider AI client.

---

## 2. Tiers & pricing

| Tier | Who | Analysis | AI | On-chain | Billing |
|---|---|---|---|---|---|
| **Starter (Free)** | Individual SMEs | Full monitoring | ~100 credits/mo + trial pack | View only | — |
| **Professional** (~KES 1,500–3,000/mo) | Growing SMEs | + forecasting, what-if, premium depth | Generous credits (managed Mistral) | Escrow + audit trail | Subscription |
| **Custom AI** | Accountants / devs / technical founders | Full | Their own key, unmetered | ✅ | Platform fee or free |
| **Accountant Workspace** (Phase 4) | Firms managing many SMEs | Multi-client board | Pooled credits | ✅ | Per-seat / per-client |

**Credit costs:** explain-transaction 1 · AI chat 2 · monthly review 15 · executive report 20 · forecast 25 · what-if 25.

---

## 3. Feature backlog → tier / credits / status / effort

| # | Feature | Tier | Credits | Status | Effort |
|---|---|---|---|---|---|
| Foundation | Credits + entitlement + routing | — | — | ✅ done | — |
| Forecast | Cash-flow forecast + AI advisor | Pro | 25 | ✅ done | — |
| Unlimited AI Chat | Higher chat limits | Pro | 2/msg | ✅ gated | S |
| What-If Simulator | Payroll/hiring/revenue scenarios | Pro | 25 | ⏳ | M |
| AI Action Plans | Findings → owned, dated tasks | Pro | (part of review) | ~partial | M |
| Smart Recommendations | "Cancel payment #483…" | Pro | (part of review) | ~partial | S |
| Exec Report PDF | Branded PDF + charts | Pro | 20 | ✅ done | M |
| Custom Rules | User-defined thresholds/approvals | Pro | — | ✅ done | M |
| WhatsApp Alerts | Push on high-risk / low cash | Pro | — | ⏳ | M |
| Email Digest | Weekly summary | Pro | — | ⏳ | S |
| Continuous Monitoring | Daily sync + instant alert | Pro | — | ⏳ | L |
| On-chain audit/escrow | Premium positioning | Pro | — | ✅ built | S (gate) |
| Payments | Paystack/M-Pesa + webhook | — | — | ⏳ | L |
| Team Members | Roles/permissions | Pro | — | ⏳ | L |
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
1. **What-If Simulator** — reuse `cashflowForecast` with adjusted inputs (payroll +15%, hire N, revenue −20%). Credit: 25.
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
1. **Continuous Monitoring** — scheduled Zoho sync + instant alert on new high-risk items (needs a scheduler/queue). Honest framing: "daily + on-sync," not "real-time."
2. **WhatsApp Alerts** — Twilio/WhatsApp Business API.
3. **Team Members** — roles/permissions (founder, finance officer, accountant, auditor, investor).
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
