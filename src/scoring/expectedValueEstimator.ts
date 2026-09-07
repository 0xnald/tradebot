// Phase 5 §8. Deliberately NOT a real expected-value calculation — no
// probabilities or dollar magnitudes are invented, because we don't have
// empirical outcome data yet (that's what backtesting, a later phase, is
// for). This produces a disclosed heuristic LABEL only, always flagged
// `statisticallyValidated: false`.

import type { EntryChaseAssessment, ExpectedValueEstimate, SmartSelectionConfig } from "../types/domain.js";

export interface ExpectedValueInputs {
  overallScore: number;
  confidence: number;
  chaseAssessment: EntryChaseAssessment;
  hardBlocked: boolean;
}

const BASE_NOTE =
  "heuristic label only — no probabilities or dollar magnitudes were computed; a real empirical expected-value model requires backtesting (a later phase)";

export class ExpectedValueEstimator {
  #config: SmartSelectionConfig;

  constructor(config: SmartSelectionConfig) {
    this.#config = config;
  }

  estimate(inputs: ExpectedValueInputs): ExpectedValueEstimate {
    if (inputs.hardBlocked) {
      return { status: "HEURISTIC_NEGATIVE", statisticallyValidated: false, notes: [BASE_NOTE, "opportunity is hard-blocked"] };
    }

    if (inputs.confidence < this.#config.minimumConfidenceForTradeCandidate) {
      return {
        status: "UNKNOWN",
        statisticallyValidated: false,
        notes: [BASE_NOTE, `confidence (${inputs.confidence.toFixed(0)}) is below the minimum needed to characterize expected value`],
      };
    }

    if (inputs.chaseAssessment.level === "HIGH_CHASE_RISK") {
      return { status: "HEURISTIC_NEGATIVE", statisticallyValidated: false, notes: [BASE_NOTE, "high chase risk"] };
    }

    if (inputs.overallScore >= this.#config.thresholds.tradeCandidate) {
      return { status: "HEURISTIC_POSITIVE", statisticallyValidated: false, notes: [BASE_NOTE] };
    }

    if (inputs.overallScore < this.#config.thresholds.watch) {
      return { status: "HEURISTIC_NEGATIVE", statisticallyValidated: false, notes: [BASE_NOTE] };
    }

    return { status: "UNKNOWN", statisticallyValidated: false, notes: [BASE_NOTE, "score falls in the ambiguous WATCH band"] };
  }
}
