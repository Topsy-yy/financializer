# Skill: Zoho Fetcher

## Purpose
Pull monthly accounting data from a provided direct Zoho URL.

## Suggested execution
Use curl:

```bash
curl -sS "$ZOHO_DIRECT_API_URL?month=YYYY-MM" \
  -H "Authorization: Bearer $ZOHO_API_KEY" \
  -H "Content-Type: application/json"
```

## Validation checks
- `transactions` is an array
- `journalEntries` is an array
- `reconciliations` is an array
- `statements.cashFlow`, `statements.balanceSheet` exist

## Failure handling
- Non-200: capture status + body
- Empty array responses: flag as data-quality issue
- Missing fields: return checklist entry `data_ingestion_gap`
