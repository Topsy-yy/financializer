// GOLDEN SCENARIOS — the deterministic engine, end to end.
//
// HISTORY. This file began as the JOB 2 baseline for src/services/riskEngine.js,
// pinning that engine's behaviour so a later refactor would be observable. Every
// test tagged [KNOWN-BAD] recorded a defect we had already judged wrong, on the
// contract that it must FAIL LOUDLY once fixed.
//
// JOB 6 deleted riskEngine.js. Each former [KNOWN-BAD] is now re-stated as a
// [FIXED in JOB n] test asserting the CORRECT behaviour, with the old behaviour
// quoted so the audit trail survives the deletion. The scenario numbering is
// unchanged so the two versions can be read side by side in git history.
//
// The engine under test is THE engine: src/domain/analysis/engine.js.

const test = require("node:test");
const assert = require("node:assert/strict");

const engine = require("../../src/domain/analysis/engine");
const { toLegacyAnalysis } = require("../../src/domain/adapters/legacyAnalysis");
const { scenarios } = require("../helpers/fixtures");

// Wall-clock time is INJECTED, so these results are reproducible forever.
const NOW = Date.parse("2026-06-15T00:00:00Z");
const run = (name, over) => engine.analyze(
  over || scenarios[name], { tenantId: "t", period: "2026-05", now: NOW });
const legacy = (name, over) => toLegacyAnalysis(run(name, over));
const findingsOf = (r, ruleId) => r.findings.filter((f) => f.ruleId === ruleId);

// ── 1. Healthy business ──────────────────────────────────────────
test("[1] healthy business produces no business findings and a real score", () => {
  const r = run("healthy");
  assert.deepEqual(r.findings.filter((f) => !f.isDataQuality).map((f) => f.ruleId), [],
    "a clean dataset must not raise business findings");
  assert.equal(r.calculations.cashflow.risk_level, "low");
  assert.equal(r.calculations.cashflow.risk_score, 20, "baseline score for a healthy month");
  assert.equal(r.riskScore.available, true);
  assert.ok(r.riskScore.overall > 60, `expected a good score, got ${r.riskScore.overall}`);
});

// ── 2. Duplicate payment ─────────────────────────────────────────
test("[2] duplicate payment is detected exactly once, citing both records", () => {
  const r = run("duplicatePayment");
  const dups = findingsOf(r, "duplicate_payment");
  assert.equal(dups.length, 1);
  assert.equal(dups[0].evidence.length, 2, "BOTH sides are cited");
  assert.equal(dups[0].evidence[0].fields.amount, 48500);
  assert.equal(dups[0].evidence[0].fields.counterparty, "Rivera Logistics");
});

test("[2b][FIXED in JOB 3] duplicate findings carry source ids, confidence and "
  + "match criteria", () => {
  // WAS: normalization dropped record ids, so a finding could never cite a
  // source; there was no confidence and no field-level evidence.
  const f = findingsOf(run("duplicatePayment"), "duplicate_payment")[0];
  assert.ok(f.sourceRecordIds.length >= 2, "cites its source records");
  assert.ok(f.confidence > 0 && f.confidence <= 1, "carries a confidence");
  assert.deepEqual(f.matchCriteria.fields, ["date", "amount", "counterparty", "account"],
    "states WHICH fields were compared, as data");
  assert.equal(f.matchCriteria.comparison, "equals");
});

test("[2c][FIXED in JOB 3] the duplicate key no longer falls back to description", () => {
  // WAS: the key was `date|amount|counterparty || description`, so two unrelated
  // transactions collided whenever one happened to name the other's counterparty
  // in its description — a documented false-positive source.
  const r = run(null, {
    transactions: [
      { date: "2026-05-11", amount: 1000, counterparty: "Acme", description: "x" },
      { date: "2026-05-11", amount: 1000, counterparty: "", description: "Acme" }
    ],
    journalEntries: [], reconciliations: [],
    statements: { cashFlow: {}, profitAndLoss: {}, balanceSheet: {} }
  });
  assert.equal(findingsOf(r, "duplicate_payment").length, 0,
    "different records with different counterparties are not duplicates");
});

// ── 3. Round-number transaction ──────────────────────────────────
test("[3] round-number rule fires on >= 10,000 and divisible by 1,000", () => {
  const r = run("roundNumber");
  const hits = findingsOf(r, "round_number_payment");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].observedValue, 250000);
  assert.equal(hits[0].threshold, 10000);
  assert.equal(hits[0].comparator, ">=");
});

