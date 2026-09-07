// Deterministic hard blockers (Phase 5 §5). Every check here is a plain
// boolean comparison against a documented, configured threshold — no
// randomness, no LLM, and nothing here can ever be overridden by one
// (there is no LLM anywhere in this decision path). A blocked result
// always forces the decision to IGNORE regardless of score/confidence —
// see smartSelectionEngine.ts.

import { safeAgeSeconds } from "./normalization.js";
import type {
  ContractFeatureDetection,
  DataQualityState,
  DeployerAnalysis,
  EntryChaseAssessment,
  EntryQualityFeatures,
  HardBlockerReason,
  HardBlockerResult,
  LiquidityAnalysis,
  SmartSelectionConfig,
  TokenContractInfo,
} from "../types/domain.js";

export interface HardBlockerInputs {
  tokenContractInfo: TokenContractInfo | null;
  contractFeatures: ContractFeatureDetection | null;
  deployerAnalysis: DeployerAnalysis | null;
  liquidityAnalysis: LiquidityAnalysis | null;
  currentLiquidityUsd: number | null;
  priceUsd: number | null;
  marketDataObservedAt: string | null;
  overallDataQuality: DataQualityState;
  chaseAssessment: EntryChaseAssessment;
  entryQuality: EntryQualityFeatures | null;
}

export class HardBlockerEngine {
  #config: SmartSelectionConfig;

  constructor(config: SmartSelectionConfig) {
    this.#config = config;
  }

  evaluate(inputs: HardBlockerInputs, now: Date = new Date()): HardBlockerResult {
    const reasons: HardBlockerReason[] = [];
    const push = (code: string, description: string) => reasons.push({ code, description });

    // 1. INVALID_CONTRACT — no usable identity for the contract at all.
    const info = inputs.tokenContractInfo;
    if (!info || (!info.name && !info.symbol && info.decimals === undefined && !info.totalSupplyRaw)) {
      push("INVALID_CONTRACT", "no token contract metadata (name/symbol/decimals/totalSupply) could be established at all");
    }

    // 2. NO_USABLE_LIQUIDITY — only when liquidity is CONFIRMED below the
    // floor, not merely unknown (unknown reduces confidence, not this).
    if (
      inputs.currentLiquidityUsd !== null &&
      inputs.currentLiquidityUsd < this.#config.hardBlockerThresholds.minimumUsableLiquidityUsd
    ) {
      push(
        "NO_USABLE_LIQUIDITY",
        `current liquidity ($${inputs.currentLiquidityUsd.toLocaleString()}) is below the minimum usable threshold ($${this.#config.hardBlockerThresholds.minimumUsableLiquidityUsd.toLocaleString()})`,
      );
    }

    // 3. CATASTROPHIC_LIQUIDITY_COLLAPSE — stricter than LiquidityAnalyzer's own informational LARGE_WITHDRAWAL threshold.
    const changePct = inputs.liquidityAnalysis?.changePct;
    if (changePct !== null && changePct !== undefined && changePct <= this.#config.hardBlockerThresholds.catastrophicLiquidityCollapsePct) {
      push(
        "CATASTROPHIC_LIQUIDITY_COLLAPSE",
        `liquidity dropped ${changePct.toFixed(1)}% in a single step, at/beyond the catastrophic threshold (${this.#config.hardBlockerThresholds.catastrophicLiquidityCollapsePct}%)`,
      );
    }

    // 4. TOKEN_DATA_FUNDAMENTALLY_UNAVAILABLE
    if (inputs.overallDataQuality === "UNAVAILABLE") {
      push("TOKEN_DATA_FUNDAMENTALLY_UNAVAILABLE", "overall data quality is UNAVAILABLE — nothing meaningful is known about this opportunity");
    }

    // 5. IMPOSSIBLE_MARKET_STATE — a defensive sanity net; should not normally trigger.
    if (inputs.priceUsd !== null && inputs.priceUsd <= 0) {
      push("IMPOSSIBLE_MARKET_STATE", `reported price (${inputs.priceUsd}) is not a valid positive number`);
    }
    if (inputs.currentLiquidityUsd !== null && inputs.currentLiquidityUsd < 0) {
      push("IMPOSSIBLE_MARKET_STATE", `reported liquidity (${inputs.currentLiquidityUsd}) is negative`);
    }

    // 6. EXTREME_EXECUTION_DETERIORATION — high chase risk compounded by confirmed liquidity deterioration.
    if (inputs.chaseAssessment.level === "HIGH_CHASE_RISK" && inputs.entryQuality?.liquidityDeteriorating === "detected") {
      push(
        "EXTREME_EXECUTION_DETERIORATION",
        "high chase risk combined with confirmed liquidity deterioration since the signal — execution conditions have materially worsened",
      );
    }

    // 7. SEVERE_CONTRACT_RESTRICTION_DETECTED — a narrow, principled
    // combination (can mint AND already controls a majority), not a
    // blanket rule on any single detected admin function (most legitimate
    // tokens have some form of ownership function too).
    const deployerShare = inputs.deployerAnalysis?.deployerTokenBalancePctOfSupply ?? null;
    if (
      inputs.contractFeatures?.mintFunctionDetected === "detected" &&
      deployerShare !== null &&
      deployerShare >= this.#config.hardBlockerThresholds.severeDeployerSupplySharePct
    ) {
      push(
        "SEVERE_CONTRACT_RESTRICTION_DETECTED",
        `mint function detected AND deployer already holds ${deployerShare.toFixed(1)}% of supply (>= ${this.#config.hardBlockerThresholds.severeDeployerSupplySharePct}%) — able to both dilute and already dominant`,
      );
    }

    // 8. STALE_CRITICAL_DATA
    // `safeAgeSeconds` returns null both when the timestamp is missing AND
    // when it's unparseable/malformed — both cases are treated identically
    // here (skip the staleness check, same as "no timestamp") rather than
    // letting a NaN age silently pass (or fail) the `>` comparison below.
    const ageSeconds = safeAgeSeconds(inputs.marketDataObservedAt, now);
    if (ageSeconds !== null) {
      if (ageSeconds > this.#config.hardBlockerThresholds.staleCriticalDataSeconds) {
        push(
          "STALE_CRITICAL_DATA",
          `market data is ${Math.round(ageSeconds)}s old, beyond the ${this.#config.hardBlockerThresholds.staleCriticalDataSeconds}s freshness threshold for a live decision`,
        );
      }
    }

    return { blocked: reasons.length > 0, reasons };
  }
}
