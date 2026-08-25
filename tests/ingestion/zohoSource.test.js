// INGESTION — the authoritative Zoho source and its transport.
//
// Every test stubs httpFetch, so no network call is made and no credential is
// required. The stub records requests, which is how pagination, retry, timeout
// and token-refresh behaviour are asserted rather than assumed.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createZohoTransport, ZohoAuthError } = require("../../src/ingestion/sources/zohoTransport");
const { createZohoSource, fetchPeriod } = require("../../src/ingestion/sources/zohoSource");
const ingestion = require("../../src/ingestion");
const { LEVEL } = require("../../src/domain/model/dataQuality");

const NOW = Date.parse("2026-06-15T00:00:00Z");

function profile(over = {}) {
  return Object.assign({
    zohoApiKey: "access-token",
    zohoRefreshToken: "refresh-token",
    zohoTokenExpiresAt: NOW + 3600_000,
    zohoOrgId: "org-1",
    zohoApiDomain: "https://www.zohoapis.com"
  }, over);
}

/** Build a stub fetch from a path->handler map. Records every call. */
function stubFetch(routes, calls = []) {
  return async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.pathname, params: Object.fromEntries(u.searchParams), init });
    const patterns = Object.keys(routes).sort((a, b) => b.length - a.length);
    for (const pattern of patterns) {
      const handler = routes[pattern];
      if (u.pathname.includes(pattern)) {
        const out = await handler(u, init, calls);
        return Object.assign({
          ok: true, status: 200,
          headers: { get: () => null },
          json: async () => out.body ?? out
        }, out.ok === undefined ? {} : { ok: out.ok, status: out.status || (out.ok ? 200 : 500) });
      }
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) };
  };
}

const page = (key, items, hasMore = false) => ({ [key]: items, page_context: { has_more_page: hasMore } });
const emptyRoutes = {
  "/invoices": async () => page("invoices", []),
  "/bills": async () => page("bills", []),
  "/expenses": async () => page("expenses", []),
  "/bankaccounts": async () => ({ bankaccounts: [] }),
  "/banktransactions": async () => page("banktransactions", []),
  "/reports/": async () => ({})
};

// ── Successful ingestion ─────────────────────────────────────────
test("[Z1] successful ingestion normalizes records with full provenance", async () => {
  const routes = Object.assign({}, emptyRoutes, {
    "/invoices": async () => page("invoices", [{
      invoice_id: "INV-1", invoice_number: "0001", date: "2026-05-10", total: 5000,
      balance: 5000, due_date: "2026-05-20", customer_name: "BigCo",
      currency_code: "KES", last_modified_time: "2026-05-11T09:00:00Z"
    }]),
    "/expenses": async () => page("expenses", [{
      expense_id: "EXP-1", date: "2026-05-12", total: 1200, vendor_name: "City Power",
      currency_code: "KES", has_attachment: false, last_modified_time: "2026-05-12T10:00:00Z"
    }])
  });
  const p = profile();
  const res = await fetchPeriod(p, "2026-05", { httpFetch: stubFetch(routes), now: NOW });

  assert.equal(res.failures.length, 0);
  assert.equal(res.data.transactions.length, 2);

  const inv = res.data.transactions.find((t) => t.txnType === "invoice");
  assert.equal(inv.sourceRecordId, "INV-1", "source record id preserved");
  assert.equal(inv.sourceSystem, "zoho-books");
  assert.equal(inv.sourceUpdatedAt, "2026-05-11T09:00:00Z", "source timestamp preserved");
  assert.equal(inv.currency, "KES", "currency preserved");
  assert.ok(inv.amount < 0, "an invoice is an inflow");

  const exp = res.data.transactions.find((t) => t.txnType === "expense");
  assert.equal(exp.hasReceipt, false, "receipt presence retained where reported");
  assert.equal(res.data.period, "2026-05");
  assert.equal(res.data.meta.source, "zoho-books");
  assert.ok(res.data.meta.fetchedAt, "retrieval timestamp recorded");
  assert.equal(res.data.receivables.length, 1, "outstanding invoice becomes a receivable");
});

