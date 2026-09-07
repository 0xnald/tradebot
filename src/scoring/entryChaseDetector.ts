// Anti-chase logic (Phase 5 §9). Classifies chase risk into three levels
// plus UNKNOWN — never automatically rejects every fast-moving token; it
// only classifies, and the scoring config decides the consequence (see
// SmartSelectionConfig.highChaseRiskCapsDecisionAt).
//
// Builds on EntryQualityAnalyzer's own chaseRisk (Phase 4) but adds the
// additional signals the Phase 5 brief specifically calls out: liquidity
// deterioration DURING a price expansion, and a volume spike without
// healthy liquidity growth (i.e. activity that isn't backed by real
// depth) — both already available as EntryQualityFeatures fields, reused
// here rather than recomputed.

import type { EntryChaseAssessment, EntryQualityFeatures, LiquidityAnalysis } from "../types/domain.js";

export class EntryChaseDetector {
  classify(entryQuality: EntryQualityFeatures | null, liquidityAnalysis: LiquidityAnalysis | null): EntryChaseAssessment {
    const evidence: string[] = [];

    if (!entryQuality || entryQuality.chaseRisk === "UNKNOWN") {
      return { level: "UNKNOWN", evidence: ["insufficient signal-time/current data to assess chase risk"] };
    }

    const volumeWithoutLiquidityGrowth =
      entryQuality.volumeAcceleration === "HIGH" && liquidityAnalysis?.trend !== "INCREASING";

    if (entryQuality.chaseRisk === "HIGH") {
      evidence.push("EntryQualityAnalyzer already classified this as HIGH chase risk (large move since signal, near the recent high)");
    }
    if (entryQuality.liquidityDeteriorating === "detected") {
      evidence.push("liquidity has deteriorated since the signal — an expansion without supporting liquidity");
    }
    if (volumeWithoutLiquidityGrowth) {
      evidence.push("volume acceleration is HIGH but liquidity is not increasing — activity without matching depth");
    }

    let level: EntryChaseAssessment["level"];
    if (entryQuality.chaseRisk === "HIGH" || (entryQuality.chaseRisk === "ELEVATED" && entryQuality.liquidityDeteriorating === "detected")) {
      level = "HIGH_CHASE_RISK";
    } else if (entryQuality.chaseRisk === "ELEVATED" || volumeWithoutLiquidityGrowth) {
      level = "MEDIUM_CHASE_RISK";
      if (entryQuality.chaseRisk === "ELEVATED" && evidence.length === 0) {
        evidence.push("price has moved up meaningfully since the signal (ELEVATED chase risk)");
      }
    } else {
      level = "LOW_CHASE_RISK";
      evidence.push("price has not moved meaningfully since the signal, and liquidity/volume look healthy");
    }

    return { level, evidence };
  }
}
