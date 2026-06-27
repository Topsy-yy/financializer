---
name: Financial Health Scorer
description: Convert findings from all analysis skills into a single executive-level financial health assessment. Creates the dashboard headline metric (0-100).
dependencies: node>=18
---

# Financial Health Scorer

## Purpose

Convert findings from all analysis skills into a single executive-level financial health assessment.

## Business Value

Creates the **dashboard headline metric** — a single number (0–100) that tells the founder "How healthy is my business right now?"

## Responsibilities

### Aggregate

- **Fraud indicators** — Count and severity of detected anomalies
- **Cash flow risk** — Runway, burn rate, liquidity status
- **Revenue stability** — Growth direction and volatility
- **Vendor dependency** — Procurement concentration score
- **Customer dependency** — Revenue concentration score
- **Data quality** — Missing fields, unreconciled accounts

### Generate

- **Weighted score** — Composite 0–100 metric
- **Risk category** — Human-readable classification
- **Executive summary** — One-sentence assessment

## Inputs

```json
{
  "fraud_results": {
    "risk_score": 35,
    "total_findings": 5,
    "high_severity": 2
  },
  "cashflow_results": {
    "cash_runway_days": 43,
    "risk_level": "medium",
    "net_cash_flow": 130000
  },
  "revenue_results": {
    "growth_rate": 11.8,
    "growth_direction": "up"
  },
  "vendor_results": {
    "vendor_risk_score": 65,
    "top_vendor_percentage": 58
  },
  "customer_results": {
    "customer_risk_score": 72,
    "top_customer_percentage": 53
  }
}
```

## Outputs

```json
{
  "overall_score": 61,
  "risk_category": "Fair",
  "summary": "Business is operationally stable but faces concentration risks in both vendors and customers that could amplify cash flow pressure.",
  "components": {
    "cashflow_health": {
      "weight": 0.30,
      "raw_score": 55,
      "weighted_contribution": 16.5
    },
    "fraud_risk": {
      "weight": 0.20,
      "raw_score": 65,
      "weighted_contribution": 13.0
    },
    "revenue_health": {
      "weight": 0.20,
      "raw_score": 88,
      "weighted_contribution": 17.6
    },
    "vendor_health": {
      "weight": 0.15,
      "raw_score": 35,
      "weighted_contribution": 5.25
    },
    "customer_health": {
      "weight": 0.15,
      "raw_score": 28,
      "weighted_contribution": 4.2
    }
  }
}
```

## Scoring Formula

### Component Weights

| Component | Weight | Source Skill |
|---|---|---|
| Cash Flow Health | 30% | cashflow-risk-analyzer |
| Fraud & Error Risk | 20% | fraud-and-errors-detector |
| Revenue Health | 20% | revenue-intelligence |
| Vendor Health | 15% | vendor-dependency-detector |
| Customer Health | 15% | customer-concentration-detector |

### Calculation

```
overall_score = Σ (component_score × weight)
```

Each component score is derived as `100 - risk_score` from its source skill. The result is clamped to `[0, 100]`.

### Risk Category Classification

| Score Range | Category | Dashboard Color |
|---|---|---|
| 80–100 | Excellent | 🟢 Emerald |
| 60–79 | Good | 🟢 Emerald |
| 40–59 | Fair | 🟠 Amber |
| 20–39 | Poor | 🔴 Red |
| 0–19 | Critical | 🔴 Red |

## Dashboard Mapping

- Populates the **Health Score** KPI card (`#kpi-health`)
- Determines the color class (`text-emerald`, `text-amber`, `text-red`)
- Drives the FinGuard AI Summary headline

## Source

- Composite of all analysis layer outputs
