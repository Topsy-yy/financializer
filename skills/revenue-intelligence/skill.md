---
name: Revenue Intelligence
description: Analyze revenue performance and identify growth or decline patterns affecting business stability. Answers the question "Is revenue getting healthier or worse?"
dependencies: node>=18
---

# Revenue Intelligence

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

## Trend Classification

| Growth Rate | Classification | Dashboard Display |
|---|---|---|
| > +10% | Strong growth | 🟢 `+X%` in Emerald |
| +1% to +10% | Moderate growth | 🟢 `+X%` in Emerald |
| -1% to +1% | Flat | 🟠 `~0%` in Amber |
| -10% to -1% | Moderate decline | 🟠 `-X%` in Amber |
| < -10% | Sharp decline | 🔴 `-X%` in Red |

## Source

- Data source: `statements.cashFlow.inflow`, `statements.profitAndLoss.netIncome`
- Dashboard mapping: `#kpi-revenue`
