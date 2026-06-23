---
name: Cashflow Risk Analyzer
description: Assess liquidity health and identify future cash flow risks before they become operational problems. Answers the question "Will the company run out of cash?"
dependencies: node>=18
---

# Cashflow Risk Analyzer

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

## Risk Scoring

### Risk Score Composition (0–100)

| Condition | Points Added |
|---|---|
| Baseline | +20 |
| Net cash flow is negative | +25 |
| Monthly burn > 0 | +15 |
| Runway < 6 months | +25 |
| Runway < 3 months | +15 |

Score is clamped to `[0, 100]`.

### Risk Level Classification

| Score Range | Risk Level | Dashboard Color |
|---|---|---|
| 0–39 | `low` | 🟢 Emerald |
| 40–69 | `medium` | 🟠 Amber |
| 70–100 | `high` | 🔴 Red |

### Runway Calculation

```
netCashFlow = inflow - outflow
monthlyBurn = (outflow > inflow) ? outflow - inflow : 0
runwayMonths = (monthlyBurn > 0) ? cashReserves / monthlyBurn : 12
runwayDays = runwayMonths × 30
```

## Source

- Implementation: `src/services/riskEngine.js` (`scoreCashFlowRisk`, `buildEarlyWarnings`)
