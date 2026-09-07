import { test } from "node:test";
import assert from "node:assert/strict";
import { runBacktest, selectEligibleSignals, type BacktestRunnerDeps } from "./backtestRunner.js";
import type { PoolDataProvider } from "../market-data/poolDataProvider.js";
import type { HistoricalPriceProvider, HistoricalCandle } from "./historicalPriceProvider.js";
import type { BacktestConfig, BacktestDataset, PoolInfo, ProviderResult, ScoutSignal } from "../types/domain.js";

const CHAIN_ID = 4663;

function scoutSignal(id: string, overrides: Partial<ScoutSignal> = {}): ScoutSignal {
  return {
    id: `telegram:scoutrobinhood:${id}`,
    source: "telegram:scoutrobinhood",
    sourceMessageId: id,
    receivedAt: "2026-09-04T20:00:01.000Z",
    postedAt: "2026-09-04T20:00:00.000Z",
    messageType: "EARLY_CALL",
    tokenSymbol: "TEST",
    contractAddress: `0x${id.padStart(40, "0")}`,
    rawText: "test",
    parseConfidence: "high",
    parseWarnings: [],
    ...overrides,
  };
}

function poolInfo(tokenAddress: string, poolAddress: string): PoolInfo {
  return { chainId: CHAIN_ID, poolAddress, dexId: "uniswap-v3-onchain", tokenAddress, quoteTokenAddress: "0xquote", source: "uniswap-v3-onchain" };
}

function candle(isoTimestamp: string, priceUsd: number): HistoricalCandle {
  return { timestamp: isoTimestamp, openUsd: priceUsd, highUsd: priceUsd * 1.05, lowUsd: priceUsd * 0.95, closeUsd: priceUsd, volumeUsd: 100 };
}

function makeDeps(poolsByToken: Record<string, string>, candlesByPool: Record<string, HistoricalCandle[]>): BacktestRunnerDeps {
  const poolDataProvider: PoolDataProvider = {
    name: "fake-pool",
    async discoverPools(contractAddress): Promise<ProviderResult<PoolInfo[]>> {
      const pool = poolsByToken[contractAddress.toLowerCase()];
      return { status: "ok", data: pool ? [poolInfo(contractAddress, pool)] : [], unavailable: [], errors: [] };
    },
    async getRecentSwaps() {
      return { status: "unavailable", data: null, unavailable: ["swaps"], errors: [] };
    },
  };

  const historicalPriceProvider: HistoricalPriceProvider = {
    name: "fake-price",
    async getCandles(_chainId, poolAddress): Promise<ProviderResult<HistoricalCandle[]>> {
      const candles = candlesByPool[poolAddress];
      if (!candles || candles.length === 0) return { status: "unavailable", data: null, unavailable: ["candles"], errors: [] };
      return { status: "ok", data: candles, unavailable: [], errors: [] };
    },
  };

  return { poolDataProvider, historicalPriceProvider, chainId: CHAIN_ID };
}

const BASE_CONFIG: BacktestConfig = {
  configVersion: "test-1",
  smartSelectionConfigVersion: "test",
  maxEntryDelayMinutes: 5,
  slippagePct: 1,
  feePct: 0.5,
  horizons: ["5m", "15m"],
  takeProfitPct: null,
  stopLossPct: null,
  treatWatchAsTrade: false,
  portfolio: {
    startingCapitalUsd: 1000,
    positionSizePct: 10,
    maxConcurrentPositions: 3,
    allowCompounding: false,
    assumedHoldingPeriodMinutes: 60,
  },
};

function dataset(ids: string[]): BacktestDataset {
  return { id: "test-dataset", createdAt: "2026-09-05T00:00:00.000Z", description: "test", signalIds: ids, source: "synthetic" };
}

