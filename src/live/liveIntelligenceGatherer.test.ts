import { test } from "node:test";
import assert from "node:assert/strict";
import { gatherLiveIntelligence } from "./liveIntelligenceGatherer.js";
import { clearTokenMetadataCache } from "../shared/tokenMetadataCache.js";

// Phase 7.1 §24 — see venueResolver.test.ts's identical note: tokenDecimals()/getCachedTokenMetadata()
// share a process-global cache, cleared here so no test in this file (or another sharing the process)
// can leak a cached decimals value into these deterministic tests.
clearTokenMetadataCache();
import type { MarketDataProvider } from "../market-data/marketDataProvider.js";
import type { TokenIntelligenceProvider } from "../token-analysis/tokenAnalysisService.js";
import type { PoolDataProvider } from "../market-data/poolDataProvider.js";
import type { HistoricalPriceProvider, HistoricalCandle } from "../backtesting/historicalPriceProvider.js";
import type { PoolInfo, ProviderResult, ScoutSignal, SwapRecord, TokenContractInfo, TokenMarketData } from "../types/domain.js";

const CHAIN_ID = 4663;

function scoutSignal(overrides: Partial<ScoutSignal> = {}): ScoutSignal {
  return {
    id: "telegram:scoutrobinhood:1",
    source: "telegram:scoutrobinhood",
    sourceMessageId: "1",
    receivedAt: "2026-09-06T12:00:00.000Z",
    postedAt: "2026-09-06T12:00:00.000Z",
    messageType: "EARLY_CALL",
    tokenSymbol: "TEST",
    contractAddress: "0xeb1898a0d496000506a2799e1b4077776497fd29",
    rawText: "test",
    parseConfidence: "high",
    parseWarnings: [],
    ...overrides,
  };
}

function poolProvider(): PoolDataProvider {
  return {
    name: "fake-pool",
    async discoverPools(): Promise<ProviderResult<PoolInfo[]>> {
      return { status: "ok", data: [], unavailable: [], errors: [] };
    },
    async getRecentSwaps() {
      return { status: "unavailable", data: null, unavailable: ["swaps"], errors: [] };
    },
  };
}

function geckoProvider(): HistoricalPriceProvider {
  return { name: "geckoterminal", async getCandles(): Promise<ProviderResult<HistoricalCandle[]>> { return { status: "unavailable", data: null, unavailable: ["candles"], errors: [] }; } };
}

function dexScreener(result: ProviderResult<TokenMarketData>, delayMs = 0): MarketDataProvider {
  return {
    name: "dexscreener",
    async getMarketData() {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return result;
    },
  };
}

/** Full control over the fast/slow split, each independently delayable — for proving Phase 7.1's concurrency/tiering behavior. */
function tokenAnalysis(options: {
  fast?: ProviderResult<TokenContractInfo>;
  fastDelayMs?: number;
  slow?: Partial<TokenContractInfo>;
  slowDelayMs?: number;
  slowThrows?: boolean;
} = {}): TokenIntelligenceProvider {
  const fast = options.fast ?? { status: "unavailable" as const, data: null, unavailable: [], errors: [] };
  const slow = options.slow ?? {};
  return {
    async getTokenIntelligence(): Promise<ProviderResult<TokenContractInfo>> {
      return fast;
    },
    async getFastTokenInfo(): Promise<ProviderResult<TokenContractInfo>> {
      if (options.fastDelayMs) await new Promise((resolve) => setTimeout(resolve, options.fastDelayMs));
      return fast;
    },
    async getSlowTokenInfo() {
      if (options.slowDelayMs) await new Promise((resolve) => setTimeout(resolve, options.slowDelayMs));
      if (options.slowThrows) throw new Error("slow tier exploded");
      return slow;
    },
  };
}

/** RobinhoodChainClient has a private #client field, which blocks structural duck-typing — `as any` is
 * the established pattern this codebase already uses for faking it in tests (see tokenAnalysisService.test.ts). */
