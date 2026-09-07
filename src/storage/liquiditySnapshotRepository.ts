import type { LiquiditySnapshot } from "../types/domain.js";
import { createFileRepository, type FileRepository } from "./fileRepository.js";

export type LiquiditySnapshotRepository = FileRepository<LiquiditySnapshot>;

/** Append-only: every observation is a distinct historical data point, keyed by pool + exact timestamp. */
export function liquiditySnapshotId(snapshot: LiquiditySnapshot): string {
  return `${snapshot.chainId}:${snapshot.poolAddress.toLowerCase()}:${snapshot.observedAt}`;
}

export function createLiquiditySnapshotRepository(filePath: string): LiquiditySnapshotRepository {
  return createFileRepository<LiquiditySnapshot>({ filePath, getId: liquiditySnapshotId, mode: "append" });
}

/**
 * Returns the N most recent snapshots for a pool, most-recent first — the
 * shape `LiquidityAnalyzer.analyze()` expects for its `previous`/
 * `priorToPrevious` arguments (see src/market-data/liquidityAnalyzer.ts).
 */
export async function getRecentLiquiditySnapshots(
  repository: LiquiditySnapshotRepository,
  chainId: number,
  poolAddress: string,
  limit: number,
): Promise<LiquiditySnapshot[]> {
  const all = await repository.list();
  return all
    .filter((s) => s.chainId === chainId && s.poolAddress.toLowerCase() === poolAddress.toLowerCase())
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))
    .slice(0, limit);
}
