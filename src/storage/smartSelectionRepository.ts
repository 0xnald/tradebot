import type { SmartSelectionResult } from "../types/domain.js";
import { createFileRepository, type FileRepository } from "./fileRepository.js";

export type SmartSelectionRepository = FileRepository<SmartSelectionResult>;

/**
 * Append-only, keyed by the result's own unique `id` — every evaluation is
 * preserved as its own record. A later re-evaluation of the same signal
 * produces a NEW `SmartSelectionResult` (a new id), never overwrites a
 * prior one — this is what lets later backtesting compare how the
 * assessment of an opportunity evolved as market conditions changed after
 * the original Scout call.
 */
export function createSmartSelectionRepository(filePath: string): SmartSelectionRepository {
  return createFileRepository<SmartSelectionResult>({
    filePath,
    getId: (result) => result.id,
    mode: "append",
  });
}

/** All evaluations recorded for a given signal, oldest first — the "how did our assessment evolve" view. */
export async function listEvaluationsForSignal(
  repository: SmartSelectionRepository,
  signalId: string,
): Promise<SmartSelectionResult[]> {
  const all = await repository.list();
  return all.filter((r) => r.signalId === signalId).sort((a, b) => a.computedAt.localeCompare(b.computedAt));
}
