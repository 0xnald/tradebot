import { test } from "node:test";
import assert from "node:assert/strict";
import { LookaheadGuard } from "./lookaheadGuard.js";

const T = "2026-09-04T20:00:00.000Z";

test("admits an observation made before the decision timestamp", () => {
  const guard = new LookaheadGuard(T);
  const value = guard.admit("price", { observedAt: "2026-09-04T19:59:00.000Z", value: 1.23 });
  assert.equal(value, 1.23);
  assert.equal(guard.hasViolations, false);
});

test("admits an observation made exactly AT the decision timestamp", () => {
  const guard = new LookaheadGuard(T);
  const value = guard.admit("price", { observedAt: T, value: 1.23 });
  assert.equal(value, 1.23);
});

test("rejects future price data — it cannot influence a historical score", () => {
  const guard = new LookaheadGuard(T);
  const value = guard.admit("priceUsd", { observedAt: "2026-09-04T20:05:00.000Z", value: 99 });
  assert.equal(value, null);
  assert.equal(guard.hasViolations, true);
  assert.equal(guard.violations[0].field, "priceUsd");
});

test("rejects future liquidity data", () => {
  const guard = new LookaheadGuard(T);
  const value = guard.admit("liquidityUsd", { observedAt: "2026-09-05T00:00:00.000Z", value: 999999 });
  assert.equal(value, null);
});

test("rejects future holder data", () => {
  const guard = new LookaheadGuard(T);
  const value = guard.admit("holderConcentration", { observedAt: "2026-09-04T21:00:00.000Z", value: { top10: 5 } });
  assert.equal(value, null);
});

test("rejects future wallet performance data", () => {
  const guard = new LookaheadGuard(T);
  const value = guard.admit("walletQuality", { observedAt: "2026-09-06T00:00:00.000Z", value: { profitabilityScore: 0.9 } });
  assert.equal(value, null);
});

test("rejects future market data generally", () => {
  const guard = new LookaheadGuard(T);
  const value = guard.admit("marketFlow", { observedAt: "2026-09-04T20:00:00.001Z", value: { buyCount: 100 } });
  assert.equal(value, null);
});

test("returns null (not a violation) for a genuinely missing observation, distinct from a rejected future one", () => {
  const guard = new LookaheadGuard(T);
  const value = guard.admit("holderConcentration", null);
  assert.equal(value, null);
  assert.equal(guard.hasViolations, false); // missing != lookahead violation
});

test("treats an unparseable observedAt as a violation rather than silently admitting it", () => {
  const guard = new LookaheadGuard(T);
  const value = guard.admit("price", { observedAt: "not-a-date", value: 1 });
  assert.equal(value, null);
  assert.equal(guard.hasViolations, true);
});

test("accumulates multiple violations across many admit() calls for one decision", () => {
  const guard = new LookaheadGuard(T);
  guard.admit("price", { observedAt: "2026-09-05T00:00:00.000Z", value: 1 });
  guard.admit("liquidity", { observedAt: "2026-09-05T00:00:00.000Z", value: 2 });
  guard.admit("holders", { observedAt: "2026-09-04T19:00:00.000Z", value: 3 }); // this one is fine
  assert.equal(guard.violations.length, 2);
});
