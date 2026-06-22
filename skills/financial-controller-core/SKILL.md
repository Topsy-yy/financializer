# Skill: Financial Controller Core

## Purpose
Coordinate monthly financial risk reviews for SMEs and produce an actionable report.

## Inputs (prefilled)
- `zoho_direct_api_url`
- `business_name`
- `business_address`
- `owner_keywords`
- `alert_recipients`
- `avalanche_cli_path`

## Workflow
1. Fetch monthly financial data from Zoho endpoint.
2. Validate required fields are present.
3. Run detection rules for errors/fraud indicators.
4. Score cash-flow risk and severity.
5. Build founder-friendly report + checklist.
6. Trigger follow-up notifications via Avalanche CLI (optional).

## Constraints
- Start narrow: focus on high-signal accounting issues first.
- Avoid acting as a legal or statutory auditor.
- Always return assumptions and confidence notes.

## Output contract
Return JSON with:
- `risk` (score, severity, runway)
- `summary` (plain language)
- `checklist` (items to fix)
- `details` (evidence snippets)
- `next_actions` (owner + due days)
