import { test } from "node:test";
import assert from "node:assert/strict";
import { OnChainWalletActivityProvider } from "./onChainWalletActivityProvider.js";
import type { PoolDataProvider } from "../market-data/poolDataProvider.js";
import type { PoolInfo, SwapRecord } from "../types/domain.js";

// All-lowercase so viem's strict isAddress() doesn't reject these for
// failing EIP-55 checksum validation (mixed-case addresses must match the
// real checksum exactly; all-lowercase/all-uppercase skip that check).
const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_WALLET = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const pool: PoolInfo = {
  chainId: 4663,
  poolAddress: "0xpool1",
  dexId: "uniswap-v3-onchain",
  tokenAddress: "0xtoken",
  quoteTokenAddress: "0xweth",
  source: "uniswap-v3-onchain",
};

function fakePoolProvider(swapsByPool: Record<string, SwapRecord[] | "error">): PoolDataProvider {
  return {
    name: "fake-pool-provider",
    discoverPools: async () => ({ status: "ok", data: [], unavailable: [], errors: [] }),
    getRecentSwaps: async (p: PoolInfo) => {
      const entry = swapsByPool[p.poolAddress];
      if (entry === "error") {
        return { status: "error", data: null, unavailable: ["swaps"], errors: [{ message: "boom", provider: "fake" }] };
      }
      return { status: "ok", data: entry ?? [], unavailable: [], errors: [] };
    },
  };
}

function swap(overrides: Partial<SwapRecord> = {}): SwapRecord {
  return {
    chainId: 4663,
    poolAddress: "0xpool1",
    transactionHash: "0xtx",
    blockNumber: 1000,
    timestamp: "2026-09-05T00:00:00.000Z",
    trader: WALLET,
    tokenAmount: "-100",
    quoteAmount: "5",
    side: "BUY",
    source: "uniswap-v3-onchain",
    ...overrides,
  };
}

test("filters swaps to only the requested wallet, case-insensitively", async () => {
  const provider = new OnChainWalletActivityProvider({
    poolProvider: fakePoolProvider({
      "0xpool1": [swap({ trader: WALLET.toLowerCase() }), swap({ trader: OTHER_WALLET, transactionHash: "0xtx2" })],
    }),
  });

  const result = await provider.getWalletTrades(4663, WALLET, { pools: [pool] });
  assert.equal(result.status, "ok");
  assert.equal(result.data?.length, 1);
  assert.equal(result.data?.[0].transactionHash, "0xtx");
});

test("never fabricates USD/price values for on-chain-only trades", async () => {
  const provider = new OnChainWalletActivityProvider({
    poolProvider: fakePoolProvider({ "0xpool1": [swap()] }),
  });

  const result = await provider.getWalletTrades(4663, WALLET, { pools: [pool] });
  assert.equal(result.data?.[0].approxUsdValue, null);
  assert.equal(result.data?.[0].tokenPriceUsdAtTrade, null);
  assert.equal(result.data?.[0].liquidityUsdAtTrade, null);
});

test("preserves UNKNOWN direction from the underlying swap classification rather than guessing", async () => {
  const provider = new OnChainWalletActivityProvider({
    poolProvider: fakePoolProvider({ "0xpool1": [swap({ side: "UNKNOWN" })] }),
  });

  const result = await provider.getWalletTrades(4663, WALLET, { pools: [pool] });
  assert.equal(result.data?.[0].direction, "UNKNOWN");
});

test("returns 'unavailable' (not 'ok' with an empty array) when no pools are given", async () => {
  const provider = new OnChainWalletActivityProvider({ poolProvider: fakePoolProvider({}) });
  const result = await provider.getWalletTrades(4663, WALLET, { pools: [] });
  assert.equal(result.status, "unavailable");
  assert.equal(result.data, null);
});

test("returns 'partial' with the trades it could find when one of several pools fails", async () => {
  const pool2: PoolInfo = { ...pool, poolAddress: "0xpool2" };
  const provider = new OnChainWalletActivityProvider({
    poolProvider: fakePoolProvider({ "0xpool1": [swap()], "0xpool2": "error" }),
  });

  const result = await provider.getWalletTrades(4663, WALLET, { pools: [pool, pool2] });
  assert.equal(result.status, "partial");
  assert.equal(result.data?.length, 1);
  assert.equal(result.errors.length, 1);
});

test("returns 'error' with no fabricated trades when every pool fails", async () => {
  const provider = new OnChainWalletActivityProvider({
    poolProvider: fakePoolProvider({ "0xpool1": "error" }),
  });

  const result = await provider.getWalletTrades(4663, WALLET, { pools: [pool] });
  assert.equal(result.status, "error");
  assert.equal(result.data, null);
});

test("rejects an invalid wallet address without calling any pool provider", async () => {
  let called = false;
  const provider = new OnChainWalletActivityProvider({
    poolProvider: {
      name: "fake",
      discoverPools: async () => ({ status: "ok", data: [], unavailable: [], errors: [] }),
      getRecentSwaps: async () => {
        called = true;
        return { status: "ok", data: [], unavailable: [], errors: [] };
      },
    },
  });

  const result = await provider.getWalletTrades(4663, "not-an-address", { pools: [pool] });
  assert.equal(result.status, "error");
  assert.equal(called, false);
});

test("sorts trades chronologically by block number across multiple pools", async () => {
  const pool2: PoolInfo = { ...pool, poolAddress: "0xpool2" };
  const provider = new OnChainWalletActivityProvider({
    poolProvider: fakePoolProvider({
      "0xpool1": [swap({ blockNumber: 2000, transactionHash: "0xlater" })],
      "0xpool2": [swap({ blockNumber: 1000, transactionHash: "0xearlier" })],
    }),
  });

  const result = await provider.getWalletTrades(4663, WALLET, { pools: [pool, pool2] });
  assert.deepEqual(
    result.data?.map((t) => t.transactionHash),
    ["0xearlier", "0xlater"],
  );
});
