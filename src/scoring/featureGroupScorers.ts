// Feature-group scorers (Smart Selection groups A-G, I). Each is a pure
// function over already-computed Phase 2-4 intelligence — no I/O, no
// randomness, no LLM. Every feature reports raw/normalized/weight/
// contribution/reason, per the Phase 5 brief's explainability requirement.
//
// DESIGN NOTE on weights: `SmartSelectionConfig.groupWeights` (9 numbers,
// summing to 100) is the versioned, top-level configuration surface the
// brief asks for. Each scorer below also has its own small, INTRA-group
// sub-weights (named exported constants, documented inline) that
// determine how that group's own features combine into its 0-100
// `groupScore` — these don't need to be re-litigated per release the way
// the group weights do, but they are just as transparent: every feature's
// weight/contribution is reported on the result. See
// docs/SMART_SELECTION.md for the full rationale.

import { clamp01, invertedU, linearBand, safeAgeSeconds, stepBand, weightedAverage } from "./normalization.js";
import type {
  ContractFeatureDetection,
  DataQualityState,
  DeployerAnalysis,
  EntryQualityFeatures,
  FeatureContribution,
  FeatureGroupScore,
  HolderConcentrationBreakdown,
  LiquidityAnalysis,
  MarketFlowAnalysis,
  MarketRegimeAssessment,
  MomentumAnalysis,
  PoolQualityAssessment,
  ScoutSignal,
  TokenAge,
  TokenContractInfo,
} from "../types/domain.js";

function feature(
  name: string,
  rawValue: unknown,
  normalizedValue: number | null,
  weight: number,
  reason: string,
  dataQuality: DataQualityState,
): FeatureContribution {
  return {
    name,
    rawValue,
    normalizedValue,
    weight,
    contribution: normalizedValue !== null ? normalizedValue * weight : null,
    reason,
    dataQuality,
  };
}

function buildGroupScore(
  group: FeatureGroupScore["group"],
  features: FeatureContribution[],
  groupWeight: number,
): FeatureGroupScore {
  const avg = weightedAverage(features.map((f) => ({ value: f.normalizedValue, weight: f.weight })));
  const groupScore = avg !== null ? avg * 100 : null;
  const knownCount = features.filter((f) => f.normalizedValue !== null).length;
  const dataQuality: DataQualityState =
    features.length === 0 || knownCount === 0 ? "UNAVAILABLE" : knownCount === features.length ? "KNOWN" : "PARTIAL";
  return { group, features, groupScore, groupWeight, dataQuality };
}

// ============================================================
// A. SIGNAL QUALITY
// ============================================================

/**
 * A PERFORMANCE_UPDATE is inherently a LATE signal — it's Scout bragging
 * about a call that already happened, not a fresh opportunity. This is
 * the direct implementation of "do not assume every Scout call type has
 * equal predictive value."
 */
export function scoreSignalQuality(signal: ScoutSignal, groupWeight: number, now: Date = new Date()): FeatureGroupScore {
  const features: FeatureContribution[] = [];

  const typeNormalized = signal.messageType === "EARLY_CALL" ? 1 : signal.messageType === "PERFORMANCE_UPDATE" ? 0.1 : null;
  features.push(
    feature(
      "scoutMessageType",
      signal.messageType,
      typeNormalized,
      4,
      signal.messageType === "EARLY_CALL"
        ? "EARLY_CALL is Scout's fresh-opportunity template"
        : signal.messageType === "PERFORMANCE_UPDATE"
          ? "PERFORMANCE_UPDATE reports a call already in progress — a late, not fresh, signal"
          : "message did not match a known Scout template",
      typeNormalized !== null ? "KNOWN" : "UNAVAILABLE",
    ),
  );

  // `signal.receivedAt` is normally self-generated (new Date().toISOString())
  // and always valid, but this must stay defensive under any sparse/malformed
  // input — an unparseable timestamp becomes UNAVAILABLE, never a NaN age.
  const ageSeconds = safeAgeSeconds(signal.receivedAt, now);
  // Full credit under 5 minutes old, linearly decaying to 0 by 60 minutes — documented, not hidden.
  const ageNormalized = ageSeconds !== null ? linearBand(ageSeconds, 5 * 60, 1, 60 * 60, 0) : null;
  features.push(
    feature(
      "signalAge",
      ageSeconds,
      ageNormalized,
      2,
      ageSeconds !== null ? `signal received ${Math.round(ageSeconds / 60)} minute(s) ago` : "signal receivedAt timestamp is missing or unparseable",
      ageNormalized !== null ? "KNOWN" : "UNAVAILABLE",
    ),
  );

  const completenessNormalized = signal.parseConfidence === "high" ? 1 : signal.parseConfidence === "partial" ? 0.5 : 0.1;
  features.push(
    feature(
      "informationCompleteness",
      signal.parseConfidence,
      completenessNormalized,
      1,
      `signal parse confidence: ${signal.parseConfidence}`,
      "KNOWN",
    ),
  );

  return buildGroupScore("signalQuality", features, groupWeight);
}

