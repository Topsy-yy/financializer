---
name: Follow-Up Orchestrator
description: Transform detected risks into trackable actions that business owners can execute. Generates tasks with priorities, due dates, and owners. Exports JSON, CSV, and notification payloads.
dependencies: node>=18
---

# Follow-Up Orchestrator

## Purpose

Transform detected risks into trackable actions that business owners can execute.

## Responsibilities

### Generate

- **Tasks** — Concrete, assignable action items derived from findings
- **Priorities** — `urgent` for high-severity findings, `normal` for medium/low
- **Due dates** — 3 days for urgent, 7 days for normal
- **Owners** — `accountant` for reconciliation items, `founder` for all others

### Export

- **JSON** — Full structured report for programmatic access (`{reportId}-report.json`)
- **CSV** — Action items for spreadsheet import (`{reportId}-actions.csv`)
- **Notification payloads** — Avalanche network notifications with risk summary

## Inputs

```json
{
  "findings": [
    {
      "source": "fraud-and-errors-detector",
      "type": "duplicate_transaction",
      "severity": "high",
      "description": "Transaction on 2026-01-15 for KES 45,000 appears twice"
    },
    {
      "source": "cashflow-risk-analyzer",
      "type": "low_runway",
      "severity": "high",
      "description": "Cash runway has fallen to 43 days"
    }
  ],
  "risk_level": "medium"
}
```

## Outputs

```json
{
  "tasks": [
    {
      "task": "Resolve: Potential duplicates",
      "owner": "founder",
      "priority": "urgent",
      "dueInDays": 3,
      "source_finding": "duplicate_transaction"
    },
    {
      "task": "Resolve: Unreconciled accounts",
      "owner": "accountant",
      "priority": "normal",
      "dueInDays": 7,
      "source_finding": "unreconciled_accounts"
    }
  ],
  "csv_export": "data/reports/2026-01-actions.csv",
  "notifications": [
    {
      "channel": "avalanche",
      "recipients": ["founder@company.com"],
      "message": "Financial review for ABC Traders (2026-01) | Risk: 65/100 (medium) | Actions: 4",
      "sent": true
    }
  ],
  "exports": {
    "actions_csv": "data/reports/{reportId}-actions.csv",
    "report_json": "data/reports/{reportId}-report.json",
    "report_txt": "data/reports/{reportId}-report.txt"
  }
}
```

## Task Generation Rules

| Finding Severity | Priority | Due In | Owner |
|---|---|---|---|
| High | `urgent` | 3 days | `founder` (or `accountant` for reconciliation) |
| Medium | `normal` | 7 days | `founder` |
| Low | `normal` | 14 days | `accountant` |

## Configuration

| Env Variable | Purpose |
|---|---|
| `ENABLE_AVALANCHE` | Enable Avalanche CLI notifications |
| `ALERT_EMAILS` | Comma-separated notification recipients |
| `AVALANCHE_CLI_PATH` | Path to Avalanche CLI binary |

## Source

- Implementation: `src/services/followUpWorkflow.js`
