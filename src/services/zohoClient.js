const config = require("../config");
const fs = require("fs");
const path = require("path");

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseMonthPeriod(month, fallbackPeriod) {
  const source = month || fallbackPeriod || new Date().toISOString().slice(0, 7);
  const match = String(source).match(/^(\d{4})-(\d{2})$/);

  if (!match) {
    const now = new Date();
    return {
      year: now.getUTCFullYear(),
      monthIndex: now.getUTCMonth() + 1,
      period: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`
    };
  }

  const year = Number(match[1]);
  const monthIndex = Math.max(1, Math.min(12, Number(match[2])));
  return { year, monthIndex, period: `${year}-${String(monthIndex).padStart(2, "0")}` };
}

function formatDate(year, monthIndex, sourceDate) {
  const parts = String(sourceDate || "").split("-");
  const day = Math.max(1, Math.min(28, Number(parts[2] || 1)));
  return `${year}-${String(monthIndex).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function loadMockMonthlyData(month) {
  const samplePath = path.resolve(process.cwd(), "data", "sample-zoho-response.json");
  const payload = JSON.parse(fs.readFileSync(samplePath, "utf-8"));
  const normalized = normalizePayload(payload);

  const { year, monthIndex, period } = parseMonthPeriod(month, normalized.period);
  const mock = JSON.parse(JSON.stringify(normalized));
  mock.period = period;

  mock.transactions = mock.transactions.map((tx, index) => {
    const amount = toNumber(tx.amount);
    const amountMultiplier = 0.86 + monthIndex * 0.025 + index * 0.035;
    return {
      ...tx,
      date: formatDate(year, monthIndex, tx.date),
      amount: Math.max(100, Math.round(amount * amountMultiplier))
    };
  });

  const isCriticalMonth = [6, 11].includes(monthIndex); // June and Nov have bad cashflow
  const hasAnomalies = [3, 6, 9, 11].includes(monthIndex); // Quarters and Nov have duplicates

  if (mock.transactions.length >= 3) {
    if (hasAnomalies) {
      // Intentionally insert a duplicate transaction
      mock.transactions[2] = {
        ...mock.transactions[1],
        date: mock.transactions[1].date
      };
    } else {
      mock.transactions[2] = {
        ...mock.transactions[2],
        amount: mock.transactions[2].amount + monthIndex * 137,
        description: `${mock.transactions[2].description} - adjusted`
      };
    }
  }

  if ([3, 6, 9, 12].includes(monthIndex)) {
    mock.transactions.push({
      date: `${year}-${String(monthIndex).padStart(2, "0")}-25`,
      account: "Main Bank",
      amount: 65000 + monthIndex * 700,
      description: "Quarter close adjustment",
      counterparty: "Advisory Partner"
    });
  }

  mock.journalEntries = mock.journalEntries.map((je, index) => {
    const amount = toNumber(je.amount);
    const amountMultiplier = 0.9 + monthIndex * 0.02 + index * 0.03;
    return {
      ...je,
      date: formatDate(year, monthIndex, je.date),
      amount: Math.max(100, Math.round(amount * amountMultiplier))
    };
  });

  mock.reconciliations = mock.reconciliations.map((reconciliation) => ({
    ...reconciliation,
    isReconciled: monthIndex % 3 !== 0
  }));

  const baseInflow = toNumber(mock.statements.cashFlow?.inflow);
  const baseOutflow = toNumber(mock.statements.cashFlow?.outflow);
  const baseCash = toNumber(mock.statements.balanceSheet?.cashAndEquivalents);

  const inflow = Math.round(baseInflow * (isCriticalMonth ? 0.6 : (0.95 + monthIndex * 0.02)));
  const outflow = Math.round(baseOutflow * (isCriticalMonth ? 1.4 : (0.8 + ((monthIndex + 4) % 12) * 0.02)));
  const quarterPressure = hasAnomalies ? 35000 : 0;

  mock.statements.cashFlow = {
    ...mock.statements.cashFlow,
    inflow,
    outflow: outflow + quarterPressure
  };

  mock.statements.profitAndLoss = {
    ...mock.statements.profitAndLoss,
    netIncome: inflow - (outflow + quarterPressure) - (isCriticalMonth ? 45000 : 15000)
  };

  mock.statements.balanceSheet = {
    ...mock.statements.balanceSheet,
    cashAndEquivalents: Math.max(25000, Math.round(baseCash * (isCriticalMonth ? 0.3 : (0.8 + monthIndex * 0.05))))
  };

  if (monthIndex >= 10) {
    mock.company = {
      ...mock.company,
      season: "year-end pressure"
    };
  }

  return mock;
}

function normalizePayload(payload) {
  return {
    company: payload.company || {},
    period: payload.period || null,
    transactions: Array.isArray(payload.transactions) ? payload.transactions : [],
    journalEntries: Array.isArray(payload.journalEntries) ? payload.journalEntries : [],
    reconciliations: Array.isArray(payload.reconciliations) ? payload.reconciliations : [],
    statements: {
      cashFlow: payload.statements?.cashFlow || {},
      profitAndLoss: payload.statements?.profitAndLoss || {},
      balanceSheet: payload.statements?.balanceSheet || {}
    }
  };
}

async function fetchMonthlyData({ directApiUrl, apiKey, month }) {
  const endpoint = directApiUrl || config.zohoDirectApiUrl;
  if (!endpoint) {
    return loadMockMonthlyData(month);
  }

  const url = new URL(endpoint);
  if (month) {
    url.searchParams.set("month", month);
  }

  const headers = {
    "content-type": "application/json"
  };

  if (apiKey || config.zohoApiKey) {
    headers.authorization = `Bearer ${apiKey || config.zohoApiKey}`;
  }

  const response = await fetch(url.toString(), { method: "GET", headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Zoho fetch failed (${response.status}): ${body}`);
  }

  const json = await response.json();
  return normalizePayload(json);
}

module.exports = {
  fetchMonthlyData
};
