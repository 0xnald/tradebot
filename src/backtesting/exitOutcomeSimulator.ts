// Phase 6 §5 — exit/outcome simulation. Computes MFE/MAE, per-horizon
// returns, and TP/SL hit detection purely from historical OHLC candles
// after a (already-decided, already-entered) position. Never assumes a
// TP/SL was hit without a candle actually crossing it, and never resolves
// same-candle TP+SL ambiguity by pretending certainty — see
// `candleOrderingAmbiguous` and the conservative-SL-first note below.

import type { HistoricalPriceProvider, HistoricalCandle, CandleTimeframe } from "./historicalPriceProvider.js";
import type { BacktestOutcome, DataQualityState, HistoricalHorizonLabel, HorizonReturn, LevelHitResult } from "../types/domain.js";

export const HORIZON_MINUTES: Record<HistoricalHorizonLabel, number> = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "4h": 240,
  "24h": 1440,
};

/** Extra candles beyond the theoretical minimum to tolerate small gaps in candle coverage. */
const CANDLE_FETCH_BUFFER = 5;

export interface ExitSimulationRequest {
  signalId: string;
  chainId: number;
  poolAddress: string | null;
  entryTimestamp: string | null;
  entryPriceUsd: number | null;
}

export interface ExitSimulatorConfig {
  horizons: HistoricalHorizonLabel[];
  takeProfitPct: number | null;
  stopLossPct: number | null;
}

function unavailableOutcome(signalId: string, hasValidEntry: boolean, notes: string[]): BacktestOutcome {
  return {
    signalId,
    hasValidEntry,
    hasValidExit: false,
    maxFavorableExcursionPct: null,
    maxAdverseExcursionPct: null,
    returnsByHorizon: [],
    takeProfitResult: null,
    stopLossResult: null,
    finalReturnPct: null,
    finalExitTimestamp: null,
    finalExitPriceUsd: null,
    candleOrderingAmbiguous: false,
    dataQuality: "UNAVAILABLE",
    notes,
  };
}

/**
 * Picks one candle granularity for the whole outcome window rather than
 * juggling several fetches. Coarser aggregates are used for longer windows
 * purely to stay within a public API's practical per-request candle limit —
 * documented precision tradeoff, not a hidden one: horizon returns and
 * TP/SL hit times beyond ~4h are candle-approximate at hour granularity.
 */
function chooseGranularity(maxHorizonMinutes: number): { timeframe: CandleTimeframe; aggregate: number; candleMinutes: number } {
  if (maxHorizonMinutes <= 60) return { timeframe: "minute", aggregate: 1, candleMinutes: 1 };
  if (maxHorizonMinutes <= 240) return { timeframe: "minute", aggregate: 5, candleMinutes: 5 };
  return { timeframe: "hour", aggregate: 1, candleMinutes: 60 };
}

