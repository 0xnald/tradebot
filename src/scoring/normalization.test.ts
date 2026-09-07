import { test } from "node:test";
import assert from "node:assert/strict";
import { linearBand, stepBand, invertedU, weightedAverage, safeAgeSeconds } from "./normalization.js";

test("linearBand interpolates between two points and clamps outside the range", () => {
  assert.equal(linearBand(50, 0, 0, 100, 1), 0.5);
  assert.equal(linearBand(-10, 0, 0, 100, 1), 0);
  assert.equal(linearBand(200, 0, 0, 100, 1), 1);
});

test("stepBand returns the score for the first band whose maxValue is not exceeded", () => {
  const bands = [
    { maxValue: 5000, score: 0.1 },
    { maxValue: 20000, score: 0.4 },
    { maxValue: Infinity, score: 1.0 },
  ];
  assert.equal(stepBand(1000, bands), 0.1);
  assert.equal(stepBand(10000, bands), 0.4);
  assert.equal(stepBand(1_000_000, bands), 1.0);
});

test("invertedU peaks at 1 at the center and falls off symmetrically", () => {
  assert.equal(invertedU(20, 20, 40), 1);
  assert.equal(invertedU(0, 20, 40), 0.5);
  assert.equal(invertedU(60, 20, 40), 0);
  assert.equal(invertedU(100, 20, 40), 0); // clamped, not negative
});

test("weightedAverage ignores null entries rather than treating them as 0", () => {
  const result = weightedAverage([
    { value: 1, weight: 1 },
    { value: null, weight: 5 }, // should not drag the average down
  ]);
  assert.equal(result, 1);
});

test("weightedAverage returns null (not 0) when nothing is available", () => {
  assert.equal(weightedAverage([{ value: null, weight: 1 }]), null);
  assert.equal(weightedAverage([]), null);
});

test("weightedAverage computes a proper weighted mean across multiple known values", () => {
  const result = weightedAverage([
    { value: 1, weight: 1 },
    { value: 0, weight: 3 },
  ]);
  assert.equal(result, 0.25);
});

// Phase 7.1 §2 — NaN/Infinity correctness bug fix (see docs/LIVE_PIPELINE.md).
// `e.value !== null` alone is not enough: NaN !== null is true in JS, so a
// NaN "value" used to be treated as usable and poison the weighted sum.
test("weightedAverage excludes NaN entries rather than letting them poison the sum", () => {
  assert.equal(weightedAverage([{ value: NaN, weight: 1 }]), null);
  assert.equal(
    weightedAverage([
      { value: NaN, weight: 1 },
      { value: 50, weight: 1 },
    ]),
    50,
  );
});

test("weightedAverage excludes Infinity and -Infinity entries", () => {
  assert.equal(weightedAverage([{ value: Infinity, weight: 1 }]), null);
  assert.equal(weightedAverage([{ value: -Infinity, weight: 1 }]), null);
  assert.equal(
    weightedAverage([
      { value: Infinity, weight: 1 },
      { value: 80, weight: 1 },
    ]),
    80,
  );
});

test("safeAgeSeconds returns null for a missing timestamp, never NaN", () => {
  const now = new Date("2026-09-05T00:10:00.000Z");
  assert.equal(safeAgeSeconds(null, now), null);
  assert.equal(safeAgeSeconds(undefined, now), null);
  assert.equal(safeAgeSeconds("", now), null);
});

test("safeAgeSeconds returns null for an unparseable timestamp, never NaN", () => {
  const now = new Date("2026-09-05T00:10:00.000Z");
  assert.equal(safeAgeSeconds("not-a-real-timestamp", now), null);
  assert.equal(safeAgeSeconds("2026-13-45T99:99:99.000Z", now), null);
});

test("safeAgeSeconds returns the real elapsed seconds for a valid ISO timestamp", () => {
  const now = new Date("2026-09-05T00:10:00.000Z");
  assert.equal(safeAgeSeconds("2026-09-05T00:08:00.000Z", now), 120);
  assert.equal(safeAgeSeconds("2026-09-05T00:10:00.000Z", now), 0);
});
