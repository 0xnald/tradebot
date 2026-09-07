// Versioned Smart Selection configuration. See docs/SMART_SELECTION.md for
// the full rationale behind every number here.
//
// ============================================================
// INITIAL HEURISTIC WEIGHTS — smart-selection-v1
// These are NOT statistically optimized. They were chosen for
// plausibility and transparency (e.g. "entry quality should matter more
// than raw token age") and are explicitly temporary until backtesting
// (a later phase) provides real evidence to revise them. Do not treat
// this file as validated.
// ============================================================

import type { SmartSelectionConfig } from "../types/domain.js";

export const SMART_SELECTION_V1_CONFIG: SmartSelectionConfig = {
  modelVersion: "smart-selection-v1",

  // Group weights sum to 100. `marketConditions` is 0 — Phase 5 only
  // stubs a market-regime interface (always UNKNOWN), so it is honestly
  // given no influence yet rather than a weight that never does anything
  // silently confusing future readers.
  groupWeights: {
    signalQuality: 8,
    tokenQuality: 12,
    liquidity: 15,
    marketFlow: 13,
    momentum: 10,
    entryQuality: 20,
    holderStructure: 10,
    walletIntelligence: 12,
    marketConditions: 0,
  },

  // overallScore thresholds (0-100). A score at/above `tradeCandidate`
  // (and passing every other gate — confidence, hard blockers, chase risk
  // cap) becomes TRADE_CANDIDATE; at/above `watch` but below that, WATCH;
  // otherwise IGNORE. Heuristic, not proven profitable.
  thresholds: { watch: 45, tradeCandidate: 70 },

  // Below this confidence (0-100), the decision is capped at WATCH even
  // if the score alone would qualify for TRADE_CANDIDATE — "a token could
  // have a score of 88 but confidence of 42" must never become a trade
  // candidate on score alone.
  minimumConfidenceForTradeCandidate: 55,

  // TRADE_CANDIDATE additionally requires the overall data quality to be
  // at least this good — UNAVAILABLE (nothing meaningful known) can never
  // become a trade candidate regardless of score/confidence math.
  minimumDataQualityForTradeCandidate: "PARTIAL",

  // HIGH_CHASE_RISK never becomes a TRADE_CANDIDATE, regardless of score —
  // it's capped at WATCH. Documented consequence of the anti-chase logic
  // (Phase 5 §9), not a silent override.
  highChaseRiskCapsDecisionAt: "WATCH",

  // Within a cluster of possibly-related wallets (Phase 3 relationship
  // signals), every member except the single best-quality one has its
  // weight multiplied by this factor before averaging — so N correlated
  // wallets contribute closer to 1 independent wallet than to N. 0.3 is a
  // stated, disclosed choice: meaningfully discounted, not zeroed out
  // (a cluster can still carry SOME extra signal — e.g. it could be one
  // sophisticated trader running several wallets, which is still real
  // capital and real skill, just not N independent opinions).
  walletRelationshipIndependenceFactor: 0.3,

  // A wallet's own WalletPerformanceSummary.sampleSizeConfidence must be
  // at least this (0-1) to be treated as more than negligible evidence —
  // below it, the wallet-intelligence group falls back to
  // INSUFFICIENT_SAMPLE rather than trusting a lucky 1-2-trade record.
  walletMinimumSampleSizeConfidence: 0.15,

  hardBlockerThresholds: {
    // Below this, liquidity is not "thin", it's not usable at all.
    minimumUsableLiquidityUsd: 500,
    // A single-step liquidity drop at/beyond this magnitude is
    // catastrophic — deliberately stricter than LiquidityAnalyzer's own
    // -30% "LARGE_WITHDRAWAL" trend threshold (which is informational,
    // not blocking); this is the "the pool is effectively gone" line.
    catastrophicLiquidityCollapsePct: -70,
    // Price/liquidity data older than this cannot support a live
    // TRADE_CANDIDATE recommendation.
    staleCriticalDataSeconds: 5 * 60,
    // A detected mint function combined with the deployer already holding
    // this much of supply is a specifically severe combination (can both
    // dilute AND already controls a majority) — narrower and more
    // defensible than blocking on any single detected admin function,
    // which most legitimate tokens also have.
    severeDeployerSupplySharePct: 50,
  },
};
