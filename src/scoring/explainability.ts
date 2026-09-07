// Phase 5 §16. Explanations are generated directly from actual feature
// contributions — never a generic AI-sounding summary. A feature counts as
// a "positive factor" or "negative factor" only when its normalized value
// meaningfully clears a documented threshold (0.6 / 0.4 — a neutral
// mid-band is deliberately not reported as either), ranked by the
// magnitude of its actual contribution to the score.

import type { FeatureGroupScore, HardBlockerResult } from "../types/domain.js";

const POSITIVE_THRESHOLD = 0.6;
const NEGATIVE_THRESHOLD = 0.4;
const MAX_FACTORS = 5;

export interface Explanation {
  positiveFactors: string[];
  negativeFactors: string[];
  blockingFactors: string[];
}

export function buildExplanation(groupScores: FeatureGroupScore[], hardBlockers: HardBlockerResult): Explanation {
  const scoredFeatures = groupScores
    .flatMap((g) => g.features)
    .filter((f) => f.normalizedValue !== null && f.contribution !== null);

  const ranked = [...scoredFeatures].sort((a, b) => Math.abs(b.contribution!) - Math.abs(a.contribution!));

  const positiveFactors = ranked
    .filter((f) => f.normalizedValue! >= POSITIVE_THRESHOLD)
    .slice(0, MAX_FACTORS)
    .map((f) => f.reason);

  const negativeFactors = ranked
    .filter((f) => f.normalizedValue! <= NEGATIVE_THRESHOLD)
    .slice(0, MAX_FACTORS)
    .map((f) => f.reason);

  const blockingFactors = hardBlockers.reasons.map((r) => r.description);

  return { positiveFactors, negativeFactors, blockingFactors };
}