function fakeChainClient(overrides: Partial<Record<string, (...args: any[]) => any>> = {}) {
  return {
    chainId: CHAIN_ID,
    getBytecode: overrides.getBytecode ?? (async () => "0x6080"),
    getStorageAt: overrides.getStorageAt ?? (async () => "0x0"),
    getTokenMetadata: overrides.getTokenMetadata ?? (async () => ({ name: "Quote", symbol: "Q", decimals: 18, totalSupplyRaw: "1000000" })),
    getNativeBalance: overrides.getNativeBalance ?? (async () => 0n),
    getTokenBalance: overrides.getTokenBalance ?? (async () => 0n),
    getContractCreationInfo: overrides.getContractCreationInfo ?? (async () => null),
  } as any;
}

const fullMarketData: TokenMarketData = {
  chainId: CHAIN_ID,
  contractAddress: "0xeb1898a0d496000506a2799e1b4077776497fd29",
  observedAt: "t",
  priceUsd: 0.05,
  marketCapUsd: 100000,
  liquidityUsd: 20000,
  volumeUsd24h: 5000,
  pools: [],
  source: "dexscreener",
};

const tokenInfo: TokenContractInfo = {
  chainId: CHAIN_ID,
  contractAddress: "0xeb1898a0d496000506a2799e1b4077776497fd29",
  name: "Test Token",
  symbol: "TEST",
  decimals: 18,
};

test("builds a full market snapshot from DexScreener when it has data", async () => {
  const result = await gatherLiveIntelligence(scoutSignal(), {
    poolDataProvider: poolProvider(),
    geckoTerminalProvider: geckoProvider(),
    marketDataProvider: dexScreener({ status: "ok", data: fullMarketData, unavailable: [], errors: [] }),
    tokenAnalysisService: tokenAnalysis({ fast: { status: "ok", data: tokenInfo, unavailable: [], errors: [] } }),
    chainId: CHAIN_ID,
  });

  assert.equal(result.inputs.marketSnapshot?.priceUsd, 0.05);
  assert.equal(result.inputs.marketSnapshot?.liquidityUsd, 20000);
  assert.equal(result.currentPrice.priceUsd, 0.05);
  assert.equal(result.inputs.tokenContractInfo?.symbol, "TEST");
});

test("falls back to the on-chain-first current-price resolver when DexScreener has no price (e.g. a pre-graduation curve)", async () => {
  const candle: HistoricalCandle = { timestamp: "t", openUsd: 0.001, highUsd: 0.001, lowUsd: 0.001, closeUsd: 0.001, volumeUsd: 1 };
  const pool: PoolInfo = { chainId: CHAIN_ID, poolAddress: "0xpool", dexId: "uniswap-v3-onchain", tokenAddress: "0xeb1898a0d496000506a2799e1b4077776497fd29", quoteTokenAddress: "0x1234567890123456789012345678901234567890", source: "uniswap-v3-onchain" };
  const poolDataProvider: PoolDataProvider = {
    name: "fake-pool",
    async discoverPools() { return { status: "ok", data: [pool], unavailable: [], errors: [] }; },
    async getRecentSwaps() { return { status: "unavailable", data: null, unavailable: ["swaps"], errors: [] }; },
  };
  const geckoWithData: HistoricalPriceProvider = { name: "geckoterminal", async getCandles() { return { status: "ok", data: [candle], unavailable: [], errors: [] }; } };

  const result = await gatherLiveIntelligence(scoutSignal(), {
    poolDataProvider,
    geckoTerminalProvider: geckoWithData,
    marketDataProvider: dexScreener({ status: "unavailable", data: null, unavailable: ["price"], errors: [] }),
    tokenAnalysisService: tokenAnalysis({ fast: { status: "ok", data: tokenInfo, unavailable: [], errors: [] } }),
    chainId: CHAIN_ID,
    // Phase 7.2: venue resolution (Pons check + V3 discovery reuse) requires a chain client — in real
    // production this is always configured (scripts/liveScout.ts). The on-chain V3 attempt itself will
    // fail against these placeholder resolver/estimator objects and gracefully fall through to GeckoTerminal.
    onChain: { chainClient: fakeChainClient(), blockTimestampResolver: {} as any, blockTimeEstimator: {} as any },
  });

  assert.equal(result.inputs.marketSnapshot?.priceUsd, 0.001);
  assert.equal(result.currentPrice.venueType, "UNISWAP_V3_POOL");
});

