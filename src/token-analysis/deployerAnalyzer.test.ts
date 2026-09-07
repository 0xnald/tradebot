import { test } from "node:test";
import assert from "node:assert/strict";
import { DeployerAnalyzer } from "./deployerAnalyzer.js";
import type { SwapRecord } from "../types/domain.js";

const TOKEN = "0xeb1898a0d496000506a2799e1b4077776497fd29";
const DEPLOYER = "0x3333333333333333333333333333333333333333";

function fakeChainClient(overrides: Partial<Record<string, (...args: any[]) => any>> = {}) {
  return {
    chainId: 4663,
    getNativeBalance: overrides.getNativeBalance ?? (async () => 1_000_000_000_000_000_000n),
    getTokenBalance: overrides.getTokenBalance ?? (async () => 500_000n),
  } as any;
}

function swap(overrides: Partial<SwapRecord> = {}): SwapRecord {
  return {
    chainId: 4663,
    poolAddress: "0xpool",
    transactionHash: "0xtx",
    blockNumber: 1,
    tokenAmount: "-1",
    quoteAmount: "1",
    side: "BUY",
    source: "test",
    ...overrides,
  };
}

test("reports UNAVAILABLE with an explanatory note when the deployer address is unknown", async () => {
  const analyzer = new DeployerAnalyzer({ chainClient: fakeChainClient() });
  const result = await analyzer.analyze(TOKEN, null, "1000000");
  assert.equal(result.dataQuality, "UNAVAILABLE");
  assert.equal(result.deployerAddress, null);
  assert.ok(result.notes.length > 0);
});

test("reports native and token balances, and computes percentage of supply", async () => {
  const analyzer = new DeployerAnalyzer({ chainClient: fakeChainClient() });
  const result = await analyzer.analyze(TOKEN, DEPLOYER, "1000000");
  assert.equal(result.dataQuality, "KNOWN");
  assert.equal(result.deployerNativeBalanceRaw, "1000000000000000000");
  assert.equal(result.deployerTokenBalanceRaw, "500000");
  assert.equal(result.deployerTokenBalancePctOfSupply, 50);
});

test("counts only swaps whose trader matches the deployer address, case-insensitively", async () => {
  const analyzer = new DeployerAnalyzer({ chainClient: fakeChainClient() });
  const swaps = [
    swap({ trader: DEPLOYER.toLowerCase() }),
    swap({ trader: "0x1111111111111111111111111111111111111111" }),
  ];
  const result = await analyzer.analyze(TOKEN, DEPLOYER, "1000000", swaps);
  assert.equal(result.observedDeployerSwapCount, 1);
});

test("always reports full history as unavailable with a documented reason, never fabricated", async () => {
  const analyzer = new DeployerAnalyzer({ chainClient: fakeChainClient() });
  const result = await analyzer.analyze(TOKEN, DEPLOYER, "1000000");
  assert.equal(result.deployerFullHistoryAvailable, false);
  assert.match(result.deployerFullHistoryUnavailableReason, /WALLET_DATA_SOURCES/);
});

test("returns 'PARTIAL' when only one of the two balance lookups succeeds", async () => {
  const analyzer = new DeployerAnalyzer({
    chainClient: fakeChainClient({
      getTokenBalance: async () => {
        throw new Error("rpc error");
      },
    }),
  });
  const result = await analyzer.analyze(TOKEN, DEPLOYER, "1000000");
  assert.equal(result.dataQuality, "PARTIAL");
  assert.equal(result.deployerTokenBalanceRaw, null);
  assert.ok(result.notes.some((n) => n.includes("token balance lookup failed")));
});
