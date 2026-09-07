import { test } from "node:test";
import assert from "node:assert/strict";
import { reconstructSignal } from "./signalReconstructor.js";
import type { PoolDataProvider } from "../market-data/poolDataProvider.js";
import type { PonsV2LaunchDataProvider, PonsV2LaunchInfo } from "../market-data/ponsV2Provider.js";
import type { HistoricalPriceProvider, HistoricalCandle } from "./historicalPriceProvider.js";
import type { PoolInfo, ProviderResult, ScoutSignal } from "../types/domain.js";

const CHAIN_ID = 4663;
const CONTRACT = "0xeb1898a0d496000506a2799e1b4077776497fd29";
const POOL = "0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca";

function scoutSignal(overrides: Partial<ScoutSignal> = {}): ScoutSignal {
  return {
    id: "telegram:scoutrobinhood:5114",
    source: "telegram:scoutrobinhood",
    sourceMessageId: "5114",
    receivedAt: "2026-09-04T19:54:10.000Z",
    postedAt: "2026-09-04T19:54:09+00:00",
    messageType: "EARLY_CALL",
    tokenSymbol: "THROBBIN",
    contractAddress: CONTRACT,
    ...overrides,
  } as ScoutSignal;
}

function poolInfo(address: string): PoolInfo {
  return {
    chainId: CHAIN_ID,
    poolAddress: address,
    dexId: "uniswap-v3-onchain",
    tokenAddress: CONTRACT,
    quoteTokenAddress: "0xquote",
    source: "uniswap-v3-onchain",
  };
}

