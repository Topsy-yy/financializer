const test = require("node:test");
const assert = require("node:assert/strict");

const entitlements = require("../../src/services/entitlements");

test("credit period key rolls every 12 hours in UTC", () => {
  const a = entitlements.currentPeriod("2026-08-31T00:10:00Z");
  const b = entitlements.currentPeriod("2026-08-31T11:59:59Z");
  const c = entitlements.currentPeriod("2026-08-31T12:00:00Z");

  assert.equal(a, "2026-08-31:00");
  assert.equal(b, "2026-08-31:00");
  assert.equal(c, "2026-08-31:12");
});

test("ensurePeriod refills when the credit window changes", () => {
  const profile = { plan: "starter", credits: 3, creditsPeriod: "2026-08-31:00" };
  const changed = entitlements.ensurePeriod(profile);

  // This assertion is time-independent: if the current key differs, refill is true;
  // if it matches, no refill is needed.
  const nowKey = entitlements.currentPeriod();
  if (nowKey === "2026-08-31:00") {
    assert.equal(changed, false);
    assert.equal(profile.credits, 3);
  } else {
    assert.equal(changed, true);
    assert.equal(profile.credits, entitlements.PLANS.starter.allowance);
    assert.equal(profile.creditsPeriod, nowKey);
  }
});
