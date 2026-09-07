import { test } from "node:test";
import assert from "node:assert/strict";
import { GeckoTerminalHistoricalPriceProvider } from "./geckoTerminalHistoricalPriceProvider.js";

const POOL = "0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca";
const BEFORE = "2026-09-04T20:30:00.000Z";

// GeckoTerminal returns ohlcv_list newest-first: [unixSeconds, open, high, low, close, volume]
const NEWEST_FIRST_OHLCV = [
  [1725481800, 0.06, 0.065, 0.058, 0.06, 5000],
  [1725481740, 0.055, 0.06, 0.05, 0.058, 4000],
  [1725481680, 0.05, 0.056, 0.048, 0.055, 3000],
];

function withMockFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

function ohlcvResponse(list: number[][]): Response {
  return new Response(JSON.stringify({ data: { attributes: { ohlcv_list: list } } }), { status: 200 });
}

test("returns candles reordered oldest-first from GeckoTerminal's newest-first response", async () => {
  const provider = new GeckoTerminalHistoricalPriceProvider();
  const result = await withMockFetch(
    (async () => ohlcvResponse(NEWEST_FIRST_OHLCV)) as typeof fetch,
    () => provider.getCandles(4663, POOL, BEFORE, "minute", 1, 3),
  );

  assert.equal(result.status, "ok");
  assert.equal(result.data?.length, 3);
  // oldest first
  assert.equal(result.data?.[0].timestamp, new Date(1725481680 * 1000).toISOString());
  assert.equal(result.data?.[0].openUsd, 0.05);
  assert.equal(result.data?.[0].highUsd, 0.056);
  assert.equal(result.data?.[0].lowUsd, 0.048);
  assert.equal(result.data?.[0].closeUsd, 0.055);
  assert.equal(result.data?.[0].volumeUsd, 3000);
  // newest last
  assert.equal(result.data?.[2].timestamp, new Date(1725481800 * 1000).toISOString());
  assert.equal(result.data?.[2].closeUsd, 0.06);
});

test("returns status 'unavailable' (not an error) when GeckoTerminal has no candles for this window", async () => {
  const provider = new GeckoTerminalHistoricalPriceProvider();
  const result = await withMockFetch(
    (async () => ohlcvResponse([])) as typeof fetch,
    () => provider.getCandles(4663, POOL, BEFORE, "minute", 1, 100),
  );

  assert.equal(result.status, "unavailable");
  assert.equal(result.data, null);
  assert.equal(result.errors.length, 0);
});

test("returns a structured error on HTTP failure rather than throwing", async () => {
  const provider = new GeckoTerminalHistoricalPriceProvider();
  const result = await withMockFetch(
    (async () => new Response("", { status: 500, statusText: "Internal Server Error" })) as typeof fetch,
    () => provider.getCandles(4663, POOL, BEFORE, "minute", 1, 100),
  );

  assert.equal(result.status, "error");
  assert.equal(result.data, null);
  assert.match(result.errors[0].message, /500/);
});

test("rejects an invalid pool address without calling fetch", async () => {
  const provider = new GeckoTerminalHistoricalPriceProvider();
  let fetchCalled = false;
  const result = await withMockFetch(
    (async () => {
      fetchCalled = true;
      return ohlcvResponse([]);
    }) as typeof fetch,
    () => provider.getCandles(4663, "not-an-address", BEFORE, "minute", 1, 100),
  );

  assert.equal(result.status, "error");
  assert.equal(fetchCalled, false);
});

test("rejects an unmapped chainId without calling fetch", async () => {
  const provider = new GeckoTerminalHistoricalPriceProvider();
  let fetchCalled = false;
  const result = await withMockFetch(
    (async () => {
      fetchCalled = true;
      return ohlcvResponse([]);
    }) as typeof fetch,
    () => provider.getCandles(1, POOL, BEFORE, "minute", 1, 100), // Ethereum mainnet, not Robinhood Chain
  );

  assert.equal(result.status, "error");
  assert.equal(fetchCalled, false);
});

test("rejects an invalid beforeTimestamp without calling fetch", async () => {
  const provider = new GeckoTerminalHistoricalPriceProvider();
  let fetchCalled = false;
  const result = await withMockFetch(
    (async () => {
      fetchCalled = true;
      return ohlcvResponse([]);
    }) as typeof fetch,
    () => provider.getCandles(4663, POOL, "not-a-timestamp", "minute", 1, 100),
  );

  assert.equal(result.status, "error");
  assert.equal(fetchCalled, false);
});

test("caches a result and does not re-fetch the same window within the TTL", async () => {
  const provider = new GeckoTerminalHistoricalPriceProvider({ cacheTtlMs: 60_000 });
  let fetchCount = 0;

  await withMockFetch(
    (async () => {
      fetchCount += 1;
      return ohlcvResponse(NEWEST_FIRST_OHLCV);
    }) as typeof fetch,
    async () => {
      await provider.getCandles(4663, POOL, BEFORE, "minute", 1, 3);
      await provider.getCandles(4663, POOL, BEFORE, "minute", 1, 3);
    },
  );

  assert.equal(fetchCount, 1);
});

test("accepts a 32-byte Uniswap V4 PoolId as a pool identifier (Pons V2 graduated launches)", async () => {
  const V4_POOL_ID = "0x29a9f241f8299f80d4fc533fee32e97a10b4b5d39d52f6b6376e1b596ab2cad3";
  const provider = new GeckoTerminalHistoricalPriceProvider();
  const result = await withMockFetch(
    (async () => ohlcvResponse(NEWEST_FIRST_OHLCV)) as typeof fetch,
    () => provider.getCandles(4663, V4_POOL_ID, BEFORE, "minute", 1, 3),
  );
  assert.equal(result.status, "ok");
  assert.equal(result.data?.length, 3);
});

test("treats a different aggregate/limit/timestamp as a distinct cache entry", async () => {
  const provider = new GeckoTerminalHistoricalPriceProvider({ cacheTtlMs: 60_000 });
  let fetchCount = 0;

  await withMockFetch(
    (async () => {
      fetchCount += 1;
      return ohlcvResponse(NEWEST_FIRST_OHLCV);
    }) as typeof fetch,
    async () => {
      await provider.getCandles(4663, POOL, BEFORE, "minute", 1, 3);
      await provider.getCandles(4663, POOL, BEFORE, "hour", 1, 3);
    },
  );

  assert.equal(fetchCount, 2);
});
