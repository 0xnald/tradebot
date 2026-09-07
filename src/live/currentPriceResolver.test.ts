import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCurrentPrice } from "./currentPriceResolver.js";
import { clearTokenMetadataCache } from "../shared/tokenMetadataCache.js";

// Phase 7.1 §24 — see venueResolver.test.ts's identical note.
clearTokenMetadataCache();
import type { PoolDataProvider } from "../market-data/poolDataProvider.js";
import type { MarketDataProvider } from "../market-data/marketDataProvider.js";
import type { HistoricalPriceProvider, HistoricalCandle } from "../backtesting/historicalPriceProvider.js";
import type { PoolInfo, ProviderResult, TokenMarketData } from "../types/domain.js";

const TOKEN = "0xeb1898a0d496000506a2799e1b4077776497fd29";
const CHAIN_ID = 4663;

function poolProvider(pools: PoolInfo[] = []): PoolDataProvider {
  return {
    name: "fake-pool",
    async discoverPools(): Promise<ProviderResult<PoolInfo[]>> {
      return { status: "ok", data: pools, unavailable: [], errors: [] };
    },
    async getRecentSwaps() {
      return { status: "unavailable", data: null, unavailable: ["swaps"], errors: [] };
    },
  };
}

function geckoProvider(candles: HistoricalCandle[] | null): HistoricalPriceProvider {
  return {
    name: "geckoterminal",
    async getCandles(): Promise<ProviderResult<HistoricalCandle[]>> {
      if (!candles) return { status: "unavailable", data: null, unavailable: ["candles"], errors: [] };
      return { status: "ok", data: candles, unavailable: [], errors: [] };
    },
  };
}

function dexScreener(result: ProviderResult<TokenMarketData> | ((...args: any[]) => Promise<ProviderResult<TokenMarketData>>)): MarketDataProvider {
  return {
    name: "dexscreener",
    async getMarketData(): Promise<ProviderResult<TokenMarketData>> {
      return typeof result === "function" ? result() : result;
    },
  };
}

const candle: HistoricalCandle = { timestamp: "t", openUsd: 0.05, highUsd: 0.05, lowUsd: 0.05, closeUsd: 0.05, volumeUsd: 10 };

const marketData: TokenMarketData = {
  chainId: CHAIN_ID,
  contractAddress: TOKEN,
  observedAt: "t",
  priceUsd: 0.08,
  marketCapUsd: null,
  liquidityUsd: 5000,
  volumeUsd24h: null,
  pools: [],
  source: "dexscreener",
};

test("falls to DexScreener when no venue can be resolved at all", async () => {
  const result = await resolveCurrentPrice(TOKEN, {
    poolDataProvider: poolProvider([]),
    geckoTerminalProvider: geckoProvider([candle]),
    marketDataProvider: dexScreener({ status: "ok", data: marketData, unavailable: [], errors: [] }),
    chainId: CHAIN_ID,
  });
  // no pool discovered and no Pons provider -> venue UNKNOWN -> no on-chain identifier -> falls to DexScreener
  assert.equal(result.priceUsd, 0.08);
  assert.equal(result.source, "dexscreener");
  assert.equal(result.venueType, "UNKNOWN");
});

test("uses the resolved venue's tiered price when a pool is discovered", async () => {
  const pool: PoolInfo = { chainId: CHAIN_ID, poolAddress: "0xpool", dexId: "uniswap-v3-onchain", tokenAddress: TOKEN, quoteTokenAddress: "0xq", source: "uniswap-v3-onchain" };
  const result = await resolveCurrentPrice(TOKEN, {
    poolDataProvider: poolProvider([pool]),
    geckoTerminalProvider: geckoProvider([candle]),
    marketDataProvider: dexScreener({ status: "ok", data: marketData, unavailable: [], errors: [] }),
    chainId: CHAIN_ID,
  });
  assert.equal(result.priceUsd, 0.05); // from the resolved venue's candle, not DexScreener
  assert.equal(result.venueType, "UNISWAP_V3_POOL");
});

test("falls back to DexScreener when the resolved venue has no data", async () => {
  const pool: PoolInfo = { chainId: CHAIN_ID, poolAddress: "0xpool", dexId: "uniswap-v3-onchain", tokenAddress: TOKEN, quoteTokenAddress: "0xq", source: "uniswap-v3-onchain" };
  const result = await resolveCurrentPrice(TOKEN, {
    poolDataProvider: poolProvider([pool]),
    geckoTerminalProvider: geckoProvider(null),
    marketDataProvider: dexScreener({ status: "ok", data: marketData, unavailable: [], errors: [] }),
    chainId: CHAIN_ID,
  });
  assert.equal(result.priceUsd, 0.08);
  assert.equal(result.source, "dexscreener");
});

test("returns UNAVAILABLE (never fabricated) when every tier fails", async () => {
  const result = await resolveCurrentPrice(TOKEN, {
    poolDataProvider: poolProvider([]),
    geckoTerminalProvider: geckoProvider(null),
    marketDataProvider: dexScreener({ status: "unavailable", data: null, unavailable: ["price"], errors: [] }),
    chainId: CHAIN_ID,
  });
  assert.equal(result.priceUsd, null);
  assert.equal(result.dataQuality, "UNAVAILABLE");
});

test("times out a slow provider rather than hanging, and still tries the next tier", async () => {
  const slowGecko: HistoricalPriceProvider = {
    name: "geckoterminal",
    async getCandles() {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { status: "ok", data: [candle], unavailable: [], errors: [] };
    },
  };
  const pool: PoolInfo = { chainId: CHAIN_ID, poolAddress: "0xpool", dexId: "uniswap-v3-onchain", tokenAddress: TOKEN, quoteTokenAddress: "0xq", source: "uniswap-v3-onchain" };
  const result = await resolveCurrentPrice(TOKEN, {
    poolDataProvider: poolProvider([pool]),
    geckoTerminalProvider: slowGecko,
    marketDataProvider: dexScreener({ status: "ok", data: marketData, unavailable: [], errors: [] }),
    chainId: CHAIN_ID,
    timeoutMs: 20,
  });
  assert.equal(result.priceUsd, 0.08); // fell through to DexScreener after the timeout
  assert.ok(result.providerCalls.some((c) => c.status === "TIMEOUT"));
});

test("records a providerCalls entry for every tier attempted", async () => {
  const result = await resolveCurrentPrice(TOKEN, {
    poolDataProvider: poolProvider([]),
    geckoTerminalProvider: geckoProvider(null),
    marketDataProvider: dexScreener({ status: "ok", data: marketData, unavailable: [], errors: [] }),
    chainId: CHAIN_ID,
  });
  assert.ok(result.providerCalls.length >= 1);
  assert.ok(result.providerCalls.some((c) => c.provider === "dexscreener"));
});
