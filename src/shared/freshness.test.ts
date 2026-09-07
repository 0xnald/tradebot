import { test } from "node:test";
import assert from "node:assert/strict";
import { computeFreshness } from "./freshness.js";

test("marks a value fresh when its age is within the threshold", () => {
  const now = new Date("2026-09-05T00:01:00.000Z");
  const observedAt = "2026-09-05T00:00:30.000Z"; // 30s ago
  const freshness = computeFreshness(observedAt, 60, now);
  assert.equal(freshness.ageSeconds, 30);
  assert.equal(freshness.isStale, false);
});

test("marks a value stale when its age exceeds the threshold", () => {
  const now = new Date("2026-09-05T00:02:00.000Z");
  const observedAt = "2026-09-05T00:00:00.000Z"; // 120s ago
  const freshness = computeFreshness(observedAt, 60, now);
  assert.equal(freshness.isStale, true);
});

test("never returns a negative age even if observedAt is slightly in the future (clock skew)", () => {
  const now = new Date("2026-09-05T00:00:00.000Z");
  const observedAt = "2026-09-05T00:00:05.000Z";
  const freshness = computeFreshness(observedAt, 60, now);
  assert.equal(freshness.ageSeconds, 0);
});
