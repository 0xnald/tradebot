// Regression tests for a core architectural invariant: Scout is the ONLY
// legitimate strategy entry point. Market-intelligence providers (Pons,
// Uniswap V3/V4, GeckoTerminal) exist to answer "given a Scout token,
// where and how does it trade" — they must never become independent
// sources of trading candidates. See the "Scout-first" note in
// ARCHITECTURE.md.
//
// Structurally, this already holds by construction:
//   - SmartSelectionEngine.evaluate() only ever runs inside
//     backtestRunner's `for (const scoutSignal of eligibleSignals)` loop.
//   - SmartSelectionInputs.scoutSignal is a required (non-optional) field
//     — there is no code path that builds one without a ScoutSignal.
//   - Every market-data provider (PoolDataProvider.discoverPools,
//     PonsV2Provider.getLaunchInfo, HistoricalPriceProvider.getCandles)
//     takes a token/pool identifier as INPUT; none of them has an
//     "enumerate/discover new tokens" method that could originate a
//     candidate.
// These tests prove that structural fact behaviorally, so a future change
// that accidentally widens the entry point breaks a test, not just a
// design intention.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runBacktest, selectEligibleSignals } from "./backtestRunner.js";
import type { PoolDataProvider } from "../market-data/poolDataProvider.js";
import type { PonsV2LaunchDataProvider, PonsV2LaunchInfo } from "../market-data/ponsV2Provider.js";
import type { HistoricalPriceProvider, HistoricalCandle } from "./historicalPriceProvider.js";
import type { BacktestConfig, BacktestDataset, PoolInfo, ProviderResult, ScoutSignal } from "../types/domain.js";

const CHAIN_ID = 4663;

function scoutSignal(id: string, contractAddress: string): ScoutSignal {
  return {
    id: `telegram:scoutrobinhood:${id}`,
    source: "telegram:scoutrobinhood",
    sourceMessageId: id,
    receivedAt: "2026-09-04T20:00:01.000Z",
    postedAt: "2026-09-04T20:00:00.000Z",
    messageType: "EARLY_CALL",
    tokenSymbol: "SCOUTED",
    contractAddress,
    rawText: "test",
    parseConfidence: "high",
    parseWarnings: [],
  };
}

const BASE_CONFIG: BacktestConfig = {
  configVersion: "test-1",
  smartSelectionConfigVersion: "test",
  maxEntryDelayMinutes: 5,
  slippagePct: 1,
  feePct: 0.5,
  horizons: ["5m"],
  takeProfitPct: null,
  stopLossPct: null,
  treatWatchAsTrade: false,
  portfolio: { startingCapitalUsd: 1000, positionSizePct: 10, maxConcurrentPositions: 3, allowCompounding: false, assumedHoldingPeriodMinutes: 60 },
};

function dataset(ids: string[]): BacktestDataset {
  return { id: "boundary-test", createdAt: "2026-09-05T00:00:00.000Z", description: "test", signalIds: ids, source: "synthetic" };
}

/**
 * An "eager" market-intelligence layer that already knows about many real
 * tokens/pools that were never mentioned by Scout — simulating "Pons
 * discovery found a bunch of real launches" or "GeckoTerminal indexes
 * lots of real pools." Records every token address it is ever asked
 * about, so a test can assert it was NEVER queried about a non-Scout
 * token — proving the orchestrator never uses it to originate candidates.
 */
function eagerPoolProvider(knownTokens: Record<string, string>, queried: Set<string>): PoolDataProvider {
  return {
    name: "eager-fake",
    async discoverPools(contractAddress: string): Promise<ProviderResult<PoolInfo[]>> {
      queried.add(contractAddress.toLowerCase());
      const pool = knownTokens[contractAddress.toLowerCase()];
      if (!pool) return { status: "ok", data: [], unavailable: [], errors: [] };
      return {
        status: "ok",
        data: [{ chainId: CHAIN_ID, poolAddress: pool, dexId: "uniswap-v3-onchain", tokenAddress: contractAddress, quoteTokenAddress: "0xquote", source: "uniswap-v3-onchain" }],
        unavailable: [],
        errors: [],
      };
    },
    async getRecentSwaps() {
      return { status: "unavailable", data: null, unavailable: ["swaps"], errors: [] };
    },
  };
}

