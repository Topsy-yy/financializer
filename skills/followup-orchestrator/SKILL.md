# Skill: Followup Orchestrator

## Purpose
Convert findings into trackable tasks for founder + accountant.

## Task generation logic
- For each checklist item with `count > 0`, create action item with:
  - `task`
  - `owner` (founder/accountant)
  - `priority` (urgent/normal)
  - `due_in_days` (3 if high risk, else 7)

## Delivery channels
1. Persist report JSON
2. Persist action CSV for Google Sheets import
3. Optional notification through Avalanche CLI

## Avalanche example
```bash
avalanche notify --to founder@company.com,accountant@company.com --message "Risk score 74/100. 6 fixes pending."
```