// ── Pagination ───────────────────────────────────────────────────
test("[Z2] pagination follows every page to exhaustion", async () => {
  const calls = [];
  let served = 0;
  const routes = Object.assign({}, emptyRoutes, {
    "/invoices": async (u) => {
      const pageNo = Number(u.searchParams.get("page"));
      served++;
      const items = Array.from({ length: 200 }, (_, i) => ({
        invoice_id: `INV-${pageNo}-${i}`, date: "2026-05-10", total: 10, customer_name: "C", balance: 0
      }));
      return page("invoices", items, pageNo < 3); // 3 pages total
    }
  });
  const res = await fetchPeriod(profile(), "2026-05", { httpFetch: stubFetch(routes, calls), now: NOW });

  assert.equal(served, 3, "all three pages requested");
  assert.equal(res.data.transactions.filter((t) => t.txnType === "invoice").length, 600,
    "no records dropped (the old client hard-stopped at 20 pages)");
  assert.deepEqual(res.truncated, [], "nothing reported as truncated");
});

test("[Z3] hitting the safety bound REPORTS truncation instead of hiding it", async () => {
  const routes = Object.assign({}, emptyRoutes, {
    "/invoices": async (u) => page("invoices",
      [{ invoice_id: `INV-${u.searchParams.get("page")}`, date: "2026-05-10", total: 1, customer_name: "C", balance: 0 }],
      true) // always claims more
  });
  const res = await fetchPeriod(profile(), "2026-05", {
    httpFetch: stubFetch(routes), now: NOW, maxPages: 3
  });
  assert.deepEqual(res.truncated, ["invoices"], "truncation is surfaced");

  const env = await ingestion.ingestPeriod({
    period: "2026-05", now: NOW,
    zoho: createZohoSource(profile(), { httpFetch: stubFetch(routes), now: NOW, maxPages: 3 })
  });
  assert.ok(env.warnings.some((w) => w.code === "pagination_truncated"),
    "the caller is warned the period is incomplete");
});

// ── Transient failure and retry ──────────────────────────────────
test("[Z4] a transient 503 is retried with backoff and then succeeds", async () => {
  let attempts = 0;
  const routes = Object.assign({}, emptyRoutes, {
    "/invoices": async () => {
      attempts++;
      if (attempts < 3) return { ok: false, status: 503, body: { message: "Service Unavailable" } };
      return { ok: true, status: 200, body: page("invoices", [{ invoice_id: "INV-9", date: "2026-05-02", total: 100, customer_name: "C", balance: 0 }]) };
    }
  });
  const res = await fetchPeriod(profile(), "2026-05", {
    httpFetch: stubFetch(routes), now: NOW, baseBackoffMs: 1
  });
  assert.equal(attempts, 3, "two retries then success");
  assert.equal(res.failures.length, 0);
  assert.equal(res.data.transactions.length, 1);
});

test("[Z5] a transient network error is retried", async () => {
  let attempts = 0;
  const routes = Object.assign({}, emptyRoutes, {
    "/bills": async () => {
      attempts++;
      if (attempts < 2) { const e = new TypeError("fetch failed"); e.cause = { code: "ECONNRESET" }; throw e; }
      return page("bills", []);
    }
  });
  const res = await fetchPeriod(profile(), "2026-05", { httpFetch: stubFetch(routes), now: NOW, baseBackoffMs: 1 });
  assert.equal(attempts, 2);
  assert.equal(res.failures.length, 0);
});

