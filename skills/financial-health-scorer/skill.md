---
name: Financial Health Scorer
description: Convert findings from all analysis skills into a single executive-level financial health assessment. Creates the dashboard headline metric (0-100).
dependencies: node>=18
---

# Financial Health Scorer

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
      "weight": "<from registry>",
      "raw_score": 55,
      "weighted_contribution": 16.5
    },
    "fraud_risk": {
      "weight": "<from registry>",
      "raw_score": 65,
      "weighted_contribution": 13.0
    },
    "revenue_health": {
      "weight": "<from registry>",
      "raw_score": 88,
      "weighted_contribution": 17.6
    },
    "vendor_health": {
      "weight": "<from registry>",
      "raw_score": 35,
      "weighted_contribution": 5.25
    },
    "customer_health": {
      "weight": "<from registry>",
      "raw_score": 28,
      "weighted_contribution": 4.2
    }
  }
}
```

## Dashboard Mapping

- Populates the **Health Score** KPI card (`#kpi-health`)
- Determines the color class (`text-emerald`, `text-amber`, `text-red`)
- Drives the FinGuard AI Summary headline

## Source

- Composite of all analysis layer outputs
