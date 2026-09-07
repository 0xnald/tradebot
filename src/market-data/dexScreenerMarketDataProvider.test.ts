import { test } from "node:test";
import assert from "node:assert/strict";
import { DexScreenerMarketDataProvider } from "./dexScreenerMarketDataProvider.js";

const TOKEN = "0xeb1898a0d496000506a2799e1b4077776497fd29";
const WETH_PAIR = {
  chainId: "robinhood",
  dexId: "uniswap",
  pairAddress: "0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca",
  baseToken: { address: TOKEN, symbol: "THROBBIN" },
  quoteToken: { address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", symbol: "WETH" },
  priceUsd: "0.05",
  liquidity: { usd: 18000 },
  volume: { h24: 41000 },
  txns: { h24: { buys: 300, sells: 78 } },
  priceChange: { h1: 1.2, h6: -3.4, h24: 12.5 },
  fdv: 50000,
  marketCap: 48000,
};

function withMockFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

test("aggregates a single pair into TokenMarketData", async () => {
  const provider = new DexScreenerMarketDataProvider();
  const result = await withMockFetch(
    (async () => new Response(JSON.stringify([WETH_PAIR]), { status: 200 })) as typeof fetch,
    () => provider.getMarketData(4663, TOKEN),
  );

  assert.equal(result.status, "ok");
  assert.equal(result.data?.priceUsd, 0.05);
  assert.equal(result.data?.marketCapUsd, 48000);
  assert.equal(result.data?.liquidityUsd, 18000);
  assert.equal(result.data?.volumeUsd24h, 41000);
  assert.equal(result.data?.buyCount24h, 300);
  assert.equal(result.data?.sellCount24h, 78);
  assert.equal(result.data?.tradeCount24h, 378);
  assert.equal(result.data?.pools.length, 1);
});

test("sums liquidity/volume across multiple pools and picks the deepest-liquidity pool for price", async () => {
  const shallowPool = { ...WETH_PAIR, pairAddress: "0xshallow", liquidity: { usd: 1000 }, priceUsd: "0.10" };
  const deepPool = { ...WETH_PAIR, pairAddress: "0xdeep", liquidity: { usd: 50000 }, priceUsd: "0.05" };

  const provider = new DexScreenerMarketDataProvider();
  const result = await withMockFetch(
    (async () => new Response(JSON.stringify([shallowPool, deepPool]), { status: 200 })) as typeof fetch,
    () => provider.getMarketData(4663, TOKEN),
  );

  assert.equal(result.data?.liquidityUsd, 51000);
  assert.equal(result.data?.priceUsd, 0.05); // from deepPool, not shallowPool
  assert.equal(result.data?.pools.length, 2);
});

test("returns status 'unavailable' (not an error) when DexScreener has no indexed pairs", async () => {
  const provider = new DexScreenerMarketDataProvider();
  const result = await withMockFetch(
    (async () => new Response(JSON.stringify([]), { status: 200 })) as typeof fetch,
    () => provider.getMarketData(4663, TOKEN),
  );

  assert.equal(result.status, "unavailable");
  assert.equal(result.data, null);
  assert.equal(result.errors.length, 0);
});

test("never fabricates marketCapUsd — returns null with a reason when DexScreener has none", async () => {
  const { marketCap, ...pairWithoutMarketCap } = WETH_PAIR;
  const provider = new DexScreenerMarketDataProvider();
  const result = await withMockFetch(
    (async () => new Response(JSON.stringify([pairWithoutMarketCap]), { status: 200 })) as typeof fetch,
    () => provider.getMarketData(4663, TOKEN),
  );

  assert.equal(result.data?.marketCapUsd, null);
  assert.ok(result.data?.marketCapUnavailableReason);
});

test("returns a structured error on HTTP failure rather than throwing", async () => {
  const provider = new DexScreenerMarketDataProvider();
  const result = await withMockFetch(
    (async () => new Response("", { status: 500, statusText: "Internal Server Error" })) as typeof fetch,
    () => provider.getMarketData(4663, TOKEN),
  );

  assert.equal(result.status, "error");
  assert.equal(result.data, null);
  assert.match(result.errors[0].message, /500/);
});

test("rejects an invalid contract address without calling fetch", async () => {
  const provider = new DexScreenerMarketDataProvider();
  let fetchCalled = false;
  const result = await withMockFetch(
    (async () => {
      fetchCalled = true;
      return new Response("[]", { status: 200 });
    }) as typeof fetch,
    () => provider.getMarketData(4663, "not-an-address"),
  );

  assert.equal(result.status, "error");
  assert.equal(fetchCalled, false);
});

test("rejects an unmapped chainId without calling fetch", async () => {
  const provider = new DexScreenerMarketDataProvider();
  let fetchCalled = false;
  const result = await withMockFetch(
    (async () => {
      fetchCalled = true;
      return new Response("[]", { status: 200 });
    }) as typeof fetch,
    () => provider.getMarketData(1, TOKEN), // Ethereum mainnet — not Robinhood Chain
  );

  assert.equal(result.status, "error");
  assert.equal(fetchCalled, false);
});

test("caches a result and does not re-fetch within the TTL", async () => {
  const provider = new DexScreenerMarketDataProvider({ cacheTtlMs: 60_000 });
  let fetchCount = 0;

  await withMockFetch(
    (async () => {
      fetchCount += 1;
      return new Response(JSON.stringify([WETH_PAIR]), { status: 200 });
    }) as typeof fetch,
    async () => {
      await provider.getMarketData(4663, TOKEN);
      await provider.getMarketData(4663, TOKEN);
    },
  );

  assert.equal(fetchCount, 1);
});