// ============================================================
// B. TOKEN QUALITY
// ============================================================

const AGE_CATEGORY_SCORE: Record<string, number> = {
  BRAND_NEW: 0.4,
  VERY_NEW: 0.5,
  NEW: 0.6,
  ESTABLISHED: 0.8,
  MATURE: 1.0,
};

export function scoreTokenQuality(
  tokenInfo: TokenContractInfo | null,
  tokenAge: TokenAge | null,
  contractFeatures: ContractFeatureDetection | null,
  deployerAnalysis: DeployerAnalysis | null,
  groupWeight: number,
): FeatureGroupScore {
  const features: FeatureContribution[] = [];

  const ageScore = tokenAge && tokenAge.ageCategory !== "UNKNOWN" ? AGE_CATEGORY_SCORE[tokenAge.ageCategory] : null;
  features.push(
    feature(
      "tokenAge",
      tokenAge?.ageCategory ?? null,
      ageScore,
      2,
      // Deliberately gentle: Scout's whole premise is brand-new tokens, so age is a mild signal, not a dominant one.
      tokenAge?.ageCategory ? `age category: ${tokenAge.ageCategory}` : "deployment timestamp unavailable",
      ageScore !== null ? "KNOWN" : "UNAVAILABLE",
    ),
  );

  // Danger-function evidence: detected -> penalize, not_detected -> mildly reward (absence of evidence, not proof of safety), unknown -> excluded.
  const dangerGroups: { key: keyof ContractFeatureDetection; label: string }[] = [
    { key: "mintFunctionDetected", label: "mint function" },
    { key: "blacklistFunctionDetected", label: "blacklist function" },
    { key: "pauseFunctionDetected", label: "pause function" },
    { key: "feeOrTaxFunctionDetected", label: "fee/tax function" },
  ];
  for (const { key, label } of dangerGroups) {
    const state = contractFeatures?.[key] as "detected" | "not_detected" | "unknown" | undefined;
    const normalized = state === "detected" ? 0.2 : state === "not_detected" ? 0.75 : null;
    features.push(
      feature(
        key,
        state ?? "unknown",
        normalized,
        1.5,
        state === "detected"
          ? `${label} selector detected in bytecode — evidence, not proof of malicious intent`
          : state === "not_detected"
            ? `no ${label} selector found — absence of evidence, not proof of safety`
            : `bytecode unavailable — ${label} status genuinely unknown`,
        normalized !== null ? "KNOWN" : "UNKNOWN",
      ),
    );
  }

  const deployerShare = deployerAnalysis?.deployerTokenBalancePctOfSupply ?? null;
  const deployerShareNormalized = deployerShare !== null ? linearBand(deployerShare, 0, 1, 60, 0.1) : null;
  features.push(
    feature(
      "deployerSupplyShare",
      deployerShare,
      deployerShareNormalized,
      1.5,
      deployerShare !== null
        ? `deployer holds ${deployerShare.toFixed(1)}% of supply`
        : "deployer token balance unavailable",
      deployerShareNormalized !== null ? "KNOWN" : "UNAVAILABLE",
    ),
  );

  const metadataFields = [tokenInfo?.name, tokenInfo?.symbol, tokenInfo?.decimals, tokenInfo?.totalSupplyRaw];
  const knownMetadata = metadataFields.filter((v) => v !== undefined && v !== null).length;
  const metadataNormalized = tokenInfo ? knownMetadata / metadataFields.length : null;
  features.push(
    feature(
      "tokenMetadataCompleteness",
      `${knownMetadata}/${metadataFields.length}`,
      metadataNormalized,
      1,
      `${knownMetadata} of ${metadataFields.length} basic metadata fields known`,
      metadataNormalized === null ? "UNAVAILABLE" : metadataNormalized === 1 ? "KNOWN" : "PARTIAL",
    ),
  );

  return buildGroupScore("tokenQuality", features, groupWeight);
}

