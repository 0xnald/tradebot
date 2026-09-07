import type { SignalMarketSnapshot } from "../types/domain.js";
import { createFileRepository, type FileRepository } from "./fileRepository.js";

export type SignalMarketSnapshotRepository = FileRepository<SignalMarketSnapshot>;

/**
 * Append-only, keyed by signal id: the FIRST snapshot recorded for a
 * signal is preserved as "the initial market state" and never overwritten
 * — a later re-run that tries to save another snapshot for the same
 * signal id is a no-op (see createFileRepository's "append" mode), exactly
 * matching the Phase 4 brief's "Do not overwrite the original ScoutSignal"
 * extended to its market snapshot.
 */
export function createSignalMarketSnapshotRepository(filePath: string): SignalMarketSnapshotRepository {
  return createFileRepository<SignalMarketSnapshot>({
    filePath,
    getId: (snapshot) => snapshot.signalId,
    mode: "append",
  });
}