test("selectEligibleSignals keeps only EARLY_CALL messages with a contract address", () => {
  const signals = [
    scoutSignal("1", { messageType: "EARLY_CALL" }),
    scoutSignal("2", { messageType: "PERFORMANCE_UPDATE" }),
    scoutSignal("3", { messageType: "EARLY_CALL", contractAddress: undefined }),
  ];
  const eligible = selectEligibleSignals(signals);
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].sourceMessageId, "1");
});

test("runs an end-to-end backtest against a fully-reconstructable synthetic signal", async () => {
  const tokenAddress = scoutSignal("1").contractAddress!.toLowerCase();
  const pool = "0x00000000000000000000000000000000000pool";
  const deps = makeDeps(
    { [tokenAddress]: pool },
    {
      [pool]: [
        candle("2026-09-04T20:00:00.000Z", 1.0),
        candle("2026-09-04T20:05:00.000Z", 1.2),
        candle("2026-09-04T20:15:00.000Z", 1.5),
      ],
    },
  );

  const run = await runBacktest(dataset(["1"]), [scoutSignal("1")], BASE_CONFIG, deps);

  assert.equal(run.datasetSize, 1);
  assert.equal(run.dataAvailability.validEntryCount, 1);
  assert.equal(run.dataAvailability.validExitCount, 1);
  assert.ok(run.metricsByCohort.some((m) => m.cohort === "RAW_SCOUT_BASELINE" && m.horizon === "final"));
  assert.ok(run.selectionLift.length > 0);
  assert.equal(run.portfolioResults.length, 3);
  assert.ok(run.assumptions.length > 0);
});

test("excludes PERFORMANCE_UPDATE messages and records the exclusion in data-availability notes", async () => {
  const deps = makeDeps({}, {});
  const run = await runBacktest(
    dataset(["1", "2"]),
    [scoutSignal("1", { messageType: "PERFORMANCE_UPDATE" }), scoutSignal("2", { messageType: "PERFORMANCE_UPDATE" })],
    BASE_CONFIG,
    deps,
  );
  assert.equal(run.datasetSize, 0);
  assert.ok(run.dataAvailability.notes.some((n) => n.includes("PERFORMANCE_UPDATE")));
});

test("handles a dataset with zero eligible signals without throwing", async () => {
  const deps = makeDeps({}, {});
  const run = await runBacktest(dataset([]), [], BASE_CONFIG, deps);
  assert.equal(run.datasetSize, 0);
  assert.equal(run.dataAvailability.datasetSize, 0);
  for (const m of run.metricsByCohort) {
    assert.equal(m.totalSignals, 0);
  }
});

test("is reproducible: the same dataset and config produce identical metrics (excluding id/runAt)", async () => {
  const tokenAddress = scoutSignal("1").contractAddress!.toLowerCase();
  const pool = "0x00000000000000000000000000000000000pool";
  const candles = { [pool]: [candle("2026-09-04T20:00:00.000Z", 1.0), candle("2026-09-04T20:05:00.000Z", 1.1)] };

  const runA = await runBacktest(dataset(["1"]), [scoutSignal("1")], BASE_CONFIG, makeDeps({ [tokenAddress]: pool }, candles));
  const runB = await runBacktest(dataset(["1"]), [scoutSignal("1")], BASE_CONFIG, makeDeps({ [tokenAddress]: pool }, candles));

  assert.notEqual(runA.id, runB.id);
  assert.deepEqual(runA.metricsByCohort, runB.metricsByCohort);
  assert.deepEqual(runA.selectionLift, runB.selectionLift);
  assert.deepEqual(runA.portfolioResults, runB.portfolioResults);
});

test("a signal whose pool never traded historically is UNAVAILABLE end-to-end, never fabricated", async () => {
  const deps = makeDeps({}, {}); // no pool discoverable
  const run = await runBacktest(dataset(["1"]), [scoutSignal("1")], BASE_CONFIG, deps);
  assert.equal(run.dataAvailability.validEntryCount, 0);
  assert.equal(run.dataAvailability.validExitCount, 0);
});