// ============================================================
// C. LIQUIDITY
// ============================================================

const LIQUIDITY_USD_BANDS = [
  { maxValue: 5_000, score: 0.1 },
  { maxValue: 20_000, score: 0.4 },
  { maxValue: 100_000, score: 0.7 },
  { maxValue: Infinity, score: 1.0 },
];

const LIQUIDITY_TREND_SCORE: Record<string, number> = {
  INCREASING: 1.0,
  STABLE: 0.7,
  DECREASING: 0.3,
  LARGE_WITHDRAWAL: 0.0,
};

export function scoreLiquidity(
  liquidityAnalysis: LiquidityAnalysis | null,
  poolQuality: PoolQualityAssessment[],
  groupWeight: number,
): FeatureGroupScore {
  const features: FeatureContribution[] = [];

  const currentLiquidity = liquidityAnalysis?.currentLiquidityUsd ?? null;
  const currentNormalized = currentLiquidity !== null ? stepBand(currentLiquidity, LIQUIDITY_USD_BANDS) : null;
  features.push(
    feature(
      "currentLiquidityUsd",
      currentLiquidity,
      currentNormalized,
      6,
      currentLiquidity !== null ? `$${currentLiquidity.toLocaleString()} current liquidity` : "current liquidity unavailable",
      currentNormalized !== null ? "KNOWN" : "UNAVAILABLE",
    ),
  );

  const trend = liquidityAnalysis?.trend;
  const trendNormalized = trend && trend !== "UNKNOWN" ? LIQUIDITY_TREND_SCORE[trend] : null;
  features.push(
    feature(
      "liquidityTrend",
      trend ?? "UNKNOWN",
      trendNormalized,
      5,
      trend && trend !== "UNKNOWN" ? `liquidity trend: ${trend}` : "no prior liquidity snapshot to establish a trend",
      trendNormalized !== null ? "KNOWN" : "UNAVAILABLE",
    ),
  );

  const acceleration = liquidityAnalysis?.accelerationPctPoints ?? null;
  const accelerationNormalized = acceleration !== null ? clamp01(0.5 + acceleration / 100) : null;
  features.push(
    feature(
      "liquidityAcceleration",
      acceleration,
      accelerationNormalized,
      2,
      acceleration !== null ? `liquidity trend acceleration: ${acceleration.toFixed(1)} pct-points` : "insufficient history for acceleration",
      accelerationNormalized !== null ? "KNOWN" : "UNAVAILABLE",
    ),
  );

  const poolCount = poolQuality.length;
  const poolCountNormalized = poolQuality.length > 0 ? clamp01(0.5 + poolCount * 0.15) : null;
  features.push(
    feature(
      "poolCount",
      poolCount,
      poolCountNormalized,
      2,
      poolCount > 0 ? `${poolCount} known pool(s)` : "no pools discovered",
      poolQuality.length > 0 ? "KNOWN" : "UNAVAILABLE",
    ),
  );

  return buildGroupScore("liquidity", features, groupWeight);
}

// ============================================================
// D. MARKET FLOW
// ============================================================

