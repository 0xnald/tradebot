import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfidenceEngine, type ConfidenceInputs } from "./confidenceEngine.js";
import { SMART_SELECTION_V1_CONFIG } from "./smartSelectionConfig.js";
import type { FeatureGroupScore, WalletSignalAssessment } from "../types/domain.js";

function groupScore(group: FeatureGroupScore["group"], groupScore: number | null, groupWeight: number): FeatureGroupScore {
  return { group, features: [], groupScore, groupWeight, dataQuality: groupScore !== null ? "KNOWN" : "UNAVAILABLE" };
}

function unresolvedWallet(): WalletSignalAssessment {
  return { status: "UNRESOLVED", identifiedWallets: [], relationshipSignals: [], walletScore: null, notes: [] };
}

function availableWallet(sampleSizeConfidence: number): WalletSignalAssessment {
  return {
    status: "AVAILABLE",
    identifiedWallets: [
      {
        walletAddress: "0xwallet",
        qualityFeatures: {
          chainId: 4663,
          walletAddress: "0xwallet",
          computedAt: new Date().toISOString(),
          consistencyScore: null,
          profitabilityScore: null,
          earlyEntryScore: null,
          liquidityAwareScore: null,
          sampleSizeConfidence,
          recentPerformanceScore: null,
          copyabilityScore: null,
          riskScore: null,
          unavailableFeatures: [],
        },
        baseWeight: 1,
        adjustedWeight: 1,
        compositeQualityScore: 50,
      },
    ],
    relationshipSignals: [],
    walletScore: 50,
    notes: [],
  };
}

function baseInputs(overrides: Partial<ConfidenceInputs> = {}): ConfidenceInputs {
  const allGroups = Object.entries(SMART_SELECTION_V1_CONFIG.groupWeights).map(([group, weight]) =>
    groupScore(group as FeatureGroupScore["group"], 70, weight),
  );
  return {
    groupScores: allGroups,
    criticalFeaturesAvailable: { liquidity: true, contractFeatures: true, holderData: true },
    walletAssessment: availableWallet(0.8),
    marketDataAgeSeconds: 10,
    ...overrides,
  };
}

test("reports high confidence when everything is known, fresh, and critical features are available", () => {
  const engine = new ConfidenceEngine(SMART_SELECTION_V1_CONFIG);
  const result = engine.compute(baseInputs());
  assert.ok(result.overallConfidence > 80);
});

test("completeness component drops proportionally when some groups are unavailable", () => {
  const engine = new ConfidenceEngine(SMART_SELECTION_V1_CONFIG);
  const partialGroups = Object.entries(SMART_SELECTION_V1_CONFIG.groupWeights).map(([group, weight], i) =>
    groupScore(group as FeatureGroupScore["group"], i % 2 === 0 ? 70 : null, weight),
  );
  const result = engine.compute(baseInputs({ groupScores: partialGroups }));
  const completeness = result.components.find((c) => c.name === "completeness")!;
  assert.ok(completeness.value < 100);
});

test("critical feature availability drops when liquidity/contract/holder data is missing", () => {
  const engine = new ConfidenceEngine(SMART_SELECTION_V1_CONFIG);
  const result = engine.compute(
    baseInputs({ criticalFeaturesAvailable: { liquidity: false, contractFeatures: false, holderData: true } }),
  );
  const critical = result.components.find((c) => c.name === "criticalFeatureAvailability")!;
  assert.ok(Math.abs(critical.value - (1 / 3) * 100) < 0.01);
});

test("unresolved wallet evidence uses a documented neutral default, not a penalty or a bonus", () => {
  const engine = new ConfidenceEngine(SMART_SELECTION_V1_CONFIG);
  const result = engine.compute(baseInputs({ walletAssessment: unresolvedWallet() }));
  const wallet = result.components.find((c) => c.name === "walletSampleSize")!;
  assert.equal(wallet.value, 30);
});

test("higher wallet sample-size confidence increases the walletSampleSize component", () => {
  const engine = new ConfidenceEngine(SMART_SELECTION_V1_CONFIG);
  const lowSample = engine.compute(baseInputs({ walletAssessment: availableWallet(0.1) }));
  const highSample = engine.compute(baseInputs({ walletAssessment: availableWallet(0.9) }));
  const lowValue = lowSample.components.find((c) => c.name === "walletSampleSize")!.value;
  const highValue = highSample.components.find((c) => c.name === "walletSampleSize")!.value;
  assert.ok(highValue > lowValue);
});

test("fresh data scores higher on the freshness component than stale (but not hard-blocked) data", () => {
  const engine = new ConfidenceEngine(SMART_SELECTION_V1_CONFIG);
  const fresh = engine.compute(baseInputs({ marketDataAgeSeconds: 10 }));
  const staleish = engine.compute(baseInputs({ marketDataAgeSeconds: 300 }));
  const freshValue = fresh.components.find((c) => c.name === "freshness")!.value;
  const staleValue = staleish.components.find((c) => c.name === "freshness")!.value;
  assert.ok(freshValue > staleValue);
});

test("reports low confidence — not a fabricated mid value — when almost everything is unavailable", () => {
  const engine = new ConfidenceEngine(SMART_SELECTION_V1_CONFIG);
  const emptyGroups = Object.entries(SMART_SELECTION_V1_CONFIG.groupWeights).map(([group, weight]) =>
    groupScore(group as FeatureGroupScore["group"], null, weight),
  );
  const result = engine.compute(
    baseInputs({
      groupScores: emptyGroups,
      criticalFeaturesAvailable: { liquidity: false, contractFeatures: false, holderData: false },
      walletAssessment: unresolvedWallet(),
      marketDataAgeSeconds: null,
    }),
  );
  assert.ok(result.overallConfidence < 30);
});

test("is fully deterministic", () => {
  const engine = new ConfidenceEngine(SMART_SELECTION_V1_CONFIG);
  const inputs = baseInputs();
  assert.deepEqual(engine.compute(inputs), engine.compute(inputs));
});
