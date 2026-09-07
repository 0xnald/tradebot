import { test } from "node:test";
import assert from "node:assert/strict";
import { LiquidityAnalyzer, computeTopPoolLiquidityConcentrationPct } from "./liquidityAnalyzer.js";
import type { PoolInfo } from "../types/domain.js";

const CHAIN_ID = 4663;
const POOL = "0xpool";

function reading(liquidityUsd: number | null, observedAt = "2026-09-05T00:00:00.000Z") {
  return { liquidityUsd, observedAt };
}

test("classifies a large increase as INCREASING", () => {
  const analyzer = new LiquidityAnalyzer();
  const result = analyzer.analyze(CHAIN_ID, POOL, reading(150), reading(100));
  assert.equal(result.trend, "INCREASING");
  assert.equal(result.changePct, 50);
});

test("classifies a small change within the stable band as STABLE", () => {
  const analyzer = new LiquidityAnalyzer({ stableBandPct: 5 });
  const result = analyzer.analyze(CHAIN_ID, POOL, reading(103), reading(100));
  assert.equal(result.trend, "STABLE");
});

test("classifies a moderate decrease as DECREASING, not a large withdrawal", () => {
  const analyzer = new LiquidityAnalyzer({ largeWithdrawalThresholdPct: 30 });
  const result = analyzer.analyze(CHAIN_ID, POOL, reading(85), reading(100));
  assert.equal(result.trend, "DECREASING");
});

test("classifies a drop at/beyond the documented threshold as LARGE_WITHDRAWAL, using neutral terminology", () => {
  const analyzer = new LiquidityAnalyzer({ largeWithdrawalThresholdPct: 30 });
  const result = analyzer.analyze(CHAIN_ID, POOL, reading(60), reading(100));
  assert.equal(result.trend, "LARGE_WITHDRAWAL");
  assert.ok(!JSON.stringify(result).toLowerCase().includes("rug"));
});

test("returns UNAVAILABLE (not STABLE) when there is no prior snapshot to compare against", () => {
  const analyzer = new LiquidityAnalyzer();
  const result = analyzer.analyze(CHAIN_ID, POOL, reading(100), null);
  assert.equal(result.trend, "UNKNOWN");
  assert.equal(result.dataQuality, "PARTIAL");
  assert.ok(result.notes.some((n) => n.includes("not evidence of stability")));
});

test("returns UNAVAILABLE when current liquidity itself is missing", () => {
  const analyzer = new LiquidityAnalyzer();
  const result = analyzer.analyze(CHAIN_ID, POOL, null, reading(100));
  assert.equal(result.dataQuality, "UNAVAILABLE");
  assert.equal(result.changePct, null);
});

test("computes acceleration only when a third (T-2) snapshot is available", () => {
  const analyzer = new LiquidityAnalyzer();
  const withThree = analyzer.analyze(CHAIN_ID, POOL, reading(150), reading(100), reading(90));
  assert.ok(withThree.accelerationPctPoints !== null);

  const withTwo = analyzer.analyze(CHAIN_ID, POOL, reading(150), reading(100));
  assert.equal(withTwo.accelerationPctPoints, null);
});

test("computeTopPoolLiquidityConcentrationPct returns the largest pool's share of total known liquidity", () => {
  const pools: PoolInfo[] = [
    { chainId: CHAIN_ID, poolAddress: "0xa", dexId: "x", tokenAddress: "0xt", quoteTokenAddress: "0xq", liquidityUsd: 80, source: "test" },
    { chainId: CHAIN_ID, poolAddress: "0xb", dexId: "x", tokenAddress: "0xt", quoteTokenAddress: "0xq", liquidityUsd: 20, source: "test" },
  ];
  assert.equal(computeTopPoolLiquidityConcentrationPct(pools), 80);
});

test("computeTopPoolLiquidityConcentrationPct returns null when no pool has known liquidity", () => {
  const pools: PoolInfo[] = [
    { chainId: CHAIN_ID, poolAddress: "0xa", dexId: "x", tokenAddress: "0xt", quoteTokenAddress: "0xq", source: "test" },
  ];
  assert.equal(computeTopPoolLiquidityConcentrationPct(pools), null);
});