test("[Z6] a permanent 403 is NOT retried and is reported per dataset", async () => {
  let attempts = 0;
  const routes = Object.assign({}, emptyRoutes, {
    "/banktransactions": async () => { attempts++; return { ok: false, status: 403, body: { message: "Forbidden" } }; }
  });
  const res = await fetchPeriod(profile(), "2026-05", { httpFetch: stubFetch(routes), now: NOW, baseBackoffMs: 1 });
  assert.equal(attempts, 1, "4xx is not retried");
  const failed = res.failures.find((f) => f.dataset === "banktransactions");
  assert.ok(failed, "the failure is reported, not swallowed");
  assert.match(failed.message, /Forbidden/);
  // CRITICAL: a failed bank-transaction fetch must NOT read as "all reconciled".
  assert.equal(res.data.reconciliations, undefined,
    "not retrieved => undefined, never [] (the old `.catch(() => [])` bug)");
});

test("[Z7] a failed dataset propagates to the quality report as FAILED", async () => {
  const routes = Object.assign({}, emptyRoutes, {
    "/banktransactions": async () => ({ ok: false, status: 403, body: { message: "Forbidden" } })
  });
  const env = await ingestion.ingestPeriod({
    period: "2026-05", now: NOW,
    zoho: createZohoSource(profile(), { httpFetch: stubFetch(routes), now: NOW, baseBackoffMs: 1 })
  });
  assert.ok(env.failures.some((f) => f.dataset === "banktransactions"));
  assert.equal(env.quality.datasets.reconciliations, LEVEL.INSUFFICIENT_EVIDENCE,
    "reconciliations are reported as not-present, not as clean");
  assert.ok(env.warnings.some((w) => w.code === "partial_ingestion"));
});

// ── Timeout ──────────────────────────────────────────────────────
test("[Z8] a hung request aborts on the configured timeout", async () => {
  const routes = Object.assign({}, emptyRoutes, {
    "/invoices": async (u, init) => new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => {
        const e = new Error("The operation was aborted"); e.name = "AbortError"; reject(e);
      });
    })
  });
  const res = await fetchPeriod(profile(), "2026-05", {
    httpFetch: stubFetch(routes), now: NOW, timeoutMs: 30, maxRetries: 1, baseBackoffMs: 1
  });
  const failed = res.failures.find((f) => f.dataset === "invoices");
  assert.ok(failed, "the timeout surfaces as a dataset failure");
  assert.match(failed.message, /Network failure|abort/i);
});

// ── Token refresh ────────────────────────────────────────────────
test("[Z9] an expired token is refreshed before the first request", async () => {
  const calls = [];
  const p = profile({ zohoTokenExpiresAt: NOW - 1000 }); // already expired
  const routes = Object.assign({}, emptyRoutes, {
    "/oauth/v2/token": async () => ({ body: { access_token: "fresh-token", expires_in: 3600 } })
  });
  await fetchPeriod(p, "2026-05", { httpFetch: stubFetch(routes, calls), now: NOW });
  assert.equal(p.zohoApiKey, "fresh-token", "profile is updated with the new token");
  assert.ok(p.zohoTokenExpiresAt > NOW, "expiry advanced");
});

test("[Z10] a 401 mid-sync triggers exactly one re-auth then retries the call", async () => {
  let refreshes = 0;
  let invoiceCalls = 0;
  const p = profile();
  const routes = Object.assign({}, emptyRoutes, {
    "/oauth/v2/token": async () => { refreshes++; return { body: { access_token: "rotated", expires_in: 3600 } }; },
    "/invoices": async () => {
      invoiceCalls++;
      if (invoiceCalls === 1) return { ok: false, status: 401, body: { message: "Unauthorized" } };
      return { ok: true, status: 200, body: page("invoices", []) };
    }
  });
  const res = await fetchPeriod(p, "2026-05", { httpFetch: stubFetch(routes), now: NOW, baseBackoffMs: 1 });
  assert.equal(refreshes, 1, "re-authenticated once");
  assert.equal(invoiceCalls, 2, "the original call was retried");
  assert.equal(res.failures.length, 0);
});

test("[Z11] a refresh failure is a hard auth error, not a partial result", async () => {
  const p = profile({ zohoTokenExpiresAt: NOW - 1000 });
  const routes = Object.assign({}, emptyRoutes, {
    "/oauth/v2/token": async () => ({ ok: false, status: 400, body: { error: "invalid_grant" } })
  });
  await assert.rejects(
    () => fetchPeriod(p, "2026-05", { httpFetch: stubFetch(routes), now: NOW }),
    (e) => e instanceof ZohoAuthError
  );
});

