import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreSignalQuality,
  scoreTokenQuality,
  scoreLiquidity,
  scoreMarketFlow,
  scoreMomentum,
  scoreEntryQuality,
  scoreHolderStructure,
  scoreMarketConditions,
} from "./featureGroupScorers.js";
import type {
  ContractFeatureDetection,
  DeployerAnalysis,
  EntryQualityFeatures,
  HolderConcentrationBreakdown,
  LiquidityAnalysis,
  MarketFlowAnalysis,
  MomentumAnalysis,
  PoolQualityAssessment,
  ScoutSignal,
  TokenAge,
  TokenContractInfo,
} from "../types/domain.js";

const NOW = new Date("2026-09-05T00:10:00.000Z");
const CHAIN_ID = 4663;

function signal(overrides: Partial<ScoutSignal> = {}): ScoutSignal {
  return {
    id: "sig1",
    source: "telegram:scoutrobinhood",
    sourceMessageId: "1",
    receivedAt: "2026-09-05T00:05:00.000Z",
    messageType: "EARLY_CALL",
    rawText: "...",
    parseConfidence: "high",
    parseWarnings: [],
    ...overrides,
  };
}

test("scoreSignalQuality rewards EARLY_CALL over PERFORMANCE_UPDATE — Scout call types are not equally predictive", () => {
  const early = scoreSignalQuality(signal({ messageType: "EARLY_CALL" }), 8, NOW);
  const update = scoreSignalQuality(signal({ messageType: "PERFORMANCE_UPDATE" }), 8, NOW);
  assert.ok(early.groupScore! > update.groupScore!);
});

test("scoreSignalQuality decays with signal age", () => {
  const fresh = scoreSignalQuality(signal({ receivedAt: "2026-09-05T00:09:00.000Z" }), 8, NOW);
  const stale = scoreSignalQuality(signal({ receivedAt: "2026-09-04T23:00:00.000Z" }), 8, NOW);
  assert.ok(fresh.groupScore! > stale.groupScore!);
});

// Phase 7.1 §2 — NaN correctness bug fix (see docs/LIVE_PIPELINE.md). An
// unparseable receivedAt used to make `new Date(x).getTime()` return NaN,
// which propagated through linearBand() into a NaN "signalAge" feature
// value and, via weightedAverage(), into a NaN groupScore. Fixed via
// safeAgeSeconds(): the signalAge feature is now UNAVAILABLE (excluded
// from the group's weighted average, like any other missing feature)
// rather than NaN.
test("scoreSignalQuality treats an unparseable receivedAt as UNAVAILABLE, not NaN", () => {
  const result = scoreSignalQuality(signal({ receivedAt: "not-a-real-timestamp" }), 8, NOW);
  const ageFeature = result.features.find((f) => f.name === "signalAge")!;
  assert.equal(ageFeature.rawValue, null);
  assert.equal(ageFeature.normalizedValue, null);
  assert.equal(ageFeature.dataQuality, "UNAVAILABLE");
  assert.ok(result.groupScore === null || Number.isFinite(result.groupScore));
});

test("scoreTokenQuality never treats 'not_detected' as a full safety guarantee, and 'unknown' is excluded (not penalized)", () => {
  const detected: ContractFeatureDetection = {
    chainId: CHAIN_ID,
    contractAddress: "0xtoken",
    observedAt: NOW.toISOString(),
    mintFunctionDetected: "detected",
    burnFunctionDetected: "not_detected",
    pauseFunctionDetected: "not_detected",
    blacklistFunctionDetected: "not_detected",
    ownershipFunctionDetected: "not_detected",
    maxTransactionFunctionDetected: "not_detected",
    maxWalletFunctionDetected: "not_detected",
    feeOrTaxFunctionDetected: "not_detected",
    proxyPatternDetected: "not_detected",
    bytecodeSizeBytes: 1000,
    detectionMethod: "bytecode-selector-scan",
    detectionCaveat: "caveat",
  };
  const unknown: ContractFeatureDetection = { ...detected, mintFunctionDetected: "unknown" };

  const withDetectedMint = scoreTokenQuality(null, null, detected, null, 12);
  const withUnknownMint = scoreTokenQuality(null, null, unknown, null, 12);
  const mintFeatureDetected = withDetectedMint.features.find((f) => f.name === "mintFunctionDetected")!;
  const mintFeatureUnknown = withUnknownMint.features.find((f) => f.name === "mintFunctionDetected")!;

  assert.equal(mintFeatureDetected.normalizedValue, 0.2); // penalized
  assert.equal(mintFeatureUnknown.normalizedValue, null); // excluded, not defaulted
  assert.equal(mintFeatureUnknown.dataQuality, "UNKNOWN");
});

