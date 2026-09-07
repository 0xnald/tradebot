import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExplanation } from "./explainability.js";
import type { FeatureContribution, FeatureGroupScore } from "../types/domain.js";

function feat(name: string, normalizedValue: number | null, weight: number, reason: string): FeatureContribution {
  return { name, rawValue: null, normalizedValue, weight, contribution: normalizedValue !== null ? normalizedValue * weight : null, reason, dataQuality: "KNOWN" };
}

function group(name: FeatureGroupScore["group"], features: FeatureContribution[]): FeatureGroupScore {
  return { group: name, features, groupScore: 50, groupWeight: 10, dataQuality: "KNOWN" };
}

test("lists strongly positive features as positive factors, using their own reason text", () => {
  const groups = [group("liquidity", [feat("currentLiquidityUsd", 0.9, 6, "healthy liquidity")])];
  const result = buildExplanation(groups, { blocked: false, reasons: [] });
  assert.deepEqual(result.positiveFactors, ["healthy liquidity"]);
});

test("lists strongly negative features as negative factors", () => {
  const groups = [group("liquidity", [feat("liquidityTrend", 0.1, 5, "liquidity trend: DECREASING")])];
  const result = buildExplanation(groups, { blocked: false, reasons: [] });
  assert.deepEqual(result.negativeFactors, ["liquidity trend: DECREASING"]);
});

test("does not classify a neutral mid-band feature as either positive or negative", () => {
  const groups = [group("momentum", [feat("shortTermPriceChange", 0.5, 4, "neutral momentum")])];
  const result = buildExplanation(groups, { blocked: false, reasons: [] });
  assert.deepEqual(result.positiveFactors, []);
  assert.deepEqual(result.negativeFactors, []);
});

test("excludes unavailable (null) features from both factor lists — never invents a reason for missing data", () => {
  const groups = [group("holderStructure", [feat("top10Concentration", null, 3, "unavailable")])];
  const result = buildExplanation(groups, { blocked: false, reasons: [] });
  assert.deepEqual(result.positiveFactors, []);
  assert.deepEqual(result.negativeFactors, []);
});

test("ranks factors by the magnitude of their actual contribution, not declaration order", () => {
  const groups = [
    group("liquidity", [feat("small", 0.7, 1, "small positive")]),
    group("marketFlow", [feat("large", 0.9, 10, "large positive")]),
  ];
  const result = buildExplanation(groups, { blocked: false, reasons: [] });
  assert.equal(result.positiveFactors[0], "large positive");
});

test("caps the number of reported factors", () => {
  const features = Array.from({ length: 10 }, (_, i) => feat(`f${i}`, 0.9, 1, `positive ${i}`));
  const groups = [group("liquidity", features)];
  const result = buildExplanation(groups, { blocked: false, reasons: [] });
  assert.ok(result.positiveFactors.length <= 5);
});

test("reports blocking factors directly from the hard-blocker descriptions", () => {
  const result = buildExplanation([], { blocked: true, reasons: [{ code: "NO_USABLE_LIQUIDITY", description: "liquidity too low" }] });
  assert.deepEqual(result.blockingFactors, ["liquidity too low"]);
});

test("reports no blocking factors when nothing was blocked", () => {
  const result = buildExplanation([], { blocked: false, reasons: [] });
  assert.deepEqual(result.blockingFactors, []);
});