// Phase 7.1 §10 — on-chain is preferred over DexScreener when BOTH resolve a price (more
// immediate/authoritative, no third-party indexing lag), but DexScreener's fuller snapshot
// (volume/marketCap) is still carried over since the on-chain tier doesn't compute those.
test("prefers the on-chain price over DexScreener's when both resolve, but keeps DexScreener's volume/marketCap", async () => {
  const candle: HistoricalCandle = { timestamp: "t", openUsd: 0.002, highUsd: 0.002, lowUsd: 0.002, closeUsd: 0.002, volumeUsd: 1 };
  const pool: PoolInfo = { chainId: CHAIN_ID, poolAddress: "0xpool", dexId: "uniswap-v3-onchain", tokenAddress: "0xeb1898a0d496000506a2799e1b4077776497fd29", quoteTokenAddress: "0x1234567890123456789012345678901234567890", source: "uniswap-v3-onchain" };
  const poolDataProvider: PoolDataProvider = {
    name: "fake-pool",
    async discoverPools() { return { status: "ok", data: [pool], unavailable: [], errors: [] }; },
    async getRecentSwaps() { return { status: "unavailable", data: null, unavailable: ["swaps"], errors: [] }; },
  };
  const geckoWithData: HistoricalPriceProvider = { name: "geckoterminal", async getCandles() { return { status: "ok", data: [candle], unavailable: [], errors: [] }; } };

  const result = await gatherLiveIntelligence(scoutSignal(), {
    poolDataProvider,
    geckoTerminalProvider: geckoWithData,
    marketDataProvider: dexScreener({ status: "ok", data: fullMarketData, unavailable: [], errors: [] }), // priceUsd: 0.05
    tokenAnalysisService: tokenAnalysis({ fast: { status: "ok", data: tokenInfo, unavailable: [], errors: [] } }),
    chainId: CHAIN_ID,
    onChain: { chainClient: fakeChainClient(), blockTimestampResolver: {} as any, blockTimeEstimator: {} as any },
  });

  assert.equal(result.currentPrice.priceUsd, 0.002); // on-chain wins over DexScreener's 0.05
  assert.equal(result.inputs.marketSnapshot?.volumeUsd24h, 5000); // carried over from DexScreener
  assert.equal(result.inputs.marketSnapshot?.marketCapUsd, 100000);
});

test("leaves marketSnapshot null (never fabricated) when no price is available from any source", async () => {
  const result = await gatherLiveIntelligence(scoutSignal(), {
    poolDataProvider: poolProvider(),
    geckoTerminalProvider: geckoProvider(),
    marketDataProvider: dexScreener({ status: "unavailable", data: null, unavailable: ["price"], errors: [] }),
    tokenAnalysisService: tokenAnalysis({ fast: { status: "ok", data: tokenInfo, unavailable: [], errors: [] } }),
    chainId: CHAIN_ID,
  });
  assert.equal(result.inputs.marketSnapshot, null);
  assert.equal(result.marketDataQuality, "UNAVAILABLE");
});

test("still returns a valid (if partial) SmartSelectionInputs when the signal has no contract address", async () => {
  const result = await gatherLiveIntelligence(scoutSignal({ contractAddress: undefined }), {
    poolDataProvider: poolProvider(),
    geckoTerminalProvider: geckoProvider(),
    marketDataProvider: dexScreener({ status: "unavailable", data: null, unavailable: ["price"], errors: [] }),
    tokenAnalysisService: tokenAnalysis(),
    chainId: CHAIN_ID,
  });
  assert.equal(result.inputs.marketSnapshot, null);
  assert.equal(result.inputs.tokenContractInfo, null);
  assert.equal(result.inputs.scoutSignal.id, "telegram:scoutrobinhood:1");
  // No contract address means nothing to fetch — no provider calls at all, not even attempted-and-skipped ones.
  assert.deepEqual(result.providerCalls, []);
});

