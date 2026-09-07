// Phase 7.3 §1 — records every Robinhood Chain RPC request made while
// processing live Scout signals, for the diagnostic summary the phase
// explicitly asks for (docs/RPC_PERFORMANCE.md). Never logs secrets —
// there are none to log here (this is a read-only public RPC; no API
// keys are recorded even where a configured provider URL might embed
// one — see `redactRpcUrl` below).

export type RpcCallStatus = "OK" | "ERROR" | "TIMEOUT";

export interface RpcCallRecord {
  signalId: string | null;
  method: string;
  /** A human label for who initiated the call — e.g. "resolveMarketContextOnce", "PonsCurveMarketReader", "TokenAnalysisService:slow" — NOT the raw JSON-RPC method alone, since e.g. `getLogs` is used by several different callers with very different value/latency profiles (§4/§20). */
  caller: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  status: RpcCallStatus;
  retryCount: number;
  fromCache: boolean;
  /** How many RPC calls (including this one) were active in the global limiter the instant this one started — the direct measurement §1/§2 ask for. */
  concurrencyAtStart: number;
  blockRange?: { fromBlock: string; toBlock: string };
  error?: string;
}

export interface RpcCallSummary {
  totalRequests: number;
  requestsBySignal: Record<string, number>;
  requestsByCaller: Record<string, number>;
  requestsByMethod: Record<string, number>;
  timeoutCount: number;
  errorCount: number;
  cacheHitCount: number;
  maxConcurrencyObserved: number;
  averageLatencyMs: number | null;
  medianLatencyMs: number | null;
  p95LatencyMs: number | null;
  /** Same (caller, method, block range) requested more than once within the same signal — a literal duplicate-request candidate for §7's deduplication audit. */
  duplicateRequestGroups: { signalId: string; caller: string; method: string; count: number }[];
}

function percentile(sortedValues: number[], p: number): number | null {
  if (sortedValues.length === 0) return null;
  const index = Math.min(sortedValues.length - 1, Math.floor(p * sortedValues.length));
  return sortedValues[index];
}

export class RpcCallLog {
  #records: RpcCallRecord[] = [];

  record(entry: RpcCallRecord): void {
    this.#records.push(entry);
  }

  getAll(): RpcCallRecord[] {
    return [...this.#records];
  }

  getForSignal(signalId: string): RpcCallRecord[] {
    return this.#records.filter((r) => r.signalId === signalId);
  }

  clear(): void {
    this.#records = [];
  }

  summarize(): RpcCallSummary {
    const requestsBySignal: Record<string, number> = {};
    const requestsByCaller: Record<string, number> = {};
    const requestsByMethod: Record<string, number> = {};
    const dupKey = new Map<string, number>();
    let timeoutCount = 0;
    let errorCount = 0;
    let cacheHitCount = 0;
    let maxConcurrencyObserved = 0;
    const latencies: number[] = [];

    for (const r of this.#records) {
      const signalKey = r.signalId ?? "(no signal context)";
      requestsBySignal[signalKey] = (requestsBySignal[signalKey] ?? 0) + 1;
      requestsByCaller[r.caller] = (requestsByCaller[r.caller] ?? 0) + 1;
      requestsByMethod[r.method] = (requestsByMethod[r.method] ?? 0) + 1;
      if (r.status === "TIMEOUT") timeoutCount += 1;
      if (r.status === "ERROR") errorCount += 1;
      if (r.fromCache) cacheHitCount += 1;
      maxConcurrencyObserved = Math.max(maxConcurrencyObserved, r.concurrencyAtStart);
      if (!r.fromCache) latencies.push(r.durationMs);

      if (!r.fromCache) {
        const key = `${signalKey}::${r.caller}::${r.method}::${r.blockRange ? `${r.blockRange.fromBlock}-${r.blockRange.toBlock}` : ""}`;
        dupKey.set(key, (dupKey.get(key) ?? 0) + 1);
      }
    }

    const sorted = [...latencies].sort((a, b) => a - b);
    const duplicateRequestGroups = [...dupKey.entries()]
      .filter(([, count]) => count > 1)
      .map(([key, count]) => {
        const [signalId, caller, method] = key.split("::");
        return { signalId, caller, method, count };
      });

    return {
      totalRequests: this.#records.length,
      requestsBySignal,
      requestsByCaller,
      requestsByMethod,
      timeoutCount,
      errorCount,
      cacheHitCount,
      maxConcurrencyObserved,
      averageLatencyMs: sorted.length > 0 ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
      medianLatencyMs: percentile(sorted, 0.5),
      p95LatencyMs: percentile(sorted, 0.95),
      duplicateRequestGroups,
    };
  }
}

let globalLog: RpcCallLog | null = null;

/** The single shared instrumentation log for the live process — a diagnostic/reporting concern, deliberately separate from the concurrency limiter itself. */
export function getGlobalRpcCallLog(): RpcCallLog {
  if (!globalLog) globalLog = new RpcCallLog();
  return globalLog;
}

export function resetGlobalRpcCallLog(): void {
  globalLog = new RpcCallLog();
}
