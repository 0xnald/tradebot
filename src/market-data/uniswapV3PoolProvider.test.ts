import { test } from "node:test";
import assert from "node:assert/strict";
import { UniswapV3PoolProvider } from "./uniswapV3PoolProvider.js";
import type { PoolInfo } from "../types/domain.js";

const TOKEN = "0xeb1898a0d496000506a2799e1b4077776497fd29";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const POOL = "0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca";
const ZERO = "0x0000000000000000000000000000000000000000";

const QUOTE_TOKENS = [
  { address: WETH, symbol: "WETH" },
  { address: USDG, symbol: "USDG" },
];

function fakeChainClient(overrides: Partial<Record<string, (...args: any[]) => any>> = {}) {
  return {
    chainId: 4663,
    readContract: overrides.readContract ?? (async () => ZERO),
    getBlockNumber: overrides.getBlockNumber ?? (async () => 1000n),
    getLogs: overrides.getLogs ?? (async () => []),
    getTransaction: overrides.getTransaction ?? (async () => ({ from: "0xdeployer" })),
    getBlockTimestamp: overrides.getBlockTimestamp ?? (async () => "2026-09-05T00:00:00.000Z"),
  } as any;
}

test("discoverPools finds a pool only for fee tiers where the factory returns a non-zero address", async () => {
  const provider = new UniswapV3PoolProvider({
    chainClient: fakeChainClient({
      readContract: async ({ args }: any) => (args[2] === 500 ? POOL : ZERO),
    }),
    quoteTokens: QUOTE_TOKENS,
    feeTiers: [500, 3000],
  });

  const result = await provider.discoverPools(TOKEN);
  assert.equal(result.status, "ok");
  assert.equal(result.data?.length, 2); // one 500-fee pool per quote token (WETH, USDG)
  assert.ok(result.data?.every((p) => p.feeTier === 500 && p.poolAddress === POOL));
});

test("discoverPools returns an empty (not error) result when no pools exist", async () => {
  const provider = new UniswapV3PoolProvider({
    chainClient: fakeChainClient(),
    quoteTokens: QUOTE_TOKENS,
    feeTiers: [500],
  });

  const result = await provider.discoverPools(TOKEN);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.data, []);
});

test("discoverPools returns status 'error' with no fabricated pools when every factory call fails", async () => {
  const provider = new UniswapV3PoolProvider({
    chainClient: fakeChainClient({
      readContract: async () => {
        throw new Error("RPC unreachable");
      },
    }),
    quoteTokens: QUOTE_TOKENS,
    feeTiers: [500],
  });

  const result = await provider.discoverPools(TOKEN);
  assert.equal(result.status, "error");
  assert.equal(result.data, null);
  assert.ok(result.errors.length > 0);
});

test("discoverPools rejects an invalid address without throwing", async () => {
  const provider = new UniswapV3PoolProvider({ chainClient: fakeChainClient() });
  const result = await provider.discoverPools("not-an-address");
  assert.equal(result.status, "error");
  assert.match(result.errors[0].message, /invalid contract address/);
});

const pool: PoolInfo = {
  chainId: 4663,
  poolAddress: POOL,
  dexId: "uniswap-v3-onchain",
  tokenAddress: TOKEN,
  quoteTokenAddress: WETH,
  quoteTokenSymbol: "WETH",
  feeTier: 500,
  source: "uniswap-v3-onchain",
};

test("getRecentSwaps classifies BUY when the pool pays out the token of interest (negative delta)", async () => {
  const provider = new UniswapV3PoolProvider({
    chainClient: fakeChainClient({
      readContract: async ({ functionName }: any) => {
        if (functionName === "token0") return TOKEN;
        if (functionName === "token1") return WETH;
        throw new Error("unexpected call");
      },
      getLogs: async () => [
        {
          transactionHash: "0xtx1",
          blockNumber: 999n,
          args: { amount0: -100n, amount1: 5n, recipient: "0xtrader" },
        },
      ],
      getTransaction: async () => ({ from: "0xtrader-eoa" }),
    }),
  });

  const result = await provider.getRecentSwaps(pool);
  assert.equal(result.status, "ok");
  assert.equal(result.data?.length, 1);
  assert.equal(result.data?.[0].side, "BUY");
  assert.equal(result.data?.[0].tokenAmount, "-100");
  assert.equal(result.data?.[0].trader, "0xtrader-eoa");
  assert.equal(result.data?.[0].timestamp, "2026-09-05T00:00:00.000Z");
});

test("getRecentSwaps classifies SELL when the pool receives the token of interest (positive delta)", async () => {
  const provider = new UniswapV3PoolProvider({
    chainClient: fakeChainClient({
      readContract: async ({ functionName }: any) => {
        if (functionName === "token0") return TOKEN;
        if (functionName === "token1") return WETH;
        throw new Error("unexpected call");
      },
      getLogs: async () => [
        { transactionHash: "0xtx2", blockNumber: 1000n, args: { amount0: 250n, amount1: -3n, recipient: "0xtrader" } },
      ],
    }),
  });

  const result = await provider.getRecentSwaps(pool);
  assert.equal(result.data?.[0].side, "SELL");
});

test("getRecentSwaps falls back to the event recipient if the transaction lookup fails", async () => {
  const provider = new UniswapV3PoolProvider({
    chainClient: fakeChainClient({
      readContract: async ({ functionName }: any) => (functionName === "token0" ? TOKEN : WETH),
      getLogs: async () => [
        { transactionHash: "0xtx3", blockNumber: 1001n, args: { amount0: -1n, amount1: 1n, recipient: "0xfallback" } },
      ],
      getTransaction: async () => {
        throw new Error("tx not found");
      },
    }),
  });

  const result = await provider.getRecentSwaps(pool);
  assert.equal(result.data?.[0].trader, "0xfallback");
});

test("getRecentSwaps returns a structured error rather than throwing when getLogs fails", async () => {
  const provider = new UniswapV3PoolProvider({
    chainClient: fakeChainClient({
      readContract: async ({ functionName }: any) => (functionName === "token0" ? TOKEN : WETH),
      getLogs: async () => {
        throw new Error("log range too large");
      },
    }),
  });

  const result = await provider.getRecentSwaps(pool);
  assert.equal(result.status, "error");
  assert.equal(result.data, null);
  assert.match(result.errors[0].message, /log range too large/);
});
