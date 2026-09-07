import { test } from "node:test";
import assert from "node:assert/strict";
import { EntryChaseDetector } from "./entryChaseDetector.js";
import type { EntryQualityFeatures, LiquidityAnalysis } from "../types/domain.js";

function entryQuality(overrides: Partial<EntryQualityFeatures> = {}): EntryQualityFeatures {
  return {
    signalId: "sig1",
    chainId: 4663,
    contractAddress: "0xtoken",
    computedAt: new Date().toISOString(),
    priceSincePct: 10,
    marketCapSincePct: 10,
    liquiditySincePct: 0,
    volumeAcceleration: "MODERATE",
    distanceFromRecentHighPct: 20,
    priceAccelerationPctPoints: 0,
    chaseRisk: "LOW",
    liquidityDeteriorating: "not_detected",
    flowDeteriorating: "not_detected",
    dataQuality: "KNOWN",
    notes: [],
    ...overrides,
  };
}

function liquidity(trend: LiquidityAnalysis["trend"]): LiquidityAnalysis {
  return {
    chainId: 4663,
    poolAddress: "0xpool",
    observedAt: new Date().toISOString(),
    currentLiquidityUsd: 50_000,
    previousLiquidityUsd: 50_000,
    changeUsd: 0,
    changePct: 0,
    accelerationPctPoints: null,
    trend,
    topPoolLiquidityConcentrationPct: null,
    dataQuality: "KNOWN",
    notes: [],
  };
}

test("classifies LOW_CHASE_RISK when price hasn't moved and liquidity is healthy", () => {
  const detector = new EntryChaseDetector();
  const result = detector.classify(entryQuality({ chaseRisk: "LOW" }), liquidity("STABLE"));
  assert.equal(result.level, "LOW_CHASE_RISK");
});

test("classifies HIGH_CHASE_RISK directly from EntryQualityAnalyzer's own HIGH classification", () => {
  const detector = new EntryChaseDetector();
  const result = detector.classify(entryQuality({ chaseRisk: "HIGH" }), liquidity("STABLE"));
  assert.equal(result.level, "HIGH_CHASE_RISK");
  assert.ok(result.evidence.length > 0);
});

test("escalates ELEVATED chase risk to HIGH when liquidity is also deteriorating", () => {
  const detector = new EntryChaseDetector();
  const result = detector.classify(entryQuality({ chaseRisk: "ELEVATED", liquidityDeteriorating: "detected" }), liquidity("DECREASING"));
  assert.equal(result.level, "HIGH_CHASE_RISK");
});

test("classifies MEDIUM_CHASE_RISK for ELEVATED chase risk alone (liquidity still fine)", () => {
  const detector = new EntryChaseDetector();
  const result = detector.classify(entryQuality({ chaseRisk: "ELEVATED", liquidityDeteriorating: "not_detected" }), liquidity("STABLE"));
  assert.equal(result.level, "MEDIUM_CHASE_RISK");
});

test("flags MEDIUM_CHASE_RISK for a volume spike without matching liquidity growth, even with LOW base chase risk", () => {
  const detector = new EntryChaseDetector();
  const result = detector.classify(entryQuality({ chaseRisk: "LOW", volumeAcceleration: "HIGH" }), liquidity("STABLE"));
  assert.equal(result.level, "MEDIUM_CHASE_RISK");
  assert.ok(result.evidence.some((e) => e.includes("without matching depth")));
});

test("returns UNKNOWN — never guesses — when entry quality data is unavailable", () => {
  const detector = new EntryChaseDetector();
  const result = detector.classify(null, null);
  assert.equal(result.level, "UNKNOWN");
});

test("does not automatically flag every fast-moving token as high risk", () => {
  const detector = new EntryChaseDetector();
  // Meaningful upward move but not extreme, liquidity fine, volume moderate.
  const result = detector.classify(entryQuality({ chaseRisk: "LOW", priceSincePct: 15 }), liquidity("INCREASING"));
  assert.equal(result.level, "LOW_CHASE_RISK");
});
