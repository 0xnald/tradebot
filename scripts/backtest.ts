// npm run backtest
//
// Runs the Phase 6 backtest against the real captured Scout dataset
// (src/ingestion/fixtures/scoutrobinhood-2026-09-04.raw.json by default).
// Read-only: makes on-chain reads (pool discovery) and public historical
// price API calls (GeckoTerminal) — never signs or broadcasts anything.
// Persists the run to data/backtests/runs.ndjson and prints the
// human-readable report.

import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { parseScoutMessage } from "../src/signal-parsing/scoutMessageParser.js";
import { RobinhoodChainClient } from "../src/blockchain/robinhoodChainClient.js";
import { BlockTimestampResolver } from "../src/blockchain/blockTimestampResolver.js";
import { BlockTimeEstimator } from "../src/blockchain/blockTimeEstimator.js";
import { UniswapV3PoolProvider } from "../src/market-data/uniswapV3PoolProvider.js";
import { PonsV2Provider } from "../src/market-data/ponsV2Provider.js";
import { GeckoTerminalHistoricalPriceProvider } from "../src/backtesting/geckoTerminalHistoricalPriceProvider.js";
import { runBacktest } from "../src/backtesting/backtestRunner.js";
import { formatBacktestReport } from "../src/backtesting/reportFormatter.js";
import { createBacktestRunRepository, DEFAULT_BACKTEST_RUNS_PATH } from "../src/storage/backtestRunRepository.js";
import { SMART_SELECTION_V1_CONFIG } from "../src/scoring/smartSelectionConfig.js";
import type { RawScoutMessage } from "../src/ingestion/types.js";
import type { BacktestConfig, BacktestDataset } from "../src/types/domain.js";

const SOURCE = "telegram:scoutrobinhood";

const DEFAULT_CONFIG: BacktestConfig = {
  configVersion: "backtest-config-v1",
  smartSelectionConfigVersion: SMART_SELECTION_V1_CONFIG.modelVersion,
  maxEntryDelayMinutes: 5,
  slippagePct: 1,
  feePct: 0.5,
  horizons: ["1m", "5m", "15m", "30m", "1h", "4h", "24h"],
  // No TP/SL by default — an arbitrary level would be an unrequested
  // assumption. Horizon returns alone tell the honest story; TP/SL can be
  // configured explicitly by editing this file if a specific level matters.
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

async function main(): Promise<void> {
  const fixturePath =
    process.env.SCOUT_BACKTEST_FIXTURE_PATH ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "ingestion", "fixtures", "scoutrobinhood-2026-09-04.raw.json");

  console.log(`Loading Scout messages from ${fixturePath}`);
  const raw = JSON.parse(await readFile(fixturePath, "utf8")) as RawScoutMessage[];
  const signals = raw.map((m) => parseScoutMessage(m, SOURCE));
  console.log(`Parsed ${signals.length} Scout message(s).`);

  const chainClient = new RobinhoodChainClient();
  const poolDataProvider = new UniswapV3PoolProvider({ chainClient });
  const ponsV2Provider = new PonsV2Provider({ chainClient });
  const historicalPriceProvider = new GeckoTerminalHistoricalPriceProvider();
  const onChainReconstruction = {
    chainClient,
    blockTimestampResolver: new BlockTimestampResolver(chainClient),
    blockTimeEstimator: new BlockTimeEstimator(chainClient),
  };

  const dataset: BacktestDataset = {
    id: `scout-real-${path.basename(fixturePath, ".raw.json")}`,
    createdAt: new Date().toISOString(),
    description: `Real captured Scout Robinhood messages from ${fixturePath}`,
    signalIds: signals.map((s) => s.id),
    source: "real",
  };

  console.log("Running backtest (on-chain pool/Pons/event discovery + GeckoTerminal fallback — this hits real network endpoints)...");
  const run = await runBacktest(dataset, signals, DEFAULT_CONFIG, {
    poolDataProvider,
    ponsV2Provider,
    historicalPriceProvider,
    onChainReconstruction,
    chainId: chainClient.chainId,
  });

  const repository = createBacktestRunRepository();
  await repository.save(run);
  console.log(`Saved run ${run.id} to ${DEFAULT_BACKTEST_RUNS_PATH}`);

  const report = formatBacktestReport(run);
  const reportDir = path.dirname(DEFAULT_BACKTEST_RUNS_PATH);
  await mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, "latest-report.txt");
  await writeFile(reportPath, report, "utf8");

  console.log();
  console.log(report);
  console.log();
  console.log(`Report also written to ${reportPath}`);
}

main().catch((error) => {
  console.error("Backtest failed:", error);
  process.exitCode = 1;
});