test("scoreTokenQuality does not reward 'not_detected' as strongly as a true positive absence would deserve — it's capped below 1.0", () => {
  const features: ContractFeatureDetection = {
    chainId: CHAIN_ID,
    contractAddress: "0xtoken",
    observedAt: NOW.toISOString(),
    mintFunctionDetected: "not_detected",
    burnFunctionDetected: "not_detected",
    pauseFunctionDetected: "not_detected",
    blacklistFunctionDetected: "not_detected",
    ownershipFunctionDetected: "not_detected",
    maxTransactionFunctionDetected: "not_detected",
    maxWalletFunctionDetected: "not_detected",
    feeOrTaxFunctionDetected: "not_detected",
    proxyPatternDetected: "not_detected",
    bytecodeSizeBytes: 1000,
    detectionMethod: "x",
    detectionCaveat: "x",
  };
  const result = scoreTokenQuality(null, null, features, null, 12);
  const mint = result.features.find((f) => f.name === "mintFunctionDetected")!;
  assert.ok(mint.normalizedValue! < 1.0);
});

const tokenAge: TokenAge = { deployedAt: NOW.toISOString(), ageSeconds: 300, ageMinutes: 5, ageHours: 0.08, ageCategory: "BRAND_NEW" };

test("scoreTokenQuality is UNAVAILABLE-quality (not zero score) when nothing is known", () => {
  const result = scoreTokenQuality(null, null, null, null, 12);
  assert.equal(result.groupScore, null);
  assert.equal(result.dataQuality, "UNAVAILABLE");
});

const liquidTrendUp: LiquidityAnalysis = {
  chainId: CHAIN_ID,
  poolAddress: "0xpool",
  observedAt: NOW.toISOString(),
  currentLiquidityUsd: 50_000,
  previousLiquidityUsd: 40_000,
  changeUsd: 10_000,
  changePct: 25,
  accelerationPctPoints: null,
  trend: "INCREASING",
  topPoolLiquidityConcentrationPct: null,
  dataQuality: "KNOWN",
  notes: [],
};

test("scoreLiquidity rewards increasing liquidity over decreasing liquidity", () => {
  const increasing = scoreLiquidity(liquidTrendUp, [], 15);
  const decreasing = scoreLiquidity({ ...liquidTrendUp, trend: "DECREASING", changePct: -20 }, [], 15);
  assert.ok(increasing.groupScore! > decreasing.groupScore!);
});

test("scoreLiquidity treats no prior snapshot as UNKNOWN trend, not STABLE", () => {
  const result = scoreLiquidity({ ...liquidTrendUp, trend: "UNKNOWN", previousLiquidityUsd: null }, [], 15);
  const trendFeature = result.features.find((f) => f.name === "liquidityTrend")!;
  assert.equal(trendFeature.normalizedValue, null);
});

test("scoreLiquidity returns UNAVAILABLE when there is no liquidity data at all", () => {
  const result = scoreLiquidity(null, [], 15);
  assert.equal(result.dataQuality, "UNAVAILABLE");
  assert.equal(result.groupScore, null);
});

function flow(overrides: Partial<MarketFlowAnalysis> = {}): MarketFlowAnalysis {
  return {
    chainId: CHAIN_ID,
    poolAddress: "0xpool",
    observedAt: NOW.toISOString(),
    buyCount: 10,
    sellCount: 5,
    unknownCount: 0,
    buyQuoteVolume: 10,
    sellQuoteVolume: 5,
    netQuoteFlow: 5,
    buySellRatio: 2,
    uniqueTraderCount: 8,
    averageTradeSizeQuote: 1,
    medianTradeSizeQuote: 1,
    largeTradeCount: 0,
    largeTradeThresholdQuote: 3,
    recentTradeCount: 5,
    recentWindowSeconds: 300,
    dataQuality: "KNOWN",
    notes: [],
    ...overrides,
  };
}

test("scoreMarketFlow rewards healthy buy pressure but caps an extreme ratio rather than rewarding it as 'even better'", () => {
  const healthy = scoreMarketFlow(flow({ buySellRatio: 2 }), 13);
  const extreme = scoreMarketFlow(flow({ buySellRatio: 50 }), 13);
  const healthyRatio = healthy.features.find((f) => f.name === "buySellRatio")!.normalizedValue!;
  const extremeRatio = extreme.features.find((f) => f.name === "buySellRatio")!.normalizedValue!;
  assert.ok(extremeRatio < healthyRatio);
});

test("scoreMarketFlow never scores unknown-direction swaps as buy or sell evidence", () => {
  const result = scoreMarketFlow(flow({ unknownCount: 100, buyCount: 1, sellCount: 1 }), 13);
  const unknownFeature = result.features.find((f) => f.name === "unknownSwapFraction")!;
  assert.equal(unknownFeature.weight, 0); // never contributes to the score
  assert.equal(unknownFeature.normalizedValue, null);
});

