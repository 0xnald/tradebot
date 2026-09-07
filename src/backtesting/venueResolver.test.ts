import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveMarketVenue } from "./venueResolver.js";
import { clearTokenMetadataCache } from "../shared/tokenMetadataCache.js";

// Phase 7.1 §24 — tokenDecimals() now shares a process-global cache (see tokenMetadataCache.ts).
// Cleared here so a decimals value cached by an earlier test (in this file OR another file sharing
// the same test-runner process) can never leak into these deterministic tests.
clearTokenMetadataCache();
import { BlockTimestampResolver } from "../blockchain/blockTimestampResolver.js";
import { BlockTimeEstimator } from "../blockchain/blockTimeEstimator.js";
import type { PoolDataProvider } from "../market-data/poolDataProvider.js";
import type { PonsV2LaunchDataProvider, PonsV2LaunchInfo } from "../market-data/ponsV2Provider.js";
import type { HistoricalPriceProvider } from "./historicalPriceProvider.js";
import type { PoolInfo, ProviderResult } from "../types/domain.js";

const TOKEN = "0xeb1898a0d496000506a2799e1b4077776497fd29";
const CHAIN_ID = 4663;

function ponsProvider(info: PonsV2LaunchInfo | null): PonsV2LaunchDataProvider {
  return {
    name: "fake-pons",
    async getLaunchInfo(): Promise<ProviderResult<PonsV2LaunchInfo | null>> {
      if (!info) return { status: "unavailable", data: null, unavailable: ["ponsV2Launch"], errors: [] };
      return { status: "ok", data: info, unavailable: [], errors: [] };
    },
  };
}

function ponsInfo(overrides: Partial<PonsV2LaunchInfo> = {}): PonsV2LaunchInfo {
  return {
    token: TOKEN,
    curve: "0xcurve",
    deployer: "0xdeployer",
    pairToken: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    poolFee: 0,
    tickSpacing: 200,
    phase: "POOL_CREATED",
    graduationThreshold: "1000",
    priceIdentifier: "0x29a9f241f8299f80d4fc533fee32e97a10b4b5d39d52f6b6376e1b596ab2cad3",
    priceIdentifierKind: "V4_POOL_ID",
    graduationTimestamp: "2026-09-04T19:52:32.000Z",
    ...overrides,
  };
}