test("[3b] the round-number rule is a WEAK signal, and says how weak", () => {
  // WAS tagged [KNOWN-BAD] for being noisy on ordinary round business amounts.
  // The noise is inherent to the rule, so the fix was not to silence it but to
  // stop it carrying the weight of a confident finding.
  const { CONFIDENCE } = require("../../src/domain/rules/registry");
  const r = run("vendorConcentration");
  const hits = findingsOf(r, "round_number_payment");
  assert.equal(hits.length, 3, "still fires on plausible round amounts");
  hits.forEach((f) => {
    // Never better than POSSIBLE, and that only for amounts far above the
    // period's materiality — the registry's declared modifier.
    assert.ok(f.confidence <= CONFIDENCE.POSSIBLE,
      `confidence ${f.confidence} must stay at or below POSSIBLE`);
    assert.equal(f.confidenceBasis, "heuristic", "the basis is stated, not implied");
    assert.equal(f.severity, "medium");
    assert.doesNotMatch(f.description, /fraud|fraudulent|stolen|theft/i,
      "a round number is not an allegation of fraud");
  });
  // The weakest of them sits at the registry's base level.
  assert.equal(Math.min(...hits.map((f) => f.confidence)), CONFIDENCE.WEAK);
});

test("[3c][FIXED in JOB 7] materiality is per-currency, not a single fixed bar", () => {
  // WAS: a flat `>= 10000` bar meant only the KES amount was ever considered
  // material — 1,000 USD and 900 EUR were invisible, though both are far more
  // significant to a business than 10,000 KES.
  // NOW: each record is judged against the floor for ITS OWN currency, resolved
  // by domain/rules/materiality.js.
  const r = run("multiCurrency");
  const hits = findingsOf(r, "round_number_payment");
  assert.equal(hits.length, 3, "each currency is judged on its own scale");

  const byCurrency = Object.fromEntries(hits.map((f) => [f.currency, f.threshold]));
  assert.equal(byCurrency.KES, 10000);
  assert.equal(byCurrency.USD, 100, "100 USD is roughly as significant as 10,000 KES");
  assert.equal(byCurrency.EUR, 100);

  // The run records the threshold it applied to each currency, so the decision
  // is reproducible after the table changes.
  const applied = Object.fromEntries(
    r.methodology.materialityByCurrency.map((m) => [m.currency, m.significant]));
  assert.deepEqual(applied, { KES: 10000, USD: 100, EUR: 100 });

  // And every finding states which currency its amount is denominated in —
  // a number without a unit is what made this bug possible.
  hits.forEach((f) => assert.ok(f.currency, "a monetary finding must name its currency"));
});

// ── 4. Cash-flow stress ──────────────────────────────────────────
test("[4] cash-flow stress raises score, severity and a short runway", () => {
  const r = run("cashflowStress");
  const c = r.calculations.cashflow;
  assert.equal(c.risk_level, "high");
  assert.equal(c.risk_score, 100, "score is clamped at 100");
  assert.ok(c.cash_runway_months < 1, `runway ${c.cash_runway_months} < 1 month`);
  assert.ok(c.net_cash_flow < 0);
  // The arithmetic is recorded, not just the result.
  assert.equal(c.risk_calculation,
    "baseline 20 + negative net cash flow +25 + burning cash +15 "
    + "+ runway under 6mo +25 + runway under 3mo +15 = 100");
});

// ── 5. Vendor concentration ──────────────────────────────────────
test("[5] vendor concentration is measured from actual transactions", () => {
  const r = run("vendorConcentration");
  const v = r.calculations.vendors;
  assert.equal(v.available, true);
  assert.equal(v.top_party.name, "Monolith Supplies");
  assert.ok(v.top_share_pct > 50);
  const f = findingsOf(r, "vendor_concentration")[0];
  assert.equal(f.severity, "high");
  assert.ok(f.evidence.length > 0, "cites the contributing transactions");
});

// ── 6. Missing customer data ─────────────────────────────────────
test("[6][FIXED in JOB 3] unattributed revenue is reported as unavailable, "
  + "never fabricated", () => {
  // WAS: buildCustomerSummary invented "BlueTech", "Nova Retail" and
  // "Eastline Logistics" with a hardcoded risk score of 72, then raised a HIGH
  // finding about a business relationship that did not exist.
  const r = run("missingCustomerData");
  const c = r.calculations.customers;
  assert.equal(c.available, false);
  assert.equal(c.risk_score, null, "never a hardcoded 72");
  assert.deepEqual(c.parties, []);
  assert.equal(c.reason, "unattributed_transactions");
  assert.ok(c.unattributed_amount > 0, "reports HOW MUCH could not be attributed");
  assert.equal(findingsOf(r, "customer_concentration").length, 0,
    "no finding about customers that were never observed");
});

// ── 7. Missing vendor data ───────────────────────────────────────
test("[7] unattributed spend is unavailable, not a vendor named 'Unknown'", () => {
  // WAS tagged [KNOWN-BAD]: unattributed spend was bucketed under a synthetic
  // vendor, which then appeared in the UI as a real counterparty.
  const r = run("missingVendorData");
  const v = r.calculations.vendors;
  assert.equal(v.available, false);
  assert.deepEqual(v.parties, []);
  assert.ok(v.unattributed_amount > 0);
  assert.equal(v.parties.find((p) => /unknown/i.test(p.name)), undefined);
});

