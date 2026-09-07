import { test } from "node:test";
import assert from "node:assert/strict";
import { EntryQualityAnalyzer } from "./entryQualityAnalyzer.js";

const CHAIN_ID = 4663;

function baseInputs(overrides: Partial<Parameters<EntryQualityAnalyzer["analyze"]>[0]> = {}) {
  return {
    signalId: "sig1",
    chainId: CHAIN_ID,
    contractAddress: "0xtoken",
    priceAtSignalUsd: 1,
    currentPriceUsd: 1,
    marketCapAtSignalUsd: 100_000,
    currentMarketCapUsd: 100_000,
    liquidityAtSignalUsd: 50_000,
    currentLiquidityUsd: 50_000,
    volumeAtSignal: 10_000,
    currentVolume: 10_000,
    ...overrides,
  };
}

test("computes priceSincePct/marketCapSincePct/liquiditySincePct from signal-time vs current values", () => {
  const analyzer = new EntryQualityAnalyzer();
  const result = analyzer.analyze(baseInputs({ currentPriceUsd: 1.5, currentMarketCapUsd: 150_000, currentLiquidityUsd: 45_000 }));
  assert.equal(result.priceSincePct, 50);
  assert.equal(result.marketCapSincePct, 50);
  assert.equal(result.liquiditySincePct, -10);
});

test("returns UNAVAILABLE with all-null core fields when signal-time data is entirely missing", () => {
  const analyzer = new EntryQualityAnalyzer();
  const result = analyzer.analyze(baseInputs({ priceAtSignalUsd: null, liquidityAtSignalUsd: null }));
  assert.equal(result.priceSincePct, null);
  assert.equal(result.liquiditySincePct, null);
  assert.equal(result.dataQuality, "UNAVAILABLE");
});

test("classifies chase risk as HIGH only when price is way up AND still near the recent high", () => {
  const analyzer = new EntryQualityAnalyzer();
  const result = analyzer.analyze(
    baseInputs({ currentPriceUsd: 2, distanceFromRecentHighPct: -2 }), // +100% price, 2% off the high
  );
  assert.equal(result.chaseRisk, "HIGH");
});

test("classifies chase risk as ELEVATED when price is up meaningfully but not necessarily near the high", () => {
  const analyzer = new EntryQualityAnalyzer();
  const result = analyzer.analyze(baseInputs({ currentPriceUsd: 1.3 })); // +30%, no distanceFromRecentHighPct given
  assert.equal(result.chaseRisk, "ELEVATED");
});

test("classifies chase risk as LOW when price hasn't moved much since the signal", () => {
  const analyzer = new EntryQualityAnalyzer();
  const result = analyzer.analyze(baseInputs({ currentPriceUsd: 1.02 }));
  assert.equal(result.chaseRisk, "LOW");
});

test("classifies chase risk as UNKNOWN — never a guess — when price-since-signal can't be computed", () => {
  const analyzer = new EntryQualityAnalyzer();
  const result = analyzer.analyze(baseInputs({ priceAtSignalUsd: null }));
  assert.equal(result.chaseRisk, "UNKNOWN");
});

test("flags liquidity as deteriorating only at/beyond the documented threshold", () => {
  const analyzer = new EntryQualityAnalyzer({ liquidityDeteriorationThresholdPct: -10 });
  const deteriorated = analyzer.analyze(baseInputs({ currentLiquidityUsd: 40_000 })); // -20%
  assert.equal(deteriorated.liquidityDeteriorating, "detected");

  const stable = analyzer.analyze(baseInputs({ currentLiquidityUsd: 48_000 })); // -4%
  assert.equal(stable.liquidityDeteriorating, "not_detected");
});

test("classifies volume acceleration by the ratio of current to signal-time volume", () => {
  const analyzer = new EntryQualityAnalyzer({ volumeAccelerationHighRatio: 3, volumeAccelerationModerateRatio: 1.5 });
  assert.equal(analyzer.analyze(baseInputs({ currentVolume: 40_000 })).volumeAcceleration, "HIGH");
  assert.equal(analyzer.analyze(baseInputs({ currentVolume: 20_000 })).volumeAcceleration, "MODERATE");
  assert.equal(analyzer.analyze(baseInputs({ currentVolume: 10_500 })).volumeAcceleration, "LOW");
  assert.equal(analyzer.analyze(baseInputs({ volumeAtSignal: null })).volumeAcceleration, "UNKNOWN");
});

test("flags deteriorating flow only when the buy/sell ratio dropped beyond the documented fraction", () => {
  const analyzer = new EntryQualityAnalyzer({ flowDeteriorationRatioFraction: 0.5 });
  const deteriorated = analyzer.analyze(baseInputs({ buySellRatioAtSignal: 4, currentBuySellRatio: 1 })); // dropped to 25% of original
  assert.equal(deteriorated.flowDeteriorating, "detected");

  const stable = analyzer.analyze(baseInputs({ buySellRatioAtSignal: 4, currentBuySellRatio: 3 }));
  assert.equal(stable.flowDeteriorating, "not_detected");

  const unknown = analyzer.analyze(baseInputs());
  assert.equal(unknown.flowDeteriorating, "unknown");
});

test("never decides BUY/SELL — the output is feature-only", () => {
  const analyzer = new EntryQualityAnalyzer();
  const result = analyzer.analyze(baseInputs({ currentPriceUsd: 5 }));
  assert.ok(!("action" in result));
  assert.ok(!("recommendation" in result));
});
