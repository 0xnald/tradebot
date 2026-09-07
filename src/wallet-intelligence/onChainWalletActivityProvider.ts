// The one verified Robinhood-compatible WalletActivityProvider in this
// phase — built entirely on Phase 2's already-verified PoolDataProvider
// (real on-chain Swap logs, no external API). Pool-scoped: see
// docs/WALLET_DATA_SOURCES.md §2d for the honest limitation this implies.

import { isAddress } from "viem";
import { ConcurrencyLimiter } from "../shared/concurrencyLimiter.js";
import type { PoolDataProvider } from "../market-data/poolDataProvider.js";
import type { ProviderResult, WalletTrade } from "../types/domain.js";
import type { GetWalletTradesOptions, WalletActivityProvider } from "./walletActivityProvider.js";

export interface OnChainWalletActivityProviderOptions {
  poolProvider: PoolDataProvider;
  /** Caps how many pools are queried in parallel — see the repo-wide "do not hammer RPC" instruction. */
  maxConcurrentPoolLookups?: number;
}

const DEFAULT_MAX_CONCURRENT_POOL_LOOKUPS = 3;

export class OnChainWalletActivityProvider implements WalletActivityProvider {
  readonly name = "on-chain-swaps";
  #poolProvider: PoolDataProvider;
  #limiter: ConcurrencyLimiter;

  constructor(options: OnChainWalletActivityProviderOptions) {
    this.#poolProvider = options.poolProvider;
    this.#limiter = new ConcurrencyLimiter(options.maxConcurrentPoolLookups ?? DEFAULT_MAX_CONCURRENT_POOL_LOOKUPS);
  }

  async getWalletTrades(
    chainId: number,
    walletAddress: string,
    options: GetWalletTradesOptions,
  ): Promise<ProviderResult<WalletTrade[]>> {
    if (!isAddress(walletAddress)) {
      return {
        status: "error",
        data: null,
        unavailable: ["trades"],
        errors: [{ message: `invalid wallet address: ${walletAddress}`, provider: this.name }],
      };
    }

    if (options.pools.length === 0) {
      return {
        status: "unavailable",
        data: null,
        unavailable: ["trades"],
        errors: [
          {
            message:
              "no pools were provided to search — this provider is pool-scoped, see docs/WALLET_DATA_SOURCES.md §2d",
            provider: this.name,
          },
        ],
      };
    }

    const target = walletAddress.toLowerCase();
    const errors: { message: string; provider?: string }[] = [];
    const trades: WalletTrade[] = [];

    const perPoolResults = await this.#limiter.map(options.pools, (pool) =>
      this.#poolProvider.getRecentSwaps(pool, { fromBlock: options.fromBlock, toBlock: options.toBlock }),
    );

    for (let i = 0; i < perPoolResults.length; i++) {
      const pool = options.pools[i];
      const result = perPoolResults[i];

      if (result.status === "error") {
        errors.push(...result.errors);
        continue;
      }
      errors.push(...result.errors); // carry through any "partial" sub-errors too

      for (const swap of result.data ?? []) {
        if (swap.trader?.toLowerCase() !== target) continue;

        trades.push({
          chainId,
          walletAddress,
          timestamp: swap.timestamp ?? null,
          blockNumber: swap.blockNumber,
          transactionHash: swap.transactionHash,
          tokenAddress: pool.tokenAddress,
          poolAddress: pool.poolAddress,
          direction: swap.side,
          tokenAmountRaw: swap.tokenAmount,
          quoteAmountRaw: swap.quoteAmount,
          // Never fabricated — no verified historical price/liquidity
          // source exists yet, see docs/WALLET_DATA_SOURCES.md §3.
          approxUsdValue: null,
          tokenPriceUsdAtTrade: null,
          liquidityUsdAtTrade: null,
          marketCapUsdAtTrade: null,
          source: this.name,
        });
      }
    }

    trades.sort((a, b) => a.blockNumber - b.blockNumber);

    if (trades.length === 0 && errors.length > 0 && errors.length === options.pools.length) {
      return { status: "error", data: null, unavailable: ["trades"], errors };
    }

    return {
      status: errors.length > 0 ? "partial" : "ok",
      data: trades,
      unavailable: [],
      errors,
    };
  }
}
