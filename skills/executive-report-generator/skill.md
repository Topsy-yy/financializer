---
name: Executive Report Generator
description: Convert technical findings into founder-friendly language that can be understood without accounting expertise. Translates financial metrics, risk scores, and anomaly findings into plain-language summaries and priority actions.
dependencies: node>=18
---

# Executive Report Generator

## Purpose

Convert technical findings into founder-friendly language that can be understood without accounting expertise.

## Responsibilities

### Translate

- **Financial metrics** — Convert raw numbers into meaningful business context
- **Risk scores** — Explain what a "65/100 risk score" actually means for the business
- **Anomaly findings** — Describe technical detections in plain language
- **Trend analysis** — Frame percentage changes as business narratives

### Into

- **Plain-language summaries** — One-paragraph overviews a founder can read in 30 seconds
- **Executive insights** — Key takeaways ranked by business impact
- **Priority actions** — Top 3–5 things the founder should do this week

## Translation Examples

### Example 1: Customer Concentration

**Technical Finding:**
```
Customer concentration ratio = 58%
```

**Executive Explanation:**
> More than half of your revenue comes from a single customer. If this customer leaves, the business could experience a significant cash flow shock. Consider diversifying your customer base over the next quarter.

### Example 2: Cash Runway

**Technical Finding:**
```
runwayMonths = 1.4, severity = <resolved by the engine>
```

**Executive Explanation:**
> At your current spending rate, you have approximately 43 days of cash remaining. This is a critical situation that requires immediate action — either accelerate incoming payments or reduce spending this week.

### Example 3: Duplicate Transactions

**Technical Finding:**
```
duplicates.length = 3, total_amount = 135000
```

**Executive Explanation:**
> We found 3 transactions that appear to have been recorded twice, totaling KES 135,000. This could be a bookkeeping error or a sign that payments were processed twice. Please review these with your accountant.

## Inputs

```json
{
  "all_findings": [
    {
      "source": "cashflow-risk-analyzer",
      "type": "low_runway",
      "severity": "high",
      "description": "Cash runway has fallen to 43 days",
      "data": { "runway_days": 43, "monthly_burn": 720000 }
    },
    {
      "source": "vendor-dependency-detector",
      "type": "supplier_dominance",
      "severity": "high",
      "description": "Supplier ABC received 58% of procurement",
      "data": { "vendor": "Supplier ABC", "percentage": 58 }
    }
  ],
  "risk_scores": {
    "overall": 61,
    "cashflow": 65,
    "fraud": 35,
    "revenue": 12,
    "vendor": 65,
    "customer": 72
  },
  "recommendations": [
    {
      "priority": "critical",
      "action": "Contact customers with overdue invoices within 48 hours"
    }
  ]
}
```

## Outputs

```json
{
  "executive_summary": "Your business is operationally stable but faces two critical risks this month: cash runway has dropped to 43 days, and more than half your procurement goes through a single supplier. Both issues are manageable if addressed this week.",
  "management_report": {
    "headline": "ABC Traders: January 2026 — Moderate Risk",
    "health_score": "<score>/100 (<category from registry>)",
    "key_insights": [
      "Cash will run out in approximately 6 weeks at current burn rate",
      "One supplier controls 58% of your procurement — this is a supply chain risk",
      "Revenue grew 12% this month — a positive trend to sustain",
      "3 duplicate transactions found totaling KES 135,000 — likely bookkeeping errors"
    ],
    "what_is_working": [
      "Revenue is growing at 12% month-over-month",
      "No fraud indicators detected beyond duplicate postings",
      "Customer base is diversified across 12 active accounts"
    ],
    "what_needs_attention": [
      "Cash runway is below the engine's warning threshold",
      "Supplier ABC has too much pricing power",
      "3 transactions need reconciliation review"
    ]
  },
  "priority_actions": [
    {
      "rank": 1,
      "action": "Follow up on all invoices older than 30 days TODAY",
      "why": "This is the fastest way to extend your cash runway"
    },
    {
      "rank": 2,
      "action": "Get quotes from 2 alternative suppliers this week",
      "why": "Reduce dependency on Supplier ABC before they raise prices"
    },
    {
      "rank": 3,
      "action": "Ask your accountant to review the 3 duplicate transactions",
      "why": "KES 135,000 may have been paid twice"
    }
  ]
}
```

## Tone Guidelines

- Use **plain English**, not accounting jargon
- Lead with **impact**, not metrics ("You could run out of cash" not "Runway is 1.4 months")
- Be **specific** — name vendors, customers, and amounts
- Be **honest but constructive** — highlight what's working alongside what's broken
- Use **urgency** appropriately — "today" for critical, "this week" for high, "this month" for medium

## Source

- Sits at the end of the pipeline, after recommendation-engine, before followup-orchestrator
- Dashboard mapping: `#ai-summary-content`