test("[Z12] auth failure at the boundary yields FAILED with no fabricated data", async () => {
  const p = profile({ zohoTokenExpiresAt: NOW - 1000 });
  const routes = Object.assign({}, emptyRoutes, {
    "/oauth/v2/token": async () => ({ ok: false, status: 400, body: { error: "invalid_grant" } })
  });
  const env = await ingestion.ingestPeriod({
    period: "2026-05", now: NOW,
    zoho: createZohoSource(p, { httpFetch: stubFetch(routes), now: NOW })
  });
  assert.equal(env.data, null);
  assert.equal(env.quality.level, LEVEL.FAILED);
  assert.match(env.quality.summary, /Could not retrieve/);
});

// ── Malformed responses ──────────────────────────────────────────
test("[Z13] a malformed Zoho payload does not produce phantom records", async () => {
  const routes = Object.assign({}, emptyRoutes, {
    // Right shape, wrong contents: nulls, missing ids, unparsable amounts.
    "/invoices": async () => page("invoices", [
      { invoice_id: "INV-OK", date: "2026-05-10", total: "not-a-number", customer_name: null, balance: null },
      { /* no id, no date */ }
    ]),
    "/bills": async () => ({ bills: "not-an-array", page_context: {} })
  });
  const res = await fetchPeriod(profile(), "2026-05", { httpFetch: stubFetch(routes), now: NOW });
  // The undated record is filtered out by the period filter; the unparsable
  // amount becomes 0 rather than NaN, and never a fabricated value.
  const invoices = res.data.transactions.filter((t) => t.txnType === "invoice");
  assert.equal(invoices.length, 1);
  assert.equal(Object.is(invoices[0].amount, -0) ? 0 : invoices[0].amount, 0, "unparsable total becomes 0, not NaN");
  assert.equal(Number.isNaN(invoices[0].amount), false);
  assert.deepEqual(res.data.transactions.filter((t) => t.txnType === "bill"), [],
    "a non-array list yields no records rather than throwing");
});

// ── Multi-currency ───────────────────────────────────────────────
test("[Z14] multi-currency records keep their own currency and are reported", async () => {
  const routes = Object.assign({}, emptyRoutes, {
    "/invoices": async () => page("invoices", [
      { invoice_id: "I-KES", date: "2026-05-03", total: 100000, currency_code: "KES", customer_name: "A", balance: 0 },
      { invoice_id: "I-USD", date: "2026-05-04", total: 1000, currency_code: "USD", exchange_rate: 129.5, customer_name: "B", balance: 0 }
    ])
  });
  const res = await fetchPeriod(profile(), "2026-05", { httpFetch: stubFetch(routes), now: NOW });
  const byId = Object.fromEntries(res.data.transactions.map((t) => [t.sourceRecordId, t]));
  assert.equal(byId["I-KES"].currency, "KES");
  assert.equal(byId["I-USD"].currency, "USD");
  assert.equal(byId["I-USD"].exchangeRate, 129.5, "the rate is preserved, not applied");
  assert.deepEqual(res.data.meta.currencies, ["KES", "USD"], "multi-currency is reported, not converted");
});

// ── Statement retrieval ──────────────────────────────────────────
test("[Z15] statements are RETRIEVED when Zoho returns the report", async () => {
  const routes = Object.assign({}, emptyRoutes, {
    /* `/reports/cashflow`. This stub used to say `cashflowstatement`, which
       mirrored the path the source requested and so passed — while the real
       Zoho API answers that path with a 404. The test agreed with the code and
       both were wrong. */
    "/reports/cashflow": async () => ({ cash_inflow: 900000, cash_outflow: 600000 }),
    "/reports/profitandloss": async () => ({ total_income: 900000, net_profit: 300000 }),
    "/reports/balancesheet": async () => ({ cash_and_equivalents: 1200000 })
  });
  const res = await fetchPeriod(profile(), "2026-05", { httpFetch: stubFetch(routes), now: NOW });
  assert.equal(res.data.statements.cashFlow.inflow, 900000);
  assert.equal(res.data.statements.cashFlow.is_derived, false, "retrieved, not computed");
  assert.equal(res.data.statements.balanceSheet.cashAndEquivalents, 1200000);
  assert.equal(res.data.meta.statementsDerived.cashFlow, false);
});

