const config = require("../config");

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function lastDayOfMonth(year, monthIndex1to12) {
  return new Date(Date.UTC(year, monthIndex1to12, 0)).getUTCDate();
}

function monthRange(period) {
  const [yearStr, monthStr] = String(period).split("-");
  const year = Number(yearStr);
  const monthIndex = Number(monthStr);
  const start = `${period}-01`;
  const end = `${period}-${String(lastDayOfMonth(year, monthIndex)).padStart(2, "0")}`;
  return { start, end };
}

function withinRange(dateStr, start, end) {
  if (!dateStr) return false;
  return dateStr >= start && dateStr <= end;
}

async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: config.zohoOauthClientId,
    client_secret: config.zohoOauthClientSecret,
    grant_type: "refresh_token"
  });

  const response = await fetch(config.zohoOauthTokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });

  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error(
      `Could not refresh Zoho access token (${data.error || response.status}). Try reconnecting Zoho Books in Settings.`
    );
  }
  return data; // { access_token, expires_in, api_domain, token_type }
}

async function ensureFreshToken(profile) {
  const now = Date.now();
  const stillValid = profile.zohoApiKey && profile.zohoTokenExpiresAt && now < profile.zohoTokenExpiresAt - 60 * 1000;
  if (stillValid) return;

  if (!profile.zohoRefreshToken) {
    throw new Error("No Zoho refresh token on file. Please reconnect Zoho Books in Settings.");
  }

  const refreshed = await refreshAccessToken(profile.zohoRefreshToken);
  profile.zohoApiKey = refreshed.access_token;
  profile.zohoTokenExpiresAt = now + (toNumber(refreshed.expires_in, 3600) * 1000);
  if (refreshed.api_domain) profile.zohoApiDomain = refreshed.api_domain;
}

function apiBase(profile) {
  return `${profile.zohoApiDomain || "https://www.zohoapis.com"}/books/v3`;
}

async function zohoGet(profile, path, params) {
  const url = new URL(apiBase(profile) + path);
  if (profile.zohoOrgId) url.searchParams.set("organization_id", profile.zohoOrgId);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value != null && value !== "") url.searchParams.set(key, value);
  });

  const response = await fetch(url.toString(), {
    headers: { authorization: `Zoho-oauthtoken ${profile.zohoApiKey}` }
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || `Zoho Books API error (${response.status}) on ${path}`);
  }
  return data;
}

async function resolveOrganizationId(profile) {
  if (profile.zohoOrgId) return profile.zohoOrgId;

  const data = await zohoGet(profile, "/organizations", {});
  const orgs = data.organizations || [];
  const defaultOrg = orgs.find((org) => org.is_default_org) || orgs[0];
  if (!defaultOrg) {
    throw new Error("No Zoho Books organization found for this account.");
  }
  profile.zohoOrgId = defaultOrg.organization_id;
  return profile.zohoOrgId;
}

async function fetchAllPages(profile, path, listKey, params) {
  const items = [];
  let page = 1;

  while (page <= 20) {
    const data = await zohoGet(profile, path, { ...params, page, per_page: 200 });
    const list = data[listKey] || [];
    items.push(...list);

    const context = data.page_context || {};
    if (!context.has_more_page) break;
    page += 1;
  }

  return items;
}

// Zoho Books bank-feed transactions carry their reconciliation workflow state
// in `status`. "uncategorized" is the one state that means "nobody has looked
// at this yet" -- everything else (categorized/matched/excluded/manually
// added) means it's been handled. See https://www.zoho.com/books/api/v3/bank-transactions/
// (filter_by=Status.Uncategorized/Categorized/Matched/Excluded/ManuallyAdded).
function isBankTransactionReconciled(tx) {
  return String(tx.status || "").toLowerCase() !== "uncategorized";
}

