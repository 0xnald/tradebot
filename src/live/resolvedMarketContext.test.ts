import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveMarketContextOnce, estimateRecentBlockWindow } from "./resolvedMarketContext.js";
import { clearTokenMetadataCache } from "../shared/tokenMetadataCache.js";
import type { PonsV2LaunchDataProvider, PonsV2LaunchInfo } from "../market-data/ponsV2Provider.js";
import type { PoolDataProvider } from "../market-data/poolDataProvider.js";
import type { PoolInfo, ProviderResult } from "../types/domain.js";

clearTokenMetadataCache();

const CHAIN_ID = 4663;
const TOKEN = "0xeb1898a0d496000506a2799e1b4077776497fd29";
const NOW = new Date("2026-09-06T12:00:00.000Z");

function fakeChainClient(overrides: Partial<Record<string, (...args: any[]) => any>> = {}) {
  return {
    chainId: CHAIN_ID,
    getTokenMetadata: overrides.getTokenMetadata ?? (async () => ({ name: "T", symbol: "T", decimals: 18, totalSupplyRaw: "1" })),
    getBlockNumber: overrides.getBlockNumber ?? (async () => 5_000_000n),
  } as any;
}

function fakeBlockTimeEstimator(overrides: Partial<Record<string, (...args: any[]) => any>> = {}) {
  return { estimateBlockAt: overrides.estimateBlockAt ?? (async () => 4_990_000n) } as any;
}

function ponsLaunchInfo(overrides: Partial<PonsV2LaunchInfo> = {}): PonsV2LaunchInfo {
  return {
    token: TOKEN,
    curve: "0xcurve0000000000000000000000000000000001",
    deployer: "0xdeployer000000000000000000000000000001",
    pairToken: "0x1234567890123456789012345678901234567890",
    poolFee: 3000,
    tickSpacing: 60,
    phase: "NOT_GRADUATED",
    graduationThreshold: "1000000000000000000",
    priceIdentifier: "0xcurve0000000000000000000000000000000001",
    priceIdentifierKind: "CURVE",
    graduationTimestamp: null,
    ...overrides,
  };
}

function fakePonsProvider(result: ProviderResult<PonsV2LaunchInfo | null>): PonsV2LaunchDataProvider & { callCount: number } {
  let callCount = 0;
  return {
    name: "fake-pons",
    get callCount() {
      return callCount;
    },
    async getLaunchInfo() {
      callCount += 1;
      return result;
    },
  };
}

function fakePoolProvider(pools: PoolInfo[]): PoolDataProvider & { discoverCallCount: number } {
  let discoverCallCount = 0;
  return {
    name: "fake-pool",
    get discoverCallCount() {
      return discoverCallCount;
    },
    async discoverPools() {
      discoverCallCount += 1;
      return { status: "ok", data: pools, unavailable: [], errors: [] };
    },
    async getRecentSwaps() {
      return { status: "unavailable", data: null, unavailable: ["swaps"], errors: [] };
    },
  };
}

test("resolves a not-yet-graduated Pons launch to PONS_V2_CURVE", async () => {
  const ponsV2Provider = fakePonsProvider({ status: "ok", data: ponsLaunchInfo({ phase: "NOT_GRADUATED" }), unavailable: [], errors: [] });
  const context = await resolveMarketContextOnce(TOKEN, "2026-09-06T11:00:00.000Z", { chainClient: fakeChainClient(), blockTimeEstimator: fakeBlockTimeEstimator(), ponsV2Provider, poolDataProvider: fakePoolProvider([]), chainId: CHAIN_ID }, NOW);
  assert.equal(context.venueType, "PONS_V2_CURVE");
  assert.equal(context.identifier, "0xcurve0000000000000000000000000000000001");
  assert.equal(context.dataQuality, "KNOWN");
});

test("resolves a graduated (POOL_CREATED) Pons launch to PONS_V2_V4_POOL with the PoolId as identifier", async () => {
  const ponsV2Provider = fakePonsProvider({ status: "ok", data: ponsLaunchInfo({ phase: "POOL_CREATED", graduationTimestamp: "2026-09-06T10:00:00.000Z", priceIdentifier: "0xpoolid00000000000000000000000000000001", priceIdentifierKind: "V4_POOL_ID" }), unavailable: [], errors: [] });
  const context = await resolveMarketContextOnce(TOKEN, "2026-09-06T11:00:00.000Z", { chainClient: fakeChainClient(), blockTimeEstimator: fakeBlockTimeEstimator(), ponsV2Provider, poolDataProvider: fakePoolProvider([]), chainId: CHAIN_ID }, NOW);
  assert.equal(context.venueType, "PONS_V2_V4_POOL");
  assert.equal(context.identifier, "0xpoolid00000000000000000000000000000001");
  assert.equal(context.graduationTimestamp, "2026-09-06T10:00:00.000Z");
  assert.ok(context.poolManagerAddress);
});

