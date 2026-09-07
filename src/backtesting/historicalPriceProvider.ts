import type { ProviderResult } from "../types/domain.js";

export interface HistoricalCandle {
  /** Candle open time, ISO 8601. */
  timestamp: string;
  openUsd: number;
  highUsd: number;
  lowUsd: number;
  closeUsd: number;
  volumeUsd: number;
}

export type CandleTimeframe = "minute" | "hour" | "day";

/**
 * Historical price reconstruction — genuinely new for this phase. See
 * docs/BACKTESTING.md for the live verification: GeckoTerminal's public
 * API provides real minute-level OHLCV for Robinhood Chain pools, going
 * back to actual pool-creation/Scout-call timestamps (confirmed live
 * against a real Scout-called token, 2026-09-05). Not available: any
 * verified source of historical LIQUIDITY, holder distribution, or wallet
 * performance at a past timestamp — only price/volume.
 */
export interface HistoricalPriceProvider {
  readonly name: string;
  /**
   * `poolAddress` is whatever identifier the underlying provider needs to
   * find this market's OHLCV history — usually a real pool contract
   * address, but for GeckoTerminal specifically it may also be a Pons V2
   * bonding curve's own contract address (pre-graduation) or a computed
   * Uniswap V4 PoolId (post-graduation) — see
   * src/market-data/ponsV2Provider.ts and docs/DATA_SOURCES.md §7.
   */
  getCandles(
    chainId: number,
    poolAddress: string,
    beforeTimestamp: string,
    timeframe: CandleTimeframe,
    aggregate: number,
    limit: number,
  ): Promise<ProviderResult<HistoricalCandle[]>>;
}