// ── 8. Missing financial data ────────────────────────────────────
test("[8] incomplete records and journal entries are detected as DATA QUALITY", () => {
  const r = run("missingData");
  assert.equal(findingsOf(r, "missing_transaction_fields").length, 2);
  assert.equal(findingsOf(r, "missing_journal_references").length, 1);
  assert.equal(findingsOf(r, "unreconciled_account").length, 1);
  // Every one of them is data quality, NOT business risk.
  ["missing_transaction_fields", "missing_journal_references", "unreconciled_account"]
    .forEach((id) => findingsOf(r, id).forEach((f) =>
      assert.equal(f.isDataQuality, true, `${id} must not count as business risk`)));
});

test("[8b][FIXED in JOB 6] a zero-amount transaction is flagged as incomplete", () => {
  // WAS: the v1 check was `tx.amount == null`, which is FALSE for an amount of
  // 0, so a transaction recorded with no value passed as complete. v2 checks
  // for a usable amount, so the missingData fixture now yields 2 findings, not 1.
  const r = run("missingData");
  const zero = findingsOf(r, "missing_transaction_fields")
    .find((f) => String(f.observedValue).includes("amount"));
  assert.ok(zero, "the zero-amount transaction is reported");
});

test("[8c][FIXED in JOB 3] a dataset with NO statements is UNSCOREABLE, "
  + "not low risk", () => {
  // WAS: missing data scored `severity: low`, `riskScore: 20` and a 12-month
  // runway — an absent balance sheet read as a solvent year of cash.
  const r = run("missingData");
  assert.equal(r.calculations.cashflow.available, false);
  assert.equal(r.calculations.cashflow.cash_runway_months, null,
    "12 months was a FALLBACK; null is the honest answer");
  assert.equal(r.riskScore.available, false);
  assert.equal(r.riskScore.overall, null);
  assert.equal(r.riskScore.category, "Unknown", "Unknown, never a passing grade");
  assert.equal(r.riskScore.unavailableReason, "insufficient_component_coverage");
  assert.ok(r.riskScore.weightCovered < 0.5, "scored on a minority of the model");
});

// ── 9. Multi-currency ────────────────────────────────────────────
test("[9][FIXED in JOB 6] mixed currencies are not labelled with one currency", () => {
  // WAS: 100,000 KES + 1,000 USD + 900 EUR were summed as one unit and the
  // result was presented without qualification.
  // NOW: amounts are still summed (conversion needs a rate source, which is a
  // product decision deferred past JOB 6), but the metric set refuses to LABEL
  // a mixed total with any single currency.
  const r = run("multiCurrency");
  assert.equal(engine.resolveCurrency(scenarios.multiCurrency), null,
    "no single currency can be claimed for this period");
  const total = r.metricsByKey["cashflow.net"];
  assert.equal(total.currency, null, "a mixed total is never labelled KES");

  // A single-currency period IS labelled.
  const single = engine.analyze({
    transactions: [{ date: "2026-05-05", amount: 1000, counterparty: "V", currency: "KES" }],
    journalEntries: [], reconciliations: [],
    statements: { cashFlow: { inflow: 0, outflow: 1000 }, profitAndLoss: {}, balanceSheet: {} }
  }, { period: "2026-05", now: NOW });
  assert.equal(single.metricsByKey["cashflow.net"].currency, "KES");
});

test("[9b][FIXED in JOB 7] equal numeric amounts in different currencies are "
  + "no longer duplicates of each other", () => {
  // WAS: the match key was (date, amount, counterparty), so 1000 USD and
  // 1000 KES collided. The JOB 6 note argued that adding currency to the key
  // would lose duplicates in records that declare no currency; JOB 7 resolves
  // that by only comparing DECLARED currencies — see rules/currency.js.
  const declared = run(null, {
    transactions: [
      { date: "2026-05-05", amount: 1000, counterparty: "Vendor", currency: "USD" },
      { date: "2026-05-05", amount: 1000, counterparty: "Vendor", currency: "KES" }
    ],
    journalEntries: [], reconciliations: [],
    statements: { cashFlow: {}, profitAndLoss: {}, balanceSheet: {} }
  });
  assert.equal(findingsOf(declared, "duplicate_payment").length, 0,
    "1000 USD and 1000 KES are different amounts");

  // ...and a genuine same-currency duplicate is still caught.
  const same = run(null, {
    transactions: [
      { date: "2026-05-05", amount: 1000, counterparty: "Vendor", currency: "KES" },
      { date: "2026-05-05", amount: 1000, counterparty: "Vendor", currency: "KES" }
    ],
    journalEntries: [], reconciliations: [],
    statements: { cashFlow: {}, profitAndLoss: {}, balanceSheet: {} }
  });
  assert.equal(findingsOf(same, "duplicate_payment").length, 1);

  // ...as is a duplicate in records that declare NO currency (CSV uploads).
  const undeclared = run(null, {
    transactions: [
      { date: "2026-05-05", amount: 1000, counterparty: "Vendor" },
      { date: "2026-05-05", amount: 1000, counterparty: "Vendor" }
    ],
    journalEntries: [], reconciliations: [],
    statements: { cashFlow: {}, profitAndLoss: {}, balanceSheet: {} }
  });
  assert.equal(findingsOf(undeclared, "duplicate_payment").length, 1,
    "an unstated currency must not suppress a real duplicate");
});