test("falls through to Uniswap V3 discovery when the token is not a Pons launch", async () => {
  const ponsV2Provider = fakePonsProvider({ status: "unavailable", data: null, unavailable: ["pons"], errors: [] });
  const pool: PoolInfo = { chainId: CHAIN_ID, poolAddress: "0xpool0000000000000000000000000000000001", dexId: "uniswap-v3-onchain", tokenAddress: TOKEN, quoteTokenAddress: "0x1234567890123456789012345678901234567890", source: "uniswap-v3-onchain" };
  const context = await resolveMarketContextOnce(TOKEN, "2026-09-06T11:00:00.000Z", { chainClient: fakeChainClient(), blockTimeEstimator: fakeBlockTimeEstimator(), ponsV2Provider, poolDataProvider: fakePoolProvider([pool]), chainId: CHAIN_ID }, NOW);
  assert.equal(context.venueType, "UNISWAP_V3_POOL");
  assert.equal(context.identifier, "0xpool0000000000000000000000000000000001");
  assert.equal(context.v3Pools.length, 1);
});

test("resolves UNKNOWN (never guessed) when neither Pons nor a V3 pool is found", async () => {
  const ponsV2Provider = fakePonsProvider({ status: "unavailable", data: null, unavailable: ["pons"], errors: [] });
  const context = await resolveMarketContextOnce(TOKEN, "2026-09-06T11:00:00.000Z", { chainClient: fakeChainClient(), blockTimeEstimator: fakeBlockTimeEstimator(), ponsV2Provider, poolDataProvider: fakePoolProvider([]), chainId: CHAIN_ID }, NOW);
  assert.equal(context.venueType, "UNKNOWN");
  assert.equal(context.identifier, null);
  assert.equal(context.dataQuality, "UNAVAILABLE");
});

test("works without a ponsV2Provider at all — goes straight to V3 discovery", async () => {
  const pool: PoolInfo = { chainId: CHAIN_ID, poolAddress: "0xpool0000000000000000000000000000000002", dexId: "uniswap-v3-onchain", tokenAddress: TOKEN, quoteTokenAddress: "0x1234567890123456789012345678901234567890", source: "uniswap-v3-onchain" };
  const context = await resolveMarketContextOnce(TOKEN, "2026-09-06T11:00:00.000Z", { chainClient: fakeChainClient(), blockTimeEstimator: fakeBlockTimeEstimator(), poolDataProvider: fakePoolProvider([pool]), chainId: CHAIN_ID }, NOW);
  assert.equal(context.venueType, "UNISWAP_V3_POOL");
});

test("market resolution happens exactly once — the Pons provider is called a single time per resolveMarketContextOnce call", async () => {
  const ponsV2Provider = fakePonsProvider({ status: "ok", data: ponsLaunchInfo(), unavailable: [], errors: [] });
  await resolveMarketContextOnce(TOKEN, "2026-09-06T11:00:00.000Z", { chainClient: fakeChainClient(), blockTimeEstimator: fakeBlockTimeEstimator(), ponsV2Provider, poolDataProvider: fakePoolProvider([]), chainId: CHAIN_ID }, NOW);
  assert.equal(ponsV2Provider.callCount, 1);
});

test("does not call V3 discovery at all once a Pons launch is confirmed — no wasted rediscovery", async () => {
  const ponsV2Provider = fakePonsProvider({ status: "ok", data: ponsLaunchInfo(), unavailable: [], errors: [] });
  const poolDataProvider = fakePoolProvider([]);
  await resolveMarketContextOnce(TOKEN, "2026-09-06T11:00:00.000Z", { chainClient: fakeChainClient(), blockTimeEstimator: fakeBlockTimeEstimator(), ponsV2Provider, poolDataProvider, chainId: CHAIN_ID }, NOW);
  assert.equal(poolDataProvider.discoverCallCount, 0);
});

