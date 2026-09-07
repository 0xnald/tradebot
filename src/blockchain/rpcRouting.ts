// Phase 7.4 §3/§4 — a single, deterministic, pure routing decision for
// which RPC provider role should serve a given `eth_getLogs` query. Called
// BEFORE any RPC request is made — the decision is based entirely on the
// requested range size vs. the PRIMARY provider's known capability, never
// on "try Alchemy first, see if it fails" (that predictable-failure pattern
// is exactly what caused Phase 7.3A's 12-55-requests-per-signal blowup).

import type { RpcProviderCapabilities } from "./chainConfig.js";

export type RpcProviderRole = "PRIMARY" | "LOG";

/**
 * Why a query needs event-history logs at all — carried through purely for
 * observability/reporting (§9); the routing decision itself is driven by
 * range size vs. capability, uniformly across purposes.
 */
export type LogQueryPurpose = "PONS_CURVE_FLOW" | "UNISWAP_V4_FLOW" | "PONS_GRADUATION_SEARCH" | "OTHER_EVENT_HISTORY";

export interface ChooseRpcForLogQueryInput {
  fromBlock: bigint;
  toBlock: bigint;
  purpose: LogQueryPurpose;
  primaryCapabilities: RpcProviderCapabilities;
}

/**
 * Deterministic: the SAME inputs always produce the SAME role, and nothing
 * here makes a network call. A range the PRIMARY provider can serve stays
 * on PRIMARY (no reason to route ordinary small/bounded reads to the public
 * endpoint); a range exceeding its known cap goes straight to LOG.
 */
export function chooseRpcForLogQuery(input: ChooseRpcForLogQueryInput): RpcProviderRole {
  const { fromBlock, toBlock, primaryCapabilities } = input;
  if (primaryCapabilities.supportsLargeGetLogs || primaryCapabilities.maxGetLogsBlockRange === undefined) return "PRIMARY";

  const rangeSize = toBlock - fromBlock + 1n;
  return rangeSize > BigInt(primaryCapabilities.maxGetLogsBlockRange) ? "LOG" : "PRIMARY";
}