/* THE SHAPE ZOHO ACTUALLY SENDS.
   Captured from the live API. The payload is not `{sections: […]}` and the
   figures are not flat keys — each report is an ARRAY of named sections under a
   report-specific key, nesting further sections under `account_transactions`.
   The old reader looked for `report.sections | report.report | report.data`,
   found none of them, returned null every time, and silently fell through to
   deriving every statement from transactions. Reports were fetched, parsed and
   thrown away. */
const REAL_CASHFLOW = {
  code: 0, message: "success",
  cash_flow: [
    { name: "Beginning Cash Balance", total: -385000 },
    { name: "Net Change in cash", total: 0 },
    { name: "Ending Cash Balance", total: -385000 }
  ]
};
const REAL_PL = {
  code: 0, message: "success",
  profit_and_loss: [
    { name: "Gross Profit", total: 732000, account_transactions: [] },
    { name: "Operating Profit", total: 115000, account_transactions: [] },
    { name: "Net Profit/Loss", total: 115000, account_transactions: [] }
  ]
};
const REAL_BS = {
  code: 0, message: "success",
  balance_sheet: [
    { name: "Assets", total: 115000, account_transactions: [
      { name: "Cash and Equivalents", total: 250000 } ] },
    { name: "Liabilities & Equities", total: 115000, account_transactions: [] }
  ]
};

test("[Z15b] the REAL Zoho report shape is read, not silently re-derived", async () => {
  const routes = Object.assign({}, emptyRoutes, {
    /* Real activity, as in the live June period. Without transactions the
       cash-flow statement is correctly NOT emitted at all, rather than
       fabricating {inflow: 0, outflow: 0} — so a derivation test needs
       something to derive from. */
    "/invoices": async () => page("invoices", [
      { invoice_id: "I-1", date: "2026-05-05", total: 90000, customer_name: "BigCo", balance: 0 }
    ]),
    "/expenses": async () => page("expenses", [
      { expense_id: "E-1", date: "2026-05-06", total: 30000, vendor_name: "Rivera" }
    ]),
    "/reports/cashflow": async () => REAL_CASHFLOW,
    "/reports/profitandloss": async () => REAL_PL,
    "/reports/balancesheet": async () => REAL_BS
  });
  const res = await fetchPeriod(profile(), "2026-05", { httpFetch: stubFetch(routes), now: NOW });
  const s = res.data.statements;

  // Read from the books, matched on Zoho's own section names.
  assert.equal(s.profitAndLoss.is_derived, false, "the P&L was RETRIEVED");
  assert.equal(s.profitAndLoss.netIncome, 115000, "Net Profit/Loss, read not recomputed");
  assert.equal(s.balanceSheet.is_derived, false, "the balance sheet was RETRIEVED");
  assert.equal(s.balanceSheet.cashAndEquivalents, 250000,
    "found by recursing into account_transactions");

  /* Zoho's cash flow report states beginning/net-change/ending balance and does
     NOT split the period into gross inflow and outflow, so those two stay
     derived — and say so. Inventing a split from a net figure would be a
     fabrication, not a fix. */
  assert.equal(s.cashFlow.is_derived, true,
    "inflow/outflow are not in the report, so they remain derived and labelled");
});

