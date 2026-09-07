import type { PoolInfo, ProviderResult, SwapRecord } from "../types/domain.js";

export interface GetRecentSwapsOptions {
  fromBlock?: bigint;
  toBlock?: bigint;
}

/**
 * Discovers DEX pools for a token and reads their recent swap activity.
 * Designed to support more than one DEX later — see `dexId` on `PoolInfo`
 * for which one a given pool came from.
 */
export interface PoolDataProvider {
  readonly name: string;
  discoverPools(contractAddress: string): Promise<ProviderResult<PoolInfo[]>>;
  getRecentSwaps(pool: PoolInfo, options?: GetRecentSwapsOptions): Promise<ProviderResult<SwapRecord[]>>;
}
