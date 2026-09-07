import { test } from "node:test";
import assert from "node:assert/strict";
import { TokenAnalysisService } from "./tokenAnalysisService.js";
import { clearTokenMetadataCache } from "../shared/tokenMetadataCache.js";
import type { HolderDataProvider } from "./holderDataProvider.js";

// Phase 7.3 §7 — getFastTokenInfo now shares the process-global token metadata cache with
// resolveMarketContextOnce (see tokenMetadataCache.ts / venueResolver.test.ts's identical note).
// Cleared here so no test in this file (or another sharing the process) can leak a cached value in.
clearTokenMetadataCache();

const TOKEN = "0xeb1898a0d496000506a2799e1b4077776497fd29";
const DEPLOYER = "0x3333333333333333333333333333333333333333";

function fakeChainClient(overrides: Partial<Record<string, (...args: any[]) => any>> = {}) {
  return {
    chainId: 4663,
    getTokenMetadata:
      overrides.getTokenMetadata ??
      (async () => ({ name: "Throbbin", symbol: "THROBBIN", decimals: 18, totalSupplyRaw: "1000000" })),
    getContractCreationInfo:
      overrides.getContractCreationInfo ??
      (async () => ({
        deploymentBlock: 42,
        deploymentTimestamp: "2026-09-04T00:00:00.000Z",
        deployerAddress: DEPLOYER,
        creationTxHash: "0xabc",
      })),
  } as any;
}

function fakeHolderProvider(overrides: Partial<HolderDataProvider> = {}): HolderDataProvider {
  return {
    name: "fake-holder-provider",
    getHolderDistribution:
      overrides.getHolderDistribution ??
      (async () => ({
        status: "ok",
        data: {
          chainId: 4663,
          contractAddress: TOKEN,
          observedAt: new Date().toISOString(),
          totalHolders: 130,
          topHolders: [],
          topHolderConcentrationPct: 25.5,
          source: "fake",
        },
        unavailable: [],
        errors: [],
      })),
  };
}

test("combines chain metadata, deployment info, and holder data into a full result", async () => {
  clearTokenMetadataCache();
  const service = new TokenAnalysisService({
    chainClient: fakeChainClient(),
    holderProvider: fakeHolderProvider(),
  });

  const result = await service.getTokenIntelligence(TOKEN);
  assert.equal(result.status, "ok");
  assert.equal(result.data?.name, "Throbbin");
  assert.equal(result.data?.symbol, "THROBBIN");
  assert.equal(result.data?.deploymentBlock, 42);
  assert.equal(result.data?.deployerAddress, DEPLOYER);
  assert.equal(result.data?.holderCount, 130);
  assert.equal(result.data?.topHolderConcentrationPct, 25.5);
  assert.equal(result.errors.length, 0);
});

test("passes the on-chain deployer address through to the holder provider", async () => {
  let receivedDeployer: string | undefined;
  const service = new TokenAnalysisService({
    chainClient: fakeChainClient(),
    holderProvider: fakeHolderProvider({
      getHolderDistribution: async (_chainId, _address, options) => {
        receivedDeployer = options?.deployerAddress;
        return { status: "ok", data: null, unavailable: [], errors: [] };
      },
    }),
  });

  await service.getTokenIntelligence(TOKEN);
  assert.equal(receivedDeployer, DEPLOYER);
});

test("returns 'partial' and lists unavailable fields when the deployment lookup throws", async () => {
  clearTokenMetadataCache();
  const service = new TokenAnalysisService({
    chainClient: fakeChainClient({
      getContractCreationInfo: async () => {
        throw new Error("binary search failed: RPC timeout");
      },
    }),
    holderProvider: fakeHolderProvider(),
  });

  const result = await service.getTokenIntelligence(TOKEN);
  assert.equal(result.status, "partial");
  assert.equal(result.data?.deploymentBlock, undefined);
  assert.ok(result.unavailable.includes("deploymentBlock"));
  assert.ok(result.errors.some((e) => e.message.includes("RPC timeout")));
});

test("still returns chain data as 'partial' when the holder provider errors", async () => {
  clearTokenMetadataCache();
  const service = new TokenAnalysisService({
    chainClient: fakeChainClient(),
    holderProvider: fakeHolderProvider({
      getHolderDistribution: async () => ({
        status: "error",
        data: null,
        unavailable: ["totalHolders", "topHolders"],
        errors: [{ message: "blockscout unreachable", provider: "blockscout" }],
      }),
    }),
  });

  const result = await service.getTokenIntelligence(TOKEN);
  assert.equal(result.status, "partial");
  assert.equal(result.data?.name, "Throbbin"); // chain data still present
  assert.equal(result.data?.holderCount, undefined);
  assert.ok(result.unavailable.includes("holderCount"));
  assert.ok(result.errors.some((e) => e.message === "blockscout unreachable"));
});

test("rejects an invalid contract address without calling any provider", async () => {
  let called = false;
  const service = new TokenAnalysisService({
    chainClient: fakeChainClient({
      getTokenMetadata: async () => {
        called = true;
        return { name: null, symbol: null, decimals: null, totalSupplyRaw: null };
      },
    }),
    holderProvider: fakeHolderProvider(),
  });

  const result = await service.getTokenIntelligence("not-an-address");
  assert.equal(result.status, "error");
  assert.equal(called, false);
});

test("returns 'unavailable' when literally nothing could be retrieved", async () => {
  clearTokenMetadataCache();
  const service = new TokenAnalysisService({
    chainClient: fakeChainClient({
      getTokenMetadata: async () => ({ name: null, symbol: null, decimals: null, totalSupplyRaw: null }),
      getContractCreationInfo: async () => null,
    }),
    holderProvider: fakeHolderProvider({
      getHolderDistribution: async () => ({
        status: "error",
        data: null,
        unavailable: ["totalHolders", "topHolders"],
        errors: [{ message: "unreachable" }],
      }),
    }),
  });

  const result = await service.getTokenIntelligence(TOKEN);
  assert.equal(result.status, "unavailable");
  assert.equal(result.data, null);
});
