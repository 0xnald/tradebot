import type { ProviderResult, WalletTrade } from "../types/domain.js";
import type { PoolInfo } from "../types/domain.js";

export interface GetWalletTradesOptions {
  /**
   * Pools to search for this wallet's activity. This provider is
   * pool-scoped, not wallet-centric — see docs/WALLET_DATA_SOURCES.md §2d
   * for why no verified "show me everything this wallet ever did" source
   * exists yet. Callers must supply the pools they care about (e.g. from a
   * Scout signal's token, or a token-analysis lookup).
   */
  pools: PoolInfo[];
  fromBlock?: bigint;
  toBlock?: bigint;
}

/**
 * Obtains a wallet's historical trading activity. See
 * docs/WALLET_DATA_SOURCES.md for what's actually verified — in
 * particular, USD/price/liquidity fields on the returned trades are `null`
 * unless a genuinely verified historical-price source populates them
 * (none does, as of this phase).
 */
export interface WalletActivityProvider {
  readonly name: string;
  getWalletTrades(
    chainId: number,
    walletAddress: string,
    options: GetWalletTradesOptions,
  ): Promise<ProviderResult<WalletTrade[]>>;
}