test("scoreMarketFlow returns UNAVAILABLE with no fabricated ratio when there's no flow data", () => {
  const result = scoreMarketFlow(null, 13);
  assert.equal(result.dataQuality, "UNAVAILABLE");
});

function momentum(overrides: Partial<MomentumAnalysis> = {}): MomentumAnalysis {
  return {
    chainId: CHAIN_ID,
    contractAddress: "0xtoken",
    observedAt: NOW.toISOString(),
    changePct1m: null,
    changePct5m: 20,
    changePct15m: 20,
    changePct30m: null,
    changePct1h: null,
    rateOfChangePctPerMinute: 4,
    accelerationPctPoints: 0,
    drawdownFromRecentHighPct: -5,
    distanceFromRecentLowPct: 30,
    volatilityPct: 10,
    observationCount: 3,
    dataQuality: "KNOWN",
    ...overrides,
  };
}

test("scoreMomentum does not simply reward the fastest pump — extreme change scores lower than healthy moderate change", () => {
  const healthy = scoreMomentum(momentum({ changePct15m: 20 }), 10);
  const parabolic = scoreMomentum(momentum({ changePct15m: 300 }), 10);
  const healthyChange = healthy.features.find((f) => f.name === "shortTermPriceChange")!.normalizedValue!;
  const parabolicChange = parabolic.features.find((f) => f.name === "shortTermPriceChange")!.normalizedValue!;
  assert.ok(parabolicChange < healthyChange);
});

test("scoreMomentum returns UNAVAILABLE with no fabricated observations when momentum is null", () => {
  const result = scoreMomentum(null, 10);
  assert.equal(result.dataQuality, "UNAVAILABLE");
});

function entryQuality(overrides: Partial<EntryQualityFeatures> = {}): EntryQualityFeatures {
  return {
    signalId: "sig1",
    chainId: CHAIN_ID,
    contractAddress: "0xtoken",
    computedAt: NOW.toISOString(),
    priceSincePct: 10,
    marketCapSincePct: 10,
    liquiditySincePct: 0,
    volumeAcceleration: "MODERATE",
    distanceFromRecentHighPct: 5,
    priceAccelerationPctPoints: 0,
    chaseRisk: "LOW",
    liquidityDeteriorating: "not_detected",
    flowDeteriorating: "not_detected",
    dataQuality: "KNOWN",
    notes: [],
    ...overrides,
  };
}

test("scoreEntryQuality penalizes a huge price move since signal (chasing) more than a small healthy one", () => {
  const healthy = scoreEntryQuality(entryQuality({ priceSincePct: 10 }), 20);
  const chasing = scoreEntryQuality(entryQuality({ priceSincePct: 200 }), 20);
  assert.ok(healthy.groupScore! > chasing.groupScore!);
});

test("scoreEntryQuality returns UNAVAILABLE when there's nothing to compare to a Scout signal", () => {
  const result = scoreEntryQuality(null, 20);
  assert.equal(result.dataQuality, "UNAVAILABLE");
});

function holders(overrides: Partial<HolderConcentrationBreakdown> = {}): HolderConcentrationBreakdown {
  return {
    chainId: CHAIN_ID,
    contractAddress: "0xtoken",
    observedAt: NOW.toISOString(),
    holderCount: 200,
    top5ConcentrationPct: 20,
    top10ConcentrationPct: 25,
    largestHolderSharePct: 8,
    deployerSharePct: 2,
    concentrationChangePct: null,
    dataQuality: "KNOWN",
    ...overrides,
  };
}

test("scoreHolderStructure rewards low concentration over high concentration, without treating either as automatically good/bad", () => {
  const spread = scoreHolderStructure(holders({ top10ConcentrationPct: 15, largestHolderSharePct: 5 }), 10);
  const concentrated = scoreHolderStructure(holders({ top10ConcentrationPct: 95, largestHolderSharePct: 80 }), 10);
  assert.ok(spread.groupScore! > concentrated.groupScore!);
});

test("scoreHolderStructure is UNAVAILABLE — not zero, not a guess — when holder data doesn't exist", () => {
  const result = scoreHolderStructure(null, 10);
  assert.equal(result.dataQuality, "UNAVAILABLE");
  assert.equal(result.groupScore, null);
});

test("scoreMarketConditions is always UNKNOWN and contributes nothing — a stub, not a model", () => {
  const result = scoreMarketConditions({ regime: "UNKNOWN", notes: [] }, 0);
  assert.equal(result.groupScore, null);
  assert.equal(result.groupWeight, 0);
});