// ── 10. No financial data ────────────────────────────────────────
test("[10][FIXED in JOB 3] an EMPTY dataset is NOT scored as a healthy business", () => {
  // WAS the single most dangerous baseline behaviour: an ingestion failure that
  // yielded [] was indistinguishable from a genuinely quiet, solvent month —
  // severity low, a 12-month runway, and no warning at all.
  const r = run("emptyResponse");
  assert.equal(r.riskScore.available, false);
  assert.equal(r.riskScore.overall, null);
  assert.equal(r.riskScore.category, "Unknown");
  assert.equal(r.calculations.cashflow.net_cash_flow, null, "not a net flow of zero");
  assert.equal(r.calculations.cashflow.cash_runway_months, null, "not 12 months");
  assert.match(r.riskScore.summary, /cannot be scored/i);
  assert.equal(r.quality.scoring_reliable, false, "the reason is stated, not implied");
});

// ── 11. Incomplete Zoho ingestion ────────────────────────────────
test("[11][FIXED in JOB 3] a failed dataset fetch degrades the data-quality "
  + "grade instead of reading as 'nothing to report'", () => {
  // WAS: zohoBooksClient's `.catch(() => [])` meant an outage on the bank
  // endpoint produced zero control findings and zero signal that data was
  // missing — "no reconciliation records" read as "fully reconciled".
  const withFailure = engine.analyze(scenarios.partialIngestion, {
    tenantId: "t", period: "2026-05", now: NOW,
    fetchFailures: ["reconciliations"]
  });
  assert.equal(findingsOf(withFailure, "unreconciled_account").length, 0,
    "we still cannot invent findings from data we never received");
  assert.notEqual(withFailure.quality.level, "COMPLETE",
    "but the run is NOT graded complete");
  assert.equal(withFailure.dataQuality.scoringReliable, false);
});

// ── Reproducibility ──────────────────────────────────────────────
test("[R] analysis is deterministic for identical input", () => {
  const a = run("duplicatePayment");
  const b = run("duplicatePayment");
  assert.equal(a.inputHash, b.inputHash);
  assert.equal(a.riskScore.overall, b.riskScore.overall);
  assert.deepEqual(a.findings.map((f) => f.findingId), b.findings.map((f) => f.findingId));
});

test("[R2][FIXED in JOB 3] overdue detection no longer depends on wall-clock time", () => {
  // WAS: detectOverdueReceivables defaulted to new Date(), so re-running a
  // historical month produced different findings over time.
  const src = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../../src/domain/analysis/detectors.js"), "utf-8");
  assert.doesNotMatch(src, /new Date\(\)/, "no wall-clock read in the detectors");

  // Injecting a different `now` changes the result, proving it is the input.
  const data = {
    transactions: [], journalEntries: [], reconciliations: [],
    statements: { cashFlow: {}, profitAndLoss: {}, balanceSheet: {} },
    receivables: [{ customer: "Acme", amount: 5000, balance: 5000, dueDate: "2026-06-01" }]
  };
  const before = engine.analyze(data, { period: "2026-05", now: Date.parse("2026-05-20T00:00:00Z") });
  const after = engine.analyze(data, { period: "2026-05", now: Date.parse("2026-07-20T00:00:00Z") });
  assert.equal(findingsOf(before, "overdue_receivable").length, 0, "not yet due");
  assert.equal(findingsOf(after, "overdue_receivable").length, 1, "overdue by the later clock");
});

// ── The legacy projection ────────────────────────────────────────
test("[L] the legacy analysis shape is projected from this run, not recomputed", () => {
  const r = run("duplicatePayment");
  const a = toLegacyAnalysis(r);
  assert.equal(a.cashFlowRisk.riskScore, r.calculations.cashflow.risk_score);
  assert.equal(a.cashFlowRisk.severity, r.calculations.cashflow.risk_level);
  assert.equal(a.detections.duplicates.length, findingsOf(r, "duplicate_payment").length);
  assert.equal(a.analysisRunId, r.analysisRunId, "same run, not a second analysis");
});
