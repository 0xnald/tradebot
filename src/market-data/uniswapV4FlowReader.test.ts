import { test } from "node:test";
import assert from "node:assert/strict";
import { UniswapV4FlowReader, type V4FlowContext } from "./uniswapV4FlowReader.js";

const CHAIN_ID = 4663;
const POOL_MANAGER = "0xmanager000000000000000000000000000000001";
const POOL_ID = "0xpoolid00000000000000000000000000000000000000000000000000000001";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const NON_STABLE_QUOTE = "0x1234567890123456789012345678901234567890";

function fakeChainClient(overrides: Partial<Record<string, (...args: any[]) => any>> = {}) {
  return { chainId: CHAIN_ID, getLogs: overrides.getLogs ?? (async () => []) } as any;
}

function fakeBlockTimestampResolver() {
  return { resolve: async (block: bigint) => new Date(1_700_000_000_000 + Number(block) * 1000).toISOString() } as any;
}

// sqrtPriceX96 for price = 1 (equal decimals): sqrt(1) * 2^96 = 2^96
const Q96 = 2n ** 96n;

function swapLog(overrides: Partial<{ blockNumber: bigint; amount0: bigint; amount1: bigint; sqrtPriceX96: bigint; sender: string }> = {}) {
  return {
    blockNumber: overrides.blockNumber ?? 100n,
    transactionHash: "0xtx1",
    args: {
      id: POOL_ID,
      sender: overrides.sender ?? "0xsender00000000000000000000000000000001",
      amount0: overrides.amount0 ?? -1000n,
      amount1: overrides.amount1 ?? 1000n,
      sqrtPriceX96: overrides.sqrtPriceX96 ?? Q96,
      liquidity: 1_000_000n,
      tick: 0,
    },
  };
}

function context(overrides: Partial<V4FlowContext> = {}): V4FlowContext {
  return { poolManagerAddress: POOL_MANAGER, poolId: POOL_ID, quoteTokenAddress: NON_STABLE_QUOTE, tokenIsCurrency0: true, tokenDecimals: 18, quoteDecimals: 18, ...overrides };
}

test("token as currency0: negative amount0 (token leaves the pool) classifies as BUY", async () => {
  const chainClient = fakeChainClient({ getLogs: async () => [swapLog({ amount0: -1000n, amount1: 1000n })] });
  const reader = new UniswapV4FlowReader({ chainClient, blockTimestampResolver: fakeBlockTimestampResolver() });
  const result = await reader.getRecentFlow(CHAIN_ID, context({ tokenIsCurrency0: true }), 0n, 1000n);
  assert.equal(result.swaps[0].side, "BUY");
  assert.equal(result.unknownDirectionCount, 0);
});

test("token as currency0: positive amount0 (token enters the pool) classifies as SELL", async () => {
  const chainClient = fakeChainClient({ getLogs: async () => [swapLog({ amount0: 1000n, amount1: -1000n })] });
  const reader = new UniswapV4FlowReader({ chainClient, blockTimestampResolver: fakeBlockTimestampResolver() });
  const result = await reader.getRecentFlow(CHAIN_ID, context({ tokenIsCurrency0: true }), 0n, 1000n);
  assert.equal(result.swaps[0].side, "SELL");
});

test("token as currency1: negative amount1 (token leaves the pool) classifies as BUY", async () => {
  const chainClient = fakeChainClient({ getLogs: async () => [swapLog({ amount0: 1000n, amount1: -1000n })] });
  const reader = new UniswapV4FlowReader({ chainClient, blockTimestampResolver: fakeBlockTimestampResolver() });
  const result = await reader.getRecentFlow(CHAIN_ID, context({ tokenIsCurrency0: false }), 0n, 1000n);
  assert.equal(result.swaps[0].side, "BUY");
});

test("token as currency1: positive amount1 (token enters the pool) classifies as SELL", async () => {
  const chainClient = fakeChainClient({ getLogs: async () => [swapLog({ amount0: -1000n, amount1: 1000n })] });
  const reader = new UniswapV4FlowReader({ chainClient, blockTimestampResolver: fakeBlockTimestampResolver() });
  const result = await reader.getRecentFlow(CHAIN_ID, context({ tokenIsCurrency0: false }), 0n, 1000n);
  assert.equal(result.swaps[0].side, "SELL");
});

