---
name: Fraud and Errors Detector
description: Detect accounting anomalies and operational red flags that may indicate bookkeeping errors, policy violations, or potential fraud indicators. Indicator engine only — never claims fraud occurred.
dependencies: node>=18
---

# Fraud and Errors Detector

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

Detect accounting anomalies and operational red flags that may indicate bookkeeping errors, policy violations, or potential fraud indicators.

> **Positioning:** This is an indicator engine only. It flags patterns that warrant human review. It **never** claims fraud occurred.

## Responsibilities

Detect:

- **Duplicate transactions** — Same date, amount, and counterparty appearing more than once
- **Duplicate invoices** — Invoice numbers or references that repeat across entries
- **Round-number payments** — Material payments for an exact round amount. The materiality threshold is currency-aware and scales with the business; the engine resolves it per period.
- **Statistical outliers** — Transactions far above the period's own distribution, computed within a single currency.
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
  "owner_keywords": ["<resolved from the rules registry>"]
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

## Source

- Implementation: `src/services/riskEngine.js`
