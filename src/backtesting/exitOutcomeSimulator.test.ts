import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateExit } from "./exitOutcomeSimulator.js";
import type { HistoricalPriceProvider, HistoricalCandle } from "./historicalPriceProvider.js";
import type { ProviderResult } from "../types/domain.js";

const ENTRY_TS = "2026-09-04T20:00:00.000Z";
const POOL = "0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca";
const ENTRY_PRICE = 1.0;

function minute(offset: number, o: number, h: number, l: number, c: number): HistoricalCandle {
  return {
    timestamp: new Date(new Date(ENTRY_TS).getTime() + offset * 60_000).toISOString(),
    openUsd: o,
    highUsd: h,
    lowUsd: l,
    closeUsd: c,
    volumeUsd: 100,
  };
}

function assertClose(actual: number | null, expected: number, epsilon = 1e-6): void {
  assert.ok(actual !== null, `expected ~${expected}, got null`);
  assert.ok(Math.abs((actual as number) - expected) < epsilon, `expected ~${expected}, got ${actual}`);
}

function fakeProvider(candles: HistoricalCandle[]): HistoricalPriceProvider {
  return {
    name: "fake",
    async getCandles(): Promise<ProviderResult<HistoricalCandle[]>> {
      if (candles.length === 0) return { status: "unavailable", data: null, unavailable: ["candles"], errors: [] };
      return { status: "ok", data: candles, unavailable: [], errors: [] };
    },
  };
}

const baseRequest = {
  signalId: "sig-1",
  chainId: 4663,
  poolAddress: POOL,
  entryTimestamp: ENTRY_TS,
  entryPriceUsd: ENTRY_PRICE,
};

test("computes per-horizon returns from the candle covering each horizon's target time", async () => {
  const candles = [
    minute(0, 1.0, 1.0, 1.0, 1.0),
    minute(1, 1.0, 1.05, 0.98, 1.02),
    minute(5, 1.02, 1.1, 1.0, 1.1),
  ];
  const provider = fakeProvider(candles);
  const outcome = await simulateExit(baseRequest, provider, { horizons: ["1m", "5m"], takeProfitPct: null, stopLossPct: null });

  const oneMin = outcome.returnsByHorizon.find((r) => r.horizon === "1m");
  const fiveMin = outcome.returnsByHorizon.find((r) => r.horizon === "5m");
  assertClose(oneMin?.returnPct ?? null, 2); // close 1.02 vs entry 1.0
  assert.equal(oneMin?.dataQuality, "KNOWN");
  assertClose(fiveMin?.returnPct ?? null, 10); // close 1.10 vs entry 1.0
});

test("marks a horizon UNAVAILABLE when no candle data reaches that far, without inventing a value", async () => {
  const candles = [minute(0, 1.0, 1.0, 1.0, 1.0)];
  const provider = fakeProvider(candles);
  const outcome = await simulateExit(baseRequest, provider, { horizons: ["1h"], takeProfitPct: null, stopLossPct: null });

  const oneHour = outcome.returnsByHorizon.find((r) => r.horizon === "1h");
  assert.equal(oneHour?.dataQuality, "UNAVAILABLE");
  assert.equal(oneHour?.returnPct, null);
});

test("detects a take-profit hit and records time-to-hit", async () => {
  const candles = [minute(0, 1.0, 1.0, 1.0, 1.0), minute(1, 1.0, 1.25, 1.0, 1.2)]; // +25% high crosses a +20% TP
  const provider = fakeProvider(candles);
  const outcome = await simulateExit(baseRequest, provider, { horizons: ["5m"], takeProfitPct: 20, stopLossPct: null });

  assert.equal(outcome.takeProfitResult?.hit, true);
  assert.equal(outcome.takeProfitResult?.timeToHitMinutes, 1);
  assertClose(outcome.finalReturnPct, 20);
});

test("detects a stop-loss hit and records time-to-hit", async () => {
  const candles = [minute(0, 1.0, 1.0, 1.0, 1.0), minute(2, 1.0, 1.0, 0.85, 0.9)]; // -15% low crosses a -10% SL
  const provider = fakeProvider(candles);
  const outcome = await simulateExit(baseRequest, provider, { horizons: ["5m"], takeProfitPct: null, stopLossPct: 10 });

  assert.equal(outcome.stopLossResult?.hit, true);
  assert.equal(outcome.stopLossResult?.timeToHitMinutes, 2);
  assertClose(outcome.finalReturnPct, -10);
});

test("never assumes a TP/SL hit without proof — no hit recorded when neither level is crossed", async () => {
  const candles = [minute(0, 1.0, 1.02, 0.98, 1.0), minute(1, 1.0, 1.03, 0.97, 1.0)];
  const provider = fakeProvider(candles);
  const outcome = await simulateExit(baseRequest, provider, { horizons: ["5m"], takeProfitPct: 20, stopLossPct: 20 });

  assert.equal(outcome.takeProfitResult?.hit, false);
  assert.equal(outcome.stopLossResult?.hit, false);
});

