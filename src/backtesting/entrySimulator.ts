// Phase 6 §4 — entry simulation. Entry timestamp is always the decision
// timestamp (we simulate acting the instant Smart Selection decided); entry
// PRICE is the earliest trustworthy candle open at or after that boundary,
// within a configurable max delay. If no such observation exists, entry is
// marked UNAVAILABLE — never invented from a later or earlier price. This
// runs strictly AFTER a decision was already made, so unlike feature
// reconstruction (LookaheadGuard), using a slightly-later fill price here is
// not lookahead bias — it's modeling real-world execution latency.

import type { HistoricalPriceProvider } from "./historicalPriceProvider.js";
import type { BacktestPosition, DataQualityState } from "../types/domain.js";

export interface EntrySimulatorConfig {
  maxEntryDelayMinutes: number;
  slippagePct: number;
  feePct: number;
  positionSizeUsd: number;
}

export interface EntrySimulationRequest {
  signalId: string;
  signalTimestamp: string;
  decisionTimestamp: string;
  chainId: number;
  /** Null when no pool could be resolved for this signal's token — entry is then UNAVAILABLE by construction. */
  poolAddress: string | null;
}

const CANDLE_TIMEFRAME = "minute" as const;
const CANDLE_AGGREGATE = 1;
/** Extra candles requested beyond the delay window to tolerate small gaps in candle coverage. */
const CANDLE_FETCH_BUFFER = 5;

function unavailablePosition(
  request: EntrySimulationRequest,
  slippagePct: number,
): BacktestPosition {
  return {
    signalId: request.signalId,
    signalTimestamp: request.signalTimestamp,
    decisionTimestamp: request.decisionTimestamp,
    entryTimestamp: null,
    entryDelayMinutes: null,
    entryPriceUsd: null,
    entryPriceSource: null,
    entryDataQuality: "UNAVAILABLE" as DataQualityState,
    positionSizeUsd: null,
    feesUsd: null,
    slippagePct,
  };
}

export async function simulateEntry(
  request: EntrySimulationRequest,
  provider: HistoricalPriceProvider,
  config: EntrySimulatorConfig,
): Promise<BacktestPosition> {
  if (!request.poolAddress) {
    return unavailablePosition(request, config.slippagePct);
  }

  const decisionMs = new Date(request.decisionTimestamp).getTime();
  if (Number.isNaN(decisionMs)) {
    return unavailablePosition(request, config.slippagePct);
  }

  const windowEndMs = decisionMs + config.maxEntryDelayMinutes * 60_000;
  const beforeTimestamp = new Date(windowEndMs).toISOString();
  const limit = Math.max(config.maxEntryDelayMinutes, 1) + CANDLE_FETCH_BUFFER;

  const result = await provider.getCandles(
    request.chainId,
    request.poolAddress,
    beforeTimestamp,
    CANDLE_TIMEFRAME,
    CANDLE_AGGREGATE,
    limit,
  );

  if (result.status !== "ok" || !result.data) {
    return unavailablePosition(request, config.slippagePct);
  }

  // result.data is oldest-first; the earliest candle at/after the decision
  // boundary is the trustworthy fill price — never pick a later, more
  // favorable one.
  const candidate = result.data.find((candle) => new Date(candle.timestamp).getTime() >= decisionMs);
  if (!candidate) {
    return unavailablePosition(request, config.slippagePct);
  }

  const entryDelayMinutes = (new Date(candidate.timestamp).getTime() - decisionMs) / 60_000;
  if (entryDelayMinutes > config.maxEntryDelayMinutes) {
    return unavailablePosition(request, config.slippagePct);
  }

  return {
    signalId: request.signalId,
    signalTimestamp: request.signalTimestamp,
    decisionTimestamp: request.decisionTimestamp,
    entryTimestamp: candidate.timestamp,
    entryDelayMinutes,
    entryPriceUsd: candidate.openUsd,
    entryPriceSource: provider.name,
    entryDataQuality: "KNOWN" as DataQualityState,
    positionSizeUsd: config.positionSizeUsd,
    feesUsd: config.positionSizeUsd * (config.feePct / 100),
    slippagePct: config.slippagePct,
  };
}

/** Effective per-unit entry cost including slippage — used by the exit/outcome simulator and portfolio simulator, never entryPriceUsd alone. */
export function effectiveEntryPriceUsd(position: BacktestPosition): number | null {
  if (position.entryPriceUsd === null) return null;
  return position.entryPriceUsd * (1 + position.slippagePct / 100);
}
