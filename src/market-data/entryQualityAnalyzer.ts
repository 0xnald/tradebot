// Compares market state at Scout-signal time against current state to
// produce entry-quality FEATURES — never a buy/sell decision (that's a
// later phase). Every threshold is documented below and repeated in
// docs/TOKEN_MARKET_INTELLIGENCE.md.

import type { EntryQualityFeatures, ChaseRiskLevel, VolumeAccelerationLevel, FeatureDetectionState } from "../types/domain.js";

export interface EntryQualityInputs {
  signalId: string;
  chainId: number;
  contractAddress: string;
  priceAtSignalUsd: number | null;
  currentPriceUsd: number | null;
  marketCapAtSignalUsd: number | null;
  currentMarketCapUsd: number | null;
  liquidityAtSignalUsd: number | null;
  currentLiquidityUsd: number | null;
  volumeAtSignal: number | null;
  currentVolume: number | null;
  buySellRatioAtSignal?: number | null;
  currentBuySellRatio?: number | null;
  /** Reuses MomentumAnalyzer's output rather than recomputing — see momentumAnalyzer.ts. */
  distanceFromRecentHighPct?: number | null;
  priceAccelerationPctPoints?: number | null;
}

export interface EntryQualityAnalyzerOptions {
  /** priceSincePct at/above this AND near the recent high => HIGH chase risk. */
  chaseRiskHighPricePct?: number;
  /** "near the recent high" means within this many pct-points of it. */
  nearRecentHighPct?: number;
  /** priceSincePct at/above this alone => ELEVATED chase risk. */
  chaseRiskElevatedPricePct?: number;
  /** liquiditySincePct at/below this (negative) => liquidity deteriorating. */
  liquidityDeteriorationThresholdPct?: number;
  /** currentVolume / volumeAtSignal ratio at/above this => HIGH volume acceleration. */
  volumeAccelerationHighRatio?: number;
  /** ... at/above this => MODERATE. */
  volumeAccelerationModerateRatio?: number;
  /** currentBuySellRatio this fraction (or less) of buySellRatioAtSignal => flow deteriorating. */
  flowDeteriorationRatioFraction?: number;
}

const DEFAULTS = {
  chaseRiskHighPricePct: 50,
  nearRecentHighPct: 5,
  chaseRiskElevatedPricePct: 20,
  liquidityDeteriorationThresholdPct: -10,
  volumeAccelerationHighRatio: 3,
  volumeAccelerationModerateRatio: 1.5,
  flowDeteriorationRatioFraction: 0.5,
};

function pctChange(current: number | null, prior: number | null): number | null {
  if (current === null || prior === null || prior === 0) return null;
  return ((current - prior) / prior) * 100;
}

export class EntryQualityAnalyzer {
  #opts: typeof DEFAULTS;

  constructor(options: EntryQualityAnalyzerOptions = {}) {
    this.#opts = { ...DEFAULTS, ...options };
  }

  analyze(inputs: EntryQualityInputs, now: Date = new Date()): EntryQualityFeatures {
    const notes: string[] = [];
    const priceSincePct = pctChange(inputs.currentPriceUsd, inputs.priceAtSignalUsd);
    const marketCapSincePct = pctChange(inputs.currentMarketCapUsd, inputs.marketCapAtSignalUsd);
    const liquiditySincePct = pctChange(inputs.currentLiquidityUsd, inputs.liquidityAtSignalUsd);

    if (priceSincePct === null) notes.push("price-since-signal unavailable — missing signal-time or current price");
    if (liquiditySincePct === null) notes.push("liquidity-since-signal unavailable — missing signal-time or current liquidity");

    let volumeAcceleration: VolumeAccelerationLevel = "UNKNOWN";
    if (inputs.volumeAtSignal !== null && inputs.volumeAtSignal > 0 && inputs.currentVolume !== null) {
      const ratio = inputs.currentVolume / inputs.volumeAtSignal;
      volumeAcceleration =
        ratio >= this.#opts.volumeAccelerationHighRatio
          ? "HIGH"
          : ratio >= this.#opts.volumeAccelerationModerateRatio
            ? "MODERATE"
            : "LOW";
    } else {
      notes.push("volume acceleration unknown — missing signal-time or current volume");
    }

    const distanceFromRecentHighPct =
      inputs.distanceFromRecentHighPct !== undefined && inputs.distanceFromRecentHighPct !== null
        ? Math.abs(inputs.distanceFromRecentHighPct)
        : null;

    let chaseRisk: ChaseRiskLevel = "UNKNOWN";
    if (priceSincePct !== null) {
      if (
        priceSincePct >= this.#opts.chaseRiskHighPricePct &&
        distanceFromRecentHighPct !== null &&
        distanceFromRecentHighPct <= this.#opts.nearRecentHighPct
      ) {
        chaseRisk = "HIGH";
      } else if (priceSincePct >= this.#opts.chaseRiskElevatedPricePct) {
        chaseRisk = "ELEVATED";
      } else {
        chaseRisk = "LOW";
      }
    }

    let liquidityDeteriorating: FeatureDetectionState = "unknown";
    if (liquiditySincePct !== null) {
      liquidityDeteriorating = liquiditySincePct <= this.#opts.liquidityDeteriorationThresholdPct ? "detected" : "not_detected";
    }

    let flowDeteriorating: FeatureDetectionState = "unknown";
    if (
      inputs.buySellRatioAtSignal !== undefined &&
      inputs.buySellRatioAtSignal !== null &&
      inputs.buySellRatioAtSignal > 0 &&
      inputs.currentBuySellRatio !== undefined &&
      inputs.currentBuySellRatio !== null
    ) {
      flowDeteriorating =
        inputs.currentBuySellRatio <= inputs.buySellRatioAtSignal * this.#opts.flowDeteriorationRatioFraction
          ? "detected"
          : "not_detected";
    } else {
      notes.push("flow deterioration unknown — missing signal-time or current buy/sell ratio");
    }

    const knownCoreFields = [priceSincePct, liquiditySincePct].filter((v) => v !== null).length;

    return {
      signalId: inputs.signalId,
      chainId: inputs.chainId,
      contractAddress: inputs.contractAddress,
      computedAt: now.toISOString(),
      priceSincePct,
      marketCapSincePct,
      liquiditySincePct,
      volumeAcceleration,
      distanceFromRecentHighPct,
      priceAccelerationPctPoints: inputs.priceAccelerationPctPoints ?? null,
      chaseRisk,
      liquidityDeteriorating,
      flowDeteriorating,
      dataQuality: knownCoreFields === 2 ? "KNOWN" : knownCoreFields === 0 ? "UNAVAILABLE" : "PARTIAL",
      notes,
    };
  }
}
