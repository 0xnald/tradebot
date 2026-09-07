import { test } from "node:test";
import assert from "node:assert/strict";
import { TieredHistoricalPriceProvider } from "./tieredHistoricalPriceProvider.js";
import type { HistoricalPriceProvider, HistoricalCandle } from "./historicalPriceProvider.js";
import type { ProviderResult } from "../types/domain.js";

const CANDLE: HistoricalCandle = { timestamp: "t", openUsd: 1, highUsd: 1, lowUsd: 1, closeUsd: 1, volumeUsd: 0 };

function fakeProvider(name: string, result: ProviderResult<HistoricalCandle[]>): HistoricalPriceProvider {
  return { name, async getCandles() { return result; } };
}

test("uses the first tier's result when it succeeds with data", async () => {
  const tiered = new TieredHistoricalPriceProvider([
    { name: "onchain", provider: fakeProvider("onchain", { status: "ok", data: [CANDLE], unavailable: [], errors: [] }) },
    { name: "geckoterminal", provider: fakeProvider("geckoterminal", { status: "ok", data: [CANDLE], unavailable: [], errors: [] }) },
  ]);
  const result = await tiered.getCandles(4663, "0xpool", "t", "minute", 1, 10);
  assert.equal(result.status, "ok");
  assert.equal(tiered.lastLookup?.winningTier, "onchain");
  assert.deepEqual(tiered.lastLookup?.attempts, ["onchain:ok"]);
});

test("falls through to the next tier when the first is unavailable", async () => {
  const tiered = new TieredHistoricalPriceProvider([
    { name: "onchain", provider: fakeProvider("onchain", { status: "unavailable", data: null, unavailable: ["candles"], errors: [] }) },
    { name: "geckoterminal", provider: fakeProvider("geckoterminal", { status: "ok", data: [CANDLE], unavailable: [], errors: [] }) },
  ]);
  const result = await tiered.getCandles(4663, "0xpool", "t", "minute", 1, 10);
  assert.equal(result.status, "ok");
  assert.equal(tiered.lastLookup?.winningTier, "geckoterminal");
  assert.deepEqual(tiered.lastLookup?.attempts, ["onchain:unavailable", "geckoterminal:ok"]);
});

test("falls through past an 'ok' status with an empty data array — not treated as a real result", async () => {
  const tiered = new TieredHistoricalPriceProvider([
    { name: "onchain", provider: fakeProvider("onchain", { status: "ok", data: [], unavailable: [], errors: [] }) },
    { name: "geckoterminal", provider: fakeProvider("geckoterminal", { status: "ok", data: [CANDLE], unavailable: [], errors: [] }) },
  ]);
  const result = await tiered.getCandles(4663, "0xpool", "t", "minute", 1, 10);
  assert.equal(tiered.lastLookup?.winningTier, "geckoterminal");
});

test("falls through past an 'error' status too", async () => {
  const tiered = new TieredHistoricalPriceProvider([
    { name: "onchain", provider: fakeProvider("onchain", { status: "error", data: null, unavailable: ["candles"], errors: [{ message: "boom" }] }) },
    { name: "geckoterminal", provider: fakeProvider("geckoterminal", { status: "ok", data: [CANDLE], unavailable: [], errors: [] }) },
  ]);
  const result = await tiered.getCandles(4663, "0xpool", "t", "minute", 1, 10);
  assert.equal(result.status, "ok");
});

test("returns 'unavailable' when every tier fails, with a full attempt trace", async () => {
  const tiered = new TieredHistoricalPriceProvider([
    { name: "onchain", provider: fakeProvider("onchain", { status: "unavailable", data: null, unavailable: ["candles"], errors: [] }) },
    { name: "geckoterminal", provider: fakeProvider("geckoterminal", { status: "unavailable", data: null, unavailable: ["candles"], errors: [] }) },
  ]);
  const result = await tiered.getCandles(4663, "0xpool", "t", "minute", 1, 10);
  assert.equal(result.status, "unavailable");
  assert.equal(tiered.lastLookup?.winningTier, null);
  assert.deepEqual(tiered.lastLookup?.attempts, ["onchain:unavailable", "geckoterminal:unavailable"]);
});

test("respects tier ordering — a later tier is never preferred over an earlier successful one", async () => {
  let laterTierCalled = false;
  const laterTier: HistoricalPriceProvider = {
    name: "geckoterminal",
    async getCandles() {
      laterTierCalled = true;
      return { status: "ok", data: [CANDLE], unavailable: [], errors: [] };
    },
  };
  const tiered = new TieredHistoricalPriceProvider([
    { name: "onchain", provider: fakeProvider("onchain", { status: "ok", data: [CANDLE], unavailable: [], errors: [] }) },
    { name: "geckoterminal", provider: laterTier },
  ]);
  await tiered.getCandles(4663, "0xpool", "t", "minute", 1, 10);
  assert.equal(laterTierCalled, false); // never even called once an earlier tier succeeded
});

test("with a single tier, behaves identically to calling that provider directly", async () => {
  const tiered = new TieredHistoricalPriceProvider([{ name: "onchain", provider: fakeProvider("onchain", { status: "ok", data: [CANDLE], unavailable: [], errors: [] }) }]);
  const result = await tiered.getCandles(4663, "0xpool", "t", "minute", 1, 10);
  assert.equal(result.status, "ok");
});