export function scoreMarketFlow(flow: MarketFlowAnalysis | null, groupWeight: number): FeatureGroupScore {
  const features: FeatureContribution[] = [];

  // Healthy buy pressure is rewarded, but an extreme ratio is capped rather
  // than treated as "even better" — an unbounded ratio is as likely to be
  // wash trading / a data artifact as genuine organic demand (this is the
  // same caution MarketAnomalyAnalyzer applies from the other direction).
  const ratio = flow?.buySellRatio ?? null;
  const ratioNormalized =
    ratio !== null
      ? stepBand(ratio, [
          { maxValue: 0.5, score: 0.2 },
          { maxValue: 1.5, score: 0.6 },
          { maxValue: 4, score: 0.9 },
          { maxValue: Infinity, score: 0.5 },
        ])
      : null;
  features.push(
    feature(
      "buySellRatio",
      ratio,
      ratioNormalized,
      5,
      ratio !== null ? `buy/sell volume ratio: ${ratio.toFixed(2)}` : "insufficient buy/sell volume data",
      ratioNormalized !== null ? "KNOWN" : "UNAVAILABLE",
    ),
  );

  const netFlow = flow?.netQuoteFlow ?? null;
  const netFlowNormalized = netFlow !== null ? (netFlow > 0 ? 0.8 : netFlow < 0 ? 0.3 : 0.5) : null;
  features.push(
    feature(
      "netFlow",
      netFlow,
      netFlowNormalized,
      2,
      netFlow !== null ? `net quote-token flow: ${netFlow > 0 ? "positive (net buying)" : netFlow < 0 ? "negative (net selling)" : "flat"}` : "net flow unavailable",
      netFlowNormalized !== null ? "KNOWN" : "UNAVAILABLE",
    ),
  );

  const recentActivity = flow?.recentTradeCount ?? null;
  const recentNormalized = recentActivity !== null ? clamp01(recentActivity / 20) : null;
  features.push(
    feature(
      "recentActivity",
      recentActivity,
      recentNormalized,
      3,
      recentActivity !== null ? `${recentActivity} trade(s) in the recent window` : "no timestamped swaps to assess recent activity",
      recentNormalized !== null ? "KNOWN" : "UNAVAILABLE",
    ),
  );

  const uniqueTraders = flow?.uniqueTraderCount ?? null;
  const uniqueTradersNormalized = uniqueTraders !== null ? clamp01(uniqueTraders / 15) : null;
  features.push(
    feature(
      "uniqueTraders",
      uniqueTraders,
      uniqueTradersNormalized,
      2,
      uniqueTraders !== null ? `${uniqueTraders} unique trader(s) observed` : "no swap in range had an observable trader",
      uniqueTradersNormalized !== null ? "KNOWN" : "UNKNOWN",
    ),
  );

  // Unknown-direction swaps never count as buys or sells — surfaced here as a data-quality signal only.
  const totalSwaps = flow ? flow.buyCount + flow.sellCount + flow.unknownCount : 0;
  const unknownFraction = flow && totalSwaps > 0 ? flow.unknownCount / totalSwaps : null;
  features.push(
    feature(
      "unknownSwapFraction",
      unknownFraction,
      null, // informational only — never scored as good or bad, per "unknown swaps are NOT buys or sells"
      0,
      unknownFraction !== null
        ? `${(unknownFraction * 100).toFixed(0)}% of swaps had undeterminable direction (excluded from buy/sell math)`
        : "no swap data to assess",
      "KNOWN",
    ),
  );

  return buildGroupScore("marketFlow", features, groupWeight);
}

// ============================================================
// E. MOMENTUM
// ============================================================

export function scoreMomentum(momentum: MomentumAnalysis | null, groupWeight: number): FeatureGroupScore {
  const features: FeatureContribution[] = [];

  // Inverted-U: healthy momentum peaks around +20% in the short-to-medium
  // term; deeply negative OR extremely parabolic (chasing) both score low.
  const change = momentum?.changePct15m ?? momentum?.changePct5m ?? null;
  const changeNormalized = change !== null ? invertedU(change, 20, 80) : null;
  features.push(
    feature(
      "shortTermPriceChange",
      change,
      changeNormalized,
      4,
      change !== null
        ? `short-term price change: ${change.toFixed(1)}% (healthy momentum peaks around +20%, not the fastest pump)`
        : "insufficient price history for short-term change",
      changeNormalized !== null ? "KNOWN" : "UNAVAILABLE",
    ),
  );

  const acceleration = momentum?.accelerationPctPoints ?? null;
  const accelerationNormalized = acceleration !== null ? invertedU(acceleration, 0, 40) : null;
  features.push(
    feature(
      "priceAcceleration",
      acceleration,
      accelerationNormalized,
      2,
      acceleration !== null ? `acceleration: ${acceleration.toFixed(1)} pct-points` : "insufficient data for acceleration",
      accelerationNormalized !== null ? "KNOWN" : "UNAVAILABLE",
    ),
  );

  const drawdown = momentum?.drawdownFromRecentHighPct ?? null;
  // Being far below a recent high suggests the move already happened and reversed.
  const drawdownNormalized = drawdown !== null ? linearBand(drawdown, -50, 0.2, 0, 0.8) : null;
  features.push(
    feature(
      "drawdownFromRecentHigh",
      drawdown,
      drawdownNormalized,
      2,
      drawdown !== null ? `${Math.abs(drawdown).toFixed(1)}% below the recent high` : "no recent-high reference available",
      drawdownNormalized !== null ? "KNOWN" : "UNAVAILABLE",
    ),
  );

  const volatility = momentum?.volatilityPct ?? null;
  // Moderate volatility is normal for a memecoin; extreme volatility is penalized.
  const volatilityNormalized = volatility !== null ? linearBand(volatility, 0, 0.8, 60, 0.2) : null;
  features.push(
    feature(
      "volatility",
      volatility,
      volatilityNormalized,
      2,
      volatility !== null ? `volatility: ${volatility.toFixed(1)}%` : "fewer than 3 observations — volatility unavailable",
      volatilityNormalized !== null ? "KNOWN" : "UNAVAILABLE",
    ),
  );

  return buildGroupScore("momentum", features, groupWeight);
}

