import type { ScoutSignal } from "../types/domain.js";

/**
 * Storage contract for captured signals. Kept deliberately small so a
 * Postgres-backed implementation (or anything else) can satisfy it later
 * without the rest of the app changing.
 */
export interface SignalRepository {
  /** No-ops if a signal with the same id already exists (dedupe). */
  saveSignal(signal: ScoutSignal): Promise<void>;
  getSignal(id: string): Promise<ScoutSignal | undefined>;
  listSignals(): Promise<ScoutSignal[]>;
  signalExists(id: string): Promise<boolean>;
}