test("a zero token-side amount classifies as UNKNOWN — never guessed", async () => {
  const chainClient = fakeChainClient({ getLogs: async () => [swapLog({ amount0: 0n, amount1: 0n })] });
  const reader = new UniswapV4FlowReader({ chainClient, blockTimestampResolver: fakeBlockTimestampResolver() });
  const result = await reader.getRecentFlow(CHAIN_ID, context({ tokenIsCurrency0: true }), 0n, 1000n);
  assert.equal(result.swaps[0].side, "UNKNOWN");
  assert.equal(result.unknownDirectionCount, 1);
  assert.ok(result.notes.some((n) => n.includes("UNKNOWN")));
});

test("a malformed Swap event (missing amount0/amount1) is excluded, never guessed", async () => {
  const malformed = { blockNumber: 100n, transactionHash: "0xbad", args: { id: POOL_ID, sender: "0xsender", sqrtPriceX96: Q96 } }; // amount0/amount1 missing
  const chainClient = fakeChainClient({ getLogs: async () => [malformed] });
  const reader = new UniswapV4FlowReader({ chainClient, blockTimestampResolver: fakeBlockTimestampResolver() });
  const result = await reader.getRecentFlow(CHAIN_ID, context(), 0n, 1000n);
  assert.equal(result.swaps.length, 0);
  assert.equal(result.dataQuality, "UNAVAILABLE");
});

test("computes current price from the latest swap's sqrtPriceX96, quote-denominated", async () => {
  const chainClient = fakeChainClient({ getLogs: async () => [swapLog({ blockNumber: 100n, sqrtPriceX96: Q96 })] });
  const reader = new UniswapV4FlowReader({ chainClient, blockTimestampResolver: fakeBlockTimestampResolver() });
  const result = await reader.getRecentFlow(CHAIN_ID, context({ quoteTokenAddress: NON_STABLE_QUOTE }), 0n, 1000n);
  assert.equal(result.latestPriceInQuote, 1); // equal decimals, sqrtPriceX96 = Q96 -> price 1
  assert.equal(result.latestPriceUsd, null); // non-stable quote — never fabricated
});

test("converts price to USD only for a recognized USD-stable quote token", async () => {
  const chainClient = fakeChainClient({ getLogs: async () => [swapLog({ sqrtPriceX96: Q96 })] });
  const reader = new UniswapV4FlowReader({ chainClient, blockTimestampResolver: fakeBlockTimestampResolver() });
  const result = await reader.getRecentFlow(CHAIN_ID, context({ quoteTokenAddress: USDG }), 0n, 1000n);
  assert.equal(result.latestPriceUsd, 1);
});

test("uses the latest (highest block) swap's price when multiple swaps exist", async () => {
  const chainClient = fakeChainClient({
    getLogs: async () => [swapLog({ blockNumber: 100n, sqrtPriceX96: Q96 }), swapLog({ blockNumber: 200n, sqrtPriceX96: Q96 * 2n })],
  });
  const reader = new UniswapV4FlowReader({ chainClient, blockTimestampResolver: fakeBlockTimestampResolver() });
  const result = await reader.getRecentFlow(CHAIN_ID, context(), 0n, 1000n);
  assert.equal(result.priceObservations.length, 2);
  assert.ok(result.latestPriceInQuote! > 1); // the later, higher-price swap won
});

test("filters Swap events to the specific PoolId requested", async () => {
  let capturedArgs: any = null;
  const chainClient = fakeChainClient({
    getLogs: async (params: any) => {
      capturedArgs = params.args;
      return [swapLog()];
    },
  });
  const reader = new UniswapV4FlowReader({ chainClient, blockTimestampResolver: fakeBlockTimestampResolver() });
  await reader.getRecentFlow(CHAIN_ID, context(), 0n, 1000n);
  assert.equal(capturedArgs.id, POOL_ID);
});

test("is honestly UNAVAILABLE when no Swap events exist for this PoolId in the window", async () => {
  const chainClient = fakeChainClient({ getLogs: async () => [] });
  const reader = new UniswapV4FlowReader({ chainClient, blockTimestampResolver: fakeBlockTimestampResolver() });
  const result = await reader.getRecentFlow(CHAIN_ID, context(), 0n, 1000n);
  assert.equal(result.dataQuality, "UNAVAILABLE");
  assert.equal(result.latestPriceInQuote, null);
});

test("degrades gracefully (no crash) when the underlying event fetch throws", async () => {
  const chainClient = fakeChainClient({
    getLogs: async () => {
      throw new Error("RPC too many results");
    },
  });
  const reader = new UniswapV4FlowReader({ chainClient, blockTimestampResolver: fakeBlockTimestampResolver() });
  const result = await reader.getRecentFlow(CHAIN_ID, context(), 0n, 1000n);
  assert.equal(result.dataQuality, "UNAVAILABLE");
  assert.equal(result.flowCompleteness, "FAILED");
  assert.ok(result.notes.some((n) => n.includes("did not complete")));
});

