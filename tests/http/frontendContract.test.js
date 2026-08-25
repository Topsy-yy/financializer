// FRONTEND CONTRACT — what public/app.js is allowed to assume about the API.
//
// JOB 6 recorded that the frontend had never been exercised against the new
// scoring behaviour. The JOB 7 audit found the consequences: a live crash on
// the most common insufficient-evidence case, `null` rendered as "KES 0", and
// colour logic in which `null >= 0` is true, so every unmeasured value was
// painted with the healthy branch.
//
// The frontend is NOT rewritten here (that belongs to a later job). These tests
// pin the two halves of the contract:
//
//   1. the API keeps emitting the signals the client needs to tell "unmeasured"
//      from "zero" — `available`, `unavailable_reason`, `by_currency`;
//   2. the client's own rendering helpers never turn one into the other.
//
// The client is plain browser JS with no module system, so its helpers are
// extracted from source and evaluated here rather than imported.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { startServer } = require("../helpers/server");

const APP_JS = fs.readFileSync(
  path.join(__dirname, "../../public/app.js"), "utf-8");

/** Evaluate the named top-level functions from app.js in isolation. */
function loadHelpers(names) {
  // The sentinel is a module-level `var` in app.js, so it is provided here
  // rather than extracted with each function.
  // Module-level `var`s the extracted helpers close over. Supplied here because
  // the loader extracts functions, not the surrounding module scope.
  const sandbox = {
    escapeHtml: (s) => String(s),
    // The extracted helpers call this for inline SVG; the markup is irrelevant
    // to what these tests assert, so it is stubbed like escapeHtml above.
    icon: () => "",
    UNMEASURED: "\u2014",
    SCORE_BANDS: null
  };
  names.forEach((name) => {
    const re = new RegExp(`(?:^|\\n)(?:var UNMEASURED[^\\n]*\\n)?function ${name}\\s*\\(`);
    const start = APP_JS.search(re);
    assert.notEqual(start, -1, `${name}() not found in public/app.js`);
    // Walk braces from the function's opening brace.
    const bodyStart = APP_JS.indexOf("{", APP_JS.indexOf(`function ${name}`));
    let depth = 0;
    let i = bodyStart;
    for (; i < APP_JS.length; i++) {
      if (APP_JS[i] === "{") depth++;
      else if (APP_JS[i] === "}") { depth--; if (depth === 0) break; }
    }
    const src = APP_JS.slice(APP_JS.indexOf(`function ${name}`), i + 1);
    vm.runInNewContext(src + `;this.${name} = ${name};`, sandbox);
  });
  return sandbox;
}

// The sentinel the client uses for an unmeasured value.
const UNMEASURED = "—";

// ── The client's own helpers ─────────────────────────────────────

test("[FE1] formatCurrency(null) is NOT a currency amount", () => {
  const { formatCurrency } = loadHelpers(["formatCurrency"]);
  // The defect: null rendered as "KES 0", indistinguishable from a measured
  // zero balance, on every KPI tile in the product.
  assert.equal(formatCurrency(null), UNMEASURED);
  assert.equal(formatCurrency(undefined), UNMEASURED);
  assert.equal(formatCurrency(NaN), UNMEASURED);
  assert.doesNotMatch(formatCurrency(null), /0/, "null must not render a zero");

  // A REAL zero still renders as money — the distinction is the whole point.
  assert.equal(formatCurrency(0), "KES 0");
  assert.equal(formatCurrency(1234567), "KES 1,234,567");
  assert.equal(formatCurrency(-5000), "-KES 5,000");
});

test("[FE2] formatPercent(null) is NOT 0%", () => {
  const { formatPercent } = loadHelpers(["formatPercent"]);
  // A growth rate with no prior period is unknown, not flat.
  assert.equal(formatPercent(null), UNMEASURED);
  assert.equal(formatPercent(0), "0.0%", "a measured zero is still zero");
  assert.equal(formatPercent(12.34), "12.3%");
});

test("[FE3] isMeasured() distinguishes unknown from zero, and guards colours", () => {
  const { isMeasured } = loadHelpers(["isMeasured"]);
  assert.equal(isMeasured(null), false);
  assert.equal(isMeasured(undefined), false);
  assert.equal(isMeasured(""), false);
  assert.equal(isMeasured(UNMEASURED), false, "the sentinel is not a number");
  assert.equal(isMeasured(0), true, "zero IS a measurement");
  assert.equal(isMeasured(-5), true);
  assert.equal(isMeasured(85), true);
});

