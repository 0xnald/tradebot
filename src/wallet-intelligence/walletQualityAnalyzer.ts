// Produces wallet-level FEATURES for a future scoring system — explicitly
// NOT the Smart Selection score and NOT a trade recommendation (that's a
// later phase, per the Phase 3 brief). Every formula here is a simple,
// disclosed heuristic — documented as such, not presented as a rigorously
// derived statistic. Any feature that depends on data no verified provider
// supplies yet (entry market cap, entry liquidity — see
// docs/WALLET_DATA_SOURCES.md §3) is `null` and named in
// `unavailableFeatures`, never approximated.

import { clamp01 } from "../shared/math.js";
import type { WalletPerformanceSummary, WalletQualityFeatures } from "../types/domain.js";

export class WalletQualityAnalyzer {
  computeFeatures(performance: WalletPerformanceSummary): WalletQualityFeatures {
    const unavailable: string[] = [];
    const { lifetime, last7d, last30d, sampleSizeConfidence } = performance;

    // --- profitabilityScore: blends lifetime win rate and average ROI ---
    let profitabilityScore: number | null = null;
    if (lifetime.winRatePct !== null) {
      const roiComponent = lifetime.averageRoiPct !== null ? clamp01((lifetime.averageRoiPct + 100) / 200) : 0.5;
      profitabilityScore = clamp01(0.5 * (lifetime.winRatePct / 100) + 0.5 * roiComponent);
    } else {
      unavailable.push("profitabilityScore (no closed trades)");
    }

    // --- consistencyScore: agreement of win rate across whichever windows have >=3 closed trades ---
    const windowWinRates = [lifetime, last30d, last7d]
      .filter((w) => w.computed && w.winningTrades + w.losingTrades >= 3)
      .map((w) => w.winRatePct)
      .filter((v): v is number => v !== null);

    let consistencyScore: number | null = null;
    if (windowWinRates.length >= 2) {
      const spread = Math.max(...windowWinRates) - Math.min(...windowWinRates);
      consistencyScore = clamp01(1 - spread / 100);
    } else {
      unavailable.push("consistencyScore (fewer than 2 windows with >=3 closed trades)");
    }

    // --- earlyEntryScore: lower average entry market cap -> higher score ---
    // Referenced against an arbitrary-but-stated $0 (score 1) to $1,000,000+ (score 0) scale.
    let earlyEntryScore: number | null = null;
    if (lifetime.averageEntryMarketCapUsd !== null) {
      earlyEntryScore = clamp01(1 - lifetime.averageEntryMarketCapUsd / 1_000_000);
    } else {
      unavailable.push("earlyEntryScore (no entry market cap data — see docs/WALLET_DATA_SOURCES.md §3)");
    }

    // --- liquidityAwareScore: higher average entry liquidity -> higher score (safer entries) ---
    // Referenced against an arbitrary-but-stated $0 (score 0) to $500,000+ (score 1) scale.
    let liquidityAwareScore: number | null = null;
    if (lifetime.averageEntryLiquidityUsd !== null) {
      liquidityAwareScore = clamp01(lifetime.averageEntryLiquidityUsd / 500_000);
    } else {
      unavailable.push("liquidityAwareScore (no entry liquidity data — see docs/WALLET_DATA_SOURCES.md §3)");
    }

    // --- recentPerformanceScore: most granular computed recent window's win rate ---
    const recentWindow = last7d.computed && last7d.winningTrades + last7d.losingTrades > 0 ? last7d : last30d;
    let recentPerformanceScore: number | null = null;
    if (recentWindow.computed && recentWindow.winRatePct !== null) {
      recentPerformanceScore = clamp01(recentWindow.winRatePct / 100);
    } else {
      unavailable.push("recentPerformanceScore (no closed trades in the last 7 or 30 days)");
    }

    // --- copyabilityScore: longer average holding time -> more realistically copyable ---
    // Referenced against an arbitrary-but-stated 0 (score 0) to 24h+ (score 1) scale — a
    // wallet that enters and exits within seconds isn't realistically followable by hand.
    let copyabilityScore: number | null = null;
    if (lifetime.averageHoldingSeconds !== null) {
      copyabilityScore = clamp01(lifetime.averageHoldingSeconds / (24 * 3600));
    } else {
      unavailable.push("copyabilityScore (no holding-time data from closed trades)");
    }

    // --- riskScore: combines losing-streak length and worst-trade drawdown. Higher = riskier. ---
    const streakComponent = lifetime.longestLossStreak > 0 ? clamp01(lifetime.longestLossStreak / 10) : null;
    const drawdownComponent = lifetime.minRoiPct !== null ? clamp01(Math.abs(Math.min(0, lifetime.minRoiPct)) / 100) : null;
    let riskScore: number | null = null;
    if (streakComponent !== null || drawdownComponent !== null) {
      const parts = [streakComponent, drawdownComponent].filter((v): v is number => v !== null);
      riskScore = parts.reduce((a, b) => a + b, 0) / parts.length;
    } else {
      unavailable.push("riskScore (no losing streak or drawdown data)");
    }

    return {
      chainId: performance.chainId,
      walletAddress: performance.walletAddress,
      computedAt: new Date().toISOString(),
      consistencyScore,
      profitabilityScore,
      earlyEntryScore,
      liquidityAwareScore,
      sampleSizeConfidence,
      recentPerformanceScore,
      copyabilityScore,
      riskScore,
      unavailableFeatures: unavailable,
    };
  }
}