// --- Phase 7.4 §11/§31: hybrid RPC routing for the V4 Swap event fetch ---

const CAPPED_AT_10 = { maxGetLogsBlockRange: 10, supportsLargeGetLogs: false };

test("getRecentFlow: a small range stays on the primary client", async () => {
  let logClientCalled = false;
  const chainClient = fakeChainClient({ getLogs: async () => [swapLog({ blockNumber: 100n })] });
  const logChainClient = fakeChainClient({
    getLogs: async () => {
      logClientCalled = true;
      throw new Error("log client should not have been used for a small range");
    },
  });
  const reader = new UniswapV4FlowReader({ chainClient, logChainClient, primaryCapabilities: CAPPED_AT_10, blockTimestampResolver: fakeBlockTimestampResolver() });
  const result = await reader.getRecentFlow(CHAIN_ID, context(), 0n, 9n);
  assert.equal(result.dataQuality, "KNOWN");
  assert.equal(result.providerRole, "PRIMARY");
  assert.equal(logClientCalled, false);
});

test("getRecentFlow: a large range (the real Phase 7.3B corrected THROBBIN V4 window) routes to the log client — primary never attempted", async () => {
  let primaryCalled = false;
  const chainClient = fakeChainClient({
    getLogs: async () => {
      primaryCalled = true;
      throw new Error("primary should not have been attempted");
    },
  });
  const logChainClient = fakeChainClient({ getLogs: async () => [swapLog({ blockNumber: 54_525_700n })] });
  const reader = new UniswapV4FlowReader({ chainClient, logChainClient, primaryCapabilities: CAPPED_AT_10, blockTimestampResolver: fakeBlockTimestampResolver() });
  const result = await reader.getRecentFlow(CHAIN_ID, context(), 54_525_667n, 54_528_641n);
  assert.equal(result.dataQuality, "KNOWN");
  assert.equal(result.providerRole, "LOG");
  assert.equal(primaryCalled, false);
});

test("getRecentFlow: preserves currency0/currency1 direction classification identically regardless of provider role", async () => {
  const sameFetch = async () => [swapLog({ blockNumber: 100n, amount0: -1000n, amount1: 1000n })]; // token (currency0) leaves pool => BUY
  const viaPrimary = new UniswapV4FlowReader({ chainClient: fakeChainClient({ getLogs: sameFetch }), primaryCapabilities: CAPPED_AT_10, blockTimestampResolver: fakeBlockTimestampResolver() });
  const viaLog = new UniswapV4FlowReader({
    chainClient: fakeChainClient({ getLogs: async () => { throw new Error("must not be called"); } }),
    logChainClient: fakeChainClient({ getLogs: sameFetch }),
    primaryCapabilities: CAPPED_AT_10,
    blockTimestampResolver: fakeBlockTimestampResolver(),
  });

  const small = await viaPrimary.getRecentFlow(CHAIN_ID, context({ tokenIsCurrency0: true }), 0n, 9n);
  const large = await viaLog.getRecentFlow(CHAIN_ID, context({ tokenIsCurrency0: true }), 0n, 1000n);

  assert.equal(small.providerRole, "PRIMARY");
  assert.equal(large.providerRole, "LOG");
  assert.equal(small.swaps[0].side, "BUY");
  assert.equal(large.swaps[0].side, "BUY");
  assert.deepEqual(small.swaps, large.swaps);
});

test("real BUY/SELL observations feed the existing, unmodified MarketFlowAnalyzer", async () => {
  const chainClient = fakeChainClient({
    getLogs: async () => [swapLog({ blockNumber: 100n, amount0: -1000n, amount1: 1000n }), swapLog({ blockNumber: 101n, amount0: 500n, amount1: -500n })],
  });
  const reader = new UniswapV4FlowReader({ chainClient, blockTimestampResolver: fakeBlockTimestampResolver() });
  const result = await reader.getRecentFlow(CHAIN_ID, context({ tokenIsCurrency0: true }), 0n, 1000n, new Date("2026-09-06T12:00:00.000Z"));
  assert.equal(result.marketFlow?.buyCount, 1);
  assert.equal(result.marketFlow?.sellCount, 1);
  const timestamps = new Set(result.priceObservations.map((o) => o.timestamp));
  assert.equal(timestamps.size, 2); // real, distinct per-trade timestamps — not all "now"
});
