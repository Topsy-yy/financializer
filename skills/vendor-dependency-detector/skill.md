---
name: Vendor Dependency Detector
description: Identify excessive dependence on suppliers and procurement concentration risks. Answers the question "What happens if this supplier disappears tomorrow?"
dependencies: node>=18
---

# Vendor Dependency Detector

## Purpose

Identify excessive dependence on suppliers and procurement concentration risks.

## Business Value

Answers: **"What happens if this supplier disappears tomorrow?"**

## Responsibilities

### Analyze

- **Vendor spend distribution** — How procurement spend is distributed across all vendors
- **Single-vendor exposure** — Percentage of total spend going to the largest vendor
- **Procurement concentration** — Whether the top 3 vendors control an outsized share of spend

### Detect

- **Supplier dominance** — Any single vendor receiving > 50% of total procurement spend
- **Procurement imbalance** — Top 3 vendors collectively receiving > 80% of total spend

## Inputs

```json
{
  "vendors": [
    {
      "name": "Supplier ABC",
      "category": "raw_materials"
    }
  ],
  "expenses": [
    {
      "vendor": "Supplier ABC",
      "amount": 320000,
      "date": "2026-01-10",
      "category": "raw_materials"
    }
  ],
  "bills": [
    {
      "vendor": "Supplier ABC",
      "amount": 320000,
      "date": "2026-01-10",
      "status": "paid"
    }
  ]
}
```

## Outputs

```json
{
  "vendor_risk_score": 65,
  "concentration": {
    "top_vendor": {
      "name": "Supplier ABC",
      "spend": 320000,
      "percentage": 58
    },
    "top_3_percentage": 85,
    "total_vendors": 7,
    "total_spend": 551724
  },
  "findings": [
    {
      "type": "supplier_dominance",
      "severity": "high",
      "description": "Supplier ABC received 58% of all procurement spending this month",
      "vendor": "Supplier ABC",
      "percentage": 58
    },
    {
      "type": "procurement_imbalance",
      "severity": "medium",
      "description": "Top 3 vendors account for 85% of total procurement spend",
      "top_3_percentage": 85
    }
  ]
}
```

## Concentration Thresholds

| Threshold | Classification | Severity |
|---|---|---|
| Any vendor > 50% of spend | Supplier dominance | 🔴 High |
| Any vendor > 30% of spend | Elevated dependency | 🟠 Medium |
| Top 3 vendors > 80% of spend | Procurement imbalance | 🟠 Medium |
| All vendors < 30% | Healthy diversification | 🟢 Low |

## Risk Implications

- **Price manipulation** — A dominant vendor can raise prices knowing the business has no alternatives
- **Supply disruption** — If the vendor fails or is delayed, operations halt
- **Audit red flag** — Auditors and investors view single-vendor dependency as a governance weakness

## Source

- Data source: `transactions[].counterparty`, `transactions[].amount` (expense transactions)