// ============================================================
// F. ENTRY QUALITY
// ============================================================

const VOLUME_ACCELERATION_SCORE: Record<string, number> = { LOW: 0.4, MODERATE: 0.8, HIGH: 0.6 };

export function scoreEntryQuality(entryQuality: EntryQualityFeatures | null, groupWeight: number): FeatureGroupScore {
  const features: FeatureContribution[] = [];

  // A small positive move since the signal is healthy confirmation; a huge
  // move means the entry has already largely happened (chasing).
  const priceSince = entryQuality?.priceSincePct ?? null;
  const priceSinceNormalized = priceSince !== null ? invertedU(priceSince, 10, 60) : null;
  features.push(
    feature(
      "priceSinceSignal",
      priceSince,
      priceSinceNormalized,
      6,
      priceSince !== null
        ? `price is ${priceSince >= 0 ? "+" : ""}${priceSince.toFixed(1)}% since the Scout signal`
        : "no signal-time price to compare against",
      priceSinceNormalized !== null ? "KNOWN" : "UNAVAILABLE",
    ),
  );

  const liquidityDeteriorating = entryQuality?.liquidityDeteriorating;
  const liquidityDetNormalized = liquidityDeteriorating === "detected" ? 0.15 : liquidityDeteriorating === "not_detected" ? 0.85 : null;
  features.push(
    feature(
      "liquidityDeterioratingSinceSignal",
      liquidityDeteriorating ?? "unknown",
      liquidityDetNormalized,
      5,
      liquidityDeteriorating === "detected"
        ? "liquidity has deteriorated meaningfully since the signal"
        : liquidityDeteriorating === "not_detected"
          ? "liquidity has held up since the signal"
          : "signal-time or current liquidity unavailable",
      liquidityDetNormalized !== null ? "KNOWN" : "UNAVAILABLE",
    ),
  );

  const volumeAcceleration = entryQuality?.volumeAcceleration;
  const volAccelNormalized = volumeAcceleration && volumeAcceleration !== "UNKNOWN" ? VOLUME_ACCELERATION_SCORE[volumeAcceleration] : null;
  features.push(
    feature(
      "volumeAccelerationSinceSignal",
      volumeAcceleration ?? "UNKNOWN",
      volAccelNormalized,
      3,
      volumeAcceleration && volumeAcceleration !== "UNKNOWN"
        ? `volume acceleration since signal: ${volumeAcceleration} (very high acceleration late in a move can mean distribution, not just demand)`
        : "signal-time or current volume unavailable",
      volAccelNormalized !== null ? "KNOWN" : "UNAVAILABLE",
    ),
  );

  const flowDeteriorating = entryQuality?.flowDeteriorating;
  const flowDetNormalized = flowDeteriorating === "detected" ? 0.2 : flowDeteriorating === "not_detected" ? 0.8 : null;
  features.push(
    feature(
      "flowDeterioratingSinceSignal",
      flowDeteriorating ?? "unknown",
      flowDetNormalized,
      3,
      flowDeteriorating === "detected"
        ? "buy/sell flow has weakened since the signal"
        : flowDeteriorating === "not_detected"
          ? "buy/sell flow has held up since the signal"
          : "signal-time or current buy/sell ratio unavailable",
      flowDetNormalized !== null ? "KNOWN" : "UNAVAILABLE",
    ),
  );

  const distanceFromHigh = entryQuality?.distanceFromRecentHighPct ?? null;
  const distanceNormalized = distanceFromHigh !== null ? linearBand(distanceFromHigh, 0, 0.2, 40, 0.9) : null;
  features.push(
    feature(
      "distanceFromRecentHigh",
      distanceFromHigh,
      distanceNormalized,
      3,
      distanceFromHigh !== null ? `${distanceFromHigh.toFixed(1)}% from the recent high` : "no recent-high reference available",
      distanceNormalized !== null ? "KNOWN" : "UNAVAILABLE",
    ),
  );

  return buildGroupScore("entryQuality", features, groupWeight);
}

