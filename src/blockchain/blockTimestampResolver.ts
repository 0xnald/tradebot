// Phase 6.6 §9 — a shared, cached blockNumber -> timestamp resolver.
// `RobinhoodChainClient.getBlockTimestamp` itself makes no attempt to
// cache; every on-chain reconstruction module in src/backtesting needs the
// same block's timestamp repeatedly (once per event touching that block),
// so a single shared cache per backtest run avoids re-querying the same
// block hundreds of times against a documented-rate-limited public RPC.

import type { RobinhoodChainClient } from "./robinhoodChainClient.js";

export class BlockTimestampResolver {
  #chainClient: RobinhoodChainClient;
  #cache = new Map<string, string>();
  #pending = new Map<string, Promise<string>>();

  constructor(chainClient: RobinhoodChainClient) {
    this.#chainClient = chainClient;
  }

  async resolve(blockNumber: bigint): Promise<string> {
    const key = blockNumber.toString();
    const cached = this.#cache.get(key);
    if (cached) return cached;

    const pending = this.#pending.get(key);
    if (pending) return pending;

    const request = this.#chainClient.getBlockTimestamp(blockNumber).then((timestamp) => {
      this.#cache.set(key, timestamp);
      this.#pending.delete(key);
      return timestamp;
    });
    this.#pending.set(key, request);
    return request;
  }

  get cacheSize(): number {
    return this.#cache.size;
  }
}
