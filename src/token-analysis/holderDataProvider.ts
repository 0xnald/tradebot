import type { HolderDistribution, ProviderResult } from "../types/domain.js";

export interface GetHolderDistributionOptions {
  /** If known (e.g. from an on-chain deployment lookup), used to find the deployer's own balance in the results. */
  deployerAddress?: string;
  /** How many top holders to return. */
  topN?: number;
}

/**
 * Holder distribution cannot be derived from the chain alone (see
 * docs/DATA_SOURCES.md §5) — it always comes from an indexer. Implementers
 * must return a "partial"/"unavailable"/"error" result rather than throw or
 * fabricate a number when the indexer can't be reached.
 */
export interface HolderDataProvider {
  readonly name: string;
  getHolderDistribution(
    chainId: number,
    contractAddress: string,
    options?: GetHolderDistributionOptions,
  ): Promise<ProviderResult<HolderDistribution>>;
}
