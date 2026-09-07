import { test } from "node:test";
import assert from "node:assert/strict";
import { WalletQualityAnalyzer } from "./walletQualityAnalyzer.js";
import type { WalletPerformanceSummary, WalletPerformanceWindow } from "../types/domain.js";

const CHAIN_ID = 4663;
const WALLET = "0xwallet";

function emptyWindow(label: WalletPerformanceWindow["windowLabel"]): WalletPerformanceWindow {
  return {
    windowLabel: label,
    computed: false,
    insufficientDataReason: "no trades",
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    openTrades: 0,
    unknownTrades: 0,
    winRatePct: null,
    realizedPnlUsd: null,
    averageRoiPct: null,
    medianRoiPct: null,
    maxRoiPct: null,
    minRoiPct: null,
    averageHoldingSeconds: null,
    medianHoldingSeconds: null,
    averageEntryMarketCapUsd: null,
    medianEntryMarketCapUsd: null,
    averageEntryLiquidityUsd: null,
    uniqueTokenCount: 0,
    uniqueTradingDayCount: 0,
    longestWinStreak: 0,
    longestLossStreak: 0,
  };
}

function summary(overrides: Partial<WalletPerformanceSummary> = {}): WalletPerformanceSummary {
  return {
    chainId: CHAIN_ID,
    walletAddress: WALLET,
    computedAt: new Date().toISOString(),
    lifetime: emptyWindow("lifetime"),
    last30d: emptyWindow("30d"),
    last7d: emptyWindow("7d"),
    sampleSizeConfidence: 0,
    ...overrides,
  };
}

test("returns null profitability/consistency scores with reasons when there are no closed trades", () => {
  const analyzer = new WalletQualityAnalyzer();
  const features = analyzer.computeFeatures(summary());

  assert.equal(features.profitabilityScore, null);
  assert.equal(features.consistencyScore, null);
  assert.ok(features.unavailableFeatures.some((f) => f.includes("profitabilityScore")));
});

test("computes a profitabilityScore from lifetime win rate and average ROI when available", () => {
  const analyzer = new WalletQualityAnalyzer();
  const features = analyzer.computeFeatures(
    summary({
      lifetime: { ...emptyWindow("lifetime"), computed: true, winRatePct: 80, averageRoiPct: 50, winningTrades: 8, losingTrades: 2 },
    }),
  );

  assert.ok(features.profitabilityScore !== null);
  assert.ok(features.profitabilityScore! > 0.5); // 80% win rate + positive ROI should score well above the midpoint
});

test("never fabricates earlyEntryScore/liquidityAwareScore — null with a reason when no entry market cap/liquidity data exists", () => {
  const analyzer = new WalletQualityAnalyzer();
  const features = analyzer.computeFeatures(
    summary({ lifetime: { ...emptyWindow("lifetime"), computed: true, winRatePct: 60, winningTrades: 6, losingTrades: 4 } }),
  );

  assert.equal(features.earlyEntryScore, null);
  assert.equal(features.liquidityAwareScore, null);
  assert.ok(features.unavailableFeatures.some((f) => f.includes("earlyEntryScore")));
  assert.ok(features.unavailableFeatures.some((f) => f.includes("liquidityAwareScore")));
});

test("computes earlyEntryScore/liquidityAwareScore once the underlying data is present", () => {
  const analyzer = new WalletQualityAnalyzer();
  const features = analyzer.computeFeatures(
    summary({
      lifetime: {
        ...emptyWindow("lifetime"),
        computed: true,
        winRatePct: 60,
        winningTrades: 6,
        losingTrades: 4,
        averageEntryMarketCapUsd: 50_000,
        averageEntryLiquidityUsd: 250_000,
      },
    }),
  );

  assert.ok(features.earlyEntryScore !== null && features.earlyEntryScore > 0.9); // $50k mcap is very early on the stated scale
  assert.ok(features.liquidityAwareScore !== null && features.liquidityAwareScore > 0.4);
});

test("passes sample-size confidence straight through so a small sample never looks more confident than a large one", () => {
  const analyzer = new WalletQualityAnalyzer();
  const smallSample = analyzer.computeFeatures(summary({ sampleSizeConfidence: 0.05 }));
  const largeSample = analyzer.computeFeatures(summary({ sampleSizeConfidence: 1 }));

  assert.equal(smallSample.sampleSizeConfidence, 0.05);
  assert.equal(largeSample.sampleSizeConfidence, 1);
});

test("recentPerformanceScore prefers the 7-day window when it has closed trades, else falls back to 30-day", () => {
  const analyzer = new WalletQualityAnalyzer();
  const features = analyzer.computeFeatures(
    summary({
      last7d: { ...emptyWindow("7d"), computed: true, winRatePct: 100, winningTrades: 1, losingTrades: 0 },
      last30d: { ...emptyWindow("30d"), computed: true, winRatePct: 40, winningTrades: 2, losingTrades: 3 },
    }),
  );

  assert.equal(features.recentPerformanceScore, 1); // from the 7d window, not the 30d one
});

test("riskScore reflects losing streak length and worst-trade drawdown", () => {
  const analyzer = new WalletQualityAnalyzer();
  const features = analyzer.computeFeatures(
    summary({
      lifetime: { ...emptyWindow("lifetime"), computed: true, longestLossStreak: 5, minRoiPct: -80 },
    }),
  );

  assert.ok(features.riskScore !== null && features.riskScore > 0);
});
