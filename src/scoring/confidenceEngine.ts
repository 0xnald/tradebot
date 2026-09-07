// Confidence is SEPARATE from score (Phase 5 §7): score answers "what does
// the available evidence indicate", confidence answers "how complete and
// reliable is that evidence". A token can score 88 with confidence 42 —
// this engine is what produces that 42, and it never subtracts missing
// data from the score itself (see featureGroupScorers.ts: unavailable
// groups are simply excluded from overallScore, not zeroed).
//
// Methodology (four documented, weighted components, each 0-100):
//
// 1. completeness (weight 40): fraction of total configured group weight
//    that came from groups with an actual (non-null) score.
// 2. criticalFeatureAvailability (weight 30): fraction of a fixed
//    checklist (liquidity known, contract-feature evidence known, holder
//    data known) that's actually available — these three are singled out
//    because a decision without them is qualitatively different from one
//    just missing a minor feature.
// 3. walletSampleSize (weight 15): the average sample-size confidence
//    (Phase 3's own WalletPerformanceSummary.sampleSizeConfidence) across
//    identified wallets when wallet evidence is AVAILABLE; a fixed,
//    documented moderate-low default (30) when it isn't — no wallet
//    evidence is treated as "less confident", not "confidently negative".
// 4. freshness (weight 15): how old the market data is, decaying from
//    100 at 60s to 0 at 10 minutes — softer and gradual, distinct from
//    HardBlockerEngine's hard 5-minute STALE_CRITICAL_DATA cutoff.

import { linearBand } from "./normalization.js";
import type { ConfidenceBreakdown, FeatureGroupScore, SmartSelectionConfig, WalletSignalAssessment } from "../types/domain.js";

export interface ConfidenceInputs {
  groupScores: FeatureGroupScore[];
  criticalFeaturesAvailable: {
    liquidity: boolean;
    contractFeatures: boolean;
    holderData: boolean;
  };
  walletAssessment: WalletSignalAssessment;
  marketDataAgeSeconds: number | null;
}

const COMPONENT_WEIGHTS = {
  completeness: 40,
  criticalFeatureAvailability: 30,
  walletSampleSize: 15,
  freshness: 15,
};

const WALLET_SAMPLE_SIZE_DEFAULT_WHEN_UNAVAILABLE = 30;

export class ConfidenceEngine {
  #config: SmartSelectionConfig;

  constructor(config: SmartSelectionConfig) {
    this.#config = config;
  }

  compute(inputs: ConfidenceInputs): ConfidenceBreakdown {
    const totalGroupWeight = Object.values(this.#config.groupWeights).reduce((a, b) => a + b, 0);
    const availableGroupWeight = inputs.groupScores
      .filter((g) => g.groupScore !== null)
      .reduce((sum, g) => sum + g.groupWeight, 0);
    const completeness = totalGroupWeight > 0 ? (availableGroupWeight / totalGroupWeight) * 100 : 0;

    const checklist = Object.values(inputs.criticalFeaturesAvailable);
    const criticalFeatureAvailability = (checklist.filter(Boolean).length / checklist.length) * 100;

    let walletSampleSize: number;
    if (inputs.walletAssessment.status === "AVAILABLE" && inputs.walletAssessment.identifiedWallets.length > 0) {
      const confidences = inputs.walletAssessment.identifiedWallets.map((w) => w.qualityFeatures.sampleSizeConfidence * 100);
      walletSampleSize = confidences.reduce((a, b) => a + b, 0) / confidences.length;
    } else {
      walletSampleSize = WALLET_SAMPLE_SIZE_DEFAULT_WHEN_UNAVAILABLE;
    }

    const freshness =
      inputs.marketDataAgeSeconds !== null ? linearBand(inputs.marketDataAgeSeconds, 60, 1, 600, 0) * 100 : 50; // unknown age: neutral default, documented

    const components: ConfidenceBreakdown["components"] = [
      {
        name: "completeness",
        value: completeness,
        weight: COMPONENT_WEIGHTS.completeness,
        reason: `${availableGroupWeight}/${totalGroupWeight} configured group weight had a computable score`,
      },
      {
        name: "criticalFeatureAvailability",
        value: criticalFeatureAvailability,
        weight: COMPONENT_WEIGHTS.criticalFeatureAvailability,
        reason: `${checklist.filter(Boolean).length}/${checklist.length} critical features (liquidity, contract evidence, holder data) available`,
      },
      {
        name: "walletSampleSize",
        value: walletSampleSize,
        weight: COMPONENT_WEIGHTS.walletSampleSize,
        reason:
          inputs.walletAssessment.status === "AVAILABLE"
            ? `average wallet sample-size confidence across ${inputs.walletAssessment.identifiedWallets.length} identified wallet(s)`
            : `wallet evidence status is ${inputs.walletAssessment.status} — using the documented default, not a penalty or a bonus`,
      },
      {
        name: "freshness",
        value: freshness,
        weight: COMPONENT_WEIGHTS.freshness,
        reason: inputs.marketDataAgeSeconds !== null ? `market data is ${Math.round(inputs.marketDataAgeSeconds)}s old` : "market data age unknown",
      },
    ];

    const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
    const overallConfidence = components.reduce((sum, c) => sum + c.value * c.weight, 0) / totalWeight;

    return { overallConfidence, components };
  }
}
