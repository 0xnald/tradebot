// npm run backtest:report
//
// Prints the human-readable report for the most recent persisted backtest
// run, without re-running anything (no network calls).

import { createBacktestRunRepository } from "../src/storage/backtestRunRepository.js";
import { formatBacktestReport } from "../src/backtesting/reportFormatter.js";

async function main(): Promise<void> {
  const repository = createBacktestRunRepository();
  const runs = await repository.list();

  if (runs.length === 0) {
    console.log("No backtest runs found. Run `npm run backtest` first.");
    return;
  }

  const latest = [...runs].sort((a, b) => new Date(b.runAt).getTime() - new Date(a.runAt).getTime())[0];
  console.log(formatBacktestReport(latest));
}

main().catch((error) => {
  console.error("Failed to load backtest report:", error);
  process.exitCode = 1;
});
