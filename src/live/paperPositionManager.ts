// Phase 7 §10/§11 — continuous monitoring for open paper positions. Never
// acts on a stale or unavailable price: a position whose latest price
// observation is stale or missing is left open with an honestly-labeled
// snapshot, not silently closed (or kept open) based on an old number.
// All exits here are paper simulations — no real transaction is ever
// involved.

import type { CurrentPriceResult } from "./currentPriceResolver.js";
import type { PaperPortfolio } from "./paperPortfolio.js";
import type { ExitReason, LivePaperPosition, PaperMarketStatus, PaperPositionSnapshot } from "../types/domain.js";

export interface PositionMonitorDeps {
  resolvePrice: (contractAddress: string, chainId: number) => Promise<CurrentPriceResult>;
  portfolio: PaperPortfolio;
  now?: () => Date;
}

export interface PollPositionResult {
  position: LivePaperPosition;
  snapshot: PaperPositionSnapshot;
  closed: boolean;
}

/**
 * Rounds away floating-point noise (e.g. `(0.8 - 1) / 1 * 100` is
 * `-19.999999999999996` in IEEE 754, not exactly `-20`) before any
 * threshold comparison — without this, an exact stop-loss/take-profit
 * level can silently fail to trigger due to representation error alone.
 */
function computeReturnPct(currentPriceUsd: number, entryPriceUsd: number): number {
  return Math.round(((currentPriceUsd - entryPriceUsd) / entryPriceUsd) * 100 * 1e8) / 1e8;
}

/** Only ever called with a KNOWN, non-stale current price — see pollPosition's guard below. */
export function evaluateExit(
  position: LivePaperPosition,
  currentPriceUsd: number,
  ageSeconds: number,
  liquidityUsd: number | null,
  liquidityEmergencyExitUsd: number | null,
): ExitReason | null {
  const returnPct = computeReturnPct(currentPriceUsd, position.execution.entryPriceUsd);

  if (position.takeProfitPct !== null && returnPct >= position.takeProfitPct) return "TAKE_PROFIT";
  if (position.stopLossPct !== null && returnPct <= -position.stopLossPct) return "STOP_LOSS";
  if (position.maxHoldingMinutes !== null && ageSeconds >= position.maxHoldingMinutes * 60) return "MAX_HOLDING_TIME";
  if (liquidityEmergencyExitUsd !== null && liquidityUsd !== null && liquidityUsd < liquidityEmergencyExitUsd) return "LIQUIDITY_EMERGENCY";
  return null;
}

function closePosition(position: LivePaperPosition, exitPriceUsd: number, exitReason: ExitReason, portfolio: PaperPortfolio, now: Date): LivePaperPosition {
  const returnPct = computeReturnPct(exitPriceUsd, position.execution.entryPriceUsd);
  // Entry fee already deducted when the position opened; this models one additional exit-side fee at the same rate.
  const exitFeesUsd = position.execution.positionSizeUsd * (position.execution.feePct / 100);
  const realizedPnlUsd = position.execution.positionSizeUsd * (returnPct / 100) - exitFeesUsd;

  portfolio.closePosition(position.execution.positionSizeUsd, realizedPnlUsd);

  return {
    ...position,
    status: "CLOSED",
    closedAt: now.toISOString(),
    exitPriceUsd,
    exitReason,
    realizedPnlUsd,
    realizedReturnPct: returnPct,
  };
}

export async function pollPosition(position: LivePaperPosition, deps: PositionMonitorDeps): Promise<PollPositionResult> {
  const priceResult = await deps.resolvePrice(position.contractAddress, position.chainId);
  const now = deps.now?.() ?? new Date();
  const ageSeconds = (now.getTime() - new Date(position.execution.entryTimestamp).getTime()) / 1000;
  const config = deps.portfolio.config;

  const priceAgeSeconds = (now.getTime() - new Date(priceResult.observedAt).getTime()) / 1000;
  const isStale = priceResult.priceUsd !== null && priceAgeSeconds > config.priceStalenessSeconds;

  let marketStatus: PaperMarketStatus;
  if (priceResult.priceUsd === null) marketStatus = "UNKNOWN";
  else if (isStale) marketStatus = "STALE_PRICE";
  else if (priceResult.liquidityUsd === null) marketStatus = "NO_LIQUIDITY_DATA";
  else marketStatus = "ACTIVE";

  const returnPct = priceResult.priceUsd !== null && !isStale ? computeReturnPct(priceResult.priceUsd, position.execution.entryPriceUsd) : null;
  const pnlUsd = returnPct !== null ? position.execution.positionSizeUsd * (returnPct / 100) : null;

  const previousMfe = position.latestSnapshot?.maxFavorableExcursionPct ?? 0;
  const previousMae = position.latestSnapshot?.maxAdverseExcursionPct ?? 0;
  const maxFavorableExcursionPct = returnPct !== null ? Math.max(previousMfe, returnPct) : previousMfe;
  const maxAdverseExcursionPct = returnPct !== null ? Math.min(previousMae, returnPct) : previousMae;

  const snapshot: PaperPositionSnapshot = {
    positionId: position.id,
    observedAt: now.toISOString(),
    priceUsd: priceResult.priceUsd,
    priceSource: priceResult.source,
    priceDataQuality: isStale ? "STALE" : priceResult.dataQuality,
    pnlUsd,
    returnPct,
    maxFavorableExcursionPct,
    maxAdverseExcursionPct,
    ageSeconds,
    liquidityUsd: priceResult.liquidityUsd,
    marketStatus,
  };

  const updatedPosition: LivePaperPosition = { ...position, latestSnapshot: snapshot };

  // Only ever evaluate exits against a KNOWN, non-stale price — a stale or unavailable price never triggers (or blocks) an exit.
  if ((marketStatus === "ACTIVE" || marketStatus === "NO_LIQUIDITY_DATA") && priceResult.priceUsd !== null) {
    const exitReason = evaluateExit(updatedPosition, priceResult.priceUsd, ageSeconds, priceResult.liquidityUsd, config.liquidityEmergencyExitUsd);
    if (exitReason) {
      const closed = closePosition(updatedPosition, priceResult.priceUsd, exitReason, deps.portfolio, now);
      return { position: closed, snapshot, closed: true };
    }
  }

  return { position: updatedPosition, snapshot, closed: false };
}
