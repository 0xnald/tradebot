// Phase 6 §9/§10 — capital-constrained portfolio simulation. This is the
// "portfolio-constrained mode" for overlapping signals: a fixed-%-of-capital
// position sizer with a hard cap on concurrent positions, no leverage, and
// no compounding unless explicitly configured. The independent-return mode
// (each signal scored on its own, ignoring capital limits) is what
// metricsCalculator computes directly from BacktestOutcome — this module is
// the separate, explicitly-labeled portfolio view. Default when signals
// compete for capital: earliest decisionTimestamp wins a free slot; a later
// signal that arrives when capital or concurrency is exhausted is recorded
// as skipped, never silently downsized or queued.
//
// Equity is tracked at cost basis for open positions (no intraday
// mark-to-market on live price — a documented simplification since this
// phase does not track continuous price paths for every open position
// simultaneously); PnL is only realized when a position closes.

import type { BacktestCohort, EquityCurvePoint, PortfolioSimulationResult } from "../types/domain.js";

export interface PortfolioSimulatorConfig {
  startingCapitalUsd: number;
  positionSizePct: number;
  maxConcurrentPositions: number;
  allowCompounding: boolean;
  assumedHoldingPeriodMinutes: number;
  slippagePct: number;
  feePct: number;
}

export interface PortfolioSignalInput {
  signalId: string;
  decisionTimestamp: string;
  hasValidEntry: boolean;
  /** The market return from BacktestOutcome.finalReturnPct — null when no valid exit could be reconstructed (excluded, never treated as a 0% trade). */
  finalReturnPct: number | null;
}

interface OpenPosition {
  signalId: string;
  closeAtMs: number;
  sizeUsd: number;
  netReturnPct: number;
}

export function simulatePortfolio(
  signals: PortfolioSignalInput[],
  cohort: BacktestCohort,
  config: PortfolioSimulatorConfig,
): PortfolioSimulationResult {
  const sorted = [...signals].sort((a, b) => new Date(a.decisionTimestamp).getTime() - new Date(b.decisionTimestamp).getTime());

  let capital = config.startingCapitalUsd;
  const openPositions: OpenPosition[] = [];
  const equityCurve: EquityCurvePoint[] = [];
  let tradesTaken = 0;
  let tradesSkippedForCapitalConstraint = 0;
  let peakEquityUsd = config.startingCapitalUsd;
  let maxDrawdownPct = 0;
  const utilizationSamples: number[] = [];

  function recordEquityPoint(timestamp: string): void {
    const openValueUsd = openPositions.reduce((sum, p) => sum + p.sizeUsd, 0);
    const equityUsd = capital + openValueUsd;
    equityCurve.push({ timestamp, equityUsd, openPositions: openPositions.length });
    peakEquityUsd = Math.max(peakEquityUsd, equityUsd);
    const drawdownPct = peakEquityUsd > 0 ? ((equityUsd - peakEquityUsd) / peakEquityUsd) * 100 : 0;
    maxDrawdownPct = Math.min(maxDrawdownPct, drawdownPct);
    utilizationSamples.push(equityUsd > 0 ? (openValueUsd / equityUsd) * 100 : 0);
  }

  function closeDuePositions(nowMs: number, timestamp: string): void {
    let closedAny = false;
    for (let i = openPositions.length - 1; i >= 0; i -= 1) {
      const position = openPositions[i];
      if (position.closeAtMs <= nowMs) {
        capital += position.sizeUsd * (1 + position.netReturnPct / 100);
        openPositions.splice(i, 1);
        closedAny = true;
      }
    }
    if (closedAny) recordEquityPoint(timestamp);
  }

  for (const signal of sorted) {
    const nowMs = new Date(signal.decisionTimestamp).getTime();
    closeDuePositions(nowMs, signal.decisionTimestamp);

    if (!signal.hasValidEntry || signal.finalReturnPct === null) continue; // no reconstructable outcome — not a capital-constraint skip

    const sizingBasis = config.allowCompounding ? capital : config.startingCapitalUsd;
    const sizeUsd = sizingBasis * (config.positionSizePct / 100);

    if (openPositions.length >= config.maxConcurrentPositions || sizeUsd > capital) {
      tradesSkippedForCapitalConstraint += 1;
      continue;
    }

    capital -= sizeUsd;
    // Round-trip execution cost (entry+exit slippage and fees) collapsed into a single deduction from the market return — see docs/BACKTESTING.md.
    const netReturnPct = signal.finalReturnPct - config.slippagePct - config.feePct;
    openPositions.push({
      signalId: signal.signalId,
      closeAtMs: nowMs + config.assumedHoldingPeriodMinutes * 60_000,
      sizeUsd,
      netReturnPct,
    });
    tradesTaken += 1;
    recordEquityPoint(signal.decisionTimestamp);
  }

  // Force-close whatever is still open at the end of the signal stream, in the order each position was scheduled to close.
  const stillOpen = [...openPositions].sort((a, b) => a.closeAtMs - b.closeAtMs);
  for (const position of stillOpen) {
    capital += position.sizeUsd * (1 + position.netReturnPct / 100);
    const idx = openPositions.findIndex((p) => p.signalId === position.signalId && p.closeAtMs === position.closeAtMs);
    if (idx >= 0) openPositions.splice(idx, 1);
    recordEquityPoint(new Date(position.closeAtMs).toISOString());
  }

  const averageCapitalUtilizationPct = utilizationSamples.length
    ? utilizationSamples.reduce((a, b) => a + b, 0) / utilizationSamples.length
    : 0;

  return {
    cohort,
    startingCapitalUsd: config.startingCapitalUsd,
    endingCapitalUsd: capital,
    realizedPnlUsd: capital - config.startingCapitalUsd,
    peakEquityUsd,
    maxDrawdownPct,
    averageCapitalUtilizationPct,
    tradesTaken,
    tradesSkippedForCapitalConstraint,
    equityCurve,
  };
}
