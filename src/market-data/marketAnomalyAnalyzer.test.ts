import { test } from "node:test";
import assert from "node:assert/strict";
import { MarketAnomalyAnalyzer, type MarketAnomalyInputs } from "./marketAnomalyAnalyzer.js";

const CHAIN_ID = 4663;
const TOKEN = "0xtoken";

function baseInputs(overrides: Partial<MarketAnomalyInputs> = {}): MarketAnomalyInputs {
  return {
    chainId: CHAIN_ID,
    contractAddress: TOKEN,
    currentIntervalVolume: 1000,
    priorIntervalAverageVolume: 1000,
    liquidityAnalysis: null,
    marketFlow: null,
    momentum: null,
    currentTxCountPerMinute: 1,
    priorAverageTxCountPerMinute: 1,
    holderConcentrationChangePct: null,
    ...overrides,
  };
}

test("returns NORMAL for volume/tx-frequency when current matches the prior average", () => {
  const analyzer = new MarketAnomalyAnalyzer();
  const result = analyzer.analyze(baseInputs());
  assert.equal(result.volumeSpike, "NORMAL");
  assert.equal(result.transactionFrequency, "NORMAL");
});

test("flags a volume spike as HIGHLY_UNUSUAL at/beyond the documented ratio", () => {
  const analyzer = new MarketAnomalyAnalyzer({ volumeSpikeHighlyUnusualRatio: 10, volumeSpikeUnusualRatio: 4 });
  const result = analyzer.analyze(baseInputs({ currentIntervalVolume: 12_000, priorIntervalAverageVolume: 1000 }));
  assert.equal(result.volumeSpike, "HIGHLY_UNUSUAL");
  assert.ok(result.evidence.some((e) => e.includes("volume spike")));
});

test("flags a moderate volume increase as UNUSUAL, not HIGHLY_UNUSUAL", () => {
  const analyzer = new MarketAnomalyAnalyzer({ volumeSpikeHighlyUnusualRatio: 10, volumeSpikeUnusualRatio: 4 });
  const result = analyzer.analyze(baseInputs({ currentIntervalVolume: 5000, priorIntervalAverageVolume: 1000 }));
  assert.equal(result.volumeSpike, "UNUSUAL");
});

test("returns UNKNOWN (not NORMAL) when there's no prior average to compare against", () => {
  const analyzer = new MarketAnomalyAnalyzer();
  const result = analyzer.analyze(baseInputs({ priorIntervalAverageVolume: null }));
  assert.equal(result.volumeSpike, "UNKNOWN");
});

test("classifies liquidity removal using its own documented thresholds, distinct from LiquidityAnalyzer's trend labels", () => {
  const analyzer = new MarketAnomalyAnalyzer({ liquidityRemovalHighlyUnusualPct: -50, liquidityRemovalUnusualPct: -25 });
  const result = analyzer.analyze(
    baseInputs({ liquidityAnalysis: { changePct: -60 } as any }),
  );
  assert.equal(result.liquidityRemoval, "HIGHLY_UNUSUAL");
});

test("classifies extreme buy/sell imbalance on either side of the ratio", () => {
  const analyzer = new MarketAnomalyAnalyzer({ buySellImbalanceHighlyUnusualRatio: 10, buySellImbalanceUnusualRatio: 4 });
  const heavyBuy = analyzer.analyze(baseInputs({ marketFlow: { buySellRatio: 15 } as any }));
  assert.equal(heavyBuy.buySellImbalance, "HIGHLY_UNUSUAL");

  const heavySell = analyzer.analyze(baseInputs({ marketFlow: { buySellRatio: 0.05 } as any }));
  assert.equal(heavySell.buySellImbalance, "HIGHLY_UNUSUAL");
});

test("classifies large-trade anomalies from MarketFlowAnalyzer's already-computed largeTradeCount", () => {
  const analyzer = new MarketAnomalyAnalyzer({ largeTradeHighlyUnusualCount: 3 });
  const result = analyzer.analyze(
    baseInputs({ marketFlow: { largeTradeCount: 4, medianTradeSizeQuote: 10 } as any }),
  );
  assert.equal(result.largeTradeAnomaly, "HIGHLY_UNUSUAL");
});

test("classifies price acceleration from MomentumAnalyzer's already-computed value", () => {
  const analyzer = new MarketAnomalyAnalyzer({ priceAccelerationHighlyUnusualPctPoints: 50 });
  const result = analyzer.analyze(baseInputs({ momentum: { accelerationPctPoints: -60 } as any }));
  assert.equal(result.priceAcceleration, "HIGHLY_UNUSUAL"); // works for deceleration too (abs value)
});

test("overall is the worst non-UNKNOWN level across all findings", () => {
  const analyzer = new MarketAnomalyAnalyzer();
  const result = analyzer.analyze(
    baseInputs({
      currentIntervalVolume: 12_000,
      priorIntervalAverageVolume: 1000, // HIGHLY_UNUSUAL
      marketFlow: { buySellRatio: 5, largeTradeCount: 0, medianTradeSizeQuote: 10 } as any, // UNUSUAL
    }),
  );
  assert.equal(result.overall, "HIGHLY_UNUSUAL");
});

test("overall stays NORMAL/known-based when at least one finding is actually computable", () => {
  const analyzer = new MarketAnomalyAnalyzer();
  // Only volume/tx-frequency inputs are missing; the base tx-frequency pair (1 vs 1) is still known.
  const result = analyzer.analyze(baseInputs({ priorIntervalAverageVolume: null }));
  assert.equal(result.volumeSpike, "UNKNOWN");
  assert.equal(result.transactionFrequency, "NORMAL");
  assert.equal(result.overall, "NORMAL");
});

test("overall is UNKNOWN only when every single finding is genuinely UNKNOWN", () => {
  const analyzer = new MarketAnomalyAnalyzer();
  const result = analyzer.analyze(
    baseInputs({ priorIntervalAverageVolume: null, priorAverageTxCountPerMinute: null }),
  );
  // liquidityAnalysis/marketFlow/momentum/holderConcentrationChangePct are also null in baseInputs,
  // so with both remaining ratio inputs nulled too, every single finding is UNKNOWN.
  assert.equal(result.overall, "UNKNOWN");
});

test("never labels a finding malicious — uses only NORMAL/UNUSUAL/HIGHLY_UNUSUAL/UNKNOWN terminology", () => {
  const analyzer = new MarketAnomalyAnalyzer();
  const result = analyzer.analyze(baseInputs({ currentIntervalVolume: 50_000, priorIntervalAverageVolume: 1000 }));
  const serialized = JSON.stringify(result).toLowerCase();
  assert.ok(!serialized.includes("malicious"));
  assert.ok(!serialized.includes("scam"));
});

test("documents every threshold used, for transparency", () => {
  const analyzer = new MarketAnomalyAnalyzer();
  const result = analyzer.analyze(baseInputs());
  assert.ok(result.thresholds.volumeSpike.length > 0);
  assert.ok(result.thresholds.liquidityRemoval.length > 0);
});
