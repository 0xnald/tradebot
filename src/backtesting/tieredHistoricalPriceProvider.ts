// Phase 6.6 §5 — the documented historical-price reconstruction hierarchy:
// on-chain event reconstruction first (ground truth, no indexer
// dependency), a verified historical indexer/API second. Tiers are tried
// in the order given to the constructor; the first tier to return a
// non-empty "ok" result wins. Every tier attempted is recorded so a
// caller can see exactly which source actually produced (or failed to
// produce) a given signal's price — see MarketResolutionTrace.

import type { CandleTimeframe, HistoricalCandle, HistoricalPriceProvider } from "./historicalPriceProvider.js";
import type { ProviderResult } from "../types/domain.js";

export interface PriceProviderTier {
  name: string;
  provider: HistoricalPriceProvider;
}

export interface TieredLookupResult {
  result: ProviderResult<HistoricalCandle[]>;
  /** Every tier attempted, in order, with its outcome status — e.g. ["onchain-pons-curve:unavailable", "geckoterminal:ok"]. */
  attempts: string[];
  /** The tier name that actually produced the winning result, or null if every tier failed/was unavailable. */
  winningTier: string | null;
}

export class TieredHistoricalPriceProvider implements HistoricalPriceProvider {
  readonly name = "tiered";
  #tiers: PriceProviderTier[];
  #lastLookup: TieredLookupResult | null = null;

  constructor(tiers: PriceProviderTier[]) {
    this.#tiers = tiers;
  }

  /** The attempt trace from the most recent getCandles call — for building a MarketResolutionTrace/reconstructionMethod without changing the shared HistoricalPriceProvider interface. */
  get lastLookup(): TieredLookupResult | null {
    return this.#lastLookup;
  }

  async getCandles(
    chainId: number,
    poolAddress: string,
    beforeTimestamp: string,
    timeframe: CandleTimeframe,
    aggregate: number,
    limit: number,
  ): Promise<ProviderResult<HistoricalCandle[]>> {
    const attempts: string[] = [];

    for (const tier of this.#tiers) {
      const result = await tier.provider.getCandles(chainId, poolAddress, beforeTimestamp, timeframe, aggregate, limit);
      attempts.push(`${tier.name}:${result.status}`);
      if (result.status === "ok" && result.data && result.data.length > 0) {
        this.#lastLookup = { result, attempts, winningTier: tier.name };
        return result;
      }
    }

    const finalResult: ProviderResult<HistoricalCandle[]> = { status: "unavailable", data: null, unavailable: ["candles"], errors: [] };
    this.#lastLookup = { result: finalResult, attempts, winningTier: null };
    return finalResult;
  }
}
