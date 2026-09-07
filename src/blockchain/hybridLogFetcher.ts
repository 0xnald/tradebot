// Phase 7.4 §3/§4/§8 — combines the pure routing decision
// (`chooseRpcForLogQuery`) with actual execution: picks PRIMARY or LOG
// BEFORE making any request (never "try Alchemy first, then fall back"),
// runs the chosen client through the existing classification-gated
// adaptive chunking (`fetchLogsWithAdaptiveChunking` — unchanged Phase 7.3B
// logic), and returns a structured outcome rather than throwing, so
// callers can distinguish FAILED / TIMED_OUT / RATE_LIMITED from a genuine
// empty result.
//
// No incompatible fallback (§8): a query routed to LOG was routed there
// specifically BECAUSE it exceeds PRIMARY's known range cap — falling back
// to PRIMARY on a LOG failure would just repeat the same predictable
// rejection Phase 7.3B eliminated, so this deliberately never attempts it.

import type { Log, PublicClient } from "viem";
import { chooseRpcForLogQuery, type ChooseRpcForLogQueryInput, type RpcProviderRole } from "./rpcRouting.js";
import { fetchLogsWithAdaptiveChunking } from "./logRangeChunking.js";
import { classifyRpcError } from "./rpcErrorClassification.js";

export type LogQueryOutcomeStatus = "OK" | "FAILED" | "TIMED_OUT" | "RATE_LIMITED" | "UNAVAILABLE";

export interface LogQueryOutcome<T> {
  status: LogQueryOutcomeStatus;
  providerRole: RpcProviderRole;
  data: T[];
  /** Present only on a non-OK outcome. Never includes a raw URL or API key — see `describeRpcEndpointSafely`/`redactUrls` for the layers that already guarantee this upstream. */
  reason?: string;
}

export type FetchLogsHybridParams = Parameters<PublicClient["getLogs"]>[0] & { fromBlock: bigint; toBlock: bigint };

/** Minimal structural shape both a raw `RobinhoodChainClient` and a `ChainClientLike`-wrapped one satisfy. */
export interface LogCapableClient {
  getLogs(params: Parameters<PublicClient["getLogs"]>[0]): Promise<Log[]>;
}

export interface HybridLogClients {
  primary: LogCapableClient;
  log: LogCapableClient;
}

/**
 * Fetches logs for `params`, routing to PRIMARY or LOG per
 * `chooseRpcForLogQuery`, and reporting a structured outcome. `maxSplitDepth`
 * is forwarded to `fetchLogsWithAdaptiveChunking` unchanged — bisection
 * still only fires for a `TOO_MANY_RESULTS`-classified error, regardless of
 * which provider role served the request.
 */
export async function fetchLogsHybrid<T extends Log = Log>(
  clients: HybridLogClients,
  params: FetchLogsHybridParams,
  routing: Omit<ChooseRpcForLogQueryInput, "fromBlock" | "toBlock">,
  maxSplitDepth?: number,
): Promise<LogQueryOutcome<T>> {
  const role = chooseRpcForLogQuery({ fromBlock: params.fromBlock, toBlock: params.toBlock, ...routing });
  const client = role === "LOG" ? clients.log : clients.primary;

  try {
    const data = await fetchLogsWithAdaptiveChunking<T>(
      (from, to) => client.getLogs({ ...params, fromBlock: from, toBlock: to }) as Promise<T[]>,
      params.fromBlock,
      params.toBlock,
      maxSplitDepth,
    );
    return { status: "OK", providerRole: role, data };
  } catch (error) {
    const errorClass = classifyRpcError(error);
    const status: LogQueryOutcomeStatus = errorClass === "TIMEOUT" ? "TIMED_OUT" : errorClass === "RATE_LIMIT" ? "RATE_LIMITED" : "FAILED";
    return { status, providerRole: role, data: [], reason: error instanceof Error ? error.message : String(error) };
  }
}