test("[Z15c] a cash figure from Zoho is LABELLED, never left to a default", async () => {
  /* cashPosition.readCashPosition() treats an UNLABELLED figure as observed,
     on the stated assumption that any source which derives a value says so.
     This source said nothing at all, so its cash inherited "observed" by
     default rather than by decision. The label here is still "observed" — a
     sum of real bank balances is an aggregation of measurements, not an
     inference like derived_from_net_income — but it is now stated. */
  const routes = Object.assign({}, emptyRoutes, {
    "/bankaccounts": async () => ({ bankaccounts: [{ account_id: "b1", balance: 40000 }] })
  });
  const res = await fetchPeriod(profile(), "2026-05", { httpFetch: stubFetch(routes), now: NOW });
  const sheet = res.data.statements.balanceSheet;

  assert.equal(sheet.cashAndEquivalentsBasis, "observed",
    "the basis is stated by the source, not inferred by the reader");

  const { readCashPosition } = require("../../src/domain/model/cashPosition");
  const pos = readCashPosition(sheet);
  assert.equal(pos.available, true, "a real bank balance is still usable");
  assert.equal(pos.value, 40000);
});

test("[Z16] when a report is unavailable the derived figure is LABELLED derived", async () => {
  // The audit found statements silently computed locally and presented as if
  // retrieved. They may still be derived — but never silently.
  // Derivation needs something to derive FROM, so this period has activity.
  const withActivity = Object.assign({}, emptyRoutes, {
    "/invoices": async () => page("invoices", [
      { invoice_id: "I-1", date: "2026-05-05", total: 50000, customer_name: "A", balance: 0 }
    ]),
    "/expenses": async () => page("expenses", [
      { expense_id: "E-1", date: "2026-05-06", total: 20000, vendor_name: "B" }
    ])
  });
  const res = await fetchPeriod(profile(), "2026-05", { httpFetch: stubFetch(withActivity), now: NOW });
  assert.equal(res.data.statements.cashFlow.is_derived, true, "computed locally");
  assert.equal(res.data.statements.cashFlow.inflow, 50000, "derived from the invoice");
  assert.equal(res.data.statements.cashFlow.outflow, 20000, "derived from the expense");
  assert.equal(res.data.meta.statementsDerived.cashFlow, true);

  const env = await ingestion.ingestPeriod({
    period: "2026-05", now: NOW,
    zoho: createZohoSource(profile(), { httpFetch: stubFetch(withActivity), now: NOW })
  });
  assert.ok(env.warnings.some((w) => w.code === "statement_derived"),
    "the caller is told the statement was computed, not retrieved");
});

test("[Z16b] a statement with nothing to derive from is ABSENT, not zero-filled", async () => {
  // Emitting {inflow: 0, outflow: 0} would assert "no money moved this month"
  // when the truth is "we have no evidence either way".
  const res = await fetchPeriod(profile(), "2026-05", { httpFetch: stubFetch(emptyRoutes), now: NOW });
  assert.equal(res.data.statements.cashFlow, undefined);
  assert.equal(res.data.statements.profitAndLoss, undefined);
});

// ── Empty but legitimate ─────────────────────────────────────────
test("[Z17] a legitimately empty period is INSUFFICIENT_EVIDENCE, not a healthy month", async () => {
  const env = await ingestion.ingestPeriod({
    period: "2026-05", now: NOW,
    zoho: createZohoSource(profile(), { httpFetch: stubFetch(emptyRoutes), now: NOW })
  });
  assert.equal(env.source, "zoho-books");
  assert.equal(env.quality.level, LEVEL.INSUFFICIENT_EVIDENCE);
  assert.equal(env.quality.scoringReliable, false);
});

// ── Invalid period ───────────────────────────────────────────────
test("[Z18] an invalid period is rejected before any HTTP call is made", async () => {
  const calls = [];
  await assert.rejects(
    () => ingestion.ingestPeriod({
      period: "2026-99", now: NOW,
      zoho: createZohoSource(profile(), { httpFetch: stubFetch(emptyRoutes, calls), now: NOW })
    }),
    /Invalid accounting period/
  );
  assert.equal(calls.length, 0, "no request was issued for an invalid period");
});
