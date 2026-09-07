// Phase 7.3 §3/§4/§17 — a single, GLOBAL, priority-aware concurrency
// limiter for Robinhood Chain RPC requests, shared across every live
// intelligence branch (Pons resolution, token analysis, contract
// features, deployer analysis, position monitoring, WATCH observation).
//
// Root cause this addresses (see docs/RPC_PERFORMANCE.md): Phase 7.2's
// live/replay verification found the Pons-aware chain timing out 7/7
// under real concurrent load, while a standalone one-token-at-a-time
// script resolved the same data quickly. The architecture fans out
// SIGNALS (bounded by `maxConcurrentSignals`) and, independently, each
// signal fans out MULTIPLE RPC-heavy branches — meaning the real
// concurrent RPC load against the public, rate-limited RPC endpoint is
// `signals × branches`, uncontrolled by the signal-level limiter alone.
// This is a SEPARATE control from `ConcurrencyLimiter` (signal
// processing) — see §17: a system may process 5 Scout signals at once
// while allowing only, say, 4 RPC calls globally at a time.
//
// Priority (§4): not all RPC work is equally valuable to a decision.
// Higher-priority work is serviced first when a slot frees up, but this
// is NOT preemption — a request already running is never cancelled to
// make room (see §12's cancellation investigation, documented in
// docs/RPC_PERFORMANCE.md, for why: viem/the underlying transport has no
// clean mid-flight abort for a plain HTTP JSON-RPC call). Deterministic:
// within the same priority tier, FIFO order is preserved.

export type RpcPriority = "CRITICAL" | "MEDIUM" | "LOW";

const PRIORITY_ORDER: RpcPriority[] = ["CRITICAL", "MEDIUM", "LOW"];

interface QueueEntry {
  priority: RpcPriority;
  resolve: () => void;
}

export interface RpcConcurrencySnapshot {
  active: number;
  maxConcurrency: number;
  queued: number;
  queuedByPriority: Record<RpcPriority, number>;
}

export class RpcConcurrencyLimiter {
  #maxConcurrency: number;
  #active = 0;
  #queues: Record<RpcPriority, QueueEntry[]> = { CRITICAL: [], MEDIUM: [], LOW: [] };

  constructor(maxConcurrency: number) {
    if (maxConcurrency < 1) throw new Error("maxConcurrency must be >= 1");
    this.#maxConcurrency = maxConcurrency;
  }

  get maxConcurrency(): number {
    return this.#maxConcurrency;
  }

  /** Live-reconfigurable so a benchmark harness (or, in principle, an ops override) can adjust without restarting every consumer. */
  setMaxConcurrency(value: number): void {
    if (value < 1) throw new Error("maxConcurrency must be >= 1");
    this.#maxConcurrency = value;
    this.#drain();
  }

  get snapshot(): RpcConcurrencySnapshot {
    return {
      active: this.#active,
      maxConcurrency: this.#maxConcurrency,
      queued: this.#queues.CRITICAL.length + this.#queues.MEDIUM.length + this.#queues.LOW.length,
      queuedByPriority: { CRITICAL: this.#queues.CRITICAL.length, MEDIUM: this.#queues.MEDIUM.length, LOW: this.#queues.LOW.length },
    };
  }

  /** Runs `task` once a global slot is available, at the given priority (default MEDIUM). Returns the concurrency level THIS task actually started at, for instrumentation (§1's "concurrency at request start"). */
  async run<T>(task: () => Promise<T>, priority: RpcPriority = "MEDIUM"): Promise<T> {
    const concurrencyAtStart = await this.#acquire(priority);
    try {
      return await task();
    } finally {
      this.#release();
    }
  }

  #acquire(priority: RpcPriority): Promise<number> {
    if (this.#active < this.#maxConcurrency) {
      this.#active += 1;
      return Promise.resolve(this.#active);
    }
    return new Promise((resolve) => {
      this.#queues[priority].push({
        priority,
        resolve: () => {
          this.#active += 1;
          resolve(this.#active);
        },
      });
    });
  }

  #release(): void {
    this.#active -= 1;
    this.#drain();
  }

  #drain(): void {
    while (this.#active < this.#maxConcurrency) {
      const next = this.#dequeueHighestPriority();
      if (!next) return;
      next.resolve();
    }
  }

  #dequeueHighestPriority(): QueueEntry | undefined {
    for (const priority of PRIORITY_ORDER) {
      const entry = this.#queues[priority].shift();
      if (entry) return entry;
    }
    return undefined;
  }
}

/**
 * Default chosen from the Phase 7.3 benchmark matrix (docs/RPC_PERFORMANCE.md)
 * — NOT an arbitrary guess. Configurable via `ROBINHOOD_RPC_MAX_CONCURRENCY`
 * so a higher-throughput authenticated RPC provider (§14) can raise it
 * without a code change.
 */
export const DEFAULT_ROBINHOOD_RPC_MAX_CONCURRENCY = 4;

function readConfiguredMaxConcurrency(): number {
  const raw = process.env.ROBINHOOD_RPC_MAX_CONCURRENCY;
  if (!raw) return DEFAULT_ROBINHOOD_RPC_MAX_CONCURRENCY;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : DEFAULT_ROBINHOOD_RPC_MAX_CONCURRENCY;
}

let globalLimiter: RpcConcurrencyLimiter | null = null;

/** The single shared instance every live intelligence branch must route Robinhood Chain RPC calls through — see the module doc comment for why a per-analyzer limiter would defeat the point. */
export function getGlobalRpcLimiter(): RpcConcurrencyLimiter {
  if (!globalLimiter) globalLimiter = new RpcConcurrencyLimiter(readConfiguredMaxConcurrency());
  return globalLimiter;
}

/** Test-only: resets the global limiter (picking up a possibly-changed env var, and clearing any queued state) so tests don't leak state into each other. */
export function resetGlobalRpcLimiter(): void {
  globalLimiter = null;
}
