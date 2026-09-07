// Simple freshness mechanism — not a distributed streaming architecture,
// per the Phase 4 brief. A value is "stale" once it's older than a
// documented threshold; each caller supplies its own threshold since
// "fresh" means something different for a price (seconds) than for a
// deployment timestamp (irrelevant — it never changes).

export interface Freshness {
  observedAt: string;
  ageSeconds: number;
  isStale: boolean;
  staleAfterSeconds: number;
}

export function computeFreshness(observedAt: string, staleAfterSeconds: number, now: Date = new Date()): Freshness {
  const ageSeconds = Math.max(0, (now.getTime() - new Date(observedAt).getTime()) / 1000);
  return {
    observedAt,
    ageSeconds,
    isStale: ageSeconds > staleAfterSeconds,
    staleAfterSeconds,
  };
}

/**
 * Documented default staleness thresholds per data kind — a starting
 * point, not a universal law. Override per-call when a different
 * threshold is more appropriate.
 */
export const DEFAULT_STALE_AFTER_SECONDS = {
  /** Price/liquidity/volume move constantly on an active memecoin pool. */
  marketData: 60,
  /** Holder distribution changes far more slowly. */
  holderData: 15 * 60,
  /** Liquidity snapshots used for trend comparison — same cadence as market data. */
  liquiditySnapshot: 60,
} as const;