test("[FE4] the client no longer contains the `null >= 0` healthy-default bug", () => {
  // `null >= 0` is TRUE in JavaScript, so every one of these painted an
  // unmeasured value with the positive branch. Each must now be guarded.
  const unguarded = [
    /\(netCF >= 0 \?/,
    /\(growth >= 0 \?/,
    /valueClass: f\.monthly_net >= 0 \?/,
    /color: s\.balance >= 0 \?/,
    /\(h\.projected_balance >= 0 \?/
  ];
  unguarded.forEach((re) =>
    assert.equal(re.test(APP_JS), false,
      `an ungated numeric comparison remains: ${re}`));
  // ...and the guard is actually present.
  assert.ok(APP_JS.includes("isMeasured("), "the client has no measured-ness guard");
});

test("[FE5] the component-score crash is fixed", () => {
  // `typeof null === 'object'`, so reading `.score` off an unmeasured component
  // threw inside an uncaught .then() and left the page on a loading skeleton.
  assert.equal(/typeof components\[key\] === 'object' \? \(components\[key\]\.score/.test(APP_JS),
    false, "the null-dereferencing expression is still present");
  assert.match(APP_JS, /raw && typeof raw === 'object'/,
    "the null-safe form is present");
});

test("[FE6] no health-score band is hardcoded in the flagship gauge", () => {
  // The client used to test for category labels ('low'/'high') that the
  // registry has never produced, so EVERY score rendered amber.
  assert.equal(/category\.toLowerCase\(\)\.includes\('low'\)/.test(APP_JS), false,
    "the dead category test is still present");
});

// ── The API keeps its side of the contract ───────────────────────

let server;
let client;

test.before(async () => {
  server = await startServer({ ALLOW_DEMO_DATA: "true" });
  client = server.client();
});
test.after(async () => { if (server) await server.stop(); });

test("[FE7] the API tells the client WHEN a value is unmeasured, not just that "
  + "it is null", async () => {
  const period = "2026-09";
  await client.upload("/api/financial-data/upload", {
    filename: "unattributed.csv",
    content: [
      "Date,Description,Amount,Counterparty",
      `${period}-03,Unattributed debit,-40000,`,
      `${period}-20,Client settlement,150000,BigCo Retail`
    ].join("\n"),
    fields: { period, currentCashBalance: 300000 }
  });
  await client.post("/api/monthly-review", { month: period, use_ai_analysis: false });

  const vendors = (await client.get("/api/vendors")).json.vendors;
  // A client cannot render this safely from the null alone — it needs the flag
  // and the reason, and both must be present.
  assert.equal(vendors.vendor_risk_score, null);
  assert.equal(vendors.available, false, "the client is told this is not a measurement");
  assert.ok(vendors.unavailable_reason, "and WHY");
  assert.equal(typeof vendors.unattributed_amount, "number",
    "and how much could not be attributed, so the notice can be specific");
});

test("[FE8] a mixed-currency response gives the client parts it CAN render", async () => {
  const period = "2026-10";
  await client.upload("/api/financial-data/upload", {
    filename: "mixed.csv",
    content: [
      "Date,Description,Amount,Counterparty,Currency",
      `${period}-04,Local supplier,-100000,Local Vendor,KES`,
      `${period}-11,Overseas supplier,-1000,Overseas Vendor,USD`
    ].join("\n"),
    fields: { period, currentCashBalance: 300000 }
  });
  await client.post("/api/monthly-review", { month: period, use_ai_analysis: false });

  const vendors = (await client.get("/api/vendors")).json.vendors;
  assert.equal(vendors.available, false);
  assert.equal(vendors.unavailable_reason, "mixed_currency");
  assert.ok(Array.isArray(vendors.by_currency) && vendors.by_currency.length >= 2,
    "the per-currency parts are supplied so the UI shows something true");
  vendors.by_currency.forEach((b) => {
    assert.ok(b.currency, "each part names its currency");
    assert.equal(typeof b.total, "number");
  });
});

test("[FE9] the client's unavailable notice renders a true statement for each "
  + "reason the API can send", () => {
  const { unavailableNotice } = loadHelpers(["formatCurrency", "formatNumber", "unavailableNotice"]);

  const mixed = unavailableNotice({
    available: false, unavailable_reason: "mixed_currency",
    by_currency: [{ currency: "KES", total: 100000 }, { currency: "USD", total: 1000 }]
  }, "Vendor concentration");
  assert.match(mixed, /more than one currency/);
  assert.match(mixed, /KES 100,000/, "the parts that ARE known are shown");
  assert.match(mixed, /USD 1,000/);
  assert.doesNotMatch(mixed, /101,000/, "the meaningless sum is never shown");

  const unattributed = unavailableNotice({
    available: false, unavailable_reason: "unattributed_transactions", unattributed_amount: 75000
  }, "Vendor concentration");
  assert.match(unattributed, /names no counterparty/);
  assert.match(unattributed, /KES 75,000/);

  // An AVAILABLE block produces no notice at all.
  assert.equal(unavailableNotice({ available: true }, "x"), "");
  assert.equal(unavailableNotice(null, "x"), "");
});

test("[FE10] an insufficient-evidence score is delivered with everything the "
  + "client needs to avoid drawing a zero", async () => {
  const period = "2026-11";
  await client.upload("/api/financial-data/upload", {
    filename: "thin.csv",
    content: `Date,Description,Amount,Counterparty\n${period}-03,Only row,-1000,\n`,
    fields: { period }
  });
  const res = await client.post("/api/monthly-review", { month: period, use_ai_analysis: false });
  assert.equal(res.status, 200, JSON.stringify(res.json));

  const health = (await client.get("/api/health-score")).json.health;
  if (health.available === false) {
    assert.equal(health.overall_score, null, "null, never 0");
    assert.equal(health.risk_category, "Unknown", "a label the client can show verbatim");
    assert.ok(health.unavailable_reason, "and a reason");
    assert.ok(health.summary, "and a sentence the client can display as-is");
  }
  // Whatever the outcome, an unmeasured COMPONENT is null and is excluded from
  // the measured list — the two signals the score bars need.
  assert.ok(Array.isArray(health.measured_components));
  Object.entries(health.component_scores).forEach(([key, value]) => {
    if (value === null) {
      assert.ok(!health.measured_components.includes(key),
        `${key} is null but still listed as measured`);
    }
  });
});

// ── JOB 8: the client consumes the registry's bands, not its own ──

test("[FE11] the client no longer hardcodes health-score bands", () => {
  // JOB 7 carry-forward. The client used 70/40 while the registry defines
  // 80/60/40/20, so a score the engine called "Good" was painted amber and
  // captioned "Needs attention".
  assert.equal(/healthScore >= 70 \? 'text-emerald'/.test(APP_JS), false,
    "the dashboard tile still bands the score itself");
  assert.equal(/riskScore >= 70 \? 'text-emerald'/.test(APP_JS), false,
    "a concentration score is still banded client-side");
  assert.match(APP_JS, /loadScoreBands/, "the client fetches the registry's bands");
  assert.match(APP_JS, /api\/methodology/, "from the generated methodology endpoint");
});

test("[FE12] the client maps the ENGINE's category label to a colour", () => {
  const { scoreCategory, categoryClass } = loadHelpers(["scoreCategory", "categoryClass"]);
  // With no bands loaded the client shows neutral rather than guessing.
  assert.equal(scoreCategory(85), null, "no bands loaded yet");
  assert.equal(categoryClass(null), "text-muted");
  // Labels the registry actually produces map to sensible colours.
  assert.equal(categoryClass("Excellent"), "text-emerald");
  assert.equal(categoryClass("Good"), "text-emerald");
  assert.equal(categoryClass("Fair"), "text-amber");
  assert.equal(categoryClass("Critical"), "text-red");
  assert.equal(categoryClass("Unknown"), "text-muted");
});

test("[FE13] the settings page no longer advertises thresholds that do nothing", () => {
  // Two inputs displayed 30 days and 40%, contradicted the registry, and were
  // read by nothing — a user could "change" a threshold with no effect.
  assert.equal(/id="settings-runway"/.test(APP_JS), false);
  assert.equal(/id="settings-concentration"/.test(APP_JS), false);
  assert.match(APP_JS, /View the current rules and thresholds/,
    "and the real, published methodology is linked instead");
});

test("[FE14] the methodology endpoint serves the bands the client needs", async () => {
  const res = await client.get("/api/methodology");
  assert.equal(res.status, 200);
  const categories = res.json.methodology.scoring.categories;
  assert.ok(Array.isArray(categories) && categories.length >= 4);
  categories.forEach((c) => {
    assert.ok(c.label, "each band is labelled");
    assert.ok(c.atOrAbove === null || typeof c.atOrAbove === "number");
  });
  // The topmost band matches the registry, so the client and engine agree.
  const registry = require("../../src/domain/rules/registry");
  assert.equal(categories[0].atOrAbove, registry.HEALTH_SCORE.categories[0].minScore);
});

// ─────────────────────────────────────────────────────────────────
// FINAL CLOSURE PHASE 4 — the frontend's half of the CSRF contract.
//
// FOUR REAL INTEGRATION DEFECTS were found here. When CSRF landed, 24 of the
// frontend's mutating fetches were updated and four were missed:
//
//   public/app.js    CSV upload            <- the core product flow
//   public/app.js    Zoho disconnect
//   public/app.js    remove team member
//   public/wallet.js wallet verify
//
// Every one of them would have been rejected with 403 in a real browser. None
// of the server-side tests could see it, because the test harness attaches the
// token itself — it behaves like a CORRECT client, so it proves the server
// accepts a good request, never that the shipped frontend sends one.
//
// This test reads the actual shipped files, so a future fetch added without a
// token fails here instead of in production.
// ─────────────────────────────────────────────────────────────────

const WALLET_JS = fs.readFileSync(
  path.join(__dirname, "../../public/wallet.js"), "utf-8");

test("[F-CSRF] every mutating fetch in the shipped frontend sends a CSRF token", () => {
  const files = [["public/app.js", APP_JS], ["public/wallet.js", WALLET_JS]];
  const missing = [];

  files.forEach(([name, source]) => {
    const lines = source.split("\n");
    lines.forEach((line, index) => {
      if (!/method:\s*['"](POST|PUT|PATCH|DELETE)/.test(line)) return;
      /* The token may be attached on the same line, via a helper, or a few
         lines away in the options object. Inspect a window around the call. */
      const window = lines.slice(Math.max(0, index - 6), index + 9).join("\n");
      const hasToken = /mutatingHeaders|csrfHeaders|x-csrf-token|csrfToken/.test(window);
      if (!hasToken) missing.push(`${name}:${index + 1} -> ${line.trim().slice(0, 80)}`);
    });
  });

  assert.deepEqual(missing, [],
    "a state-changing request with no CSRF token is a 403 in the browser:\n"
    + missing.join("\n"));
});

test("[F-CSRF2] the multipart upload does NOT hand-set Content-Type", () => {
  /* A FormData body must have its Content-Type set by the BROWSER, because the
     header has to carry the generated multipart boundary. Setting it by hand
     alongside the CSRF token makes the body unparseable server-side -- which is
     the mistake the obvious fix (reusing mutatingHeaders) would have made. */
  const upload = APP_JS.slice(APP_JS.indexOf("/api/financial-data/upload"));
  const call = upload.slice(0, upload.indexOf("});") + 3);
  assert.match(call, /csrfHeaders\(/, "the upload sends the CSRF token");

  /* Strip comments before matching. The comment ON this very call explains why
     Content-Type is omitted -- and therefore contains the string being searched
     for. A source guard that reads its own documentation as if it were code is
     a guard that reports the opposite of the truth. */
  const code = call
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.equal(/Content-Type/i.test(code), false,
    "and does NOT set Content-Type, leaving the boundary to the browser");
});

test("[F-CSRF3] the token is read from the cookie the server actually sets", () => {
  // A mismatch in the cookie name would silently send an empty token forever.
  const httpSecurity = require("../../src/services/httpSecurity");
  assert.equal(httpSecurity.CSRF_COOKIE, "fg_csrf");
  assert.equal(httpSecurity.CSRF_HEADER, "x-csrf-token");
  assert.match(APP_JS, /fg_csrf=/, "app.js reads the same cookie name");
  assert.match(WALLET_JS, /fg_csrf=/, "wallet.js reads the same cookie name");
  assert.match(APP_JS, /["']x-csrf-token["']/, "and sends the same header name");
});

// ─────────────────────────────────────────────────────────────────
// JOB 13 PART D — the frontend must not show a legacy run as "no analysis".
//
// The copilot returns an honest message for a run that predates the recovery
// contract, but `renderCopilotUnavailable` labelled EVERY failure "Not
// available" — so a user whose analysis is saved-but-unloadable was told, in
// the same words as a missing one, that nothing was there.
// ─────────────────────────────────────────────────────────────────

test("[F-LEGACY] the frontend distinguishes a legacy run and offers the action", () => {
  assert.match(APP_JS, /analysis_legacy_unrecoverable/,
    "app.js recognises the legacy reason the API returns");
  assert.match(APP_JS, /Saved, but needs re-running/,
    "and labels it distinctly from a generic failure");
  assert.match(APP_JS, /runMonthlyReview\(/,
    "and offers the one action that resolves it");

  // The button needs the period, so the API must supply it.
  const routes = fs.readFileSync(
    path.join(__dirname, "../../src/routes/api.js"), "utf-8");
  const block = routes.slice(routes.indexOf('reason: "analysis_legacy_unrecoverable"'));
  const response = block.slice(0, block.indexOf("});"));
  assert.match(response, /period: targetMonth/,
    "the API returns the period the frontend needs to re-run");
  assert.match(response, /analysis_saved: true/,
    "and states that the analysis IS saved");
  assert.match(response, /recoverable: false/,
    "but cannot be reloaded");
});

test("[F-LEGACY2] the legacy branch is reached before the generic one", () => {
  /* Order matters: a generic handler placed first would swallow the legacy
     case and the distinction would silently disappear. */
  const legacyAt = APP_JS.indexOf("analysis_legacy_unrecoverable");
  const genericAt = APP_JS.indexOf("blocked ? 'Answer withheld' : 'Not available'");
  assert.ok(legacyAt > 0 && genericAt > 0, "both branches exist");
  assert.ok(legacyAt < genericAt,
    "the legacy case is handled BEFORE the generic fallback");
});

// ─────────────────────────────────────────────────────────────────
// FINAL CLOSURE PART A — the frontend actually CONSUMES `disclosure`.
//
// The API attaches a `disclosure` block to every route whose figures may be
// incomplete. app.js ignored it entirely, so a page built on an estimated cash
// balance looked identical to one built on fully observed books, and a metric
// the engine had a precise reason for withholding rendered as a blank the
// reader would naturally read as zero.
// ─────────────────────────────────────────────────────────────────

test("[F-DISC1] a single shared helper renders disclosures", () => {
  assert.match(APP_JS, /function renderDisclosure\s*\(/,
    "one helper exists rather than per-page DOM logic");

  // Used by every page that receives a disclosure, not just one.
  const uses = (APP_JS.match(/renderDisclosure\(/g) || []).length;
  assert.ok(uses >= 4,
    `defined once and called from each consumer (found ${uses} references)`);
});

test("[F-DISC2] the helper uses the BACKEND's wording, not its own", () => {
  const { renderDisclosure } = loadHelpers(["renderDisclosure"]);

  const html = renderDisclosure({
    complete: false,
    limitations: [{
      type: "derived_input",
      input: "statements.balanceSheet.cashAndEquivalents",
      basis: "derived_from_net_income",
      detail: "No cash balance was supplied; an estimate was derived from net income."
    }]
  });

  assert.match(html, /No cash balance was supplied/,
    "the server's own explanation is what the user sees");
  assert.match(html, /must not be read as zero/i,
    "and the standing warning against reading a blank as zero");
});

test("[F-DISC3] nothing is rendered when there is nothing to disclose", () => {
  /* Disclosure has to mean something. A notice on every page would be noise,
     and a reader would learn to ignore the one that mattered. */
  const { renderDisclosure } = loadHelpers(["renderDisclosure"]);
  assert.equal(renderDisclosure(null), "");
  assert.equal(renderDisclosure(undefined), "");
  assert.equal(renderDisclosure({ limitations: [] }), "");
});

test("[F-DISC4] an unavailable metric is rendered with its reason", () => {
  const { renderDisclosure } = loadHelpers(["renderDisclosure"]);
  const html = renderDisclosure({
    limitations: [{ type: "unavailable_metric", metric: "cash_on_hand",
      reason: "input_not_authoritative",
      detail: "Cash on hand and runway are not reported." }]
  });
  assert.match(html, /Cash on hand and runway are not reported/);
});

test("[F-DISC5] scoring coverage is surfaced when partial", () => {
  const { renderDisclosure } = loadHelpers(["renderDisclosure"]);
  const html = renderDisclosure({
    scoring_coverage_pct: 80,
    limitations: [{ type: "unavailable_metric", metric: "x", detail: "unmeasured" }]
  });
  assert.match(html, /80% of the model/,
    "the reader is told the score rests on part of the model");
});

test("[F-DISC6] the cashflow page no longer coerces unmeasured values to zero", () => {
  /* `var netCF = cf.net_cash_flow || 0` sat directly above an
     `isMeasured(netCF)` guard, which it defeated — the value was already 0 by
     the time the guard ran, so an unmeasured net flow rendered "KES 0" in the
     POSITIVE colour. The same JOB 7 defect this file fixed elsewhere, still
     live on this page. */
  assert.equal(/var netCF = cf\.net_cash_flow \|\| 0/.test(APP_JS), false,
    "net cash flow is not coerced to zero");
  assert.equal(/var burn = cf\.monthly_burn \|\| cf\.burn_rate \|\| 0/.test(APP_JS), false,
    "nor is monthly burn");
  assert.match(APP_JS, /cf\.net_cash_flow != null\) \? cf\.net_cash_flow : null/,
    "both stay null when unmeasured, so formatCurrency renders the sentinel");
});

test("[F-DISC7] an incomplete report is not announced as unqualified success", () => {
  assert.match(APP_JS, /data\.complete === false/,
    "the client reads the completeness flag the server sets");
  assert.equal(
    /if \(data\.ok\) \{[\s\S]{0,400}showToast\('Report generated successfully!', 'success'\);\s*\} else \{/
      .test(APP_JS),
    false,
    "and does not report unqualified success for a report carrying limitations");
});

// ─────────────────────────────────────────────────────────────────
// JOB P6 — the checkout UI holds NO plan catalog of its own.
// ─────────────────────────────────────────────────────────────────

test("[F-BILL1] the client defines no plans, prices or durations", () => {
  /* A second catalog in client code is a second source of truth, and billing
     cannot survive one: the price shown and the price charged would drift. */
  const code = APP_JS
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  assert.equal(/price\s*[:=]\s*\d+/.test(code), false,
    "no hardcoded price");
  assert.equal(/\b(2500|1500)\b/.test(code), false,
    "no plan amount is written into the client");
  assert.equal(/period_days\s*[:=]\s*\d+/.test(code), false,
    "no hardcoded billing period");

  // It reads them from the server instead.
  assert.match(APP_JS, /\/api\/billing\/plans/, "the catalog is fetched");
  assert.match(APP_JS, /\/api\/account\/entitlements/, "and so is the capability map");
});

test("[F-BILL2] checkout sends ONLY a plan key and a phone number", () => {
  const start = APP_JS.indexOf("async function submitCheckout");
  const body = APP_JS.slice(start, APP_JS.indexOf("function pollCheckout"));
  assert.match(body, /JSON\.stringify\(\{ plan: planKey, phone: phone \}\)/,
    "the request carries no amount, price or duration — the server prices it");
  assert.equal(/amount:/.test(body), false, "specifically no amount is sent");
});

test("[F-BILL3] the client never decides that a payment succeeded", () => {
  const start = APP_JS.indexOf("function pollCheckout");
  const body = APP_JS.slice(start, APP_JS.indexOf("async function cancelSubscription"));
  assert.match(body, /d\.status === 'successful'/,
    "success is read from the SERVER's payment status");
  assert.equal(/setPlan\(|appState\.account\.plan\s*=/.test(body), false,
    "the client never sets a plan itself");
});

test("[F-BILL4] an unavailable provider is shown honestly, with no checkout", () => {
  const start = APP_JS.indexOf("function renderBilling");
  const body = APP_JS.slice(start, APP_JS.indexOf("function startCheckout"));
  assert.match(body, /!d\.payment\.available/,
    "the client reads whether payment is actually available");
  assert.match(body, /not set up on this\s*\n?\s*\+ 'server yet|Unavailable/,
    "and says so rather than offering a checkout that cannot complete");
});

/* ── Startup ──────────────────────────────────────────────────────
   The app booted, painted, and looked healthy while doing almost nothing.
   `loadScoreBands()` called `api()`, a helper that exists nowhere in the file,
   and it was the FIRST statement of the init() sequence — so it threw a
   synchronous ReferenceError and cancelled checkOnboarding(), loadNetworks(),
   loadEntitlement() and loadNotifications() with it.

   The reported symptom was "Log in is not configured on this server yet" on a
   server whose /api/auth/session returned google_enabled: true. Nothing was
   wrong with the login; appState.authSession was simply never assigned. These
   two tests pin the cause and the containment separately. */

test("[F-INIT1] every function init() calls actually exists", () => {
  const start = APP_JS.indexOf("(function init()");
  assert.ok(start > 0, "init() is still the startup entry point");
  const body = APP_JS.slice(start);

  /* The names init() dispatches, whether wrapped in step() or called bare. */
  const called = new Set();
  for (const m of body.matchAll(/step\(\s*'([A-Za-z_$][\w$]*)'/g)) called.add(m[1]);
  for (const m of body.matchAll(/^\s{2}([a-z][\w$]*)\(\);/gm)) called.add(m[1]);
  assert.ok(called.size >= 5, `init() dispatches several steps, found ${called.size}`);

  called.forEach((name) => {
    const declared = new RegExp(
      `(?:async\\s+)?function\\s+${name}\\s*\\(|\\b${name}\\s*=\\s*(?:async\\s*)?function`);
    assert.ok(declared.test(APP_JS),
      `init() calls ${name}(), which is not defined anywhere in app.js`);
  });
});

test("[F-INIT2] one failing startup step cannot disable the others", () => {
  const start = APP_JS.indexOf("(function init()");
  const body = APP_JS.slice(start);

  assert.match(body, /function step\(name, fn\)\s*\{\s*try\s*\{/,
    "init() runs each step inside its own try/catch");
  assert.match(body, /step\('checkOnboarding'/,
    "authentication setup is one of the isolated steps");

  /* And it is REACHED even if an earlier step throws — the ordering that made
     a score-band fetch able to take down login. */
  const scoreBands = body.indexOf("step('loadScoreBands'");
  const onboarding = body.indexOf("step('checkOnboarding'");
  assert.ok(scoreBands > 0 && onboarding > scoreBands,
    "loadScoreBands still runs first, so its failure must stay contained");
});

test("[F-INIT3] the score-band loader uses a helper that exists", () => {
  const start = APP_JS.indexOf("function loadScoreBands");
  const body = APP_JS.slice(start, APP_JS.indexOf("function scoreCategory"));
  assert.match(body, /fetch\('\/api\/methodology'\)/,
    "it fetches the registry's bands directly");

  /* CODE ONLY. The comment above loadScoreBands names the removed helper, and
     a guard that matches its own explanation proves nothing. */
  const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.equal(/[^.\w]api\(/.test(code), false,
    "and no longer calls the undefined api() helper");
  // The failure path must stay neutral: no bands rather than guessed bands.
  assert.match(body, /\.catch\(/, "a failed load leaves SCORE_BANDS unset");
});

/* ── Upload panel ─────────────────────────────────────────────────
   The API accepts PDF source documents; the panel offered a single-file CSV
   picker, so the capability was unreachable from the product. These pin the
   two halves that matter: the input can express what the API accepts, and a
   partial import cannot be presented as a clean one. */

test("[F-UP1] the picker accepts PDFs and more than one file", () => {
  const start = APP_JS.indexOf("function renderUploadPanel");
  const body = APP_JS.slice(start, APP_JS.indexOf("function renderUnreadDocuments"));

  assert.match(body, /accept="\.csv,\.pdf,text\/csv,application\/pdf"/,
    "both formats are offered");
  assert.match(body, /<input type="file" multiple /,
    "a day of paperwork is many files, so the input takes a selection");
  assert.match(body, /Scanned or photographed PDFs cannot be read/,
    "the limitation is stated up front, not discovered after uploading");
});

test("[F-UP2] every file selected is sent, not just the first", () => {
  const start = APP_JS.indexOf("async function handleUploadSubmit");
  const body = APP_JS.slice(start, APP_JS.indexOf("async function handleWalletConnectClick"));

  assert.match(body, /files\.forEach\(function \(f\) \{ formData\.append\('file', f\); \}\)/,
    "each file is appended");
  assert.equal(/formData\.append\('file', fileEl\.files\[0\]\)/.test(body), false,
    "the single-file form is gone");

  /* Mixing a CSV export with the documents behind it would count the same
     money twice. Refused in the client too, so the user is told immediately. */
  assert.match(body, /not both at/, "a mixed selection is refused");
});

test("[F-UP3] documents the server refused are always shown", () => {
  const start = APP_JS.indexOf("function renderUnreadDocuments");
  const body = APP_JS.slice(start, APP_JS.indexOf("async function handleUploadSubmit"));

  assert.match(body, /if \(!rows\.length\) return '';/,
    "nothing is drawn when everything imported");
  assert.match(body, /not included in the figures above/,
    "and when something did not, the consequence is stated");
  assert.match(body, /escapeHtml\(r\.reason/, "the server's reason is rendered, escaped");

  // Both refusal kinds reach the user: unreadable, and outside the period.
  assert.match(body, /rejected \|\| \[\]/);
  assert.match(body, /outOfPeriod \|\| \[\]/);
});

test("[F-UP4] a partial import does not auto-navigate away from the evidence", () => {
  /* Running the review re-renders the import page and destroys the list of
     refused documents, so the user would land on a dashboard built from an
     incomplete month having never seen what was missing. */
  const submit = APP_JS.slice(
    APP_JS.indexOf("async function handleUploadSubmit"),
    APP_JS.indexOf("async function handleWalletConnectClick"));
  assert.match(submit, /data-fg-action="analyse-anyway"/,
    "proceeding is an explicit choice the user makes after reading");

  const importPage = APP_JS.slice(APP_JS.indexOf("renderUploadPanel('import-upload-panel'"));
  assert.match(importPage.slice(0, 1200), /if \(unread\) return;/,
    "the analysis is not started automatically when something was refused");

  // And the success path still takes them straight to the dashboard.
  assert.match(importPage.slice(0, 1600), /navigate\('overview'\)/);
});

test("[F-UP5] the panel no longer describes itself as CSV-only", () => {
  const start = APP_JS.indexOf("function renderUploadPanel");
  const body = APP_JS.slice(start, APP_JS.indexOf("function renderUnreadDocuments"));
  const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.match(code, /PDF documents/, "PDFs are advertised");
  assert.equal(/Bank \/ Accounting CSV Export/.test(code), false,
    "the old CSV-only label is gone");
});

/* ── Finna ────────────────────────────────────────────────────────
   The copilot's face. She is decoration over a real state machine, and the
   only thing that can make her harmful is decoration that disagrees with the
   system: looking cheerful over a failed request, or looking busy when nothing
   is in flight. These pin her to real events. */

const FINNA_JS = fs.readFileSync(
  path.join(__dirname, "../../public/finna.js"), "utf-8");

test("[FN1] Finna ships as a same-origin script with no build step", () => {
  const html = fs.readFileSync(
    path.join(__dirname, "../../public/index.html"), "utf-8");
  assert.match(html, /<script src="\/finna\.js" defer><\/script>/,
    "served from this origin, so `script-src 'self'` allows it");
  assert.equal(/<script[^>]+src="https?:/.test(html), false,
    "and still nothing is pulled from a third party");
});

test("[FN2] every state she can show is a state the app actually sets", () => {
  const code = FINNA_JS.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const declared = /var STATES = \[([^\]]+)\]/.exec(code);
  assert.ok(declared, "the state list is declared in one place");
  const states = declared[1].split(",").map((s) => s.trim().replace(/"/g, ""));
  assert.deepEqual(states, ["idle", "thinking", "speaking", "happy", "error"]);

  // An unknown state is ignored rather than guessed at.
  assert.match(code, /if \(STATES\.indexOf\(next\) === -1\) return api;/);
});

test("[FN3] thinking is tied to the request, not to a timer", () => {
  const send = APP_JS.slice(APP_JS.indexOf("async function sendChat"),
    APP_JS.indexOf("function renderCopilotAnswer"));

  assert.match(send, /mountFinnaOn\(document\.getElementById\(typingId\), 'thinking'\)/,
    "she starts thinking when the placeholder goes up, before the fetch resolves");
  assert.match(send, /finnaSpeak\(feed\.lastElementChild/,
    "and speaks only once an answer is on the page");

  /* The ordering is the whole point: `speaking` must appear AFTER the answer is
     inserted, never before, or she implies an answer that does not exist. */
  const answerAt = send.indexOf("renderCopilotAnswer(data)");
  const speakAt = send.indexOf("finnaSpeak(");
  assert.ok(answerAt > 0 && speakAt > answerAt,
    "she speaks after the answer is rendered, not before");
});

test("[FN4] a refusal is not dressed up, and a failure is not dressed down", () => {
  const send = APP_JS.slice(APP_JS.indexOf("async function sendChat"),
    APP_JS.indexOf("function renderCopilotAnswer"));

  /* "No analysis for this period" is the copilot working correctly.
     renderCopilotUnavailable() exists to stop those reading as breakage, so an
     alarmed face there would put the alarm straight back. */
  const unavailable = send.slice(send.indexOf("renderCopilotUnavailable(data)"));
  assert.match(unavailable.slice(0, 700), /mountFinnaOn\(feed\.lastElementChild, 'idle'\)/,
    "a legitimate refusal leaves her calm");

  // A transport failure is a real failure and gets the error face.
  const katch = send.slice(send.indexOf("} catch (e) {"));
  assert.match(katch, /mountFinnaOn\(feed\.lastElementChild, 'error'\)/,
    "an unreachable copilot shows the error face");
});

test("[FN5] she stops talking when she stops speaking", () => {
  /* A mouth left animating after the request finished would keep implying the
     assistant is still producing something. */
  const code = FINNA_JS.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.match(code, /if \(talkTimer\) \{ global\.clearInterval\(talkTimer\); talkTimer = null; \}/,
    "the talk cycle is cleared on every state change");
  assert.match(code, /api\.state !== "speaking"/,
    "and the cycle stops itself if the state moved on");
  assert.match(code, /if \(talkTimer\) global\.clearInterval\(talkTimer\)/,
    "and on destroy, so a torn-down chat leaves no timer running");
});

test("[FN6] motion respects the OS setting, and the states still read without it", () => {
  const code = FINNA_JS.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.match(code, /prefers-reduced-motion: reduce/,
    "the preference is honoured in JS too, not only in CSS");
  assert.match(code, /if \(next === "speaking" && !reducedMotion\(\)\)/,
    "no talking loop when motion is reduced");

  const css = fs.readFileSync(path.join(__dirname, "../../public/styles.css"), "utf-8");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?finna-bob[\s\S]*?animation: none !important/,
    "and the CSS animations are disabled");

  /* Each state must remain DISTINGUISHABLE when animation is off, or Finna
     stops conveying anything to the people most likely to need the cue. */
  const mouths = /var MOUTHS = \{([\s\S]*?)\};/.exec(code);
  assert.ok(mouths, "mouth shapes are declared in JS");
  const shapes = mouths[1].match(/"M[^"]+"/g) || [];
  assert.equal(new Set(shapes).size, shapes.length,
    "no two states share a mouth shape");
  assert.ok(shapes.length >= 5, `expected a shape per state, found ${shapes.length}`);
});

test("[FN7] there is one Finna, and she follows the newest answer", () => {
  const code = FINNA_JS.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.match(code, /if \(current\) current\.destroy\(\);/,
    "mounting replaces the previous instance rather than accumulating avatars");

  // Assistant rows carry an empty slot for her; the user's row keeps its icon.
  assert.match(APP_JS, /'<div class="chat-msg-avatar finna-slot"><\/div>'/,
    "assistant messages provide a slot");
  assert.match(APP_JS, /isUser\s*\n?\s*\?\s*'<div class="chat-msg-avatar">' \+ icon\('user'\)/,
    "the user's own avatar is unchanged");
});

test("[FN8] the upstream work she is based on is credited", () => {
  /* bloub is MIT. The licence is satisfied by attribution, and the honest
     reason for a reimplementation rather than a dependency is recorded. */
  assert.match(FINNA_JS, /github\.com\/jeremy-prt\/bloub/, "the source project is named");
  assert.match(FINNA_JS, /MIT/, "with its licence");
  const css = fs.readFileSync(path.join(__dirname, "../../public/styles.css"), "utf-8");
  assert.match(css, /bloub/, "and the stylesheet carries the credit too");
});
