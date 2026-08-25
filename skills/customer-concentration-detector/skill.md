---
name: Customer Concentration Detector
description: Identify overreliance on specific customers that could threaten future revenue stability. Answers the question "Which customer could cripple the company if they leave?"
dependencies: node>=18
---

# Customer Concentration Detector

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

Identify overreliance on specific customers that could threaten future revenue stability.

## Business Value

Answers: **"Which customer could cripple the company if they leave?"**

## Responsibilities

### Calculate

- **Revenue contribution by customer** — Total revenue attributed to each customer as a percentage of total income
- **Customer dependency ratios** — How much revenue would be lost if the top 1, 2, or 3 customers churned

### Detect

- **Customer concentration** — Any single customer contributing > 50% of total revenue
- **Revenue concentration** — Top 3 customers contributing > 80% of total revenue

## Inputs

```json
{
  "customers": [
    {
      "name": "Client ABC",
      "since": "2024-03",
      "segment": "enterprise"
    }
  ],
  "invoices": [
    {
      "customer": "Client ABC",
      "amount": 450000,
      "date": "2026-01-10",
      "status": "paid"
    }
  ],
  "payments": [
    {
      "customer": "Client ABC",
      "amount": 450000,
      "date": "2026-01-15"
    }
  ]
}
```

## Outputs

```json
{
  "customer_risk_score": 72,
  "concentration": {
    "top_customer": {
      "name": "Client ABC",
      "revenue": 450000,
      "percentage": 53
    },
    "top_3_percentage": 87,
    "total_customers": 12,
    "total_revenue": 850000
  },
  "findings": [
    {
      "type": "customer_concentration",
      "severity": "high",
      "description": "Client ABC contributes 53% of total revenue. Losing this customer would be catastrophic.",
      "customer": "Client ABC",
      "percentage": 53
    },
    {
      "type": "revenue_concentration",
      "severity": "medium",
      "description": "Top 3 customers account for 87% of total revenue",
      "top_3_percentage": 87
    }
  ]
}
```

## Risk Implications

- **Revenue cliff** — Losing the top customer could eliminate half the business overnight
- **Negotiation weakness** — The dominant customer knows they have leverage and may demand discounts
- **Investor concern** — VCs and lenders view customer concentration as a critical funding risk
- **Accounts receivable amplification** — If a high-concentration customer also has overdue invoices, the risk multiplies

## Source

- Data source: `transactions[].counterparty`, `transactions[].amount` (income transactions)
