// Phase 7.3B §H — classifies an RPC call failure so adaptive chunking only
// bisects when doing so is actually likely to help. Phase 6.6's original
// bisection logic treated ANY thrown error as "too many results" (the
// public RPC's one real failure mode at the time) and retried unconditionally
// — which, against the authenticated endpoint's flat "JSON is not a valid
// request object" rejection (a deterministic, size-independent refusal — see
// docs/RPC_PERFORMANCE.md), caused repeated bisection attempts that also
// failed, multiplying RPC calls without ever succeeding (Phase 7.3A: 12-55
// requests per signal instead of 4).
//
// Classification is deliberately conservative: an error is only treated as
// "shrinking the range would plausibly fix this" when its message actually
// says so. A generic or unrecognized error is never assumed to be a size
// problem — see `isBisectable`.

export type RpcErrorClass = "TIMEOUT" | "RATE_LIMIT" | "TOO_MANY_RESULTS" | "RANGE_LIMIT" | "NETWORK_TRANSIENT" | "INVALID_REQUEST" | "DETERMINISTIC_RPC_ERROR";

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).toLowerCase();
}

/**
 * Classifies an error thrown by an RPC call (e.g. `eth_getLogs`) into a
 * coarse category. Order matters: more specific patterns are checked first.
 */
export function classifyRpcError(error: unknown): RpcErrorClass {
  const message = messageOf(error);

  if (/\btimed?[\s-]?out\b|\betimedout\b/.test(message)) return "TIMEOUT";
  if (/\b429\b|rate limit|too many requests/.test(message)) return "RATE_LIMIT";
  // The one failure mode bisection was originally designed for (Phase 6.6) — a real "shrink the
  // range and it'll fit" signal, distinct from a flat rejection.
  if (/too many results|response size|query returned more than|log response size exceeded|more than \d+\s*(results|logs|events)/.test(message)) return "TOO_MANY_RESULTS";
  // An explicit, size-specific rejection naming a range/block limit — also plausibly fixable by
  // shrinking, though bounded by `maxTotalRequests` since the actual limit is unknown up front.
  if (/block range|range (exceeds|limit|too large)|exceeds maximum|max(imum)? range|range of \d+ blocks/.test(message)) return "RANGE_LIMIT";
  if (/econnreset|socket hang up|fetch failed|network error|enotfound|econnrefused|eai_again/.test(message)) return "NETWORK_TRANSIENT";
  // A generic "invalid request"/"invalid params" shape carries NO evidence the problem is size —
  // it could just as easily be a malformed filter, an unsupported combination of params, or (as
  // observed against the authenticated endpoint) an edge/WAF-layer rejection unrelated to result
  // volume. Never assumed bisectable.
  if (/invalid request|invalid params|is not a valid request|-32600|-32602/.test(message)) return "INVALID_REQUEST";
  return "DETERMINISTIC_RPC_ERROR";
}

/**
 * Only TOO_MANY_RESULTS is bisectable — Phase 6.6's validated case against
 * the public RPC, where a busy pool's query fails but a smaller one
 * succeeds because there's genuinely less data to return.
 *
 * RANGE_LIMIT is deliberately NOT bisectable by blind recursive halving,
 * even though it names a concrete size problem: Phase 7.3B found an
 * authenticated provider whose actual cap was a flat 10 blocks (confirmed
 * both by direct probing and by the provider's own error text — e.g.
 * "Under the Free tier plan, you can make eth_getLogs requests with up to a
 * 10 block range"), while the ranges this codebase requests are in the tens
 * of thousands to millions of blocks. Halving toward a limit that small
 * would take 15-20+ splits — far past any sane `maxSplitDepth` — and
 * exploded the request count in exactly this scenario (Phase 7.3A: up to 55
 * requests per signal) without a single one ever succeeding. A range this
 * restrictive makes the provider unusable for this query regardless of
 * chunking strategy; failing fast and reporting that clearly (see
 * docs/RPC_PERFORMANCE.md) is more honest than a retry loop that cannot work.
 */
export function isBisectable(errorClass: RpcErrorClass): boolean {
  return errorClass === "TOO_MANY_RESULTS";
}