async function fetchMonthlyDataFromZoho(profile, period) {
  await ensureFreshToken(profile);
  await resolveOrganizationId(profile);

  const { start, end } = monthRange(period);
  const dateParams = { date_start: start, date_end: end };

  const [invoicesRaw, billsRaw, expensesRaw, bankAccounts, bankTransactionsRaw] = await Promise.all([
    fetchAllPages(profile, "/invoices", "invoices", dateParams),
    fetchAllPages(profile, "/bills", "bills", dateParams),
    fetchAllPages(profile, "/expenses", "expenses", dateParams),
    zohoGet(profile, "/bankaccounts", {}).then((data) => data.bankaccounts || []),
    fetchAllPages(profile, "/banktransactions", "banktransactions", dateParams).catch(() => [])
  ]);

  // Defensive client-side re-filter: Zoho's date-range params aren't fully
  // documented for every endpoint, so don't trust the server-side filter alone.
  const invoices = invoicesRaw.filter((inv) => withinRange(inv.date, start, end));
  const bills = billsRaw.filter((bill) => withinRange(bill.date, start, end));
  const expenses = expensesRaw.filter((exp) => withinRange(exp.date, start, end));
  const bankTransactions = bankTransactionsRaw.filter((tx) => withinRange(tx.date, start, end));

  const transactions = [];

  invoices.forEach((inv) => {
    transactions.push({
      date: inv.date,
      account: "Accounts Receivable",
      amount: toNumber(inv.total),
      description: `Invoice ${inv.invoice_number || inv.invoice_id || ""}`.trim(),
      counterparty: inv.customer_name || "Unknown Customer"
    });
  });

  bills.forEach((bill) => {
    transactions.push({
      date: bill.date,
      account: "Accounts Payable",
      amount: -toNumber(bill.total),
      description: `Bill ${bill.bill_number || bill.bill_id || ""}`.trim(),
      counterparty: bill.vendor_name || "Unknown Vendor"
    });
  });

  expenses.forEach((exp) => {
    // Zoho's own `is_personal` flag (set by the bookkeeper/owner in Zoho Books)
    // is a far more reliable personal-expense signal than keyword-guessing on
    // the description -- use it directly when present.
    const receiptName = String(exp.expense_receipt_name || "").trim();
    transactions.push({
      date: exp.date,
      account: exp.paid_through_account_name || "Main Bank",
      amount: -toNumber(exp.total != null ? exp.total : exp.amount),
      description: exp.description || exp.account_name || "Expense",
      counterparty: exp.vendor_name || exp.account_name || "Unmapped",
      isPersonal: Boolean(exp.is_personal),
      hasReceipt: receiptName.length > 0
    });
  });

  // Outstanding receivables/payables -- `balance` is Zoho's own "unpaid amount"
  // field, so this reflects real invoice/bill payment status, not an estimate.
  const receivables = invoices
    .filter((inv) => toNumber(inv.balance) > 0)
    .map((inv) => ({
      customer: inv.customer_name || "Unknown Customer",
      amount: toNumber(inv.balance),
      dueDate: inv.due_date || null,
      status: inv.status || "unpaid"
    }));

  const payables = bills
    .filter((bill) => toNumber(bill.balance) > 0)
    .map((bill) => ({
      vendor: bill.vendor_name || "Unknown Vendor",
      amount: toNumber(bill.balance),
      dueDate: bill.due_date || null,
      status: bill.status || "unpaid"
    }));

  const reconciliations = bankTransactions.map((tx) => ({
    accountName: tx.account_name || tx.from_account_name || tx.to_account_name || "Bank Account",
    date: tx.date,
    amount: toNumber(tx.amount),
    description: tx.description || tx.reference_number || "Bank transaction",
    isReconciled: isBankTransactionReconciled(tx)
  }));

  const inflow = invoices.reduce((sum, inv) => sum + toNumber(inv.total), 0);
  const outflow =
    bills.reduce((sum, bill) => sum + toNumber(bill.total), 0) +
    expenses.reduce((sum, exp) => sum + toNumber(exp.total != null ? exp.total : exp.amount), 0);
  const cashAndEquivalents = bankAccounts.reduce(
    (sum, acc) => sum + toNumber(acc.bcy_balance != null ? acc.bcy_balance : acc.balance),
    0
  );

  return {
    company: { name: profile.businessName || "Zoho Business", country: "" },
    period,
    transactions,
    journalEntries: [],
    reconciliations,
    receivables,
    payables,
    statements: {
      cashFlow: { inflow: Math.round(inflow), outflow: Math.round(outflow) },
      profitAndLoss: { netIncome: Math.round(inflow - outflow) },
      balanceSheet: { cashAndEquivalents: Math.round(cashAndEquivalents) }
    },
    meta: {
      source: "zoho-books",
      invoiceCount: invoices.length,
      billCount: bills.length,
      expenseCount: expenses.length,
      bankAccountCount: bankAccounts.length,
      bankTransactionCount: bankTransactions.length,
      fetchedAt: new Date().toISOString()
    }
  };
}

module.exports = {
  fetchMonthlyDataFromZoho,
  resolveOrganizationId,
  ensureFreshToken
};
