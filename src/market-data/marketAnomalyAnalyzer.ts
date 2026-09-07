// Objective anomaly detection, built entirely on top of the other Phase 4
// analyzers' outputs (LiquidityAnalyzer, MarketFlowAnalyzer,
// MomentumAnalyzer, holderConcentrationAnalyzer) rather than recomputing
// anything — see the Phase 4 brief's "reuse existing abstractions."
//
// Every threshold below is a disclosed, documented choice (order-of-
// magnitude jumps that are unlikely under normal organic trading) — not
// empirically derived, and explicitly not a claim of malicious intent.
// "HIGHLY_UNUSUAL" describes the statistical shape of the data, nothing
// more.

import type {
  AnomalyLevel,
  LiquidityAnalysis,
  MarketAnomalyFindings,
  MarketFlowAnalysis,
  MomentumAnalysis,
} from "../types/domain.js";

export interface MarketAnomalyInputs {
  chainId: number;
  contractAddress: string;
  currentIntervalVolume: number | null;
  priorIntervalAverageVolume: number | null;
  liquidityAnalysis: LiquidityAnalysis | null;
  marketFlow: MarketFlowAnalysis | null;
  momentum: MomentumAnalysis | null;
  currentTxCountPerMinute: number | null;
  priorAverageTxCountPerMinute: number | null;
  holderConcentrationChangePct: number | null;
}

export interface MarketAnomalyAnalyzerOptions {
  volumeSpikeHighlyUnusualRatio?: number;
  volumeSpikeUnusualRatio?: number;
  liquidityRemovalHighlyUnusualPct?: number;
  liquidityRemovalUnusualPct?: number;
  buySellImbalanceHighlyUnusualRatio?: number;
  buySellImbalanceUnusualRatio?: number;
  largeTradeHighlyUnusualCount?: number;
  priceAccelerationHighlyUnusualPctPoints?: number;
  priceAccelerationUnusualPctPoints?: number;
  txFrequencyHighlyUnusualRatio?: number;
  txFrequencyUnusualRatio?: number;
  holderConcentrationHighlyUnusualPctPoints?: number;
  holderConcentrationUnusualPctPoints?: number;
}

const DEFAULTS = {
  volumeSpikeHighlyUnusualRatio: 10,
  volumeSpikeUnusualRatio: 4,
  liquidityRemovalHighlyUnusualPct: -50,
  liquidityRemovalUnusualPct: -25,
  buySellImbalanceHighlyUnusualRatio: 10,
  buySellImbalanceUnusualRatio: 4,
  largeTradeHighlyUnusualCount: 3,
  priceAccelerationHighlyUnusualPctPoints: 50,
  priceAccelerationUnusualPctPoints: 20,
  txFrequencyHighlyUnusualRatio: 8,
  txFrequencyUnusualRatio: 3,
  holderConcentrationHighlyUnusualPctPoints: 20,
  holderConcentrationUnusualPctPoints: 10,
};

const LEVEL_RANK: Record<AnomalyLevel, number> = { UNKNOWN: -1, NORMAL: 0, UNUSUAL: 1, HIGHLY_UNUSUAL: 2 };

export class MarketAnomalyAnalyzer {
  #opts: typeof DEFAULTS;

  constructor(options: MarketAnomalyAnalyzerOptions = {}) {
    this.#opts = { ...DEFAULTS, ...options };
  }

  analyze(inputs: MarketAnomalyInputs): MarketAnomalyFindings {
    const evidence: string[] = [];

    const volumeSpike = this.#classifyRatio(
      inputs.currentIntervalVolume,
      inputs.priorIntervalAverageVolume,
      this.#opts.volumeSpikeHighlyUnusualRatio,
      this.#opts.volumeSpikeUnusualRatio,
      (level, ratio) => evidence.push(`volume spike: current interval is ${ratio.toFixed(1)}x the prior average (${level})`),
    );

