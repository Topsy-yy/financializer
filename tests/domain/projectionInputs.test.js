// FINAL CLEANUP — the projection modules refuse unmeasured inputs THEMSELVES.
//
// THE DEFECT. `cashflowForecast` opened with `num(input.startingCash, 0)` and
// `whatIfSimulator` with `num(baseline.startingCash)`. Both turn null,
// undefined, NaN and Infinity into 0 — so an unmeasured cash position produced
// a projection starting from zero, with every horizon, the days-to-zero figure
// and the status ("critical") computed from a number nobody supplied.
//
// The HTTP callers were taught to refuse first, which made this unreachable
// through the API — but a module that fabricates a projection when called
// directly is one call site away from doing it again, and these two are exactly
// the modules a future feature would reach for. They now refuse on their own
// account.
//
// EVERY TEST HERE CALLS THE MODULE DIRECTLY. No server, no route, no HTTP.

const test = require("node:test");
const assert = require("node:assert/strict");

const { computeCashflowForecast } = require("../../src/services/cashflowForecast");
const whatIfSimulator = require("../../src/services/whatIfSimulator");

/** A baseline where everything IS measured, for the positive cases. */
const MEASURED = Object.freeze({
  startingCash: 1200000,
  monthlyNet: -345000,
  monthlyBurn: 345000,
  overdueReceivables: 0
});

/* The values that must never become zero. `0` and `-0` are deliberately NOT
   here — they are measurements, and the tests below prove they still work. */
const UNMEASURED = [
  ["null", null],
  ["undefined", undefined],
  ["NaN", NaN],
  ["Infinity", Infinity],
  ["-Infinity", -Infinity],
  ["empty string", ""]
];

// ══════════════════════════════════════════════════════════════════
// cashflowForecast
// ══════════════════════════════════════════════════════════════════

test("[PI1] a MEASURED baseline still produces a full projection", () => {
  const f = computeCashflowForecast(MEASURED);
  assert.equal(f.available, true);
  assert.equal(f.starting_cash, 1200000);
  assert.ok(Array.isArray(f.horizons) && f.horizons.length > 0, "horizons are produced");
  assert.ok(Array.isArray(f.series) && f.series.length > 0, "a balance series is produced");
  assert.equal(typeof f.days_to_zero, "number", "and days-to-zero, since it is burning");
});

test("[PI2] a MEASURED ZERO cash position is valid and still projects", () => {
  /* THE DISTINCTION THIS WHOLE CHANGE PROTECTS. A business that tells us it has
     nothing is making a statement, and it must still get a projection. Only the
     ABSENCE of a measurement is refused. */
  const f = computeCashflowForecast(Object.assign({}, MEASURED, { startingCash: 0 }));
  assert.equal(f.available, true, "an observed zero is a measurement, not a gap");
  assert.equal(f.starting_cash, 0, "and it is carried through as zero");
  assert.ok(f.horizons.length > 0, "with a real projection");
  // Burning from zero: there is no runway left, and that is a real answer.
  assert.equal(f.days_to_zero, null,
    "days-to-zero is null because there is no positive balance to deplete");
  assert.equal(f.status, "burning");
});

test("[PI3] every kind of unmeasured startingCash is REFUSED, never zeroed", () => {
  UNMEASURED.forEach(([label, value]) => {
    const f = computeCashflowForecast(Object.assign({}, MEASURED, { startingCash: value }));

    assert.equal(f.available, false, `${label} startingCash is refused`);
    assert.equal(f.reason, "unmeasured_input");
    assert.ok(f.missing.includes("startingCash"), `${label}: the missing input is named`);
    assert.match(f.detail, /not substituted with zero/i,
      `${label}: and the refusal says so explicitly`);

    // NO PROJECTION, and no fabricated figure anywhere in the result.
    assert.equal(f.horizons, null, `${label}: no horizons were generated`);
    assert.equal(f.series, null, `${label}: no balance series was generated`);
    assert.equal(f.starting_cash, null, `${label}: starting cash is null, NOT 0`);
    assert.notEqual(f.starting_cash, 0, `${label}: specifically not zero`);
    assert.equal(f.days_to_zero, null);
    assert.equal(f.status, null, `${label}: no status was asserted`);
    assert.equal(f.optimistic_30d_balance, null);
  });
});

test("[PI4] unmeasured monthlyNet or monthlyBurn is refused too", () => {
  ["monthlyNet", "monthlyBurn"].forEach((field) => {
    const f = computeCashflowForecast(Object.assign({}, MEASURED, { [field]: null }));
    assert.equal(f.available, false, `${field} is required`);
    assert.ok(f.missing.includes(field), `${field} is named as missing`);
    assert.equal(f.horizons, null, `${field}: no projection was produced`);
  });
});

test("[PI5] several missing inputs are ALL named, not just the first", () => {
  const f = computeCashflowForecast({ startingCash: null, monthlyNet: null, monthlyBurn: null });
  assert.equal(f.available, false);
  assert.deepEqual([...f.missing].sort(),
    ["monthlyBurn", "monthlyNet", "startingCash"],
    "the caller is told everything that is missing, so one round trip fixes it");
});

