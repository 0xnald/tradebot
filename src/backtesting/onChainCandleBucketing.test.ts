import { test } from "node:test";
import assert from "node:assert/strict";
import { bucketTradesIntoCandles } from "./onChainCandleBucketing.js";

const BASE = new Date("2026-09-04T20:00:00.000Z").getTime();
function ts(offsetSeconds: number): string {
  return new Date(BASE + offsetSeconds * 1000).toISOString();
}

test("returns an empty array for no trades", () => {
  assert.deepEqual(bucketTradesIntoCandles([], "minute", 1), []);
});

test("buckets multiple trades within the same minute into one candle with correct OHLC", () => {
  const points = [
    { timestamp: ts(0), priceUsd: 1.0 },
    { timestamp: ts(10), priceUsd: 1.2 },
    { timestamp: ts(20), priceUsd: 0.9 },
    { timestamp: ts(30), priceUsd: 1.1 },
  ];
  const candles = bucketTradesIntoCandles(points, "minute", 1);
  assert.equal(candles.length, 1);
  assert.equal(candles[0].openUsd, 1.0);
  assert.equal(candles[0].highUsd, 1.2);
  assert.equal(candles[0].lowUsd, 0.9);
  assert.equal(candles[0].closeUsd, 1.1);
});

test("splits trades across minute boundaries into separate candles, sorted oldest-first", () => {
  const points = [
    { timestamp: ts(65), priceUsd: 2.0 }, // minute 1
    { timestamp: ts(5), priceUsd: 1.0 }, // minute 0, out of order input
  ];
  const candles = bucketTradesIntoCandles(points, "minute", 1);
  assert.equal(candles.length, 2);
  assert.equal(candles[0].openUsd, 1.0);
  assert.equal(candles[1].openUsd, 2.0);
});

test("respects the aggregate factor (e.g. 5-minute candles)", () => {
  const points = [
    { timestamp: ts(0), priceUsd: 1.0 },
    { timestamp: ts(4 * 60), priceUsd: 1.5 }, // still within the first 5-minute bucket
    { timestamp: ts(5 * 60), priceUsd: 2.0 }, // next bucket
  ];
  const candles = bucketTradesIntoCandles(points, "minute", 5);
  assert.equal(candles.length, 2);
  assert.equal(candles[0].closeUsd, 1.5);
  assert.equal(candles[1].openUsd, 2.0);
});

test("orders trades within a bucket by timestamp regardless of input order", () => {
  const points = [
    { timestamp: ts(30), priceUsd: 3.0 },
    { timestamp: ts(10), priceUsd: 1.0 },
    { timestamp: ts(20), priceUsd: 2.0 },
  ];
  const candles = bucketTradesIntoCandles(points, "minute", 1);
  assert.equal(candles[0].openUsd, 1.0);
  assert.equal(candles[0].closeUsd, 3.0);
});

test("always reports zero volume — this phase reconstructs price only", () => {
  const candles = bucketTradesIntoCandles([{ timestamp: ts(0), priceUsd: 1.0 }], "minute", 1);
  assert.equal(candles[0].volumeUsd, 0);
});
