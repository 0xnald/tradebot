// Phase 6.6 §4 — the Robinhood public RPC's `eth_getLogs` failure mode
// turned out (verified live, see docs/DATA_SOURCES.md) to be a
// too-many-results limit, not a fixed block-range cap: a sparse pool's
// full 1,000,000-block history succeeds in one call while a busy pool's
// 50,000-block window can fail. Rather than guess a safe fixed chunk size
// (which would either be too conservative for quiet pools or still fail
// on busy ones), this recursively bisects a failing range until each half
// succeeds — bounded so a genuinely broken query fails fast instead of
// hanging.
//
// Phase 7.3B §H — Phase 7.3A found this bisected on ANY thrown error,
// including a deterministic, size-independent rejection from an
// authenticated endpoint ("JSON is not a valid request object" — see
// docs/RPC_PERFORMANCE.md), multiplying RPC calls (12-55 per signal instead
// of 4) without ever succeeding. Bisection now only fires for error classes
// that actually carry evidence a smaller range would help (see
// `rpcErrorClassification.ts`), and a hard `maxTotalRequests` ceiling — shared
// across the whole recursive call tree, not just depth — stops runaway
// request storms even if a future error message is misclassified.

import { classifyRpcError, isBisectable } from "./rpcErrorClassification.js";

const DEFAULT_MAX_SPLIT_DEPTH = 6;
const DEFAULT_MAX_TOTAL_REQUESTS = 32;

interface RequestBudget {
  remaining: number;
}

interface LogLike {
  transactionHash?: string | null;
  logIndex?: number | null;
  blockNumber?: bigint | null;
}

/** Stable, order-independent identity for a log — used to drop duplicates if ranges ever overlap. */
function logIdentity(log: LogLike): string {
  if (log.transactionHash != null && log.logIndex != null) return `${log.transactionHash}:${log.logIndex}`;
  return JSON.stringify(log, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
}

/** Chronological order: ascending block number, then ascending log index within a block. */
function compareChronological(a: LogLike, b: LogLike): number {
  const blockDelta = (a.blockNumber ?? 0n) - (b.blockNumber ?? 0n);
  if (blockDelta !== 0n) return blockDelta < 0n ? -1 : 1;
  return (a.logIndex ?? 0) - (b.logIndex ?? 0);
}

/** Deduplicates by stable identity and sorts chronologically — defensive: bisection's disjoint ranges shouldn't overlap, but a provider or future retry path could still return duplicates. */
function mergeDeterministically<T extends LogLike>(logs: T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const log of logs) {
    const id = logIdentity(log);
    if (seen.has(id)) continue;
    seen.add(id);
    deduped.push(log);
  }
  return deduped.sort(compareChronological);
}

/**
 * Fetches logs over [fromBlock, toBlock] via `fetchRange`, bisecting the
 * range and retrying each half ONLY when the thrown error is classified as
 * one a smaller range plausibly fixes (`isBisectable` — see
 * `rpcErrorClassification.ts`). Re-throws the original error once
 * `maxSplitDepth`/`maxTotalRequests` is exhausted, the range can no longer
 * be split, or the error class gives no reason to believe splitting helps.
 */
export async function fetchLogsWithAdaptiveChunking<T extends LogLike>(
  fetchRange: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
  fromBlock: bigint,
  toBlock: bigint,
  maxSplitDepth: number = DEFAULT_MAX_SPLIT_DEPTH,
  maxTotalRequests: number = DEFAULT_MAX_TOTAL_REQUESTS,
): Promise<T[]> {
  const results = await fetchLogsRecursive(fetchRange, fromBlock, toBlock, maxSplitDepth, { remaining: maxTotalRequests });
  return mergeDeterministically(results);
}

async function fetchLogsRecursive<T extends LogLike>(fetchRange: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>, fromBlock: bigint, toBlock: bigint, maxSplitDepth: number, budget: RequestBudget): Promise<T[]> {
  if (budget.remaining <= 0) throw new Error(`fetchLogsWithAdaptiveChunking: request budget exhausted before [${fromBlock}, ${toBlock}] could complete`);
  budget.remaining -= 1;

  try {
    return await fetchRange(fromBlock, toBlock);
  } catch (error) {
    const mid = fromBlock + (toBlock - fromBlock) / 2n;
    const canSplit = maxSplitDepth > 0 && mid >= fromBlock && mid < toBlock && isBisectable(classifyRpcError(error)) && budget.remaining > 0;
    if (!canSplit) throw error;

    const [left, right] = await Promise.all([
      fetchLogsRecursive(fetchRange, fromBlock, mid, maxSplitDepth - 1, budget),
      fetchLogsRecursive(fetchRange, mid + 1n, toBlock, maxSplitDepth - 1, budget),
    ]);
    return [...left, ...right];
  }
}
