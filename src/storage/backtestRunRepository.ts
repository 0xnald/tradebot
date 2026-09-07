import type { BacktestRun } from "../types/domain.js";
import { createFileRepository, type FileRepository } from "./fileRepository.js";

export type BacktestRunRepository = FileRepository<BacktestRun>;

export const DEFAULT_BACKTEST_RUNS_PATH = "data/backtests/runs.ndjson";

/** Each run is immutable once computed — "append" mode, never rewritten. */
export function createBacktestRunRepository(filePath: string = DEFAULT_BACKTEST_RUNS_PATH): BacktestRunRepository {
  return createFileRepository<BacktestRun>({
    filePath,
    getId: (run) => run.id,
    mode: "append",
  });
}
