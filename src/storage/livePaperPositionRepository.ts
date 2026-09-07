import type { LivePaperPosition } from "../types/domain.js";
import { createFileRepository, type FileRepository } from "./fileRepository.js";

export type LivePaperPositionRepository = FileRepository<LivePaperPosition>;

export const DEFAULT_LIVE_PAPER_POSITIONS_PATH = "data/live/paper-positions.ndjson";

/** "upsert" — a position is rewritten on every snapshot/close, not appended fresh each time (Phase 7 §19 restart recovery reads the latest state of every position). */
export function createLivePaperPositionRepository(filePath: string = DEFAULT_LIVE_PAPER_POSITIONS_PATH): LivePaperPositionRepository {
  return createFileRepository<LivePaperPosition>({
    filePath,
    getId: (position) => position.id,
    mode: "upsert",
  });
}