function eagerPonsProvider(knownTokens: Record<string, PonsV2LaunchInfo>, queried: Set<string>): PonsV2LaunchDataProvider {
  return {
    name: "eager-pons-fake",
    async getLaunchInfo(tokenAddress: string): Promise<ProviderResult<PonsV2LaunchInfo | null>> {
      queried.add(tokenAddress.toLowerCase());
      const info = knownTokens[tokenAddress.toLowerCase()];
      if (!info) return { status: "unavailable", data: null, unavailable: ["ponsV2Launch"], errors: [] };
      return { status: "ok", data: info, unavailable: [], errors: [] };
    },
  };
}

function eagerPriceProvider(candlesByPool: Record<string, HistoricalCandle[]>): HistoricalPriceProvider {
  return {
    name: "eager-price-fake",
    async getCandles(_chainId, poolAddress): Promise<ProviderResult<HistoricalCandle[]>> {
      const candles = candlesByPool[poolAddress];
      if (!candles) return { status: "unavailable", data: null, unavailable: ["candles"], errors: [] };
      return { status: "ok", data: candles, unavailable: [], errors: [] };
    },
  };
}

test("no Scout signal -> no Smart Selection candidate: an empty signal list produces zero decisions", async () => {
  const queried = new Set<string>();
  const run = await runBacktest(dataset([]), [], BASE_CONFIG, {
    poolDataProvider: eagerPoolProvider({}, queried),
    historicalPriceProvider: eagerPriceProvider({}),
    chainId: CHAIN_ID,
  });

  assert.equal(run.datasetSize, 0);
  for (const metrics of run.metricsByCohort) {
    assert.equal(metrics.totalSignals, 0);
  }
  assert.equal(queried.size, 0); // the market layer was never even asked about anything
});

test("a market-intelligence layer that knows about real tokens Scout never called does not inject them as candidates", async () => {
  const scoutedToken = "0x0000000000000000000000000000000000aaaa";
  const nonScoutTokenA = "0x0000000000000000000000000000000000bbbb"; // e.g. "Pons discovered this real launch"
  const nonScoutTokenB = "0x0000000000000000000000000000000000cccc"; // e.g. "GeckoTerminal indexes this real pool"

  const poolQueried = new Set<string>();
  const ponsQueried = new Set<string>();

  const knownPools: Record<string, string> = {
    [scoutedToken]: "0xpoolScouted",
    [nonScoutTokenA]: "0xpoolA",
    [nonScoutTokenB]: "0xpoolB",
  };

  const run = await runBacktest(
    dataset(["1"]),
    [scoutSignal("1", scoutedToken)], // Scout only ever mentioned ONE token
    BASE_CONFIG,
    {
      poolDataProvider: eagerPoolProvider(knownPools, poolQueried),
      ponsV2Provider: eagerPonsProvider({}, ponsQueried),
      historicalPriceProvider: eagerPriceProvider({}),
      chainId: CHAIN_ID,
    },
  );

  // exactly one signal entered the pipeline — the market layer's other "known" tokens never became candidates
  assert.equal(run.datasetSize, 1);
  for (const metrics of run.metricsByCohort) {
    assert.ok(metrics.totalSignals <= 1);
  }

  // the market layer was asked about the Scout token only — never about the tokens it separately "knows about"
  assert.ok(poolQueried.has(scoutedToken));
  assert.equal(poolQueried.has(nonScoutTokenA), false);
  assert.equal(poolQueried.has(nonScoutTokenB), false);
  assert.ok(ponsQueried.has(scoutedToken));
  assert.equal(ponsQueried.has(nonScoutTokenA), false);
  assert.equal(ponsQueried.has(nonScoutTokenB), false);
});

test("selectEligibleSignals never adds a signal that wasn't in the Scout input", () => {
  const signals = [scoutSignal("1", "0xaaaa")];
  const eligible = selectEligibleSignals(signals);
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].contractAddress, "0xaaaa");
  // no mechanism exists to append a signal from elsewhere — the function is a pure filter over its input
});