export async function simulateExit(
  request: ExitSimulationRequest,
  provider: HistoricalPriceProvider,
  config: ExitSimulatorConfig,
): Promise<BacktestOutcome> {
  const hasValidEntry = request.poolAddress !== null && request.entryTimestamp !== null && request.entryPriceUsd !== null;
  if (!hasValidEntry) {
    return unavailableOutcome(request.signalId, false, ["no valid entry position — outcome cannot be computed"]);
  }

  const entryTimeMs = new Date(request.entryTimestamp as string).getTime();
  if (Number.isNaN(entryTimeMs)) {
    return unavailableOutcome(request.signalId, false, ["entry timestamp could not be parsed"]);
  }
  const entryPriceUsd = request.entryPriceUsd as number;

  const maxHorizonMinutes = config.horizons.length > 0 ? Math.max(...config.horizons.map((h) => HORIZON_MINUTES[h])) : 0;
  const { timeframe, aggregate, candleMinutes } = chooseGranularity(Math.max(maxHorizonMinutes, 1));
  const windowEndMs = entryTimeMs + maxHorizonMinutes * 60_000 + candleMinutes * 60_000;
  const limit = Math.ceil(maxHorizonMinutes / candleMinutes) + CANDLE_FETCH_BUFFER;

  const result = await provider.getCandles(
    request.chainId,
    request.poolAddress as string,
    new Date(windowEndMs).toISOString(),
    timeframe,
    aggregate,
    limit,
  );

  if (result.status !== "ok" || !result.data || result.data.length === 0) {
    return unavailableOutcome(request.signalId, true, ["no candle data available after entry — exit/outcome cannot be reconstructed"]);
  }

  const candles = result.data.filter((c) => new Date(c.timestamp).getTime() >= entryTimeMs);
  if (candles.length === 0) {
    return unavailableOutcome(request.signalId, true, ["no candle data available at or after the entry timestamp"]);
  }

  const notes: string[] = [];

  // MFE/MAE across every candle actually observed in the window.
  let mfePct = -Infinity;
  let maePct = Infinity;
  for (const c of candles) {
    mfePct = Math.max(mfePct, ((c.highUsd - entryPriceUsd) / entryPriceUsd) * 100);
    maePct = Math.min(maePct, ((c.lowUsd - entryPriceUsd) / entryPriceUsd) * 100);
  }

  // TP/SL hit detection — first candle (in chronological order) where a
  // configured level is crossed. If both are crossed in the SAME candle,
  // OHLC data cannot establish which happened first; we flag the ambiguity
  // and conservatively resolve it as the stop-loss (the worse outcome),
  // rather than assume the more favorable take-profit.
  let candleOrderingAmbiguous = false;
  let takeProfitResult: LevelHitResult | null = config.takeProfitPct === null ? null : { hit: false, hitAt: null, timeToHitMinutes: null, dataQuality: "KNOWN" };
  let stopLossResult: LevelHitResult | null = config.stopLossPct === null ? null : { hit: false, hitAt: null, timeToHitMinutes: null, dataQuality: "KNOWN" };
  const tpPrice = config.takeProfitPct !== null ? entryPriceUsd * (1 + config.takeProfitPct / 100) : null;
  const slPrice = config.stopLossPct !== null ? entryPriceUsd * (1 - config.stopLossPct / 100) : null;

  if (tpPrice !== null || slPrice !== null) {
    for (const c of candles) {
      const tpCrossed = tpPrice !== null && c.highUsd >= tpPrice;
      const slCrossed = slPrice !== null && c.lowUsd <= slPrice;
      if (!tpCrossed && !slCrossed) continue;

      const timeToHitMinutes = (new Date(c.timestamp).getTime() - entryTimeMs) / 60_000;
      if (tpCrossed && slCrossed) {
        candleOrderingAmbiguous = true;
        notes.push(
          `candle at ${c.timestamp} crossed both take-profit and stop-loss; OHLC data cannot establish order — conservatively recorded as stop-loss hit`,
        );
        stopLossResult = { hit: true, hitAt: c.timestamp, timeToHitMinutes, dataQuality: "PARTIAL" };
        if (takeProfitResult) takeProfitResult = { ...takeProfitResult, dataQuality: "PARTIAL" };
        break;
      }
      if (tpCrossed) {
        takeProfitResult = { hit: true, hitAt: c.timestamp, timeToHitMinutes, dataQuality: "KNOWN" };
        break;
      }
      stopLossResult = { hit: true, hitAt: c.timestamp, timeToHitMinutes, dataQuality: "KNOWN" };
      break;
    }
  }

  // Per-horizon returns: the last candle at/before the horizon's target
  // time stands in for "the price at that horizon" — a candle-granularity
  // approximation, not an exact tick price. Crucially, we only accept this
  // approximation when the fetched series actually EXTENDS to roughly that
  // point in time; if the data ran out well before the target, we mark the
  // horizon UNAVAILABLE rather than silently reusing a stale earlier price.
  const lastCandle = candles[candles.length - 1];
  const lastCoverageMs = new Date(lastCandle.timestamp).getTime() + candleMinutes * 60_000;

  const returnsByHorizon: HorizonReturn[] = config.horizons.map((horizon) => {
    const targetMs = entryTimeMs + HORIZON_MINUTES[horizon] * 60_000;
    if (targetMs > lastCoverageMs) {
      return { horizon, returnPct: null, priceUsd: null, observedAt: null, dataQuality: "UNAVAILABLE" as DataQualityState };
    }
    let covering: HistoricalCandle | null = null;
    for (const c of candles) {
      if (new Date(c.timestamp).getTime() <= targetMs) covering = c;
      else break;
    }
    if (!covering) {
      return { horizon, returnPct: null, priceUsd: null, observedAt: null, dataQuality: "UNAVAILABLE" as DataQualityState };
    }
    return {
      horizon,
      returnPct: ((covering.closeUsd - entryPriceUsd) / entryPriceUsd) * 100,
      priceUsd: covering.closeUsd,
      observedAt: covering.timestamp,
      dataQuality: "KNOWN" as DataQualityState,
    };
  });

  // Final mark: whichever level was actually hit; otherwise the largest
  // horizon with known data stands in as a paper mark-to-market close — an
  // explicit simplification (there was no real forced exit), not a real fill.
  let finalReturnPct: number | null = null;
  let finalExitTimestamp: string | null = null;
  let finalExitPriceUsd: number | null = null;

  if (stopLossResult?.hit) {
    finalExitTimestamp = stopLossResult.hitAt;
    finalExitPriceUsd = slPrice;
    finalReturnPct = slPrice !== null ? ((slPrice - entryPriceUsd) / entryPriceUsd) * 100 : null;
    notes.push("final outcome taken at stop-loss hit");
  } else if (takeProfitResult?.hit) {
    finalExitTimestamp = takeProfitResult.hitAt;
    finalExitPriceUsd = tpPrice;
    finalReturnPct = tpPrice !== null ? ((tpPrice - entryPriceUsd) / entryPriceUsd) * 100 : null;
    notes.push("final outcome taken at take-profit hit");
  } else {
    const lastKnown = [...returnsByHorizon].reverse().find((r) => r.dataQuality === "KNOWN");
    if (lastKnown) {
      finalReturnPct = lastKnown.returnPct;
      finalExitTimestamp = lastKnown.observedAt;
      finalExitPriceUsd = lastKnown.priceUsd;
      notes.push(`no TP/SL hit within the configured horizons — final outcome marked at the ${lastKnown.horizon} horizon close`);
    }
  }

  const hasValidExit = finalReturnPct !== null;
  const knownHorizonCount = returnsByHorizon.filter((r) => r.dataQuality === "KNOWN").length;
  const dataQuality: DataQualityState = !hasValidExit
    ? "UNAVAILABLE"
    : knownHorizonCount < returnsByHorizon.length
      ? "PARTIAL"
      : "KNOWN";

  return {
    signalId: request.signalId,
    hasValidEntry: true,
    hasValidExit,
    maxFavorableExcursionPct: Number.isFinite(mfePct) ? mfePct : null,
    maxAdverseExcursionPct: Number.isFinite(maePct) ? maePct : null,
    returnsByHorizon,
    takeProfitResult,
    stopLossResult,
    finalReturnPct,
    finalExitTimestamp,
    finalExitPriceUsd,
    candleOrderingAmbiguous,
    dataQuality,
    notes,
  };
}
