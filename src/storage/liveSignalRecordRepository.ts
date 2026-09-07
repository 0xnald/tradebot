import type { LiveSignalRecord } from "../types/domain.js";
import { createFileRepository, type FileRepository } from "./fileRepository.js";

export type LiveSignalRecordRepository = FileRepository<LiveSignalRecord>;

export const DEFAULT_LIVE_SIGNAL_RECORDS_PATH = "data/live/signal-records.ndjson";

/** "upsert" — a record is rewritten as it moves through its lifecycle (RECEIVED -> ... -> PAPER_POSITION_OPEN), not appended fresh each time. */
export function createLiveSignalRecordRepository(filePath: string = DEFAULT_LIVE_SIGNAL_RECORDS_PATH): LiveSignalRecordRepository {
  return createFileRepository<LiveSignalRecord>({
    filePath,
    getId: (record) => record.signalId,
    mode: "upsert",
  });
}
