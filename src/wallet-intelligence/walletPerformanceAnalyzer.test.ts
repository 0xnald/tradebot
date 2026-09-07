import { test } from "node:test";
import assert from "node:assert/strict";
import { WalletPerformanceAnalyzer, computeSampleSizeConfidence, SAMPLE_SIZE_CONFIDENCE_TARGET } from "./walletPerformanceAnalyzer.js";
import type { WalletRoundTrip, WalletTrade } from "../types/domain.js";

const WALLET = "0xwallet";
const CHAIN_ID = 4663;
const NOW = new Date("2026-09-05T00:00:00.000Z");

function tradeAt(daysAgo: number, overrides: Partial<WalletTrade> = {}): WalletTrade {
  const ts = new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  return {
    chainId: CHAIN_ID,
    walletAddress: WALLET,
    timestamp: ts,
    blockNumber: 1000 - daysAgo,
    transactionHash: `0xtx-${daysAgo}-${Math.random()}`,
    tokenAddress: "0xtoken",
    poolAddress: "0xpool",
    direction: "BUY",
    tokenAmountRaw: "-1",
    quoteAmountRaw: "1",
    approxUsdValue: null,
    tokenPriceUsdAtTrade: null,
    liquidityUsdAtTrade: null,
    marketCapUsdAtTrade: null,
    source: "test",
    ...overrides,
  };
}

function win(daysAgo: number, entryUsd: number, exitUsd: number, tokenAddress = "0xtoken"): WalletRoundTrip {
  const entryTrade = tradeAt(daysAgo, { direction: "BUY", approxUsdValue: entryUsd, tokenAddress });
  const exitTrade = tradeAt(daysAgo - 0.1, { direction: "SELL", approxUsdValue: exitUsd, tokenAddress, blockNumber: entryTrade.blockNumber + 1 });
  return {
    chainId: CHAIN_ID,
    walletAddress: WALLET,
    tokenAddress,
    entryTrade,
    exitTrade,
    entryUsdValue: entryUsd,
    exitUsdValue: exitUsd,
    pnlUsd: exitUsd - entryUsd,
    roiPct: ((exitUsd - entryUsd) / entryUsd) * 100,
    holdingSeconds: 3600,
    status: exitUsd > entryUsd ? "WIN" : "LOSS",
  };
}

test("computeSampleSizeConfidence scales with closed-trade count up to the documented target, capped at 1", () => {
  assert.equal(computeSampleSizeConfidence(0), 0);
  assert.equal(computeSampleSizeConfidence(SAMPLE_SIZE_CONFIDENCE_TARGET / 2), 0.5);
  assert.equal(computeSampleSizeConfidence(SAMPLE_SIZE_CONFIDENCE_TARGET), 1);
  assert.equal(computeSampleSizeConfidence(SAMPLE_SIZE_CONFIDENCE_TARGET * 10), 1); // never exceeds 1
});

test("a wallet with 2 wins should not out-rank a wallet with 200 trades on sample size confidence alone", () => {
  const smallSample = computeSampleSizeConfidence(2);
  const largeSample = computeSampleSizeConfidence(200);
  assert.ok(largeSample > smallSample);
  assert.equal(largeSample, 1);
});

test("lifetime window aggregates win rate, realized PnL, and streaks correctly", () => {
  const roundTrips = [win(10, 100, 150), win(9, 100, 80), win(8, 100, 200)];
  const analyzer = new WalletPerformanceAnalyzer();
  const summary = analyzer.computeSummary(CHAIN_ID, WALLET, roundTrips, NOW);

  assert.equal(summary.lifetime.computed, true);
  assert.equal(summary.lifetime.totalTrades, 3);
  assert.equal(summary.lifetime.winningTrades, 2);
  assert.equal(summary.lifetime.losingTrades, 1);
  assert.equal(summary.lifetime.winRatePct, (2 / 3) * 100);
  assert.equal(summary.lifetime.realizedPnlUsd, 50 + -20 + 100);
});

test("30-day and 7-day windows only include trades within their recency cutoff", () => {
  const roundTrips = [
    win(2, 100, 150), // within both 7d and 30d
    win(15, 100, 150), // within 30d only
    win(60, 100, 150), // outside both
  ];
  const analyzer = new WalletPerformanceAnalyzer();
  const summary = analyzer.computeSummary(CHAIN_ID, WALLET, roundTrips, NOW);

  assert.equal(summary.lifetime.totalTrades, 3);
  assert.equal(summary.last30d.totalTrades, 2);
  assert.equal(summary.last7d.totalTrades, 1);
});

test("a window with zero trades is 'not computed' with a stated reason, not a fabricated zero", () => {
  const analyzer = new WalletPerformanceAnalyzer();
  const summary = analyzer.computeSummary(CHAIN_ID, WALLET, [], NOW);

  assert.equal(summary.lifetime.computed, false);
  assert.ok(summary.lifetime.insufficientDataReason);
  assert.equal(summary.lifetime.winRatePct, null);
  assert.equal(summary.lifetime.realizedPnlUsd, null);
});

test("OPEN and UNKNOWN round trips are counted but excluded from win-rate/PnL math", () => {
  const openTrip: WalletRoundTrip = {
    chainId: CHAIN_ID,
    walletAddress: WALLET,
    tokenAddress: "0xtoken2",
    entryTrade: tradeAt(1, { direction: "BUY", tokenAddress: "0xtoken2" }),
    entryUsdValue: null,
    exitUsdValue: null,
    pnlUsd: null,
    roiPct: null,
    holdingSeconds: null,
    status: "OPEN",
  };

  const analyzer = new WalletPerformanceAnalyzer();
  const summary = analyzer.computeSummary(CHAIN_ID, WALLET, [win(1, 100, 150), openTrip], NOW);

  assert.equal(summary.lifetime.totalTrades, 2);
  assert.equal(summary.lifetime.openTrades, 1);
  assert.equal(summary.lifetime.winRatePct, 100); // only the 1 closed trade counts toward win rate
  assert.equal(summary.lifetime.uniqueTokenCount, 2);
});

test("computes longest win and loss streaks in chronological order", () => {
  // win, win, loss, win, loss, loss, loss (most recent last)
  const roundTrips = [
    win(6, 100, 150), // win
    win(5, 100, 150), // win
    win(4, 100, 50), // loss
    win(3, 100, 150), // win
    win(2, 100, 50), // loss
    win(1, 100, 50), // loss
    win(0.5, 100, 50), // loss
  ];

  const analyzer = new WalletPerformanceAnalyzer();
  const summary = analyzer.computeSummary(CHAIN_ID, WALLET, roundTrips, NOW);
  assert.equal(summary.lifetime.longestWinStreak, 2);
  assert.equal(summary.lifetime.longestLossStreak, 3);
});
