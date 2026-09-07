// Computes wallet performance statistics from matched round trips (see
// walletTradeMatcher.ts). Every number here is either directly observed or
// a plain aggregate over directly-observed numbers — nothing is invented
// to fill a gap. See docs/WALLET_DATA_SOURCES.md §3 for why, in practice,
// most fields will be null for wallets sourced only from the on-chain
// provider (no historical USD values available yet).

import type { WalletPerformanceSummary, WalletPerformanceWindow, WalletRoundTrip } from "../types/domain.js";

/**
 * Documented, stated threshold for "fully confident" sample size — not
 * empirically derived, just a commonly-cited rule of thumb for when an
 * average starts to approximate a stable distribution. A wallet with 2
 * trades and a 100% win rate should not look more confident than a wallet
 * with 200 trades and a 60% win rate — this is the mechanism that
 * prevents that.
 */
export const SAMPLE_SIZE_CONFIDENCE_TARGET = 30;

export function computeSampleSizeConfidence(closedTradeCount: number): number {
  return Math.min(1, closedTradeCount / SAMPLE_SIZE_CONFIDENCE_TARGET);
}

function average(values: number[]): number | null {
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function nonNull(values: (number | null | undefined)[]): number[] {
  return values.filter((v): v is number => v !== null && v !== undefined);
}

function computeStreaks(closedTrips: WalletRoundTrip[]): { longestWinStreak: number; longestLossStreak: number } {
  const ordered = [...closedTrips].sort(
    (a, b) => (a.exitTrade?.blockNumber ?? 0) - (b.exitTrade?.blockNumber ?? 0),
  );

  let longestWin = 0;
  let longestLoss = 0;
  let currentWin = 0;
  let currentLoss = 0;

  for (const trip of ordered) {
    if (trip.status === "WIN") {
      currentWin += 1;
      currentLoss = 0;
      longestWin = Math.max(longestWin, currentWin);
    } else if (trip.status === "LOSS") {
      currentLoss += 1;
      currentWin = 0;
      longestLoss = Math.max(longestLoss, currentLoss);
    }
  }

  return { longestWinStreak: longestWin, longestLossStreak: longestLoss };
}

function tradeTimestamp(trip: WalletRoundTrip): string | null {
  return trip.entryTrade?.timestamp ?? trip.exitTrade?.timestamp ?? null;
}

function computeWindow(windowLabel: WalletPerformanceWindow["windowLabel"], roundTrips: WalletRoundTrip[]): WalletPerformanceWindow {
  if (roundTrips.length === 0) {
    return {
      windowLabel,
      computed: false,
      insufficientDataReason: "no trades observed in this window",
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

  const winning = roundTrips.filter((t) => t.status === "WIN");
  const losing = roundTrips.filter((t) => t.status === "LOSS");
  const open = roundTrips.filter((t) => t.status === "OPEN");
  const unknown = roundTrips.filter((t) => t.status === "UNKNOWN");
  const closed = [...winning, ...losing];

  const pnlValues = nonNull(closed.map((t) => t.pnlUsd));
  const roiValues = nonNull(closed.map((t) => t.roiPct));
  const holdingValues = nonNull(closed.map((t) => t.holdingSeconds));
  const entryMarketCapValues = nonNull(closed.map((t) => t.entryTrade?.marketCapUsdAtTrade));
  const entryLiquidityValues = nonNull(closed.map((t) => t.entryTrade?.liquidityUsdAtTrade));

  const uniqueTokenCount = new Set(roundTrips.map((t) => t.tokenAddress)).size;
  const uniqueTradingDayCount = new Set(
    roundTrips.map(tradeTimestamp).filter((ts): ts is string => ts !== null).map((ts) => ts.slice(0, 10)),
  ).size;

  const { longestWinStreak, longestLossStreak } = computeStreaks(closed);

  return {
    windowLabel,
    computed: true,
    totalTrades: roundTrips.length,
    winningTrades: winning.length,
    losingTrades: losing.length,
    openTrades: open.length,
    unknownTrades: unknown.length,
    winRatePct: closed.length > 0 ? (winning.length / closed.length) * 100 : null,
    realizedPnlUsd: pnlValues.length > 0 ? pnlValues.reduce((a, b) => a + b, 0) : null,
    averageRoiPct: average(roiValues),
    medianRoiPct: median(roiValues),
    maxRoiPct: roiValues.length > 0 ? Math.max(...roiValues) : null,
    minRoiPct: roiValues.length > 0 ? Math.min(...roiValues) : null,
    averageHoldingSeconds: average(holdingValues),
    medianHoldingSeconds: median(holdingValues),
    averageEntryMarketCapUsd: average(entryMarketCapValues),
    medianEntryMarketCapUsd: median(entryMarketCapValues),
    averageEntryLiquidityUsd: average(entryLiquidityValues),
    uniqueTokenCount,
    uniqueTradingDayCount,
    longestWinStreak,
    longestLossStreak,
  };
}

function filterToLastNDays(roundTrips: WalletRoundTrip[], now: Date, days: number): WalletRoundTrip[] {
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  return roundTrips.filter((trip) => {
    const ts = tradeTimestamp(trip);
    if (!ts) return false; // can't place an untimestamped trade in a recency window — it still counts in lifetime
    return new Date(ts).getTime() >= cutoff;
  });
}

export class WalletPerformanceAnalyzer {
  computeSummary(
    chainId: number,
    walletAddress: string,
    roundTrips: WalletRoundTrip[],
    now: Date = new Date(),
  ): WalletPerformanceSummary {
    const lifetime = computeWindow("lifetime", roundTrips);
    const last30d = computeWindow("30d", filterToLastNDays(roundTrips, now, 30));
    const last7d = computeWindow("7d", filterToLastNDays(roundTrips, now, 7));

    const closedLifetimeCount = lifetime.winningTrades + lifetime.losingTrades;

    return {
      chainId,
      walletAddress,
      computedAt: now.toISOString(),
      lifetime,
      last30d,
      last7d,
      sampleSizeConfidence: computeSampleSizeConfidence(closedLifetimeCount),
    };
  }
}
