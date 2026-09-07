// Buy/sell flow analysis over normalized SwapRecord data. Volumes are
// reported in QUOTE-TOKEN units, not USD — no verified per-swap USD source
// exists (see docs/WALLET_DATA_SOURCES.md §3), and converting with a
// *current* price would misrepresent past trades' actual value at the
// time, which the project treats the same as inventing a historical
// price. Callers that want an approximate USD figure can multiply by a
// current quote-token price themselves, explicitly, outside this analyzer.
//
// UNKNOWN-direction swaps are always counted separately — never folded
// into buy or sell counts/volumes.

import type { MarketFlowAnalysis, SwapRecord } from "../types/domain.js";

export interface MarketFlowAnalyzerOptions {
  /** A trade at or beyond this multiple of the median trade size counts as "large". Documented, not arbitrary-and-hidden. */
  largeTradeMultiplier?: number;
  /** Window used for the recentTradeCount feature. */
  recentWindowSeconds?: number;
}

const DEFAULT_LARGE_TRADE_MULTIPLIER = 3;
const DEFAULT_RECENT_WINDOW_SECONDS = 5 * 60;

function toQuoteAmount(raw: string, decimals: number): number {
  return Math.abs(Number(BigInt(raw))) / 10 ** decimals;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export class MarketFlowAnalyzer {
  #largeTradeMultiplier: number;
  #recentWindowSeconds: number;

  constructor(options: MarketFlowAnalyzerOptions = {}) {
    this.#largeTradeMultiplier = options.largeTradeMultiplier ?? DEFAULT_LARGE_TRADE_MULTIPLIER;
    this.#recentWindowSeconds = options.recentWindowSeconds ?? DEFAULT_RECENT_WINDOW_SECONDS;
  }

  analyze(
    chainId: number,
    poolAddress: string | "ALL_POOLS",
    swaps: SwapRecord[],
    quoteTokenDecimals: number,
    now: Date = new Date(),
  ): MarketFlowAnalysis {
    const observedAt = now.toISOString();
    const buys = swaps.filter((s) => s.side === "BUY");
    const sells = swaps.filter((s) => s.side === "SELL");
    const unknowns = swaps.filter((s) => s.side === "UNKNOWN");

    const notes: string[] = [];
    if (swaps.length === 0) notes.push("no swaps supplied — counts are genuinely zero, but volume/ratio stats cannot be computed");

    const buyQuoteVolume = swaps.length > 0 ? buys.reduce((sum, s) => sum + toQuoteAmount(s.quoteAmount, quoteTokenDecimals), 0) : null;
    const sellQuoteVolume = swaps.length > 0 ? sells.reduce((sum, s) => sum + toQuoteAmount(s.quoteAmount, quoteTokenDecimals), 0) : null;
    const netQuoteFlow = buyQuoteVolume !== null && sellQuoteVolume !== null ? buyQuoteVolume - sellQuoteVolume : null;
    const buySellRatio =
      buyQuoteVolume !== null && sellQuoteVolume !== null && sellQuoteVolume > 0 ? buyQuoteVolume / sellQuoteVolume : null;

    const traders = new Set(swaps.map((s) => s.trader).filter((t): t is string => Boolean(t)));
    // null (not 0) when nothing has an observed trader — an empty set here means "unknown", not "zero unique traders".
    const uniqueTraderCount = traders.size > 0 ? traders.size : null;

    const allSizes = swaps.map((s) => toQuoteAmount(s.quoteAmount, quoteTokenDecimals));
    const averageTradeSizeQuote = allSizes.length > 0 ? allSizes.reduce((a, b) => a + b, 0) / allSizes.length : null;
    const medianTradeSizeQuote = median(allSizes);
    const largeTradeThresholdQuote = medianTradeSizeQuote !== null ? medianTradeSizeQuote * this.#largeTradeMultiplier : null;
    const largeTradeCount = largeTradeThresholdQuote !== null ? allSizes.filter((s) => s > largeTradeThresholdQuote).length : 0;

    const recentCutoffMs = now.getTime() - this.#recentWindowSeconds * 1000;
    const timedSwaps = swaps.filter((s) => s.timestamp);
    const recentTradeCount =
      timedSwaps.length > 0 ? timedSwaps.filter((s) => new Date(s.timestamp as string).getTime() >= recentCutoffMs).length : null;
    if (swaps.length > 0 && timedSwaps.length === 0) {
      notes.push("no swap in this set has a timestamp — recent-activity count is unavailable, not zero");
    }

    return {
      chainId,
      poolAddress,
      observedAt,
      buyCount: buys.length,
      sellCount: sells.length,
      unknownCount: unknowns.length,
      buyQuoteVolume,
      sellQuoteVolume,
      netQuoteFlow,
      buySellRatio,
      uniqueTraderCount,
      averageTradeSizeQuote,
      medianTradeSizeQuote,
      largeTradeCount,
      largeTradeThresholdQuote,
      recentTradeCount,
      recentWindowSeconds: this.#recentWindowSeconds,
      dataQuality: swaps.length > 0 ? "KNOWN" : "PARTIAL",
      notes,
    };
  }
}
