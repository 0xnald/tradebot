// Liquidity trend analysis over LiquiditySnapshot history — see
// docs/TOKEN_MARKET_INTELLIGENCE.md for the documented thresholds below.
// Deliberately uses neutral, evidence-based terminology: a liquidity drop
// is reported as "DECREASING" or "LARGE_WITHDRAWAL", never labeled a "rug"
// — that's an interpretive claim this analyzer doesn't make.

import type { LiquidityAnalysis, LiquidityTrend, PoolInfo } from "../types/domain.js";

export interface LiquidityAnalyzerOptions {
  /** A single-step drop at or beyond this magnitude is LARGE_WITHDRAWAL. Documented, not hidden. */
  largeWithdrawalThresholdPct?: number;
  /** A single-step change within +/- this band is STABLE rather than INCREASING/DECREASING. */
  stableBandPct?: number;
}

const DEFAULT_LARGE_WITHDRAWAL_THRESHOLD_PCT = 30;
const DEFAULT_STABLE_BAND_PCT = 5;

export function computeTopPoolLiquidityConcentrationPct(pools: PoolInfo[]): number | null {
  const knownLiquidity = pools.filter((p): p is PoolInfo & { liquidityUsd: number } => typeof p.liquidityUsd === "number");
  if (knownLiquidity.length === 0) return null;
  const total = knownLiquidity.reduce((sum, p) => sum + p.liquidityUsd, 0);
  if (total <= 0) return null;
  const max = Math.max(...knownLiquidity.map((p) => p.liquidityUsd));
  return (max / total) * 100;
}

export class LiquidityAnalyzer {
  #largeWithdrawalThresholdPct: number;
  #stableBandPct: number;

  constructor(options: LiquidityAnalyzerOptions = {}) {
    this.#largeWithdrawalThresholdPct = options.largeWithdrawalThresholdPct ?? DEFAULT_LARGE_WITHDRAWAL_THRESHOLD_PCT;
    this.#stableBandPct = options.stableBandPct ?? DEFAULT_STABLE_BAND_PCT;
  }

  /**
   * `previous`/`priorToPrevious` are the two most recent earlier snapshots
   * (T-1, T-2), oldest last — pass what's actually available; acceleration
   * is only computed when both are present. `allPools`, if supplied, lets
   * `topPoolLiquidityConcentrationPct` be computed across every pool for
   * this token, not just the one being analyzed.
   */
  analyze(
    chainId: number,
    poolAddress: string,
    current: { liquidityUsd: number | null; observedAt: string } | null,
    previous: { liquidityUsd: number | null; observedAt: string } | null,
    priorToPrevious?: { liquidityUsd: number | null; observedAt: string } | null,
    allPools?: PoolInfo[],
  ): LiquidityAnalysis {
    const observedAt = new Date().toISOString();
    const notes: string[] = [];
    const topPoolLiquidityConcentrationPct = allPools ? computeTopPoolLiquidityConcentrationPct(allPools) : null;

    if (current === null || current.liquidityUsd === null) {
      notes.push("current liquidity is unavailable — trend cannot be assessed");
      return {
        chainId,
        poolAddress,
        observedAt,
        currentLiquidityUsd: null,
        previousLiquidityUsd: previous?.liquidityUsd ?? null,
        changeUsd: null,
        changePct: null,
        accelerationPctPoints: null,
        trend: "UNKNOWN",
        topPoolLiquidityConcentrationPct,
        dataQuality: "UNAVAILABLE",
        notes,
      };
    }

    if (previous === null || previous.liquidityUsd === null) {
      notes.push("no prior liquidity snapshot available — this is the first known reading, not evidence of stability");
      return {
        chainId,
        poolAddress,
        observedAt,
        currentLiquidityUsd: current.liquidityUsd,
        previousLiquidityUsd: null,
        changeUsd: null,
        changePct: null,
        accelerationPctPoints: null,
        trend: "UNKNOWN",
        topPoolLiquidityConcentrationPct,
        dataQuality: "PARTIAL",
        notes,
      };
    }

    const changeUsd = current.liquidityUsd - previous.liquidityUsd;
    const changePct = previous.liquidityUsd !== 0 ? (changeUsd / previous.liquidityUsd) * 100 : null;

    let trend: LiquidityTrend = "UNKNOWN";
    if (changePct !== null) {
      if (changePct <= -this.#largeWithdrawalThresholdPct) trend = "LARGE_WITHDRAWAL";
      else if (Math.abs(changePct) <= this.#stableBandPct) trend = "STABLE";
      else if (changePct > 0) trend = "INCREASING";
      else trend = "DECREASING";
    }

    let accelerationPctPoints: number | null = null;
    if (priorToPrevious?.liquidityUsd != null && priorToPrevious.liquidityUsd !== 0 && changePct !== null) {
      const priorChangePct = ((previous.liquidityUsd - priorToPrevious.liquidityUsd) / priorToPrevious.liquidityUsd) * 100;
      accelerationPctPoints = changePct - priorChangePct;
    }

    return {
      chainId,
      poolAddress,
      observedAt,
      currentLiquidityUsd: current.liquidityUsd,
      previousLiquidityUsd: previous.liquidityUsd,
      changeUsd,
      changePct,
      accelerationPctPoints,
      trend,
      topPoolLiquidityConcentrationPct,
      dataQuality: "KNOWN",
      notes,
    };
  }
}
