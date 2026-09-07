import { test } from "node:test";
import assert from "node:assert/strict";
import { PoolQualityAnalyzer } from "./poolQualityAnalyzer.js";
import type { PoolInfo, SwapRecord } from "../types/domain.js";

const CHAIN_ID = 4663;

function pool(overrides: Partial<PoolInfo> = {}): PoolInfo {
  return {
    chainId: CHAIN_ID,
    poolAddress: "0xpoolA",
    dexId: "uniswap-v3-onchain",
    tokenAddress: "0xtoken",
    quoteTokenAddress: "0xweth",
    source: "test",
    ...overrides,
  };
}

function swap(side: SwapRecord["side"]): SwapRecord {
  return {
    chainId: CHAIN_ID,
    poolAddress: "0xpoolA",
    transactionHash: "0xtx",
    blockNumber: 1,
    tokenAmount: "-1",
    quoteAmount: "1",
    side,
    source: "test",
  };
}

function fakeChainClient(overrides: Partial<Record<string, (...args: any[]) => any>> = {}) {
  return {
    chainId: CHAIN_ID,
    getContractCreationInfo:
      overrides.getContractCreationInfo ??
      (async () => ({
        deploymentBlock: 1,
        deploymentTimestamp: new Date(Date.now() - 3600_000).toISOString(),
        deployerAddress: "0xdeployer",
        creationTxHash: "0xtx",
      })),
  } as any;
}

test("computes pool age from the deployment timestamp via the reused chain-client lookup", async () => {
  const analyzer = new PoolQualityAnalyzer({ chainClient: fakeChainClient() });
  const result = await analyzer.assessPool(pool());
  assert.ok(result.poolAgeSeconds !== null && result.poolAgeSeconds >= 3599);
});

test("reports pool age as null (not zero) when the deployment lookup fails", async () => {
  const analyzer = new PoolQualityAnalyzer({
    chainClient: fakeChainClient({
      getContractCreationInfo: async () => {
        throw new Error("rpc error");
      },
    }),
  });
  const result = await analyzer.assessPool(pool());
  assert.equal(result.poolAgeSeconds, null);
});

test("counts recent buys/sells only when swap data is actually supplied", async () => {
  const analyzer = new PoolQualityAnalyzer({ chainClient: fakeChainClient() });
  const withSwaps = await analyzer.assessPool(pool(), [swap("BUY"), swap("BUY"), swap("SELL")]);
  assert.equal(withSwaps.recentBuyCount, 2);
  assert.equal(withSwaps.recentSellCount, 1);
  assert.equal(withSwaps.recentSwapCount, 3);

  const withoutSwaps = await analyzer.assessPool(pool());
  assert.equal(withoutSwaps.recentSwapCount, null);
});

test("assessAllPools returns every pool, never silently narrowing to 'the best' one", async () => {
  const analyzer = new PoolQualityAnalyzer({ chainClient: fakeChainClient() });
  const pools = [pool({ poolAddress: "0xa" }), pool({ poolAddress: "0xb" }), pool({ poolAddress: "0xc" })];
  const results = await analyzer.assessAllPools(pools);
  assert.equal(results.length, 3);
  assert.deepEqual(results.map((r) => r.pool.poolAddress), ["0xa", "0xb", "0xc"]);
});
