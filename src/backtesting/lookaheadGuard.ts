// The single enforcement point for "no lookahead bias" (Phase 6 §3).
// Every historical feature fed into a backtested Smart Selection decision
// must pass through `LookaheadGuard.admit()`. A fact observed strictly
// after the decision timestamp is EXCLUDED (returns null), never
// substituted with today's value, and recorded as a violation so tests
// (and real runs) can prove it never silently happened.

import type { LookaheadViolation, TimestampedObservation } from "../types/domain.js";

export class LookaheadGuard {
  readonly decisionTimestamp: string;
  #violations: LookaheadViolation[] = [];
  #decisionTimeMs: number;

  constructor(decisionTimestamp: string) {
    this.decisionTimestamp = decisionTimestamp;
    this.#decisionTimeMs = new Date(decisionTimestamp).getTime();
  }

  /**
   * Admits `observation.value` only if `observation.observedAt <=
   * decisionTimestamp`. Returns null (and records a violation) for a
   * future-dated observation, and null (no violation — nothing to admit)
   * for a missing observation.
   */
  admit<T>(field: string, observation: TimestampedObservation<T> | null | undefined): T | null {
    if (!observation) return null;
    const observedAtMs = new Date(observation.observedAt).getTime();
    if (Number.isNaN(observedAtMs)) {
      this.#violations.push({ field, observedAt: observation.observedAt, decisionTimestamp: this.decisionTimestamp });
      return null;
    }
    if (observedAtMs > this.#decisionTimeMs) {
      this.#violations.push({ field, observedAt: observation.observedAt, decisionTimestamp: this.decisionTimestamp });
      return null;
    }
    return observation.value;
  }

  get violations(): LookaheadViolation[] {
    return [...this.#violations];
  }

  get hasViolations(): boolean {
    return this.#violations.length > 0;
  }
}
