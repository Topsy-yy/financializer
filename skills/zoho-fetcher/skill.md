---
name: Zoho Fetcher
description: Retrieve and validate monthly financial data from Zoho Books and normalize it into a consistent structure for downstream analysis. Use when ingesting accounting records, validating schemas, or generating ingestion diagnostics.
dependencies: node>=18
---

# Zoho Fetcher

## Purpose

Retrieve and validate monthly financial data from Zoho Books and normalize it into a consistent structure for downstream analysis.

## Responsibilities

- Fetch accounting records from Zoho Books Direct API
- Validate schema integrity of returned data
- Detect missing datasets (transactions, journals, reconciliations, statements)
- Standardize field names across all record types
- Generate ingestion diagnostics for data quality reporting

## Inputs

```json
{
  "zoho_direct_api_url": "https://books.zoho.com/api/v3/...",
  "api_key": "Bearer token for authentication",
  "period_start": "2026-01-01",
  "period_end": "2026-01-31"
}
```

## Outputs

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
  "reconciliations": [
    {
      "account": "Main Bank",
      "isReconciled": true
    }
  ],
  "cashFlow": {
    "inflow": 850000,
    "outflow": 720000
  },
  "balanceSheet": {
    "cashAndEquivalents": 430000
  },
  "ingestion_diagnostics": [
    {
      "check": "transactions_present",
      "status": "pass",
      "detail": "Retrieved 47 transactions for 2026-01"
    },
    {
      "check": "journal_entries_present",
      "status": "pass",
      "detail": "Retrieved 12 journal entries"
    },
    {
      "check": "reconciliation_status",
      "status": "warning",
      "detail": "2 of 5 accounts are unreconciled"
    }
  ]
}
```

## Validation Checks

The ingestion diagnostics module runs the following checks before releasing data downstream:

| Check | Pass Condition | Failure Action |
|---|---|---|
| `transactions_present` | At least 1 transaction returned | Block analysis, report empty dataset |
| `journal_entries_present` | At least 1 journal entry returned | Warn, allow partial analysis |
| `reconciliation_status` | All accounts reconciled | Warn, flag unreconciled accounts |
| `cashflow_statement` | Both `inflow` and `outflow` are numeric | Block cash flow analysis |
| `balance_sheet` | `cashAndEquivalents` is numeric | Block runway calculation |
| `field_completeness` | All required fields populated | Warn per missing field |

## Mock Data Generation

When `zoho_direct_api_url` is not configured, the skill generates realistic mock data from `data/sample-zoho-response.json` with the following variance model:

- **Standard months** (Jan, Feb, Apr, May, Jul, Aug, Oct): Positive net cash flow, clean data
- **Quarter-close months** (Mar, Sep): Elevated expenses, some anomalies injected
- **Critical months** (Jun, Nov): Dramatically reduced inflow, inflated outflow, duplicate transactions injected

## Success Criteria

- ✅ Data available and retrieved successfully
- ✅ Structure valid against expected schema
- ✅ All required fields populated
- ✅ Ready for downstream analysis skills

## Configuration

| Env Variable | Purpose |
|---|---|
| `ZOHO_DIRECT_API_URL` | Full URL to the Zoho data endpoint |
| `ZOHO_API_KEY` | Bearer token for authentication |
| `MOCK_REQUIRED_INTEGRATIONS` | Set `true` to use mock data engine |

## Source

- Implementation: `src/services/zohoClient.js`