test("derives walletAssociations from the message text even when all market/token providers fail", async () => {
  const result = await gatherLiveIntelligence(scoutSignal(), {
    poolDataProvider: poolProvider(),
    geckoTerminalProvider: geckoProvider(),
    marketDataProvider: dexScreener({ status: "unavailable", data: null, unavailable: ["price"], errors: [] }),
    tokenAnalysisService: tokenAnalysis(),
    chainId: CHAIN_ID,
  });
  assert.ok(Array.isArray(result.inputs.walletAssociations));
});

test("degrades gracefully when a provider throws, without crashing the whole gather", async () => {
  const throwingDex: MarketDataProvider = { name: "dexscreener", async getMarketData() { throw new Error("network exploded"); } };
  const result = await gatherLiveIntelligence(scoutSignal(), {
    poolDataProvider: poolProvider(),
    geckoTerminalProvider: geckoProvider(),
    marketDataProvider: throwingDex,
    tokenAnalysisService: tokenAnalysis({ fast: { status: "ok", data: tokenInfo, unavailable: [], errors: [] } }),
    chainId: CHAIN_ID,
  });
  assert.equal(result.inputs.marketSnapshot, null);
  assert.ok(result.providerCalls.some((c) => c.status === "ERROR"));
  assert.equal(result.inputs.tokenContractInfo?.symbol, "TEST"); // the other provider still succeeded independently
});

test("times out a slow provider rather than hanging the whole gather", async () => {
  const slowDex = dexScreener({ status: "ok", data: fullMarketData, unavailable: [], errors: [] }, 500);
  const result = await gatherLiveIntelligence(scoutSignal(), {
    poolDataProvider: poolProvider(),
    geckoTerminalProvider: geckoProvider(),
    marketDataProvider: slowDex,
    tokenAnalysisService: tokenAnalysis({ fast: { status: "ok", data: tokenInfo, unavailable: [], errors: [] } }),
    chainId: CHAIN_ID,
    timeoutMs: 20,
  });
  assert.equal(result.inputs.marketSnapshot, null);
  assert.ok(result.providerCalls.some((c) => c.status === "TIMEOUT"));
});

// ---------------------------------------------------------------------
// Phase 7.1 §4/§8/§9 — parallel fan-out and the fast/slow token-analysis split.
// ---------------------------------------------------------------------

test("price resolution and token analysis run concurrently, not sequentially — total latency is bounded by the slowest branch, not their sum", async () => {
  const DELAY_MS = 150;
  const slowDex = dexScreener({ status: "ok", data: fullMarketData, unavailable: [], errors: [] }, DELAY_MS);
  const startedAt = Date.now();
  await gatherLiveIntelligence(scoutSignal(), {
    poolDataProvider: poolProvider(),
    geckoTerminalProvider: geckoProvider(),
    marketDataProvider: slowDex,
    tokenAnalysisService: tokenAnalysis({ fast: { status: "ok", data: tokenInfo, unavailable: [], errors: [] }, fastDelayMs: DELAY_MS, slowDelayMs: DELAY_MS }),
    chainId: CHAIN_ID,
    timeoutMs: 5000,
  });
  const elapsed = Date.now() - startedAt;
  // Sequential would be >= 3*DELAY_MS (dex + fast + slow); concurrent should be close to 1*DELAY_MS.
  assert.ok(elapsed < DELAY_MS * 2, `expected concurrent fan-out (~${DELAY_MS}ms), took ${elapsed}ms — looks sequential`);
});

test("fast token metadata is returned even when slow token enrichment (deployment/holders) times out", async () => {
  const result = await gatherLiveIntelligence(scoutSignal(), {
    poolDataProvider: poolProvider(),
    geckoTerminalProvider: geckoProvider(),
    marketDataProvider: dexScreener({ status: "unavailable", data: null, unavailable: ["price"], errors: [] }),
    tokenAnalysisService: tokenAnalysis({
      fast: { status: "ok", data: tokenInfo, unavailable: [], errors: [] },
      slowDelayMs: 500,
    }),
    chainId: CHAIN_ID,
    timeoutMs: 30,
  });
  assert.equal(result.inputs.tokenContractInfo?.symbol, "TEST");
  assert.equal(result.inputs.tokenContractInfo?.deploymentBlock, undefined);
  assert.equal(result.inputs.tokenContractInfo?.holderCount, undefined);
  assert.ok(result.providerCalls.some((c) => c.provider === "token-analysis-service:slow" && c.status === "TIMEOUT"));
  assert.ok(result.providerCalls.some((c) => c.provider === "token-analysis-service:fast" && c.status === "OK"));
});

