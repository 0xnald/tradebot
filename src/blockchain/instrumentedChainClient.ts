// Phase 7.3 §1/§3/§4 — wraps a real `RobinhoodChainClient` so every RPC
// call it makes on behalf of the LIVE pipeline (a) goes through the
// single GLOBAL `RpcConcurrencyLimiter` (never a separate limiter per
// analyzer — see rpcConcurrencyLimiter.ts) and (b) is recorded to the
// shared `RpcCallLog` for the diagnostic summary §1 asks for.
//
// Deliberately a WRAPPER, not a modification to `RobinhoodChainClient`
// itself: `src/backtesting` uses the raw client directly and must not
// have its calls silently rate-limited or tagged with live-signal
// context that doesn't apply to a historical replay.
//
// Structural note: `RobinhoodChainClient` has a private `#client` field,
// which blocks TypeScript structural (duck-type) compatibility — the one
// `as unknown as RobinhoodChainClient` cast at the construction site in
// scripts/liveScout.ts is the established pattern this codebase already
// uses for exactly this situation (see tokenAnalysisService.test.ts's
// `fakeChainClient` for the same class-shape workaround in tests). This
// wrapper only ever adds instrumentation/throttling around read-only
// calls — it cannot add, remove, or alter what the underlying client is
// capable of.

import type { Address, Hash, Log, PublicClient } from "viem";
import type { RobinhoodChainClient, TokenMetadataRaw, ContractCreationInfo } from "./robinhoodChainClient.js";
import { getGlobalRpcLimiter, type RpcPriority } from "./rpcConcurrencyLimiter.js";
import { getGlobalRpcCallLog, type RpcCallStatus } from "./rpcInstrumentation.js";
import { getCurrentSignalId } from "../shared/signalContext.js";

export interface InstrumentedChainClientOptions {
  /** A human label for the caller wrapping this instance — e.g. "resolveMarketContextOnce", "PonsCurveMarketReader" — used for per-caller RPC accounting (§1), not the raw method name alone. */
  caller: string;
  /** Default priority (§4) for calls made through THIS wrapper instance. Different callers get different priorities by using differently-configured wrappers around the SAME underlying client and the SAME global limiter — never a separate limiter. */
  priority: RpcPriority;
}

async function instrumented<T>(caller: string, priority: RpcPriority, method: string, blockRange: { fromBlock: string; toBlock: string } | undefined, fn: () => Promise<T>): Promise<T> {
  const limiter = getGlobalRpcLimiter();
  const log = getGlobalRpcCallLog();
  const signalId = getCurrentSignalId();
  const startedAt = Date.now();
  let concurrencyAtStart = 0;
  let status: RpcCallStatus = "OK";
  let error: string | undefined;
  try {
    return await limiter.run(async () => {
      concurrencyAtStart = limiter.snapshot.active;
      return fn();
    }, priority);
  } catch (e) {
    status = "ERROR";
    error = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    const endedAt = Date.now();
    log.record({ signalId, method, caller, startedAt, endedAt, durationMs: endedAt - startedAt, status, retryCount: 0, fromCache: false, concurrencyAtStart, blockRange, error });
  }
}

/** Structural interface matching the subset of `RobinhoodChainClient` the live intelligence path actually calls — lets tests supply a fake without needing the concrete class's private fields. */
export interface ChainClientLike {
  readonly chainId: number;
  getBlockNumber(): Promise<bigint>;
  getNativeBalance(address: Address): Promise<bigint>;
  getTokenBalance(token: Address, owner: Address): Promise<bigint>;
  readContract<T>(params: Parameters<PublicClient["readContract"]>[0]): Promise<T>;
  getTokenMetadata(token: Address): Promise<TokenMetadataRaw>;
  getLogs(params: Parameters<PublicClient["getLogs"]>[0]): Promise<Log[]>;
  getBlockTimestamp(blockNumber: bigint): Promise<string>;
  getBytecode(address: Address): Promise<string | null>;
  getStorageAt(address: Address, slot: `0x${string}`): Promise<string | null>;
  getContractCreationInfo(address: Address): Promise<ContractCreationInfo | null>;
  getTransaction(hash: Hash): ReturnType<RobinhoodChainClient["getTransaction"]>;
  getTransactionReceipt(hash: Hash): ReturnType<RobinhoodChainClient["getTransactionReceipt"]>;
}

function blockRangeOf(params: any): { fromBlock: string; toBlock: string } | undefined {
  if (params && (params.fromBlock !== undefined || params.toBlock !== undefined)) {
    return { fromBlock: String(params.fromBlock ?? "?"), toBlock: String(params.toBlock ?? "?") };
  }
  return undefined;
}

/**
 * Wraps `inner` (a real `RobinhoodChainClient`) so every call recorded
 * above routes through the shared global limiter + instrumentation log.
 * Returns a `ChainClientLike` — cast to `RobinhoodChainClient` at the ONE
 * production call site that needs the nominal type (scripts/liveScout.ts)
 * since every live-path consumer already only calls the methods listed
 * on `ChainClientLike`.
 */
export function wrapChainClientWithRpcControl(inner: RobinhoodChainClient, options: InstrumentedChainClientOptions): ChainClientLike {
  const { caller, priority } = options;
  return {
    chainId: inner.chainId,
    getBlockNumber: () => instrumented(caller, priority, "getBlockNumber", undefined, () => inner.getBlockNumber()),
    getNativeBalance: (address) => instrumented(caller, priority, "getNativeBalance", undefined, () => inner.getNativeBalance(address)),
    getTokenBalance: (token, owner) => instrumented(caller, priority, "getTokenBalance", undefined, () => inner.getTokenBalance(token, owner)),
    readContract: (params) => instrumented(caller, priority, "readContract", undefined, () => inner.readContract(params)),
    getTokenMetadata: (token) => instrumented(caller, priority, "getTokenMetadata", undefined, () => inner.getTokenMetadata(token)),
    getLogs: (params) => instrumented(caller, priority, "getLogs", blockRangeOf(params), () => inner.getLogs(params)),
    getBlockTimestamp: (blockNumber) => instrumented(caller, priority, "getBlockTimestamp", undefined, () => inner.getBlockTimestamp(blockNumber)),
    getBytecode: (address) => instrumented(caller, priority, "getBytecode", undefined, () => inner.getBytecode(address)),
    getStorageAt: (address, slot) => instrumented(caller, priority, "getStorageAt", undefined, () => inner.getStorageAt(address, slot)),
    getContractCreationInfo: (address) => instrumented(caller, priority, "getContractCreationInfo", undefined, () => inner.getContractCreationInfo(address)),
    getTransaction: (hash) => instrumented(caller, priority, "getTransaction", undefined, () => inner.getTransaction(hash)),
    getTransactionReceipt: (hash) => instrumented(caller, priority, "getTransactionReceipt", undefined, () => inner.getTransactionReceipt(hash)),
  };
}
