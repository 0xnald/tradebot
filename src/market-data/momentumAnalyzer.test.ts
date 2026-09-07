import { test } from "node:test";
import assert from "node:assert/strict";
import { MomentumAnalyzer } from "./momentumAnalyzer.js";

const CHAIN_ID = 4663;
const TOKEN = "0xtoken";
const NOW = new Date("2026-09-05T00:10:00.000Z");

test("reports UNAVAILABLE with a stated reason when there are no observations at all", () => {
  const analyzer = new MomentumAnalyzer();
  const result = analyzer.analyze(CHAIN_ID, TOKEN, [], NOW);
  assert.equal(result.dataQuality, "UNAVAILABLE");
  assert.ok(result.insufficientDataReason);
});

test("reports UNAVAILABLE — every interval null — when only the current price is available", () => {
  const analyzer = new MomentumAnalyzer();
  const result = analyzer.analyze(CHAIN_ID, TOKEN, [{ observedAt: NOW.toISOString(), priceUsd: 1 }], NOW);
  assert.equal(result.dataQuality, "UNAVAILABLE");
  assert.equal(result.changePct1m, null);
  assert.equal(result.changePct1h, null);
  assert.match(result.insufficientDataReason ?? "", /only one price observation/);
});

test("computes a 5-minute change when an observation exists close to 5 minutes ago", () => {
  const analyzer = new MomentumAnalyzer();
  const observations = [
    { observedAt: "2026-09-05T00:05:00.000Z", priceUsd: 1.0 },
    { observedAt: NOW.toISOString(), priceUsd: 1.5 },
  ];
  const result = analyzer.analyze(CHAIN_ID, TOKEN, observations, NOW);
  assert.equal(result.changePct5m, 50);
  assert.equal(result.dataQuality, "KNOWN");
});

test("does not compute an interval when no observation falls within the documented tolerance window", () => {
  const analyzer = new MomentumAnalyzer();
  // A point 3 hours old is outside even the 1h interval's tolerance (60min +/- 30min),
  // so every interval (1m/5m/15m/30m/1h) should be null — nothing close enough to any of them.
  const observations = [
    { observedAt: "2026-09-04T21:10:00.000Z", priceUsd: 1.0 },
    { observedAt: NOW.toISOString(), priceUsd: 1.5 },
  ];
  const result = analyzer.analyze(CHAIN_ID, TOKEN, observations, NOW);
  assert.equal(result.changePct1m, null);
  assert.equal(result.changePct5m, null);
  assert.equal(result.changePct15m, null);
  assert.equal(result.changePct30m, null);
  assert.equal(result.changePct1h, null);
  assert.equal(result.dataQuality, "PARTIAL"); // observations exist, but no interval could be computed
});

test("computes drawdown from the recent high and distance from the recent low", () => {
  const analyzer = new MomentumAnalyzer();
  const observations = [
    { observedAt: "2026-09-05T00:00:00.000Z", priceUsd: 1.0 }, // low
    { observedAt: "2026-09-05T00:05:00.000Z", priceUsd: 2.0 }, // high
    { observedAt: NOW.toISOString(), priceUsd: 1.5 }, // current
  ];
  const result = analyzer.analyze(CHAIN_ID, TOKEN, observations, NOW);
  assert.equal(result.drawdownFromRecentHighPct, -25); // (1.5-2)/2
  assert.equal(result.distanceFromRecentLowPct, 50); // (1.5-1)/1
});

test("computes volatility as the stddev of consecutive pct changes, requiring at least 3 observations", () => {
  const analyzer = new MomentumAnalyzer();
  const twoObs = analyzer.analyze(
    CHAIN_ID,
    TOKEN,
    [
      { observedAt: "2026-09-05T00:05:00.000Z", priceUsd: 1.0 },
      { observedAt: NOW.toISOString(), priceUsd: 1.5 },
    ],
    NOW,
  );
  assert.equal(twoObs.volatilityPct, null);

  const threeObs = analyzer.analyze(
    CHAIN_ID,
    TOKEN,
    [
      { observedAt: "2026-09-05T00:00:00.000Z", priceUsd: 1.0 },
      { observedAt: "2026-09-05T00:05:00.000Z", priceUsd: 1.5 },
      { observedAt: NOW.toISOString(), priceUsd: 1.0 },
    ],
    NOW,
  );
  assert.ok(threeObs.volatilityPct !== null && threeObs.volatilityPct > 0);
});

test("computes rate of change from the shortest available interval and acceleration from the two shortest", () => {
  const analyzer = new MomentumAnalyzer();
  const observations = [
    { observedAt: "2026-09-05T00:05:00.000Z", priceUsd: 1.0 }, // 5m ago
    { observedAt: "2026-09-05T00:09:00.000Z", priceUsd: 1.1 }, // 1m ago
    { observedAt: NOW.toISOString(), priceUsd: 1.5 }, // now
  ];
  const result = analyzer.analyze(CHAIN_ID, TOKEN, observations, NOW);
  assert.ok(result.rateOfChangePctPerMinute !== null);
  assert.ok(result.accelerationPctPoints !== null);
});