test("merges fast metadata and slow enrichment into a single TokenContractInfo when both succeed", async () => {
  const result = await gatherLiveIntelligence(scoutSignal(), {
    poolDataProvider: poolProvider(),
    geckoTerminalProvider: geckoProvider(),
    marketDataProvider: dexScreener({ status: "unavailable", data: null, unavailable: ["price"], errors: [] }),
    tokenAnalysisService: tokenAnalysis({
      fast: { status: "ok", data: tokenInfo, unavailable: [], errors: [] },
      slow: { deploymentBlock: 12345, deployerAddress: "0xdeployer0000000000000000000000000000001", holderCount: 42, topHolderConcentrationPct: 61.5 },
    }),
    chainId: CHAIN_ID,
  });
  assert.equal(result.inputs.tokenContractInfo?.symbol, "TEST");
  assert.equal(result.inputs.tokenContractInfo?.deploymentBlock, 12345);
  assert.equal(result.inputs.tokenContractInfo?.holderCount, 42);
  assert.equal(result.inputs.tokenContractInfo?.topHolderConcentrationPct, 61.5);
});

test("a throwing slow-token-enrichment tier degrades gracefully and does not affect fast metadata", async () => {
  const result = await gatherLiveIntelligence(scoutSignal(), {
    poolDataProvider: poolProvider(),
    geckoTerminalProvider: geckoProvider(),
    marketDataProvider: dexScreener({ status: "unavailable", data: null, unavailable: ["price"], errors: [] }),
    tokenAnalysisService: tokenAnalysis({ fast: { status: "ok", data: tokenInfo, unavailable: [], errors: [] }, slowThrows: true }),
    chainId: CHAIN_ID,
  });
  assert.equal(result.inputs.tokenContractInfo?.symbol, "TEST");
  assert.ok(result.providerCalls.some((c) => c.provider === "token-analysis-service:slow" && c.status === "ERROR"));
});

test("no contract info at all when both fast and slow token tiers are unavailable", async () => {
  const result = await gatherLiveIntelligence(scoutSignal(), {
    poolDataProvider: poolProvider(),
    geckoTerminalProvider: geckoProvider(),
    marketDataProvider: dexScreener({ status: "unavailable", data: null, unavailable: ["price"], errors: [] }),
    tokenAnalysisService: tokenAnalysis(),
    chainId: CHAIN_ID,
  });
  assert.equal(result.inputs.tokenContractInfo, null);
});

// ---------------------------------------------------------------------
// Phase 7.1 (this pass) — wiring the remaining feasible Phase 4 analyzers:
// contractFeatures, tokenAge, liquidityAnalysis, momentum, marketFlow, deployerAnalysis.
// ---------------------------------------------------------------------

test("wires contractFeatures from a single bytecode read when a chainClient is available", async () => {
  const result = await gatherLiveIntelligence(scoutSignal(), {
    poolDataProvider: poolProvider(),
    geckoTerminalProvider: geckoProvider(),
    marketDataProvider: dexScreener({ status: "unavailable", data: null, unavailable: ["price"], errors: [] }),
    tokenAnalysisService: tokenAnalysis(),
    chainId: CHAIN_ID,
    onChain: { chainClient: fakeChainClient(), blockTimestampResolver: {} as any, blockTimeEstimator: {} as any },
  });
  assert.ok(result.inputs.contractFeatures);
  assert.equal(result.inputs.contractFeatures?.mintFunctionDetected, "not_detected");
  assert.ok(result.providerCalls.some((c) => c.provider === "contract-feature-analyzer" && c.status === "OK"));
});

