import type { WatchObservation } from "../types/domain.js";
import { createFileRepository, type FileRepository } from "./fileRepository.js";

export type WatchObservationRepository = FileRepository<WatchObservation>;

export const DEFAULT_WATCH_OBSERVATIONS_PATH = "data/live/watch-observations.ndjson";

/** "append" — every poll of a WATCHed signal produces a NEW, distinct record (id includes observedAt), never overwritten — see WatchObservation's doc comment (Phase 7.2 §23). */
export function createWatchObservationRepository(filePath: string = DEFAULT_WATCH_OBSERVATIONS_PATH): WatchObservationRepository {
  return createFileRepository<WatchObservation>({
    filePath,
    getId: (record) => record.id,
    mode: "append",
  });
}
