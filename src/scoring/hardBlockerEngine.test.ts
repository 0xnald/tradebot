import { test } from "node:test";
import assert from "node:assert/strict";
import { HardBlockerEngine, type HardBlockerInputs } from "./hardBlockerEngine.js";
import { SMART_SELECTION_V1_CONFIG } from "./smartSelectionConfig.js";

const NOW = new Date("2026-09-05T00:10:00.000Z");

function baseInputs(overrides: Partial<HardBlockerInputs> = {}): HardBlockerInputs {
  return {
    tokenContractInfo: { chainId: 4663, contractAddress: "0xtoken", name: "Test", symbol: "TST", decimals: 18 },
    contractFeatures: null,
    deployerAnalysis: null,
    liquidityAnalysis: null,
    currentLiquidityUsd: 50_000,
    priceUsd: 1,
    marketDataObservedAt: NOW.toISOString(),
    overallDataQuality: "KNOWN",
    chaseAssessment: { level: "LOW_CHASE_RISK", evidence: [] },
    entryQuality: null,
    ...overrides,
  };
}

test("does not block a normal, healthy opportunity", () => {
  const engine = new HardBlockerEngine(SMART_SELECTION_V1_CONFIG);
  const result = engine.evaluate(baseInputs(), NOW);
  assert.equal(result.blocked, false);
  assert.deepEqual(result.reasons, []);
});

test("blocks on INVALID_CONTRACT when no token metadata exists at all", () => {
  const engine = new HardBlockerEngine(SMART_SELECTION_V1_CONFIG);
  const result = engine.evaluate(baseInputs({ tokenContractInfo: null }), NOW);
  assert.equal(result.blocked, true);
  assert.ok(result.reasons.some((r) => r.code === "INVALID_CONTRACT"));
});

test("blocks on NO_USABLE_LIQUIDITY only when liquidity is confirmed below the floor, not merely unknown", () => {
  const engine = new HardBlockerEngine(SMART_SELECTION_V1_CONFIG);
  const belowFloor = engine.evaluate(baseInputs({ currentLiquidityUsd: 100 }), NOW);
  assert.ok(belowFloor.reasons.some((r) => r.code === "NO_USABLE_LIQUIDITY"));

  const unknown = engine.evaluate(baseInputs({ currentLiquidityUsd: null }), NOW);
  assert.ok(!unknown.reasons.some((r) => r.code === "NO_USABLE_LIQUIDITY"));
});

test("blocks on CATASTROPHIC_LIQUIDITY_COLLAPSE using a stricter threshold than LiquidityAnalyzer's own trend label", () => {
  const engine = new HardBlockerEngine(SMART_SELECTION_V1_CONFIG);
  const collapsed = engine.evaluate(
    baseInputs({ liquidityAnalysis: { changePct: -80 } as any }),
    NOW,
  );
  assert.ok(collapsed.reasons.some((r) => r.code === "CATASTROPHIC_LIQUIDITY_COLLAPSE"));

  // A -40% drop is LiquidityAnalyzer's "LARGE_WITHDRAWAL" (informational) but not catastrophic enough to hard-block.
  const merelyLarge = engine.evaluate(baseInputs({ liquidityAnalysis: { changePct: -40 } as any }), NOW);
  assert.ok(!merelyLarge.reasons.some((r) => r.code === "CATASTROPHIC_LIQUIDITY_COLLAPSE"));
});

test("blocks on TOKEN_DATA_FUNDAMENTALLY_UNAVAILABLE when overall data quality is UNAVAILABLE", () => {
  const engine = new HardBlockerEngine(SMART_SELECTION_V1_CONFIG);
  const result = engine.evaluate(baseInputs({ overallDataQuality: "UNAVAILABLE" }), NOW);
  assert.ok(result.reasons.some((r) => r.code === "TOKEN_DATA_FUNDAMENTALLY_UNAVAILABLE"));
});

