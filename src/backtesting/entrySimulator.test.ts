import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateEntry, effectiveEntryPriceUsd } from "./entrySimulator.js";
import type { HistoricalPriceProvider, HistoricalCandle } from "./historicalPriceProvider.js";
import type { ProviderResult } from "../types/domain.js";

const DECISION_TS = "2026-09-04T20:00:00.000Z";
const POOL = "0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca";

function candle(minutesAfterDecision: number, openUsd: number): HistoricalCandle {
  const ts = new Date(new Date(DECISION_TS).getTime() + minutesAfterDecision * 60_000).toISOString();
  return { timestamp: ts, openUsd, highUsd: openUsd, lowUsd: openUsd, closeUsd: openUsd, volumeUsd: 100 };
}

function fakeProvider(candles: HistoricalCandle[] | null, status: ProviderResult<HistoricalCandle[]>["status"] = "ok"): HistoricalPriceProvider {
  return {
    name: "fake",
    async getCandles(): Promise<ProviderResult<HistoricalCandle[]>> {
      if (!candles) return { status, data: null, unavailable: ["candles"], errors: [] };
      return { status: "ok", data: candles, unavailable: [], errors: [] };
    },
  };
}

const baseRequest = {
  signalId: "sig-1",
  signalTimestamp: DECISION_TS,
  decisionTimestamp: DECISION_TS,
  chainId: 4663,
  poolAddress: POOL,
};

const baseConfig = { maxEntryDelayMinutes: 5, slippagePct: 1, feePct: 0.5, positionSizeUsd: 100 };

test("enters at the earliest candle at or after the decision boundary", async () => {
  const provider = fakeProvider([candle(-2, 0.04), candle(0, 0.05), candle(1, 0.06)]);
  const position = await simulateEntry(baseRequest, provider, baseConfig);

  assert.equal(position.entryDataQuality, "KNOWN");
  assert.equal(position.entryPriceUsd, 0.05);
  assert.equal(position.entryDelayMinutes, 0);
  assert.equal(position.entryTimestamp, candle(0, 0.05).timestamp);
});

test("picks the earliest in-window candle strictly after decision time, not a later more-favorable one", async () => {
  const provider = fakeProvider([candle(1, 0.05), candle(2, 0.03)]); // 0.03 is "better" but later
  const position = await simulateEntry(baseRequest, provider, baseConfig);

  assert.equal(position.entryPriceUsd, 0.05);
  assert.equal(position.entryDelayMinutes, 1);
});

test("marks entry UNAVAILABLE when no candle falls within maxEntryDelayMinutes", async () => {
  const provider = fakeProvider([candle(10, 0.05)]); // outside the 5-minute window
  const position = await simulateEntry(baseRequest, provider, baseConfig);

  assert.equal(position.entryDataQuality, "UNAVAILABLE");
  assert.equal(position.entryPriceUsd, null);
  assert.equal(position.entryTimestamp, null);
});

test("marks entry UNAVAILABLE rather than inventing a price when no pool is resolved", async () => {
  const provider = fakeProvider([candle(0, 0.05)]);
  const position = await simulateEntry({ ...baseRequest, poolAddress: null }, provider, baseConfig);

  assert.equal(position.entryDataQuality, "UNAVAILABLE");
  assert.equal(position.entryPriceUsd, null);
});

test("marks entry UNAVAILABLE when the provider itself has no data", async () => {
  const provider = fakeProvider(null, "unavailable");
  const position = await simulateEntry(baseRequest, provider, baseConfig);

  assert.equal(position.entryDataQuality, "UNAVAILABLE");
});

test("marks entry UNAVAILABLE for an invalid decision timestamp rather than throwing", async () => {
  const provider = fakeProvider([candle(0, 0.05)]);
  const position = await simulateEntry({ ...baseRequest, decisionTimestamp: "not-a-date" }, provider, baseConfig);

  assert.equal(position.entryDataQuality, "UNAVAILABLE");
});

test("computes fees from positionSizeUsd and feePct", async () => {
  const provider = fakeProvider([candle(0, 0.05)]);
  const position = await simulateEntry(baseRequest, provider, baseConfig);

  assert.equal(position.feesUsd, 100 * (0.5 / 100));
  assert.equal(position.positionSizeUsd, 100);
});

test("effectiveEntryPriceUsd applies slippage on top of the observed price", async () => {
  const position = {
    signalId: "s",
    signalTimestamp: DECISION_TS,
    decisionTimestamp: DECISION_TS,
    entryTimestamp: DECISION_TS,
    entryDelayMinutes: 0,
    entryPriceUsd: 0.05,
    entryPriceSource: "fake",
    entryDataQuality: "KNOWN" as const,
    positionSizeUsd: 100,
    feesUsd: 0.5,
    slippagePct: 2,
  };
  assert.equal(effectiveEntryPriceUsd(position), 0.05 * 1.02);
});

test("effectiveEntryPriceUsd returns null when entry price is unavailable", () => {
  const position = {
    signalId: "s",
    signalTimestamp: DECISION_TS,
    decisionTimestamp: DECISION_TS,
    entryTimestamp: null,
    entryDelayMinutes: null,
    entryPriceUsd: null,
    entryPriceSource: null,
    entryDataQuality: "UNAVAILABLE" as const,
    positionSizeUsd: null,
    feesUsd: null,
    slippagePct: 1,
  };
  assert.equal(effectiveEntryPriceUsd(position), null);
});
