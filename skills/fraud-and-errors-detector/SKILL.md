# Skill: Fraud And Errors Detector

## Purpose
Detect high-risk accounting anomalies with clear evidence.

## Rules (v1)
1. Duplicate transactions: same date + amount + counterparty/description
2. Round-number payments: amount >= 10000 and divisible by 1000
3. Unusual transactions: amount > mean + 2*std
4. Missing entries: null date/account/description/amount fields
5. Mixed funds: owner/personal keywords found in payment description/counterparty
6. Unreconciled accounts: reconciliation status is false

## Output format
For each rule return:
- `count`
- `severity`
- `evidence` (top examples)
- `recommended_fix`

## Notes
- This is a fraud indicator screen, not proof of fraud.
- Minimize false positives by including evidence.
