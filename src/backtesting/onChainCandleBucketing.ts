// Buckets discrete on-chain trade events into the same OHLCV candle shape
// GeckoTerminal returns, so entrySimulator/exitOutcomeSimulator work
// completely unchanged regardless of which HistoricalPriceProvider fed
// them — on-chain-reconstructed or indexer-sourced. Volume is always 0
// here: this phase reconstructs price only (see docs/BACKTESTING.md's
// "liquidity/volume reconstruction" limitation note).

import type { CandleTimeframe, HistoricalCandle } from "./historicalPriceProvider.js";

export interface RawTradePricePoint {
  timestamp: string;
  priceUsd: number;
}

const TIMEFRAME_MS: Record<CandleTimeframe, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

export function bucketTradesIntoCandles(
  points: RawTradePricePoint[],
  timeframe: CandleTimeframe,
  aggregate: number,
): HistoricalCandle[] {
  if (points.length === 0) return [];

  const bucketMs = TIMEFRAME_MS[timeframe] * aggregate;
  const buckets = new Map<number, RawTradePricePoint[]>();

  for (const point of points) {
    const t = new Date(point.timestamp).getTime();
    const bucketStart = Math.floor(t / bucketMs) * bucketMs;
    const existing = buckets.get(bucketStart);
    if (existing) existing.push(point);
    else buckets.set(bucketStart, [point]);
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bucketStart, bucketPoints]) => {
      const ordered = [...bucketPoints].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      const prices = ordered.map((p) => p.priceUsd);
      return {
        timestamp: new Date(bucketStart).toISOString(),
        openUsd: prices[0],
        highUsd: Math.max(...prices),
        lowUsd: Math.min(...prices),
        closeUsd: prices[prices.length - 1],
        volumeUsd: 0,
      };
    });
}