test("contractFeatures stays null (not fabricated) when no chainClient is configured", async () => {
  const result = await gatherLiveIntelligence(scoutSignal(), {
    poolDataProvider: poolProvider(),
    geckoTerminalProvider: geckoProvider(),
    marketDataProvider: dexScreener({ status: "unavailable", data: null, unavailable: ["price"], errors: [] }),
    tokenAnalysisService: tokenAnalysis(),
    chainId: CHAIN_ID,
  });
  assert.equal(result.inputs.contractFeatures, null);
});

test("wires tokenAge from the slow token tier's deployedAt once it resolves", async () => {
  const result = await gatherLiveIntelligence(scoutSignal(), {
    poolDataProvider: poolProvider(),
    geckoTerminalProvider: geckoProvider(),
    marketDataProvider: dexScreener({ status: "unavailable", data: null, unavailable: ["price"], errors: [] }),
    tokenAnalysisService: tokenAnalysis({ fast: { status: "ok", data: tokenInfo, unavailable: [], errors: [] }, slow: { deployedAt: new Date().toISOString() } }),
    chainId: CHAIN_ID,
  });
  assert.equal(result.inputs.tokenAge?.ageCategory, "BRAND_NEW");
});

test("tokenAge is honestly UNKNOWN (not fabricated) when deployment info never resolved", async () => {
  const result = await gatherLiveIntelligence(scoutSignal(), {
    poolDataProvider: poolProvider(),
    geckoTerminalProvider: geckoProvider(),
    marketDataProvider: dexScreener({ status: "unavailable", data: null, unavailable: ["price"], errors: [] }),
    tokenAnalysisService: tokenAnalysis({ fast: { status: "ok", data: tokenInfo, unavailable: [], errors: [] } }),
    chainId: CHAIN_ID,
  });
  assert.equal(result.inputs.tokenAge?.ageCategory, "UNKNOWN");
});

test("wires liquidityAnalysis as a first-known-reading (never a fabricated STABLE trend) from current price/pools", async () => {
  const result = await gatherLiveIntelligence(scoutSignal(), {
    poolDataProvider: poolProvider(),
    geckoTerminalProvider: geckoProvider(),
    marketDataProvider: dexScreener({ status: "ok", data: fullMarketData, unavailable: [], errors: [] }),
    tokenAnalysisService: tokenAnalysis({ fast: { status: "ok", data: tokenInfo, unavailable: [], errors: [] } }),
    chainId: CHAIN_ID,
  });
  assert.equal(result.inputs.liquidityAnalysis?.currentLiquidityUsd, 20000);
  assert.equal(result.inputs.liquidityAnalysis?.trend, "UNKNOWN"); // no prior snapshot — honest, not fabricated
});

test("wires momentum as insufficient-history (never a fabricated trend) from a single current-price observation", async () => {
  const result = await gatherLiveIntelligence(scoutSignal(), {
    poolDataProvider: poolProvider(),
    geckoTerminalProvider: geckoProvider(),
    marketDataProvider: dexScreener({ status: "ok", data: fullMarketData, unavailable: [], errors: [] }),
    tokenAnalysisService: tokenAnalysis({ fast: { status: "ok", data: tokenInfo, unavailable: [], errors: [] } }),
    chainId: CHAIN_ID,
  });
  assert.equal(result.inputs.momentum?.observationCount, 1);
  assert.equal(result.inputs.momentum?.changePct15m, null); // one observation can't show a 15m change
});

