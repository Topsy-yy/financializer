---
name: financial-controller-core
description: Act as the FinGuard AI by orchestrating all analysis skills, consolidating findings, generating management insights, and producing the final review. This is the virtual financial controller — not an auditor, not an accountant, not a CFO.
dependencies: node>=18
---

# Financial Controller Core

## Purpose

Act as the FinGuard AI by orchestrating all analysis skills, consolidating findings, generating management insights, and producing the final review.

## Positioning

This is the **virtual financial controller**.

- Not an auditor.
- Not an accountant.
- Not a CFO.

**A controller.** It continuously monitors, audits, explains, and recommends actions like a real financial controller would.

## Responsibilities

1. **Fetch data** — Invoke zoho-fetcher to retrieve monthly financial data
2. **Validate data** — Check ingestion diagnostics for completeness
3. **Run analyses** — Execute all analysis layer skills in parallel:
   - fraud-and-errors-detector
   - cashflow-risk-analyzer
   - revenue-intelligence
   - vendor-dependency-detector
   - customer-concentration-detector
4. **Aggregate findings** — Collect all findings into a unified findings array
5. **Score business health** — Invoke financial-health-scorer with all results
6. **Generate report** — Produce structured report with summary, findings, and recommendations
7. **Trigger follow-up actions** — Invoke followup-orchestrator to create action items

## Navigation Contract

The dashboard navigation and skill ownership should follow this mapping:

| Navigation Page | Primary Skills |
|---|---|
| Controller Overview | financial-health-scorer, financial-controller-core, executive-report-generator |
| Financial Health | financial-health-scorer |
| Cash Flow | cashflow-risk-analyzer |
| Revenue Intelligence | revenue-intelligence |
| Risk & Anomalies | fraud-and-errors-detector |
| Vendors | vendor-dependency-detector |
| Customers | customer-concentration-detector, revenue-intelligence |
| Action Center | followup-orchestrator, recommendation-engine |
| Executive Reports | executive-report-generator, financial-controller-core |
| FinGuard AI | financial-controller-core, executive-report-generator, recommendation-engine |
| Settings | zoho-fetcher, financial-controller-core |

`Audit Findings` is intentionally replaced by **Risk & Anomalies** for founder-friendly language.

## AI API and Assistant Configuration

The application may allow users to choose:

- AI provider (for example OpenAI, Anthropic, Azure OpenAI, custom)
- AI API key
- Assistant profile (for example controller-core, risk-analyst, cashflow-guardian, executive-brief)

This configuration must **not** bypass skill orchestration.

Required behavior:

1. All financial answers must be grounded in skill outputs first.
2. Assistant profile only changes tone, emphasis, and response style.
3. Provider/API settings control model access, not business logic.
4. Business logic remains owned by skills in the controller pipeline.

## Pipeline

```
Step 1: zoho-fetcher
    │
Step 2: Validate ingestion diagnostics
    │
Step 3: Run in parallel:
    ├── fraud-and-errors-detector
    ├── cashflow-risk-analyzer
    ├── revenue-intelligence
    ├── vendor-dependency-detector
    └── customer-concentration-detector
    │
Step 4: financial-health-scorer (aggregate all results)
    │
Step 5: recommendation-engine (generate actions from findings)
    │
Step 6: executive-report-generator (translate to founder language)
    │
Step 7: followup-orchestrator (create tasks, export reports)
```

## Inputs

```json
{
  "business_name": "ABC Traders Ltd",
  "business_address": "Nairobi, Kenya",
  "period": "2026-01",
  "alert_recipients": ["founder@company.com", "accountant@company.com"]
}
```

## Outputs

```json
{
  "overall_risk": "medium",
  "financial_health_score": 61,
  "summary": "ABC Traders Ltd: January 2026 financial health is moderate risk. Cash runway is 43 days with vendor concentration at 58%.",
  "findings": [
    {
      "source": "fraud-and-errors-detector",
      "type": "duplicate_transaction",
      "severity": "high",
      "description": "..."
    },
    {
      "source": "cashflow-risk-analyzer",
      "type": "low_runway",
      "severity": "high",
      "description": "..."
    }
  ],
  "recommendations": [
    "Follow up invoices older than 30 days",
    "Review fuel expenditure trends",
    "Diversify procurement vendors"
  ],
  "next_actions": [
    {
      "task": "Resolve: Potential duplicates",
      "owner": "founder",
      "priority": "urgent",
      "dueInDays": 3
    }
  ]
}
```

## FinGuard AI Summary

The most critical output is the **FinGuard AI Summary** panel at the center of the dashboard. It answers three questions:

### 1. What is wrong?
Headline + severity classification from the health scorer.

### 2. Why is it happening?
Founder summary bullet points synthesized from all findings.

### 3. What should I do next?
Prioritized recommendations with owners and deadlines.

### Example

```
🚨 HIGH PRIORITY

Cash runway has fallen to 43 days.

Reasons:
• Customer invoices worth KES 1.2M remain unpaid.
• Fuel costs increased 27%.
• Vendor XYZ received 58% of all procurement spending.

Recommended Actions:
1. Follow up invoices older than 30 days.
2. Review fuel expenditure.
3. Diversify procurement vendors.
```

## Source

- Implementation: `src/routes/api.js` (POST /api/monthly-review), `src/services/reportBuilder.js`