test("[PI6] an empty input object produces no projection at all", () => {
  const f = computeCashflowForecast({});
  assert.equal(f.available, false);
  assert.equal(f.horizons, null);
  assert.equal(f.starting_cash, null);
});

test("[PI7] overdue receivables stay OPTIONAL, and absence withholds rather than invents", () => {
  /* Overdue receivables gate only the optimistic branch. Absent means the
     optimistic figure is omitted — which withholds a claim rather than making
     one, the conservative direction. */
  const without = computeCashflowForecast(
    Object.assign({}, MEASURED, { overdueReceivables: null }));
  assert.equal(without.available, true, "a projection is still possible without it");
  assert.equal(without.optimistic_30d_balance, null,
    "but no optimistic balance is claimed");

  const with_ = computeCashflowForecast(
    Object.assign({}, MEASURED, { overdueReceivables: 500000 }));
  assert.equal(typeof with_.optimistic_30d_balance, "number",
    "and a measured figure does produce one");
});

// ══════════════════════════════════════════════════════════════════
// whatIfSimulator
// ══════════════════════════════════════════════════════════════════

test("[PI8] a MEASURED baseline still simulates", () => {
  const r = whatIfSimulator.simulate({
    type: "reduce_revenue", params: { pct: 20 },
    baseline: Object.assign({ monthlyRevenue: 900000, componentScores: {} }, MEASURED)
  });
  assert.notEqual(r.available, false, "a measured baseline is simulated");
  assert.ok(r.scenario, "with a scenario");
  assert.ok(r.forecast_before && r.forecast_after, "and a before/after projection");
});

test("[PI9] a MEASURED ZERO baseline is valid", () => {
  const r = whatIfSimulator.simulate({
    type: "reduce_revenue", params: { pct: 20 },
    baseline: { startingCash: 0, monthlyNet: 0, monthlyBurn: 0,
      overdueReceivables: 0, monthlyRevenue: 0, componentScores: {} }
  });
  assert.notEqual(r.available, false,
    "zeros that were MEASURED are a legitimate baseline");
  assert.ok(r.scenario, "and the scenario runs");
});

test("[PI10] every kind of unmeasured baseline value is REFUSED, never zeroed", () => {
  UNMEASURED.forEach(([label, value]) => {
    const r = whatIfSimulator.simulate({
      type: "reduce_revenue", params: { pct: 20 },
      baseline: Object.assign({ monthlyRevenue: 900000, componentScores: {} },
        MEASURED, { startingCash: value })
    });

    assert.equal(r.available, false, `${label} startingCash is refused`);
    assert.equal(r.reason, "unmeasured_baseline");
    assert.ok(r.missing.includes("startingCash"), `${label}: named`);
    assert.match(r.detail, /not substituted with zero/i);

    // NO SIMULATION, and nothing that could be mistaken for one.
    assert.equal(r.forecast_before, null, `${label}: no before-projection`);
    assert.equal(r.forecast_after, null, `${label}: no after-projection`);
    assert.equal(r.baseline, null, `${label}: no baseline figures`);
    assert.equal(r.health_before, null, `${label}: no health figure was computed`);
    assert.equal(r.health_after, null);
  });
});

test("[PI11] an unmeasured monthlyNet or monthlyBurn refuses the simulation", () => {
  ["monthlyNet", "monthlyBurn"].forEach((field) => {
    const r = whatIfSimulator.simulate({
      type: "reduce_revenue", params: { pct: 20 },
      baseline: Object.assign({ monthlyRevenue: 900000, componentScores: {} },
        MEASURED, { [field]: undefined })
    });
    assert.equal(r.available, false, `${field} is required`);
    assert.ok(r.missing.includes(field));
    assert.equal(r.forecast_after, null, `${field}: nothing was projected`);
  });
});

test("[PI12] an empty baseline produces no simulation", () => {
  const r = whatIfSimulator.simulate({ type: "reduce_revenue", params: {}, baseline: {} });
  assert.equal(r.available, false);
  assert.deepEqual([...r.missing].sort(),
    ["monthlyBurn", "monthlyNet", "startingCash"]);
  assert.equal(r.forecast_before, null);
});

// ══════════════════════════════════════════════════════════════════
// The guard against the pattern returning
// ══════════════════════════════════════════════════════════════════

test("[PI13] neither module defaults a required financial input to zero", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const strip = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  const forecast = strip(fs.readFileSync(
    path.join(__dirname, "../../src/services/cashflowForecast.js"), "utf-8"));
  const simulator = strip(fs.readFileSync(
    path.join(__dirname, "../../src/services/whatIfSimulator.js"), "utf-8"));

  // The exact expressions that fabricated the zeros.
  assert.equal(/num\(input\.startingCash, 0\)/.test(forecast), false,
    "the forecaster no longer defaults starting cash to zero");
  assert.equal(/num\(input\.monthlyNet, 0\)/.test(forecast), false);
  assert.equal(/num\(baseline\.startingCash\)/.test(simulator), false,
    "nor does the simulator");

  // And the refusal is present in both.
  assert.match(forecast, /reason: "unmeasured_input"/);
  assert.match(simulator, /reason: "unmeasured_baseline"/);
});