    const liquidityRemoval = this.#classifyThreshold(
      inputs.liquidityAnalysis?.changePct ?? null,
      this.#opts.liquidityRemovalHighlyUnusualPct,
      this.#opts.liquidityRemovalUnusualPct,
      "lte",
      (level, value) => evidence.push(`liquidity change of ${value.toFixed(1)}% (${level})`),
    );

    const buySellImbalance = this.#classifyImbalanceRatio(inputs.marketFlow?.buySellRatio ?? null, evidence);

    const largeTradeAnomaly = this.#classifyLargeTradeCount(inputs.marketFlow, evidence);

    const priceAcceleration = this.#classifyAbsThreshold(
      inputs.momentum?.accelerationPctPoints ?? null,
      this.#opts.priceAccelerationHighlyUnusualPctPoints,
      this.#opts.priceAccelerationUnusualPctPoints,
      (level, value) => evidence.push(`price acceleration of ${value.toFixed(1)} pct-points between intervals (${level})`),
    );

    const transactionFrequency = this.#classifyRatio(
      inputs.currentTxCountPerMinute,
      inputs.priorAverageTxCountPerMinute,
      this.#opts.txFrequencyHighlyUnusualRatio,
      this.#opts.txFrequencyUnusualRatio,
      (level, ratio) => evidence.push(`transaction frequency is ${ratio.toFixed(1)}x the prior average (${level})`),
    );

    const holderConcentrationChange = this.#classifyAbsThreshold(
      inputs.holderConcentrationChangePct,
      this.#opts.holderConcentrationHighlyUnusualPctPoints,
      this.#opts.holderConcentrationUnusualPctPoints,
      (level, value) => evidence.push(`top-10 holder concentration changed by ${value.toFixed(1)} pct-points (${level})`),
    );

    const levels = [
      volumeSpike,
      liquidityRemoval,
      buySellImbalance,
      largeTradeAnomaly,
      priceAcceleration,
      transactionFrequency,
      holderConcentrationChange,
    ];
    const overall = this.#worstOf(levels);

    return {
      chainId: inputs.chainId,
      contractAddress: inputs.contractAddress,
      observedAt: new Date().toISOString(),
      volumeSpike,
      liquidityRemoval,
      buySellImbalance,
      largeTradeAnomaly,
      priceAcceleration,
      transactionFrequency,
      holderConcentrationChange,
      overall,
      evidence,
      thresholds: {
        volumeSpike: `HIGHLY_UNUSUAL >= ${this.#opts.volumeSpikeHighlyUnusualRatio}x prior average, UNUSUAL >= ${this.#opts.volumeSpikeUnusualRatio}x (order-of-magnitude jumps are unlikely under normal organic trading)`,
        liquidityRemoval: `HIGHLY_UNUSUAL <= ${this.#opts.liquidityRemovalHighlyUnusualPct}%, UNUSUAL <= ${this.#opts.liquidityRemovalUnusualPct}% single-step change`,
        buySellImbalance: `HIGHLY_UNUSUAL ratio >= ${this.#opts.buySellImbalanceHighlyUnusualRatio} or <= ${(1 / this.#opts.buySellImbalanceHighlyUnusualRatio).toFixed(2)}, UNUSUAL >= ${this.#opts.buySellImbalanceUnusualRatio} or <= ${(1 / this.#opts.buySellImbalanceUnusualRatio).toFixed(2)}`,
        largeTradeAnomaly: `HIGHLY_UNUSUAL >= ${this.#opts.largeTradeHighlyUnusualCount} large trades (>3x median size, per MarketFlowAnalyzer), UNUSUAL >= 1`,
        priceAcceleration: `HIGHLY_UNUSUAL >= ${this.#opts.priceAccelerationHighlyUnusualPctPoints} pct-points, UNUSUAL >= ${this.#opts.priceAccelerationUnusualPctPoints} pct-points between consecutive intervals`,
        transactionFrequency: `HIGHLY_UNUSUAL >= ${this.#opts.txFrequencyHighlyUnusualRatio}x prior average, UNUSUAL >= ${this.#opts.txFrequencyUnusualRatio}x`,
        holderConcentrationChange: `HIGHLY_UNUSUAL >= ${this.#opts.holderConcentrationHighlyUnusualPctPoints} pct-points, UNUSUAL >= ${this.#opts.holderConcentrationUnusualPctPoints} pct-points change in top-10 concentration`,
      },
    };
  }

  #classifyRatio(
    current: number | null,
    prior: number | null,
    highlyUnusualRatio: number,
    unusualRatio: number,
    onEvidence: (level: AnomalyLevel, ratio: number) => void,
  ): AnomalyLevel {
    if (current === null || prior === null || prior <= 0) return "UNKNOWN";
    const ratio = current / prior;
    const level: AnomalyLevel = ratio >= highlyUnusualRatio ? "HIGHLY_UNUSUAL" : ratio >= unusualRatio ? "UNUSUAL" : "NORMAL";
    if (level !== "NORMAL") onEvidence(level, ratio);
    return level;
  }

  #classifyThreshold(
    value: number | null,
    highlyUnusualAt: number,
    unusualAt: number,
    direction: "lte",
    onEvidence: (level: AnomalyLevel, value: number) => void,
  ): AnomalyLevel {
    if (value === null) return "UNKNOWN";
    const level: AnomalyLevel = value <= highlyUnusualAt ? "HIGHLY_UNUSUAL" : value <= unusualAt ? "UNUSUAL" : "NORMAL";
    if (level !== "NORMAL") onEvidence(level, value);
    return level;
  }

  #classifyAbsThreshold(
    value: number | null,
    highlyUnusualAt: number,
    unusualAt: number,
    onEvidence: (level: AnomalyLevel, value: number) => void,
  ): AnomalyLevel {
    if (value === null) return "UNKNOWN";
    const abs = Math.abs(value);
    const level: AnomalyLevel = abs >= highlyUnusualAt ? "HIGHLY_UNUSUAL" : abs >= unusualAt ? "UNUSUAL" : "NORMAL";
    if (level !== "NORMAL") onEvidence(level, value);
    return level;
  }

  #classifyImbalanceRatio(ratio: number | null, evidence: string[]): AnomalyLevel {
    if (ratio === null) return "UNKNOWN";
    const { buySellImbalanceHighlyUnusualRatio: hi, buySellImbalanceUnusualRatio: un } = this.#opts;
    let level: AnomalyLevel = "NORMAL";
    if (ratio >= hi || ratio <= 1 / hi) level = "HIGHLY_UNUSUAL";
    else if (ratio >= un || ratio <= 1 / un) level = "UNUSUAL";
    if (level !== "NORMAL") evidence.push(`buy/sell volume ratio of ${ratio.toFixed(2)} (${level})`);
    return level;
  }

  #classifyLargeTradeCount(marketFlow: MarketFlowAnalysis | null, evidence: string[]): AnomalyLevel {
    if (!marketFlow || marketFlow.medianTradeSizeQuote === null) return "UNKNOWN";
    const level: AnomalyLevel =
      marketFlow.largeTradeCount >= this.#opts.largeTradeHighlyUnusualCount
        ? "HIGHLY_UNUSUAL"
        : marketFlow.largeTradeCount >= 1
          ? "UNUSUAL"
          : "NORMAL";
    if (level !== "NORMAL") evidence.push(`${marketFlow.largeTradeCount} unusually large trade(s) observed (${level})`);
    return level;
  }

  #worstOf(levels: AnomalyLevel[]): AnomalyLevel {
    const known = levels.filter((l) => l !== "UNKNOWN");
    if (known.length === 0) return "UNKNOWN";
    return known.reduce((worst, level) => (LEVEL_RANK[level] > LEVEL_RANK[worst] ? level : worst), "NORMAL" as AnomalyLevel);
  }
}