function emptyPoolProvider(pools: PoolInfo[] = []): PoolDataProvider {
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

function geckoAlwaysUnavailable(): HistoricalPriceProvider {
  return { name: "geckoterminal", async getCandles() { return { status: "unavailable", data: null, unavailable: ["candles"], errors: [] }; } };
}

function geckoAlwaysHasData(): HistoricalPriceProvider {
  return {
    name: "geckoterminal",
    async getCandles() {
      return { status: "ok", data: [{ timestamp: "t", openUsd: 1, highUsd: 1, lowUsd: 1, closeUsd: 1, volumeUsd: 0 }], unavailable: [], errors: [] };
    },
  };
}

const DECISION_BEFORE_GRADUATION = "2026-09-04T19:50:00.000Z"; // before ponsInfo's graduationTimestamp
const DECISION_AFTER_GRADUATION = "2026-09-04T19:54:09.000Z"; // after
const GRADUATION_EXACT = "2026-09-04T19:52:32.000Z";

test("a decision before graduation resolves to the pre-graduation curve, never the V4 pool", async () => {
  const resolution = await resolveMarketVenue(TOKEN, DECISION_BEFORE_GRADUATION, {
    poolDataProvider: emptyPoolProvider(),
    ponsV2Provider: ponsProvider(ponsInfo()),
    geckoTerminalProvider: geckoAlwaysUnavailable(),
    chainId: CHAIN_ID,
  });

  assert.equal(resolution.venueType, "PONS_V2_CURVE");
  assert.equal(resolution.identifier, "0xcurve");
  assert.equal(resolution.usedPreGraduationVenue, true);
});

test("a decision after graduation resolves to the V4 pool", async () => {
  const resolution = await resolveMarketVenue(TOKEN, DECISION_AFTER_GRADUATION, {
    poolDataProvider: emptyPoolProvider(),
    ponsV2Provider: ponsProvider(ponsInfo()),
    geckoTerminalProvider: geckoAlwaysUnavailable(),
    chainId: CHAIN_ID,
  });

  assert.equal(resolution.venueType, "PONS_V2_V4_POOL");
  assert.equal(resolution.identifier, ponsInfo().priceIdentifier);
  assert.equal(resolution.usedPreGraduationVenue, false);
});

test("exact graduation boundary (decision === graduationTimestamp) resolves to the V4 pool, per Scout timestamp >= graduation timestamp -> V4", async () => {
  const resolution = await resolveMarketVenue(TOKEN, GRADUATION_EXACT, {
    poolDataProvider: emptyPoolProvider(),
    ponsV2Provider: ponsProvider(ponsInfo()),
    geckoTerminalProvider: geckoAlwaysUnavailable(),
    chainId: CHAIN_ID,
  });
  assert.equal(resolution.venueType, "PONS_V2_V4_POOL");
  assert.equal(resolution.usedPreGraduationVenue, false);
});

test("a never-graduated (NOT_GRADUATED) launch always resolves to the curve, regardless of decision time", async () => {
  const resolution = await resolveMarketVenue(TOKEN, DECISION_AFTER_GRADUATION, {
    poolDataProvider: emptyPoolProvider(),
    ponsV2Provider: ponsProvider(ponsInfo({ phase: "NOT_GRADUATED", graduationTimestamp: null })),
    geckoTerminalProvider: geckoAlwaysUnavailable(),
    chainId: CHAIN_ID,
  });
  assert.equal(resolution.venueType, "PONS_V2_CURVE");
  assert.equal(resolution.usedPreGraduationVenue, null); // n/a — never graduated at all
});

test("a graduated launch whose real graduation timestamp could not be found fails closed (UNKNOWN), never guesses a venue", async () => {
  const resolution = await resolveMarketVenue(TOKEN, DECISION_AFTER_GRADUATION, {
    poolDataProvider: emptyPoolProvider(),
    ponsV2Provider: ponsProvider(ponsInfo({ graduationTimestamp: null })),
    geckoTerminalProvider: geckoAlwaysUnavailable(),
    chainId: CHAIN_ID,
  });
  assert.equal(resolution.venueType, "UNKNOWN");
  assert.equal(resolution.identifier, null);
  assert.ok(resolution.notes.some((n) => n.includes("CurveCompleted timestamp could not be found")));
});

test("falls back to Uniswap V3 discovery when the token is not a Pons V2 launch", async () => {
  const pool: PoolInfo = { chainId: CHAIN_ID, poolAddress: "0xv3pool", dexId: "uniswap-v3-onchain", tokenAddress: TOKEN, quoteTokenAddress: "0xquote", source: "uniswap-v3-onchain" };
  const resolution = await resolveMarketVenue(TOKEN, DECISION_AFTER_GRADUATION, {
    poolDataProvider: emptyPoolProvider([pool]),
    ponsV2Provider: ponsProvider(null),
    geckoTerminalProvider: geckoAlwaysHasData(),
    chainId: CHAIN_ID,
  });
  assert.equal(resolution.venueType, "UNISWAP_V3_POOL");
  assert.equal(resolution.identifier, "0xv3pool");
});

test("resolves to UNKNOWN when neither Pons nor Uniswap V3 has any record of the token", async () => {
  const resolution = await resolveMarketVenue(TOKEN, DECISION_AFTER_GRADUATION, {
    poolDataProvider: emptyPoolProvider([]),
    ponsV2Provider: ponsProvider(null),
    geckoTerminalProvider: geckoAlwaysUnavailable(),
    chainId: CHAIN_ID,
  });
  assert.equal(resolution.venueType, "UNKNOWN");
  assert.equal(resolution.identifier, null);
});

test("without ponsV2Provider at all, goes straight to Uniswap V3 discovery", async () => {
  const pool: PoolInfo = { chainId: CHAIN_ID, poolAddress: "0xv3pool", dexId: "uniswap-v3-onchain", tokenAddress: TOKEN, quoteTokenAddress: "0xquote", source: "uniswap-v3-onchain" };
  const resolution = await resolveMarketVenue(TOKEN, DECISION_AFTER_GRADUATION, {
    poolDataProvider: emptyPoolProvider([pool]),
    geckoTerminalProvider: geckoAlwaysHasData(),
    chainId: CHAIN_ID,
  });
  assert.equal(resolution.venueType, "UNISWAP_V3_POOL");
});

test("without an onChain reconstruction dependency, only the GeckoTerminal tier is used", async () => {
  const resolution = await resolveMarketVenue(TOKEN, DECISION_AFTER_GRADUATION, {
    poolDataProvider: emptyPoolProvider(),
    ponsV2Provider: ponsProvider(ponsInfo()),
    geckoTerminalProvider: geckoAlwaysHasData(),
    chainId: CHAIN_ID,
  });
  assert.equal(resolution.onChainTierAvailable, false);
  const result = await resolution.provider.getCandles(CHAIN_ID, resolution.identifier!, DECISION_AFTER_GRADUATION, "minute", 1, 1);
  assert.equal(result.status, "ok"); // gecko tier still works
});

test("with an onChain reconstruction dependency and resolvable decimals, an on-chain tier is built first", async () => {
  const fakeChainClient = {
    getTokenMetadata: async () => ({ name: "t", symbol: "T", decimals: 18, totalSupplyRaw: "0" }),
    getBlockNumber: async () => 1_000_000n,
    getBlockTimestamp: async () => "2026-09-04T20:00:00.000Z",
    getLogs: async () => [],
  } as any;

  const resolution = await resolveMarketVenue(TOKEN, DECISION_AFTER_GRADUATION, {
    poolDataProvider: emptyPoolProvider(),
    ponsV2Provider: ponsProvider(ponsInfo()),
    geckoTerminalProvider: geckoAlwaysHasData(),
    onChain: {
      chainClient: fakeChainClient,
      blockTimestampResolver: new BlockTimestampResolver(fakeChainClient),
      blockTimeEstimator: new BlockTimeEstimator(fakeChainClient),
    },
    chainId: CHAIN_ID,
  });

  assert.equal(resolution.onChainTierAvailable, true);
});