test("estimateRecentBlockWindow never goes negative for a very early anchor", async () => {
  const chainClient = fakeChainClient({ getBlockNumber: async () => 100n });
  const blockTimeEstimator = fakeBlockTimeEstimator({ estimateBlockAt: async () => 0n });
  const window = await estimateRecentBlockWindow(blockTimeEstimator, chainClient, "2020-01-01T00:00:00.000Z", 60, NOW);
  assert.equal(window.fromBlock, 0n);
});

// --- Phase 7.3B §C/§E regression coverage: `toBlock` must bound to the anchor, not the live tip ---

/** A timestamp-aware fake matching Robinhood Chain's measured ~9.91 blocks/sec (see docs/RPC_PERFORMANCE.md), anchored so `estimateBlockAt(currentTimestampMs) === currentBlock`. */
function linearBlockTimeEstimator(currentBlock: bigint, currentTimestampMs: number, blocksPerMs = 9.91 / 1000) {
  return {
    estimateBlockAt: async (targetMs: number) => {
      const deltaBlocks = BigInt(Math.round((currentTimestampMs - targetMs) * blocksPerMs));
      const estimated = currentBlock - deltaBlocks;
      return estimated < 0n ? 0n : estimated;
    },
  } as any;
}

test("estimateRecentBlockWindow: for a genuinely live signal (anchor essentially now), toBlock stays at the live tip", async () => {
  const currentBlock = 56_635_515n;
  const chainClient = fakeChainClient({ getBlockNumber: async () => currentBlock });
  const nowMs = NOW.getTime();
  const blockTimeEstimator = linearBlockTimeEstimator(currentBlock, nowMs);
  // Anchor is 2 seconds before "now" — a signal that just arrived, exactly the live scenario.
  const anchorIso = new Date(nowMs - 2_000).toISOString();
  const window = await estimateRecentBlockWindow(blockTimeEstimator, chainClient, anchorIso, 180, NOW);
  // A signal 2 seconds old estimates to ~20 blocks behind the live tip (2s * ~9.91 blocks/sec) —
  // effectively unaffected by the fix, unlike a multi-day-old replayed signal (next test).
  assert.ok(currentBlock - window.toBlock < 100n, `expected toBlock within ~100 blocks of the live tip, got a gap of ${currentBlock - window.toBlock}`);
  // ~180 minutes at ~9.91 blocks/sec is ~107,000 blocks — not millions.
  const spanBlocks = window.toBlock - window.fromBlock;
  assert.ok(spanBlocks > 100_000n && spanBlocks < 115_000n, `expected ~107k blocks for a 180-minute window, got ${spanBlocks}`);
});

test("estimateRecentBlockWindow: for a REPLAYED signal from days ago, toBlock bounds to the anchor's own time — NOT the live tip (Phase 7.3A's root cause)", async () => {
  const currentBlock = 56_635_515n;
  const nowMs = NOW.getTime();
  const chainClient = fakeChainClient({ getBlockNumber: async () => currentBlock });
  const blockTimeEstimator = linearBlockTimeEstimator(currentBlock, nowMs);
  // Anchor is 2.5 days before "now" — exactly what replaying a real captured Scout fixture looks like.
  const anchorIso = new Date(nowMs - 2.5 * 24 * 60 * 60 * 1000).toISOString();
  const window = await estimateRecentBlockWindow(blockTimeEstimator, chainClient, anchorIso, 180, NOW);

  assert.ok(window.toBlock < currentBlock, "toBlock must NOT be the live tip when the anchor is days old");
  const spanBlocks = window.toBlock - window.fromBlock;
  // The old, buggy behavior (toBlock = currentBlock unconditionally) produced a span in the millions here.
  assert.ok(spanBlocks < 200_000n, `expected a bounded ~107k-block span, got ${spanBlocks} (the pre-fix bug produced millions)`);
  assert.ok(spanBlocks > 90_000n, `window collapsed too far — expected roughly a 180-minute span, got ${spanBlocks}`);
});

test("estimateRecentBlockWindow: toBlock never exceeds the live tip even if the anchor estimate somehow overshoots it", async () => {
  const currentBlock = 5_000_000n;
  const chainClient = fakeChainClient({ getBlockNumber: async () => currentBlock });
  // A pathological estimator that always returns something past the tip.
  const blockTimeEstimator = { estimateBlockAt: async () => 5_500_000n } as any;
  const window = await estimateRecentBlockWindow(blockTimeEstimator, chainClient, NOW.toISOString(), 180, NOW);
  assert.equal(window.toBlock, currentBlock);
});
