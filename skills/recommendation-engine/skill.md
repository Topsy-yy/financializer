---
name: Recommendation Engine
description: Convert findings from all analysis skills into specific, actionable management recommendations. Generates prioritized actions with context, timelines, and expected impact.
dependencies: node>=18
---

# Recommendation Engine

## Purpose

Convert findings into specific management actions that business owners can execute immediately.

## Responsibilities

Generate actionable recommendations from:

- **Revenue decline** — Customer outreach, contract review, collection acceleration
- **Cash flow risks** — Spending deferrals, payment term renegotiation, receivables follow-up
- **Vendor risks** — Supplier diversification, contract renegotiation, competitive bidding
- **Customer concentration** — Pipeline acceleration, service diversification, contract lock-in
- **Fraud indicators** — Investigation triggers, approval process reviews, reconciliation tasks
- **Data quality issues** — Field completion, account reconciliation, audit preparation

## Inputs

```json
{
  "findings": [
    {
      "source": "cashflow-risk-analyzer",
      "type": "low_runway",
      "severity": "high",
      "description": "Cash runway has fallen to 43 days"
    },
    {
      "source": "vendor-dependency-detector",
      "type": "supplier_dominance",
      "severity": "high",
      "description": "Supplier ABC received 58% of all procurement spending"
    },
    {
      "source": "revenue-intelligence",
      "type": "lost_customer",
      "severity": "medium",
      "description": "Customer XYZ has not invoiced in 3 months"
    }
  ],
  "risk_scores": {
    "fraud": 35,
    "cashflow": 65,
    "revenue": 12,
    "vendor": 65,
    "customer": 72
  }
}
```

## Outputs

```json
{
  "recommendations": [
    {
      "priority": "critical",
      "category": "cashflow",
      "action": "Contact customers with overdue invoices within 48 hours",
      "reason": "Cash runway is 43 days. Accelerating collections is the fastest path to extending runway.",
      "expected_impact": "Could recover KES 1.2M and extend runway by 20+ days",
      "timeline": "48 hours"
    },
    {
      "priority": "high",
      "category": "vendor",
      "action": "Request competitive quotes from 2-3 alternative suppliers for raw materials",
      "reason": "Supplier ABC controls 58% of procurement. This creates pricing and supply chain risk.",
      "expected_impact": "Reduce vendor concentration below 40% within 2 months",
      "timeline": "7 days"
    },
    {
      "priority": "medium",
      "category": "revenue",
      "action": "Reach out to Customer XYZ to understand inactivity",
      "reason": "Customer XYZ has not invoiced in 3 months. Early intervention may prevent churn.",
      "expected_impact": "Retain revenue stream worth KES 150,000/month",
      "timeline": "3 days"
    },
    {
      "priority": "medium",
      "category": "cashflow",
      "action": "Review contracts generating less than 10% margin",
      "reason": "Low-margin contracts consume resources without contributing to cash reserves.",
      "expected_impact": "Free up capacity for higher-margin work",
      "timeline": "14 days"
    }
  ]
}
```

## Recommendation Generation Rules

| Finding Type | Recommendation Template | Priority |
|---|---|---|
| `low_runway` (< 30 days) | Accelerate collections, defer spending | Critical |
| `low_runway` (30-60 days) | Follow up receivables, negotiate payables | High |
| `supplier_dominance` | Source alternative suppliers | High |
| `customer_concentration` | Diversify customer base | High |
| `lost_customer` | Customer outreach & retention | Medium |
| `duplicate_transaction` | Review and resolve duplicates | Medium |
| `mixed_funds` | Separate personal/business accounts | High |
| `revenue_decline` | Revenue recovery plan | High |
| `unreconciled_accounts` | Complete reconciliation | Medium |

## Example Output (Plain Language)

```
Revenue declining.

Recommended Actions:
• Contact Customer ABC within 48 hours.
• Review contracts generating less than 10% margin.
• Accelerate collection of invoices older than 30 days.
```

## Source

- Sits between financial-health-scorer and executive-report-generator in the pipeline