test("wires marketFlow from discovered pools + recent swaps + quote-token decimals", async () => {
  const pool: PoolInfo = { chainId: CHAIN_ID, poolAddress: "0xpool", dexId: "uniswap-v3-onchain", tokenAddress: "0xeb1898a0d496000506a2799e1b4077776497fd29", quoteTokenAddress: "0x1234567890123456789012345678901234567890", source: "uniswap-v3-onchain" };
  const swaps: SwapRecord[] = [
    { chainId: CHAIN_ID, poolAddress: "0xpool", transactionHash: "0x1", blockNumber: 1, tokenAmount: "1000000000000000000", quoteAmount: "1000000000000000000", side: "BUY", source: "uniswap-v3-onchain" },
    { chainId: CHAIN_ID, poolAddress: "0xpool", transactionHash: "0x2", blockNumber: 2, tokenAmount: "500000000000000000", quoteAmount: "500000000000000000", side: "SELL", source: "uniswap-v3-onchain" },
  ];
  const poolDataProvider: PoolDataProvider = {
    name: "fake-pool",
    async discoverPools() { return { status: "ok", data: [pool], unavailable: [], errors: [] }; },
    async getRecentSwaps() { return { status: "ok", data: swaps, unavailable: [], errors: [] }; },
  };
  const result = await gatherLiveIntelligence(scoutSignal({ contractAddress: "0xeb1898a0d496000506a2799e1b4077776497fd29" }), {
    poolDataProvider,
    geckoTerminalProvider: geckoProvider(),
    marketDataProvider: dexScreener({ status: "unavailable", data: null, unavailable: ["price"], errors: [] }),
    tokenAnalysisService: tokenAnalysis({ fast: { status: "ok", data: tokenInfo, unavailable: [], errors: [] } }),
    chainId: CHAIN_ID,
    onChain: { chainClient: fakeChainClient(), blockTimestampResolver: {} as any, blockTimeEstimator: {} as any },
  });
  assert.ok(result.inputs.marketFlow);
  assert.equal(result.inputs.marketFlow?.buyCount, 1);
  assert.equal(result.inputs.marketFlow?.sellCount, 1);
  assert.ok(result.providerCalls.some((c) => c.provider === "market-flow-analyzer" && c.status === "OK"));
});

test("marketFlow is honestly unavailable (not fabricated) when no pool can be discovered", async () => {
  const result = await gatherLiveIntelligence(scoutSignal(), {
    poolDataProvider: poolProvider(), // discovers zero pools
    geckoTerminalProvider: geckoProvider(),
    marketDataProvider: dexScreener({ status: "unavailable", data: null, unavailable: ["price"], errors: [] }),
    tokenAnalysisService: tokenAnalysis(),
    chainId: CHAIN_ID,
  });
  assert.equal(result.inputs.marketFlow, null);
});

test("wires deployerAnalysis once the slow tier resolves a deployerAddress", async () => {
  const deployerAddress = "0x111111111111111111111111111111111111111a";
  const result = await gatherLiveIntelligence(scoutSignal(), {
    poolDataProvider: poolProvider(),
    geckoTerminalProvider: geckoProvider(),
    marketDataProvider: dexScreener({ status: "unavailable", data: null, unavailable: ["price"], errors: [] }),
    tokenAnalysisService: tokenAnalysis({ fast: { status: "ok", data: tokenInfo, unavailable: [], errors: [] }, slow: { deployerAddress } }),
    chainId: CHAIN_ID,
    onChain: { chainClient: fakeChainClient(), blockTimestampResolver: {} as any, blockTimeEstimator: {} as any },
  });
  assert.equal(result.inputs.deployerAnalysis?.deployerAddress, deployerAddress);
  assert.notEqual(result.inputs.deployerAnalysis?.dataQuality, "UNAVAILABLE");
});

test("deployerAnalysis is UNAVAILABLE (not zero, no extra RPC calls) when deployerAddress never resolved", async () => {
  let nativeBalanceCalls = 0;
  const result = await gatherLiveIntelligence(scoutSignal(), {
    poolDataProvider: poolProvider(),
    geckoTerminalProvider: geckoProvider(),
    marketDataProvider: dexScreener({ status: "unavailable", data: null, unavailable: ["price"], errors: [] }),
    tokenAnalysisService: tokenAnalysis({ fast: { status: "ok", data: tokenInfo, unavailable: [], errors: [] } }), // no slow.deployerAddress
    chainId: CHAIN_ID,
    onChain: { chainClient: fakeChainClient({ getNativeBalance: async () => { nativeBalanceCalls += 1; return 0n; } }), blockTimestampResolver: {} as any, blockTimeEstimator: {} as any },
  });
  assert.equal(result.inputs.deployerAnalysis?.dataQuality, "UNAVAILABLE");
  assert.equal(nativeBalanceCalls, 0); // never guesses/fetches without a resolved deployer address
});
