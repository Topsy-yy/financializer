---
name: Cashflow Risk Analyzer
description: Assess liquidity health and identify future cash flow risks before they become operational problems. Answers the question "Will the company run out of cash?"
dependencies: node>=18
---

# Cashflow Risk Analyzer

## Methodology

> **This document is NOT the source of truth for any number.**
>
> Every threshold, weight, severity, confidence value and score band this skill
> refers to is defined in the authoritative rules registry at
> `src/domain/rules/registry.js` and is applied by the deterministic engine.
> The generated, always-current statement of that methodology is available at
> `GET /api/methodology` (and rendered from `src/domain/rules/methodology.js`).
>
> This file previously restated those numbers, and they had drifted from the
> code. Because these files are loaded into the AI's system prompt at runtime,
> the drift meant the model was being instructed with figures the engine does
> not use. The numbers have therefore been removed rather than corrected: a
> hand-maintained copy will drift again.
>
> **The deterministic engine decides. This skill explains what the engine
> decided, in language a business owner can act on.**



## Purpose

Assess liquidity health and identify future cash flow risks before they become operational problems.

## Business Value

Answers: **"Will the company run out of cash?"**

## Responsibilities

### Calculate

- **Cash runway** — How many days/months of operations can current reserves fund at current burn rate
- **Operating liquidity** — Ratio of liquid assets to short-term obligations
- **Cash trend** — Direction of cash reserves over time (growing, flat, declining)
- **Receivables pressure** — Volume and aging of unpaid customer invoices
- **Payables pressure** — Volume and urgency of unpaid supplier bills
- **Payroll coverage** — Can the business meet the next payroll cycle

### Detect

- **Negative cash trajectory** — Outflow consistently exceeding inflow
- **Potential cash shortages** — Runway dropping below critical thresholds
- **Delayed customer collections** — Receivables aging beyond 30/60/90 days

## Inputs

```json
{
  "cashFlow": {
    "inflow": 850000,
    "outflow": 720000
  },
  "transactions": [],
  "accountsReceivable": [
    {
      "customer": "Client ABC",
      "amount": 320000,
      "dueDate": "2026-01-15",
      "status": "overdue"
    }
  ],
  "accountsPayable": [
    {
      "vendor": "Supplier XYZ",
      "amount": 180000,
      "dueDate": "2026-01-20",
      "status": "pending"
    }
  ]
}
```

## Outputs

```json
{
  "cash_runway_days": 43,
  "cash_runway_months": 1.4,
  "risk_level": "medium",
  "net_cash_flow": 130000,
  "monthly_burn": 720000,
  "liquidity_ratio": 1.18,
  "findings": [
    {
      "type": "low_runway",
      "severity": "high",
      "description": "Cash runway has fallen to 43 days. Immediate action required."
    },
    {
      "type": "receivables_pressure",
      "severity": "medium",
      "description": "KES 320,000 in overdue receivables from Client ABC (15 days past due)"
    }
  ],
  "recommendations": [
    "Follow up invoices older than 30 days immediately",
    "Negotiate extended payment terms with top 3 vendors",
    "Review discretionary spending and defer non-essential purchases"
  ]
}
```

## Source

- Implementation: `src/services/riskEngine.js` (`scoreCashFlowRisk`, `buildEarlyWarnings`)
