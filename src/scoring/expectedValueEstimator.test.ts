import { test } from "node:test";
import assert from "node:assert/strict";
import { ExpectedValueEstimator } from "./expectedValueEstimator.js";
import { SMART_SELECTION_V1_CONFIG } from "./smartSelectionConfig.js";

const NOT_BLOCKED = { hardBlocked: false };
const LOW_CHASE = { level: "LOW_CHASE_RISK" as const, evidence: [] };
const HIGH_CHASE = { level: "HIGH_CHASE_RISK" as const, evidence: [] };

test("never claims statistical validation", () => {
  const estimator = new ExpectedValueEstimator(SMART_SELECTION_V1_CONFIG);
  const result = estimator.estimate({ overallScore: 90, confidence: 90, chaseAssessment: LOW_CHASE, ...NOT_BLOCKED });
  assert.equal(result.statisticallyValidated, false);
});

test("returns HEURISTIC_NEGATIVE for a hard-blocked opportunity regardless of score", () => {
  const estimator = new ExpectedValueEstimator(SMART_SELECTION_V1_CONFIG);
  const result = estimator.estimate({ overallScore: 95, confidence: 95, chaseAssessment: LOW_CHASE, hardBlocked: true });
  assert.equal(result.status, "HEURISTIC_NEGATIVE");
});

test("returns UNKNOWN — not a guessed direction — when confidence is too low", () => {
  const estimator = new ExpectedValueEstimator(SMART_SELECTION_V1_CONFIG);
  const result = estimator.estimate({ overallScore: 90, confidence: 10, chaseAssessment: LOW_CHASE, ...NOT_BLOCKED });
  assert.equal(result.status, "UNKNOWN");
});

test("returns HEURISTIC_NEGATIVE for high chase risk even with a strong score", () => {
  const estimator = new ExpectedValueEstimator(SMART_SELECTION_V1_CONFIG);
  const result = estimator.estimate({ overallScore: 90, confidence: 90, chaseAssessment: HIGH_CHASE, ...NOT_BLOCKED });
  assert.equal(result.status, "HEURISTIC_NEGATIVE");
});

test("returns HEURISTIC_POSITIVE for a strong, confident, non-blocked, low-chase-risk opportunity", () => {
  const estimator = new ExpectedValueEstimator(SMART_SELECTION_V1_CONFIG);
  const result = estimator.estimate({ overallScore: 85, confidence: 80, chaseAssessment: LOW_CHASE, ...NOT_BLOCKED });
  assert.equal(result.status, "HEURISTIC_POSITIVE");
});

test("returns HEURISTIC_NEGATIVE for a clearly weak score", () => {
  const estimator = new ExpectedValueEstimator(SMART_SELECTION_V1_CONFIG);
  const result = estimator.estimate({ overallScore: 20, confidence: 80, chaseAssessment: LOW_CHASE, ...NOT_BLOCKED });
  assert.equal(result.status, "HEURISTIC_NEGATIVE");
});

test("is fully deterministic", () => {
  const estimator = new ExpectedValueEstimator(SMART_SELECTION_V1_CONFIG);
  const inputs = { overallScore: 60, confidence: 60, chaseAssessment: LOW_CHASE, ...NOT_BLOCKED };
  assert.deepEqual(estimator.estimate(inputs), estimator.estimate(inputs));
});
