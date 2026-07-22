---
name: Fraud and Errors Detector
description: Detect accounting anomalies and operational red flags that may indicate bookkeeping errors, policy violations, or potential fraud indicators. Indicator engine only — never claims fraud occurred.
dependencies: node>=18
---

# Fraud and Errors Detector

## Purpose

Detect accounting anomalies and operational red flags that may indicate bookkeeping errors, policy violations, or potential fraud indicators.

> **Positioning:** This is an indicator engine only. It flags patterns that warrant human review. It **never** claims fraud occurred.

## Responsibilities

Detect:

- **Duplicate transactions** — Same date, amount, and counterparty appearing more than once
- **Duplicate invoices** — Invoice numbers or references that repeat across entries
- **Round-number payments** — Amounts ≥ 10,000 that are exact multiples of 1,000 (common fraud signal)
- **Statistical outliers** — Transactions exceeding mean + 2σ of the dataset
- **Missing fields** — Transactions without date, account, amount, or description
- **Missing references** — Journal entries without debit/credit accounts or amounts
- **Personal/business expense mixing** — Zoho Books' own `is_personal` flag on an expense when available, otherwise counterparty/description matching owner keywords
- **Missing receipts** — Expenses with no receipt attached (Zoho `expense_receipt_name` empty)
- **Unreconciled transactions** — Bank-feed transactions whose Zoho Books status is `uncategorized`
- **Overdue receivables/payables** — Invoices/bills with an outstanding `balance` past their `due_date`
- **Unusual transaction timing** — Entries posted on weekends, holidays, or outside business hours

## Inputs

```json
{
  "transactions": [
    {
      "date": "2026-01-15",
      "account": "Main Bank",
      "amount": 45000,
      "description": "Supplier payment",
      "counterparty": "Vendor ABC"
    }
  ],
  "journalEntries": [
    {
      "date": "2026-01-15",
      "debitAccount": "Cost of Sales",
      "creditAccount": "Bank",
      "amount": 45000,
      "description": "Supplier payment posting"
    }
  ],
  "owner_keywords": ["personal", "owner", "family", "home"]
}
```

## Outputs

```json
{
  "findings": [
    {
      "type": "duplicate_transaction",
      "severity": "high",
      "description": "Transaction on 2026-01-15 for KES 45,000 to Vendor ABC appears twice",
      "evidence": {
        "original": { "date": "2026-01-15", "amount": 45000 },
        "duplicate": { "date": "2026-01-15", "amount": 45000 }
      }
    },
    {
      "type": "round_number_payment",
      "severity": "medium",
      "description": "Payment of KES 100,000 is a suspicious round number",
      "evidence": { "amount": 100000, "counterparty": "Unknown Vendor" }
    },
    {
      "type": "mixed_funds",
      "severity": "high",
      "description": "Transaction description contains owner keyword 'personal'",
      "evidence": { "description": "Personal car fuel", "amount": 12000 }
    }
  ],
  "risk_score": 35,
  "summary": {
    "total_findings": 3,
    "high_severity": 2,
    "medium_severity": 1,
    "low_severity": 0
  }
}
```

## Detection Thresholds

| Detection Type | Trigger Condition | Severity |
|---|---|---|
| Duplicate transaction | Same `date + amount + counterparty` | High |
| Duplicate invoice | Same invoice reference | High |
| Round-number payment | `amount >= 10,000` AND `amount % 1,000 === 0` | Medium |
| Statistical outlier | `amount > mean + 2σ` | Medium |
| Missing fields | Required field is null/empty | Low |
| Mixed funds | `is_personal === true`, else owner keyword in description/counterparty | High |
| Missing documentation | Expense has no receipt attached | Low |
| Unreconciled | Bank transaction status is `uncategorized` | High |
| Overdue receivable | Invoice `balance > 0` past `due_date` | High |
| Overdue payable | Bill `balance > 0` past `due_date` | Medium |
| Weekend transaction | Date falls on Saturday/Sunday | Low |

## Risk Score Calculation

```
risk_score = (high_count × 10) + (medium_count × 5) + (low_count × 2)
clamped to [0, 100]
```

## Source

- Implementation: `src/services/riskEngine.js`
