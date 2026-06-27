# FinGuard AI Financial Controller

FinGuard AI is a skills-based financial control platform for SMEs. It ingests monthly finance data, detects risk patterns, scores business health, and generates practical management actions founders can execute immediately.

## Solution Overview

Most SMEs do not fail because data is unavailable. They fail because risk signals are hidden inside fragmented accounting records.

FinGuard AI solves this by acting as a virtual financial controller that:

- pulls monthly accounting data from Zoho/direct APIs
- translates raw records into risk findings and trend intelligence
- produces founder-friendly executive summaries
- outputs trackable follow-up actions with priorities and owners
- keeps an auditable report trail in JSON, CSV, and text

## What This App Delivers

- Monthly financial risk review in one workflow
- Unified visibility across cash flow, revenue, customers, and vendors
- Early warnings for anomalies and concentration risk
- Financial health score (0-100) for fast decision-making
- Action center with concrete next steps and due windows
- Optional Avalanche integration for notifications and contract deployment workflows

## Core Features

### 1) Data Ingestion and Validation

- Zoho/direct API ingestion with environment-driven configuration
- OAuth start/callback flow for Zoho account connection
- Mock data mode for local demos and offline development
- Ingestion diagnostics for missing or incomplete datasets

### 2) Risk and Anomaly Detection

- duplicate transaction detection
- round-number and outlier pattern checks
- mixed personal/business spending signals
- unreconciled account and missing-field checks
- severity-tagged findings for triage

### 3) Cash Flow Intelligence

- cash runway estimation
- burn and net cash analysis
- liquidity pressure indicators
- cash trajectory warnings

### 4) Revenue and Concentration Intelligence

- revenue trend and growth direction summary
- customer concentration analysis
- vendor dependency analysis
- top counterparty exposure visibility

### 5) Health Scoring and Recommendations

- weighted financial health scoring
- consolidated risk posture by month
- recommendation engine for priority actions
- founder-friendly executive report generation

### 6) Follow-Up Operations

- action item generation from findings
- owner assignment and due-day logic
- export-ready CSV action plans
- timestamped report artifacts for audit trail

### 7) Conversational and Dashboard Experience

- web dashboard for overview and drill-down pages
- monthly review trigger from API/UI
- chat endpoint for context-aware Q&A on review data

### 8) Optional Avalanche Capabilities

- optional notifications integration
- contract template listing
- controlled contract deployment endpoint (allowlist + deployment toggle)
- deployment history tracking

## Skills Implemented

The solution is organized as modular skills under `skills/`:

- financial-controller-core
- zoho-fetcher
- fraud-and-errors-detector
- cashflow-risk-analyzer
- revenue-intelligence
- vendor-dependency-detector
- customer-concentration-detector
- financial-health-scorer
- recommendation-engine
- executive-report-generator
- followup-orchestrator

## API Surface

Base path: `/api`

- `GET /health`
- `GET /profile`
- `POST /profile`
- `GET /oauth/zoho/start`
- `GET /oauth/zoho/callback`
- `POST /monthly-review`
- `GET /health-score`
- `GET /cashflow`
- `GET /revenue`
- `GET /anomalies`
- `GET /vendors`
- `GET /customers`
- `GET /actions`
- `POST /executive-report`
- `POST /chat`
- `GET /avalanche/contracts/templates`
- `POST /avalanche/contracts/deploy`
- `GET /avalanche/contracts/deployments`

## Tech Stack

- Node.js + Express
- dotenv configuration
- ethers.js for on-chain interactions
- static frontend served from `public/`

## Project Structure

- `src/server.js`: app bootstrap and API mount
- `src/routes/api.js`: API endpoints and orchestration glue
- `src/services/`: ingestion, risk, reporting, follow-up, and Avalanche services
- `skills/`: modular capability definitions
- `public/`: dashboard UI assets
- `data/reports/`: generated reports, action CSVs, and deployment logs

## Quick Start

1. Install dependencies

```bash
npm install
```

2. Create environment file

```bash
cp .env.example .env
```

3. Start in development mode

```bash
npm run dev
```

4. Open

`http://localhost:8080`

## Environment Configuration

Use `.env.example` as your template. Key settings include:

- runtime: `PORT`, `APP_BASE_URL`, `MOCK_REQUIRED_INTEGRATIONS`
- Zoho direct/OAuth: `ZOHO_DIRECT_API_URL`, `ZOHO_API_KEY`, `ZOHO_OAUTH_*`
- business profile: `BUSINESS_NAME`, `USER_NAME`, `BUSINESS_ADDRESS`
- risk hints and alerts: `BUSINESS_OWNER_KEYWORDS`, `ALERT_EMAILS`
- Avalanche optional settings: `ENABLE_AVALANCHE`, `AVALANCHE_*`, `ENABLE_AVALANCHE_CONTRACT_DEPLOY`

## Output Artifacts

Monthly reviews generate timestamped files in `data/reports/`:

- `{reportId}-report.json`
- `{reportId}-report.txt`
- `{reportId}-actions.csv`

Contract deployment events are appended to:

- `data/reports/contract-deployments.jsonl`

## Typical Flow

1. Connect profile and integrations (Zoho, optional wallet)
2. Trigger monthly review for a target month
3. Review health score, anomalies, and concentration signals
4. Export actions and assign owners
5. Use chat for quick, contextual follow-up questions

## Notes

- This platform provides decision support and risk indicators, not legal or audit conclusions.
- Keep secrets in `.env` and never commit live credentials.
