// Phase 7 §4 — records a timestamped transition for every stage a live
// signal passes through, with the duration since the previous stage, so
// real per-stage latency can be measured later (see latencyMetrics.ts).
// Every transition is append-only — nothing here is ever edited or
// removed after the fact.

import type { LifecycleEvent, LiveSignalLifecycleStage } from "../types/domain.js";

export interface RecordOptions {
  error?: string;
  details?: Record<string, unknown>;
  /** Injectable for deterministic tests — defaults to the real current time. */
  at?: Date;
}

export class LifecycleTracker {
  readonly signalId: string;
  #events: LifecycleEvent[] = [];
  #lastTimestampMs: number | null = null;

  constructor(signalId: string) {
    this.signalId = signalId;
  }

  record(stage: LiveSignalLifecycleStage, status: LifecycleEvent["status"] = "OK", options: RecordOptions = {}): LifecycleEvent {
    const at = options.at ?? new Date();
    const timestampMs = at.getTime();
    const durationMsSincePrevious = this.#lastTimestampMs === null ? null : timestampMs - this.#lastTimestampMs;

    const event: LifecycleEvent = {
      signalId: this.signalId,
      stage,
      timestamp: at.toISOString(),
      durationMsSincePrevious,
      status,
      ...(options.error !== undefined ? { error: options.error } : {}),
      ...(options.details !== undefined ? { details: options.details } : {}),
    };

    this.#events.push(event);
    this.#lastTimestampMs = timestampMs;
    return event;
  }

  get events(): LifecycleEvent[] {
    return [...this.#events];
  }

  get currentStage(): LiveSignalLifecycleStage | null {
    return this.#events.length > 0 ? this.#events[this.#events.length - 1].stage : null;
  }

  /** Total elapsed time from the very first recorded event to now (or to the last event if `at` events are all in the past) — the raw material for "signal-to-X" latency. */
  millisecondsSince(stage: LiveSignalLifecycleStage): number | null {
    const first = this.#events.find((e) => e.stage === stage);
    if (!first) return null;
    const last = this.#events[this.#events.length - 1];
    return new Date(last.timestamp).getTime() - new Date(first.timestamp).getTime();
  }

  /** Milliseconds between two specific stages (first occurrence of each), or null if either is missing. */
  millisecondsBetween(fromStage: LiveSignalLifecycleStage, toStage: LiveSignalLifecycleStage): number | null {
    const from = this.#events.find((e) => e.stage === fromStage);
    const to = this.#events.find((e) => e.stage === toStage);
    if (!from || !to) return null;
    return new Date(to.timestamp).getTime() - new Date(from.timestamp).getTime();
  }
}
