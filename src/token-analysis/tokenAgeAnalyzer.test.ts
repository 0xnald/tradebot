import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTokenAge } from "./tokenAgeAnalyzer.js";

const NOW = new Date("2026-09-05T00:00:00.000Z");

test("returns UNKNOWN category and null fields when deployment timestamp is missing", () => {
  const age = computeTokenAge(undefined, NOW);
  assert.equal(age.ageCategory, "UNKNOWN");
  assert.equal(age.ageSeconds, null);
  assert.equal(age.deployedAt, null);
});

test("returns UNKNOWN for an unparseable timestamp rather than throwing", () => {
  const age = computeTokenAge("not-a-date", NOW);
  assert.equal(age.ageCategory, "UNKNOWN");
});

test("categorizes a token deployed 2 minutes ago as BRAND_NEW", () => {
  const age = computeTokenAge(new Date(NOW.getTime() - 2 * 60 * 1000).toISOString(), NOW);
  assert.equal(age.ageCategory, "BRAND_NEW");
  assert.equal(age.ageMinutes, 2);
});

test("categorizes a token deployed 30 minutes ago as VERY_NEW", () => {
  const age = computeTokenAge(new Date(NOW.getTime() - 30 * 60 * 1000).toISOString(), NOW);
  assert.equal(age.ageCategory, "VERY_NEW");
});

test("categorizes a token deployed 5 hours ago as NEW", () => {
  const age = computeTokenAge(new Date(NOW.getTime() - 5 * 60 * 60 * 1000).toISOString(), NOW);
  assert.equal(age.ageCategory, "NEW");
  assert.equal(age.ageHours, 5);
});

test("categorizes a token deployed 10 days ago as ESTABLISHED", () => {
  const age = computeTokenAge(new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(), NOW);
  assert.equal(age.ageCategory, "ESTABLISHED");
});

test("categorizes a token deployed 60 days ago as MATURE", () => {
  const age = computeTokenAge(new Date(NOW.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString(), NOW);
  assert.equal(age.ageCategory, "MATURE");
});