test("blocks on IMPOSSIBLE_MARKET_STATE for a non-positive price or negative liquidity", () => {
  const engine = new HardBlockerEngine(SMART_SELECTION_V1_CONFIG);
  const badPrice = engine.evaluate(baseInputs({ priceUsd: 0 }), NOW);
  assert.ok(badPrice.reasons.some((r) => r.code === "IMPOSSIBLE_MARKET_STATE"));

  const badLiquidity = engine.evaluate(baseInputs({ currentLiquidityUsd: -100 }), NOW);
  assert.ok(badLiquidity.reasons.some((r) => r.code === "IMPOSSIBLE_MARKET_STATE"));
});

test("blocks on EXTREME_EXECUTION_DETERIORATION for high chase risk plus confirmed liquidity deterioration", () => {
  const engine = new HardBlockerEngine(SMART_SELECTION_V1_CONFIG);
  const result = engine.evaluate(
    baseInputs({
      chaseAssessment: { level: "HIGH_CHASE_RISK", evidence: [] },
      entryQuality: { liquidityDeteriorating: "detected" } as any,
    }),
    NOW,
  );
  assert.ok(result.reasons.some((r) => r.code === "EXTREME_EXECUTION_DETERIORATION"));
});

test("blocks on SEVERE_CONTRACT_RESTRICTION_DETECTED only for the narrow mint+majority-deployer combination, not mint alone", () => {
  const engine = new HardBlockerEngine(SMART_SELECTION_V1_CONFIG);
  const severe = engine.evaluate(
    baseInputs({
      contractFeatures: { mintFunctionDetected: "detected" } as any,
      deployerAnalysis: { deployerTokenBalancePctOfSupply: 70 } as any,
    }),
    NOW,
  );
  assert.ok(severe.reasons.some((r) => r.code === "SEVERE_CONTRACT_RESTRICTION_DETECTED"));

  const mintAlone = engine.evaluate(
    baseInputs({
      contractFeatures: { mintFunctionDetected: "detected" } as any,
      deployerAnalysis: { deployerTokenBalancePctOfSupply: 5 } as any,
    }),
    NOW,
  );
  assert.ok(!mintAlone.reasons.some((r) => r.code === "SEVERE_CONTRACT_RESTRICTION_DETECTED"));
});

test("blocks on STALE_CRITICAL_DATA when market data is older than the documented threshold", () => {
  const engine = new HardBlockerEngine(SMART_SELECTION_V1_CONFIG);
  const stale = engine.evaluate(baseInputs({ marketDataObservedAt: "2026-09-05T00:00:00.000Z" }), NOW); // 10 min old > 5 min threshold
  assert.ok(stale.reasons.some((r) => r.code === "STALE_CRITICAL_DATA"));

  const fresh = engine.evaluate(baseInputs({ marketDataObservedAt: "2026-09-05T00:09:00.000Z" }), NOW); // 1 min old
  assert.ok(!fresh.reasons.some((r) => r.code === "STALE_CRITICAL_DATA"));
});

// Phase 7.1 §2 — NaN correctness bug fix (see docs/LIVE_PIPELINE.md). An
// unparseable marketDataObservedAt used to make `new Date(x).getTime()`
// return NaN, and `NaN > threshold` is always false — so the check never
// actually blocked, but the computed ageSeconds (surfaced elsewhere, e.g.
// confidence's freshness component) was NaN. Fixed via safeAgeSeconds():
// an invalid timestamp is now treated exactly like a missing one (skip
// the check — never a fabricated block, never a NaN age).
test("does not block, and does not crash, on an unparseable marketDataObservedAt", () => {
  const engine = new HardBlockerEngine(SMART_SELECTION_V1_CONFIG);
  const result = engine.evaluate(baseInputs({ marketDataObservedAt: "not-a-real-timestamp" }), NOW);
  assert.ok(!result.reasons.some((r) => r.code === "STALE_CRITICAL_DATA"));
});

test("is fully deterministic — the same inputs always produce the same result", () => {
  const engine = new HardBlockerEngine(SMART_SELECTION_V1_CONFIG);
  const inputs = baseInputs({ currentLiquidityUsd: 100 });
  const first = engine.evaluate(inputs, NOW);
  const second = engine.evaluate(inputs, NOW);
  assert.deepEqual(first, second);
});