// ============================================================
// G. HOLDER STRUCTURE
// ============================================================

const CONCENTRATION_BANDS = [
  { maxValue: 30, score: 0.9 },
  { maxValue: 60, score: 0.6 },
  { maxValue: 85, score: 0.3 },
  { maxValue: 100, score: 0.1 },
];

export function scoreHolderStructure(holders: HolderConcentrationBreakdown | null, groupWeight: number): FeatureGroupScore {
  const features: FeatureContribution[] = [];

  if (!holders || holders.dataQuality === "UNAVAILABLE") {
    // Missing holder data reduces CONFIDENCE (handled by the confidence engine), never the score directly.
    features.push(feature("holderDistribution", null, null, 5, "holder distribution unavailable", "UNAVAILABLE"));
    return buildGroupScore("holderStructure", features, groupWeight);
  }

  const top10 = holders.top10ConcentrationPct;
  const top10Normalized = top10 !== null ? stepBand(top10, CONCENTRATION_BANDS) : null;
  features.push(
    feature(
      "top10Concentration",
      top10,
      top10Normalized,
      3,
      top10 !== null ? `top 10 holders control ${top10.toFixed(1)}% of supply` : "top-10 concentration unavailable",
      top10Normalized !== null ? "KNOWN" : "UNAVAILABLE",
    ),
  );

  const largest = holders.largestHolderSharePct;
  const largestNormalized = largest !== null ? stepBand(largest, [
    { maxValue: 10, score: 0.9 },
    { maxValue: 25, score: 0.6 },
    { maxValue: 50, score: 0.3 },
    { maxValue: 100, score: 0.1 },
  ]) : null;
  features.push(
    feature(
      "largestHolderShare",
      largest,
      largestNormalized,
      2,
      largest !== null ? `largest holder controls ${largest.toFixed(1)}%` : "largest-holder share unavailable",
      largestNormalized !== null ? "KNOWN" : "UNAVAILABLE",
    ),
  );

  const deployerShare = holders.deployerSharePct;
  const deployerShareNormalized = deployerShare !== null ? linearBand(deployerShare, 0, 0.9, 40, 0.2) : null;
  features.push(
    feature(
      "deployerHolderShare",
      deployerShare,
      deployerShareNormalized,
      2,
      deployerShare !== null ? `deployer holds ${deployerShare.toFixed(1)}% (from the holder list)` : "deployer not found in the top-holders page",
      deployerShareNormalized !== null ? "KNOWN" : "UNKNOWN",
    ),
  );

  const holderCount = holders.holderCount;
  const holderCountNormalized = holderCount !== null ? clamp01(Math.log10(Math.max(1, holderCount)) / 3) : null;
  features.push(
    feature(
      "holderCount",
      holderCount,
      holderCountNormalized,
      1,
      holderCount !== null ? `${holderCount} known holders` : "holder count unavailable",
      holderCountNormalized !== null ? "KNOWN" : "UNAVAILABLE",
    ),
  );

  return buildGroupScore("holderStructure", features, groupWeight);
}

// ============================================================
// I. MARKET CONDITIONS (stub — see docs/SMART_SELECTION.md §I)
// ============================================================

/** Always UNKNOWN and excluded from scoring in Phase 5 — an interface stub, not a model, per the brief. Configured group weight is 0. */
export function scoreMarketConditions(regime: MarketRegimeAssessment, groupWeight: number): FeatureGroupScore {
  const features: FeatureContribution[] = [
    feature("marketRegime", regime.regime, null, 0, "no market-regime model implemented yet (Phase 5 scope)", "UNKNOWN"),
  ];
  return buildGroupScore("marketConditions", features, groupWeight);
}