test("flags candleOrderingAmbiguous and conservatively records a stop-loss when both levels cross in the same candle", async () => {
  const candles = [minute(0, 1.0, 1.0, 1.0, 1.0), minute(1, 1.0, 1.3, 0.8, 1.0)]; // high +30%, low -20% in one candle
  const provider = fakeProvider(candles);
  const outcome = await simulateExit(baseRequest, provider, { horizons: ["5m"], takeProfitPct: 20, stopLossPct: 15 });

  assert.equal(outcome.candleOrderingAmbiguous, true);
  assert.equal(outcome.stopLossResult?.hit, true);
  assert.equal(outcome.stopLossResult?.dataQuality, "PARTIAL");
  assert.ok(outcome.notes.some((n) => n.includes("cannot establish order")));
});

test("computes MFE and MAE across the full observed window", async () => {
  const candles = [
    minute(0, 1.0, 1.0, 1.0, 1.0),
    minute(1, 1.0, 1.5, 0.9, 1.1), // MFE candidate +50%, MAE candidate -10%
    minute(2, 1.1, 1.2, 1.05, 1.15),
  ];
  const provider = fakeProvider(candles);
  const outcome = await simulateExit(baseRequest, provider, { horizons: ["5m"], takeProfitPct: null, stopLossPct: null });

  assertClose(outcome.maxFavorableExcursionPct, 50);
  assertClose(outcome.maxAdverseExcursionPct, -10);
});

test("falls back to the largest known horizon close as the final mark when no TP/SL is hit", async () => {
  const candles = [minute(0, 1.0, 1.0, 1.0, 1.0), minute(1, 1.0, 1.05, 0.98, 1.03), minute(5, 1.03, 1.08, 1.0, 1.08)];
  const provider = fakeProvider(candles);
  const outcome = await simulateExit(baseRequest, provider, { horizons: ["1m", "5m"], takeProfitPct: 50, stopLossPct: 50 });

  assertClose(outcome.finalReturnPct, 8); // 5m horizon close
  assert.ok(outcome.notes.some((n) => n.includes("no TP/SL hit")));
});

test("marks the outcome UNAVAILABLE when there is no valid entry", async () => {
  const provider = fakeProvider([minute(0, 1.0, 1.0, 1.0, 1.0)]);
  const outcome = await simulateExit({ ...baseRequest, entryPriceUsd: null }, provider, {
    horizons: ["5m"],
    takeProfitPct: null,
    stopLossPct: null,
  });

  assert.equal(outcome.hasValidEntry, false);
  assert.equal(outcome.dataQuality, "UNAVAILABLE");
});

test("marks the outcome UNAVAILABLE when the provider has no candle data after entry", async () => {
  const provider = fakeProvider([]);
  const outcome = await simulateExit(baseRequest, provider, { horizons: ["5m"], takeProfitPct: null, stopLossPct: null });

  assert.equal(outcome.hasValidEntry, true);
  assert.equal(outcome.hasValidExit, false);
  assert.equal(outcome.dataQuality, "UNAVAILABLE");
});

test("marks the outcome PARTIAL when some horizons are known and others are not", async () => {
  const candles = [minute(0, 1.0, 1.0, 1.0, 1.0), minute(1, 1.0, 1.05, 1.0, 1.03)];
  const provider = fakeProvider(candles);
  const outcome = await simulateExit(baseRequest, provider, { horizons: ["1m", "1h"], takeProfitPct: null, stopLossPct: null });

  assert.equal(outcome.dataQuality, "PARTIAL");
});

test("supports multiple horizons simultaneously without cross-contamination", async () => {
  const candles = [
    minute(0, 1.0, 1.0, 1.0, 1.0),
    minute(1, 1.0, 1.0, 1.0, 1.05),
    minute(5, 1.05, 1.0, 1.0, 1.1),
    minute(15, 1.1, 1.0, 1.0, 0.95),
  ];
  const provider = fakeProvider(candles);
  const outcome = await simulateExit(baseRequest, provider, { horizons: ["1m", "5m", "15m"], takeProfitPct: null, stopLossPct: null });

  assert.equal(outcome.returnsByHorizon.length, 3);
  assertClose(outcome.returnsByHorizon.find((r) => r.horizon === "1m")?.returnPct ?? null, 5);
  assertClose(outcome.returnsByHorizon.find((r) => r.horizon === "5m")?.returnPct ?? null, 10);
  assertClose(outcome.returnsByHorizon.find((r) => r.horizon === "15m")?.returnPct ?? null, -5);
});
