---
name: Revenue Intelligence
description: Analyze revenue performance and identify growth or decline patterns affecting business stability. Answers the question "Is revenue getting healthier or worse?"
dependencies: node>=18
---

# Revenue Intelligence

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

Analyze revenue performance and identify growth or decline patterns affecting business stability.

## Business Value

Answers: **"Is revenue getting healthier or worse?"**

## Responsibilities

### Measure

- **Revenue growth** — Month-over-month and year-over-year percentage change in total income
- **Revenue decline** — Periods where income is falling below previous baselines
- **Customer activity** — Number of paying customers and average revenue per customer
- **Seasonal trends** — Identification of months that consistently over- or underperform
- **Revenue volatility** — Standard deviation of monthly revenue indicating predictability

### Detect

- **Lost customers** — Customers who paid in previous periods but not in the current one
- **Shrinking customers** — Customers whose payments are declining period-over-period
- **Revenue concentration shifts** — Changes in which customers contribute the most

## Inputs

```json
{
  "invoices": [
    {
      "customer": "Client ABC",
      "amount": 250000,
      "date": "2026-01-10",
      "status": "paid"
    }
  ],
  "payments": [
    {
      "customer": "Client ABC",
      "amount": 250000,
      "date": "2026-01-15",
      "method": "bank_transfer"
    }
  ],
  "customers": [
    {
      "name": "Client ABC",
      "since": "2024-03",
      "segment": "enterprise"
    }
  ]
}
```

## Outputs

```json
{
  "revenue_summary": {
    "total_revenue": 850000,
    "previous_period": 760000,
    "growth_rate": 11.8,
    "growth_direction": "up",
    "active_customers": 12,
    "average_revenue_per_customer": 70833,
    "revenue_volatility": "low"
  },
  "findings": [
    {
      "type": "revenue_growth",
      "severity": "info",
      "description": "Revenue increased 11.8% compared to the previous period"
    },
    {
      "type": "lost_customer",
      "severity": "medium",
      "description": "Customer 'Old Client XYZ' has not invoiced in 3 months"
    }
  ],
  "trends": [
    {
      "period": "2026-01",
      "revenue": 850000,
      "direction": "up"
    },
    {
      "period": "2025-12",
      "revenue": 760000,
      "direction": "down"
    }
  ]
}
```

## Source

- Data source: `statements.cashFlow.inflow`, `statements.profitAndLoss.netIncome`
- Dashboard mapping: `#kpi-revenue`