function fakePoolProvider(pools: PoolInfo[]): PoolDataProvider {
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

function fakePonsProvider(infoByToken: Record<string, PonsV2LaunchInfo>): PonsV2LaunchDataProvider {
  return {
    name: "fake-pons-v2",
    async getLaunchInfo(tokenAddress: string): Promise<ProviderResult<PonsV2LaunchInfo | null>> {
      const info = infoByToken[tokenAddress.toLowerCase()];
      if (!info) return { status: "unavailable", data: null, unavailable: ["ponsV2Launch"], errors: [] };
      return { status: "ok", data: info, unavailable: [], errors: [] };
    },
  };
}

function ponsLaunchInfo(overrides: Partial<PonsV2LaunchInfo> = {}): PonsV2LaunchInfo {
  return {
    token: CONTRACT,
    curve: "0x5d9C26776C0c7d9D512f8891F04f0d61aa87f6DE",
    deployer: "0xdeployer",
    pairToken: "0xpair",
    poolFee: 0,
    tickSpacing: 200,
    phase: "POOL_CREATED",
    graduationThreshold: "8090000000",
    priceIdentifier: "0x29a9f241f8299f80d4fc533fee32e97a10b4b5d39d52f6b6376e1b596ab2cad3",
    priceIdentifierKind: "V4_POOL_ID",
    graduationTimestamp: "2026-09-04T19:52:32.000Z",
    ...overrides,
  };
}

function fakePriceProvider(candlesByPool: Record<string, HistoricalCandle[]>): HistoricalPriceProvider {
  return {
    name: "fake-price",
    async getCandles(_chainId, poolAddress): Promise<ProviderResult<HistoricalCandle[]>> {
      const candles = candlesByPool[poolAddress];
      if (!candles || candles.length === 0) return { status: "unavailable", data: null, unavailable: ["candles"], errors: [] };
      return { status: "ok", data: candles, unavailable: [], errors: [] };
    },
  };
}

const DECISION_TS = "2026-09-04T19:54:09+00:00";

test("reconstructs marketSnapshot.priceUsd from a real historical candle and admits it via LookaheadGuard", async () => {
  const candle: HistoricalCandle = { timestamp: "2026-09-04T19:54:00.000Z", openUsd: 0.05, highUsd: 0.05, lowUsd: 0.05, closeUsd: 0.05, volumeUsd: 10 };
  const deps = {
    poolDataProvider: fakePoolProvider([poolInfo(POOL)]),
    historicalPriceProvider: fakePriceProvider({ [POOL]: [candle] }),
    chainId: CHAIN_ID,
  };

  const result = await reconstructSignal(scoutSignal(), deps);

  assert.equal(result.poolAddress, POOL);
  assert.equal(result.smartSelectionInputs.marketSnapshot?.priceUsd, 0.05);
  assert.ok(result.backtestSignal.reconstructedFields.includes("marketSnapshot.priceUsd"));
  assert.equal(result.backtestSignal.lookaheadViolations.length, 0);
  assert.equal(result.backtestSignal.dataQuality, "PARTIAL");
});

test("marks every structurally-unreconstructable feature group as unavailable, never fabricated", async () => {
  const candle: HistoricalCandle = { timestamp: "2026-09-04T19:54:00.000Z", openUsd: 0.05, highUsd: 0.05, lowUsd: 0.05, closeUsd: 0.05, volumeUsd: 10 };
  const deps = {
    poolDataProvider: fakePoolProvider([poolInfo(POOL)]),
    historicalPriceProvider: fakePriceProvider({ [POOL]: [candle] }),
    chainId: CHAIN_ID,
  };

  const result = await reconstructSignal(scoutSignal(), deps);

  assert.equal(result.smartSelectionInputs.tokenContractInfo, null);
  assert.equal(result.smartSelectionInputs.contractFeatures, null);
  assert.equal(result.smartSelectionInputs.liquidityAnalysis, null);
  assert.equal(result.smartSelectionInputs.holderConcentration, null);
  assert.equal(result.smartSelectionInputs.walletQualityByAddress.size, 0);
  assert.equal(result.smartSelectionInputs.walletRelationships.length, 0);
  assert.ok(result.backtestSignal.unavailableFields.includes("holderConcentration"));
  assert.ok(result.backtestSignal.unavailableFields.includes("marketSnapshot.liquidityUsd"));
});

test("marks the signal fully UNAVAILABLE when no pool can be resolved — never invents a price", async () => {
  const deps = {
    poolDataProvider: fakePoolProvider([]),
    historicalPriceProvider: fakePriceProvider({}),
    chainId: CHAIN_ID,
  };

  const result = await reconstructSignal(scoutSignal(), deps);

  assert.equal(result.poolAddress, null);
  assert.equal(result.smartSelectionInputs.marketSnapshot?.priceUsd, null);
  assert.equal(result.backtestSignal.dataQuality, "UNAVAILABLE");
});

test("marks the signal UNAVAILABLE when a pool resolves but has no historical candle data at all", async () => {
  const deps = {
    poolDataProvider: fakePoolProvider([poolInfo(POOL)]),
    historicalPriceProvider: fakePriceProvider({}),
    chainId: CHAIN_ID,
  };

  const result = await reconstructSignal(scoutSignal(), deps);

  assert.equal(result.poolAddress, null); // probe found no data for the pool, so it's never treated as "resolved"
  assert.equal(result.smartSelectionInputs.marketSnapshot?.priceUsd, null);
});

test("tries the next candidate pool when the first has no historical data", async () => {
  const otherPool = "0x0000000000000000000000000000000000dead";
  const candle: HistoricalCandle = { timestamp: "2026-09-04T19:54:00.000Z", openUsd: 0.07, highUsd: 0.07, lowUsd: 0.07, closeUsd: 0.07, volumeUsd: 5 };
  const deps = {
    poolDataProvider: fakePoolProvider([poolInfo(otherPool), poolInfo(POOL)]),
    historicalPriceProvider: fakePriceProvider({ [POOL]: [candle] }), // only the second pool has data
    chainId: CHAIN_ID,
  };

  const result = await reconstructSignal(scoutSignal(), deps);
  assert.equal(result.poolAddress, POOL);
  assert.equal(result.smartSelectionInputs.marketSnapshot?.priceUsd, 0.07);
});

test("derives walletAssociations from the Scout message text itself — legitimate, not lookahead", async () => {
  const deps = {
    poolDataProvider: fakePoolProvider([]),
    historicalPriceProvider: fakePriceProvider({}),
    chainId: CHAIN_ID,
  };
  const result = await reconstructSignal(scoutSignal(), deps);
  assert.ok(Array.isArray(result.smartSelectionInputs.walletAssociations));
});

test("has no marketSnapshot at all when the signal carries no contract address", async () => {
  const deps = {
    poolDataProvider: fakePoolProvider([]),
    historicalPriceProvider: fakePriceProvider({}),
    chainId: CHAIN_ID,
  };
  const result = await reconstructSignal(scoutSignal({ contractAddress: undefined }), deps);
  assert.equal(result.smartSelectionInputs.marketSnapshot, null);
  assert.ok(result.backtestSignal.unavailableFields.includes("marketSnapshot"));
});

test("decisionTimestamp falls back to receivedAt when the message has no postedAt", async () => {
  const deps = {
    poolDataProvider: fakePoolProvider([]),
    historicalPriceProvider: fakePriceProvider({}),
    chainId: CHAIN_ID,
  };
  const result = await reconstructSignal(scoutSignal({ postedAt: undefined }), deps);
  assert.equal(result.backtestSignal.decisionTimestamp, "2026-09-04T19:54:10.000Z");
});

test("prefers a Pons V2 launch's price identifier over Uniswap V3 discovery when both are present", async () => {
  const V4_POOL_ID = "0x29a9f241f8299f80d4fc533fee32e97a10b4b5d39d52f6b6376e1b596ab2cad3";
  const candle: HistoricalCandle = { timestamp: "2026-09-04T19:54:00.000Z", openUsd: 0.09, highUsd: 0.09, lowUsd: 0.09, closeUsd: 0.09, volumeUsd: 10 };
  const deps = {
    poolDataProvider: fakePoolProvider([poolInfo(POOL)]), // a real, unrelated V3 pool also exists (e.g. CRC's case)
    ponsV2Provider: fakePonsProvider({ [CONTRACT.toLowerCase()]: ponsLaunchInfo({ priceIdentifier: V4_POOL_ID }) }),
    historicalPriceProvider: fakePriceProvider({ [V4_POOL_ID]: [candle], [POOL]: [{ ...candle, openUsd: 999 }] }),
    chainId: CHAIN_ID,
  };

  const result = await reconstructSignal(scoutSignal(), deps);

  assert.equal(result.poolAddress, V4_POOL_ID);
  assert.equal(result.smartSelectionInputs.marketSnapshot?.priceUsd, 0.09);
});

test("falls back to Uniswap V3 discovery when the token was never launched through Pons V2", async () => {
  const candle: HistoricalCandle = { timestamp: "2026-09-04T19:54:00.000Z", openUsd: 0.12, highUsd: 0.12, lowUsd: 0.12, closeUsd: 0.12, volumeUsd: 10 };
  const deps = {
    poolDataProvider: fakePoolProvider([poolInfo(POOL)]),
    ponsV2Provider: fakePonsProvider({}), // not a Pons launch
    historicalPriceProvider: fakePriceProvider({ [POOL]: [candle] }),
    chainId: CHAIN_ID,
  };

  const result = await reconstructSignal(scoutSignal(), deps);

  assert.equal(result.poolAddress, POOL);
  assert.equal(result.smartSelectionInputs.marketSnapshot?.priceUsd, 0.12);
});

test("stays UNAVAILABLE on the resolved Pons venue when it has no data — never silently switches to an unrelated V3 pool that happens to have data", async () => {
  // A real scenario (CRC1): a token can be BOTH a genuine Pons V2 launch AND separately
  // have an unrelated standalone V3 pool. Once Pons resolves the real venue, that's
  // authoritative — falling back to a different, unrelated pool would risk misattributing
  // price to the wrong market rather than honestly reporting this venue as unavailable.
  const V4_POOL_ID = "0x29a9f241f8299f80d4fc533fee32e97a10b4b5d39d52f6b6376e1b596ab2cad3";
  const candle: HistoricalCandle = { timestamp: "2026-09-04T19:54:00.000Z", openUsd: 0.5, highUsd: 0.5, lowUsd: 0.5, closeUsd: 0.5, volumeUsd: 10 };
  const deps = {
    poolDataProvider: fakePoolProvider([poolInfo(POOL)]),
    ponsV2Provider: fakePonsProvider({ [CONTRACT.toLowerCase()]: ponsLaunchInfo({ priceIdentifier: V4_POOL_ID }) }),
    historicalPriceProvider: fakePriceProvider({ [POOL]: [candle] }), // an unrelated V3 pool has data — but Pons's own venue does not
    chainId: CHAIN_ID,
  };

  const result = await reconstructSignal(scoutSignal(), deps);

  assert.equal(result.poolAddress, V4_POOL_ID); // stayed on the correct, resolved Pons venue
  assert.equal(result.smartSelectionInputs.marketSnapshot?.priceUsd, null); // honestly unavailable, not borrowed from an unrelated pool
  assert.equal(result.backtestSignal.marketResolution?.venueType, "PONS_V2_V4_POOL");
});

test("works with no ponsV2Provider supplied at all (optional dependency, backward compatible)", async () => {
  const candle: HistoricalCandle = { timestamp: "2026-09-04T19:54:00.000Z", openUsd: 0.3, highUsd: 0.3, lowUsd: 0.3, closeUsd: 0.3, volumeUsd: 10 };
  const deps = {
    poolDataProvider: fakePoolProvider([poolInfo(POOL)]),
    historicalPriceProvider: fakePriceProvider({ [POOL]: [candle] }),
    chainId: CHAIN_ID,
  };

  const result = await reconstructSignal(scoutSignal(), deps);
  assert.equal(result.poolAddress, POOL);
});

test("marketResolution records the classified failure reason and reconstruction method when a price IS found", async () => {
  const candle: HistoricalCandle = { timestamp: "2026-09-04T19:54:00.000Z", openUsd: 0.05, highUsd: 0.05, lowUsd: 0.05, closeUsd: 0.05, volumeUsd: 10 };
  const deps = {
    poolDataProvider: fakePoolProvider([poolInfo(POOL)]),
    historicalPriceProvider: fakePriceProvider({ [POOL]: [candle] }),
    chainId: CHAIN_ID,
  };
  const result = await reconstructSignal(scoutSignal(), deps);
  assert.equal(result.backtestSignal.marketResolution?.failureReason, null);
  assert.equal(result.backtestSignal.marketResolution?.reconstructionMethod, "GECKOTERMINAL");
  assert.equal(result.backtestSignal.marketResolution?.venueType, "UNISWAP_V3_POOL");
});

test("marketResolution classifies a fully-undiscovered market as MARKET_NOT_DISCOVERED", async () => {
  const deps = {
    poolDataProvider: fakePoolProvider([]),
    historicalPriceProvider: fakePriceProvider({}),
    chainId: CHAIN_ID,
  };
  const result = await reconstructSignal(scoutSignal(), deps);
  assert.equal(result.backtestSignal.marketResolution?.failureReason, "MARKET_NOT_DISCOVERED");
});

test("marketResolution classifies a signal with no contract address as NO_MARKET", async () => {
  const deps = {
    poolDataProvider: fakePoolProvider([]),
    historicalPriceProvider: fakePriceProvider({}),
    chainId: CHAIN_ID,
  };
  const result = await reconstructSignal(scoutSignal({ contractAddress: undefined }), deps);
  assert.equal(result.backtestSignal.marketResolution?.failureReason, "NO_MARKET");
});

test("marketResolution propagates graduation phase/timestamp/usedPreGraduationVenue for a Pons V2 signal", async () => {
  const V4_POOL_ID = "0x29a9f241f8299f80d4fc533fee32e97a10b4b5d39d52f6b6376e1b596ab2cad3";
  const candle: HistoricalCandle = { timestamp: "2026-09-04T19:54:00.000Z", openUsd: 0.05, highUsd: 0.05, lowUsd: 0.05, closeUsd: 0.05, volumeUsd: 10 };
  const deps = {
    poolDataProvider: fakePoolProvider([]),
    ponsV2Provider: fakePonsProvider({ [CONTRACT.toLowerCase()]: ponsLaunchInfo({ priceIdentifier: V4_POOL_ID }) }),
    historicalPriceProvider: fakePriceProvider({ [V4_POOL_ID]: [candle] }),
    chainId: CHAIN_ID,
  };
  const result = await reconstructSignal(scoutSignal(), deps);
  assert.equal(result.backtestSignal.marketResolution?.graduationPhase, "POOL_CREATED");
  assert.equal(result.backtestSignal.marketResolution?.graduationTimestamp, "2026-09-04T19:52:32.000Z");
  assert.equal(result.backtestSignal.marketResolution?.usedPreGraduationVenue, false);
});

test("marketResolution classifies a graduated launch with an unfindable graduation timestamp as MISSING_BLOCK_TIMESTAMP, not the generic MARKET_NOT_DISCOVERED", async () => {
  const deps = {
    poolDataProvider: fakePoolProvider([]),
    ponsV2Provider: fakePonsProvider({ [CONTRACT.toLowerCase()]: ponsLaunchInfo({ graduationTimestamp: null }) }),
    historicalPriceProvider: fakePriceProvider({}),
    chainId: CHAIN_ID,
  };
  const result = await reconstructSignal(scoutSignal(), deps);
  assert.equal(result.backtestSignal.marketResolution?.venueType, "UNKNOWN");
  assert.equal(result.backtestSignal.marketResolution?.failureReason, "MISSING_BLOCK_TIMESTAMP");
  assert.equal(result.backtestSignal.marketResolution?.graduationPhase, "POOL_CREATED");
});
