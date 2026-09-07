// Phase 6 — the orchestrator. Wires together signal reconstruction, the
// REAL Phase 5 SmartSelectionEngine (never reimplemented here), entry/exit
// simulation, and metrics/lift/bucket/portfolio computation into one
// persisted, reproducible BacktestRun.

import { randomUUID } from "node:crypto";
import { SmartSelectionEngine, type SmartSelectionInputs } from "../scoring/smartSelectionEngine.js";
import { SMART_SELECTION_V1_CONFIG } from "../scoring/smartSelectionConfig.js";
import { reconstructSignal, type SignalReconstructionDeps } from "./signalReconstructor.js";
import { simulateEntry } from "./entrySimulator.js";
import { simulateExit } from "./exitOutcomeSimulator.js";
import { buildDataAvailabilityReport } from "./dataAvailabilityReporter.js";
import {
  computeBacktestMetrics,
  computeChaseRiskBuckets,
  computeConfidenceBuckets,
  computeScoreBuckets,
  computeSelectionLift,
  extractReturnPct,
  type BacktestRecord,
} from "./metricsCalculator.js";
import { simulatePortfolio, type PortfolioSignalInput } from "./portfolioSimulator.js";
import type {
  BacktestCohort,
  BacktestConfig,
  BacktestDataset,
  BacktestOutcome,
  BacktestPosition,
  BacktestRun,
  BacktestSignal,
  HistoricalHorizonLabel,
  PortfolioSimulationResult,
  ScoutSignal,
  SmartSelectionConfig,
} from "../types/domain.js";

const COHORTS: BacktestCohort[] = ["RAW_SCOUT_BASELINE", "TRADE_CANDIDATE", "WATCH"];

export interface BacktestRunnerDeps extends SignalReconstructionDeps {
  smartSelectionConfig?: SmartSelectionConfig;
}

/**
 * Only EARLY_CALL messages with a recovered contract address are new entry
 * opportunities — PERFORMANCE_UPDATE messages describe a token already
 * called earlier and are not a fresh decision point. Excluded here, not
 * silently dropped: callers should report how many were excluded and why.
 */
export function selectEligibleSignals(signals: ScoutSignal[]): ScoutSignal[] {
  return signals.filter((s) => s.messageType === "EARLY_CALL" && Boolean(s.contractAddress));
}

function inCohort(record: BacktestRecord, cohort: BacktestCohort): boolean {
  return cohort === "RAW_SCOUT_BASELINE" || record.decision === cohort;
}

function buildAssumptions(config: BacktestConfig): string[] {
  return [
    `Entry: earliest trustworthy candle at/after the decision timestamp, within ${config.maxEntryDelayMinutes} minute(s) — never a later, more favorable price.`,
    `Execution costs: ${config.slippagePct}% slippage + ${config.feePct}% fee, deducted once per round trip.`,
    config.takeProfitPct !== null ? `Take-profit: +${config.takeProfitPct}%.` : "No take-profit configured.",
    config.stopLossPct !== null ? `Stop-loss: -${config.stopLossPct}%.` : "No stop-loss configured.",
    `Horizons evaluated: ${config.horizons.join(", ")}.`,
    `Portfolio: $${config.portfolio.startingCapitalUsd} starting capital, ${config.portfolio.positionSizePct}% per position, max ${config.portfolio.maxConcurrentPositions} concurrent positions, compounding ${config.portfolio.allowCompounding ? "ON" : "OFF"}.`,
    "Smart Selection ran with its real, unmodified production config — no parameter was tuned to improve these results.",
    "Only price/volume are historically reconstructable for this dataset (via GeckoTerminal candles); liquidity, holder distribution, contract features, deployer analysis, and wallet performance have no verified historical point-in-time source and were left UNAVAILABLE, never substituted with current values.",
    "WATCH is a counterfactual cohort only — no capital is assumed committed to WATCH signals in a live system; it is reported here purely to show what Smart Selection would have flagged as 'worth monitoring'.",
  ];
}

export async function runBacktest(
  dataset: BacktestDataset,
  scoutSignals: ScoutSignal[],
  config: BacktestConfig,
  deps: BacktestRunnerDeps,
): Promise<BacktestRun> {
  const eligibleSignals = selectEligibleSignals(scoutSignals);
  const excludedCount = scoutSignals.length - eligibleSignals.length;

  const engine = new SmartSelectionEngine(deps.smartSelectionConfig ?? SMART_SELECTION_V1_CONFIG);

  const backtestSignals: BacktestSignal[] = [];
  const positions: BacktestPosition[] = [];
  const outcomes: BacktestOutcome[] = [];
  const records: BacktestRecord[] = [];

  for (const scoutSignal of eligibleSignals) {
    const { backtestSignal, smartSelectionInputs, poolAddress, historicalPriceProvider } = await reconstructSignal(scoutSignal, deps);
    backtestSignals.push(backtestSignal);

    const decisionResult = engine.evaluate(smartSelectionInputs as SmartSelectionInputs, new Date(backtestSignal.decisionTimestamp));

    // Reuses the SAME per-signal provider (on-chain reconstruction tier(s) + GeckoTerminal
    // fallback, in that documented order) that resolved the decision-time price — not the raw
    // shared GeckoTerminal provider — so entry/exit simulation benefits from the same
    // reconstruction hierarchy. See docs/BACKTESTING.md.
    const flatPositionSizeUsd = (config.portfolio.startingCapitalUsd * config.portfolio.positionSizePct) / 100;
    const position = await simulateEntry(
      {
        signalId: backtestSignal.signalId,
        signalTimestamp: backtestSignal.signalTimestamp,
        decisionTimestamp: backtestSignal.decisionTimestamp,
        chainId: deps.chainId,
        poolAddress,
      },
      historicalPriceProvider,
      {
        maxEntryDelayMinutes: config.maxEntryDelayMinutes,
        slippagePct: config.slippagePct,
        feePct: config.feePct,
        positionSizeUsd: flatPositionSizeUsd,
      },
    );
    positions.push(position);

    const outcome = await simulateExit(
      {
        signalId: backtestSignal.signalId,
        chainId: deps.chainId,
        poolAddress,
        entryTimestamp: position.entryTimestamp,
        entryPriceUsd: position.entryPriceUsd,
      },
      historicalPriceProvider,
      { horizons: config.horizons, takeProfitPct: config.takeProfitPct, stopLossPct: config.stopLossPct },
    );
    outcomes.push(outcome);

    records.push({
      signalId: backtestSignal.signalId,
      decisionTimestamp: backtestSignal.decisionTimestamp,
      decision: decisionResult.decision,
      overallScore: decisionResult.overallScore,
      confidence: decisionResult.confidence,
      chaseRisk: decisionResult.chaseAssessment.level,
      outcome,
    });
  }

  const dataAvailability = buildDataAvailabilityReport(backtestSignals, positions, outcomes);
  if (excludedCount > 0) {
    dataAvailability.notes.push(
      `${excludedCount} PERFORMANCE_UPDATE message(s) were excluded from the eligible signal set — they describe a token already called earlier, not a fresh entry decision.`,
    );
  }

  const horizonsPlusFinal: (HistoricalHorizonLabel | "final")[] = [...config.horizons, "final"];

  const metricsByCohort = COHORTS.flatMap((cohort) => horizonsPlusFinal.map((horizon) => computeBacktestMetrics(records, cohort, horizon)));
  const selectionLift = horizonsPlusFinal.map((horizon) => computeSelectionLift(records, horizon));
  const scoreBuckets = computeScoreBuckets(records, "final");
  const confidenceBuckets = computeConfidenceBuckets(records, "final");
  const chaseRiskBuckets = computeChaseRiskBuckets(records, "final");

  const portfolioResults: PortfolioSimulationResult[] = COHORTS.map((cohort) => {
    const cohortInputs: PortfolioSignalInput[] = records
      .filter((r) => inCohort(r, cohort))
      .map((r) => ({
        signalId: r.signalId,
        decisionTimestamp: r.decisionTimestamp,
        hasValidEntry: r.outcome.hasValidEntry,
        finalReturnPct: extractReturnPct(r.outcome, "final"),
      }));
    return simulatePortfolio(cohortInputs, cohort, {
      startingCapitalUsd: config.portfolio.startingCapitalUsd,
      positionSizePct: config.portfolio.positionSizePct,
      maxConcurrentPositions: config.portfolio.maxConcurrentPositions,
      allowCompounding: config.portfolio.allowCompounding,
      assumedHoldingPeriodMinutes: config.portfolio.assumedHoldingPeriodMinutes,
      slippagePct: config.slippagePct,
      feePct: config.feePct,
    });
  });

  return {
    id: randomUUID(),
    runAt: new Date().toISOString(),
    datasetId: dataset.id,
    datasetSize: backtestSignals.length,
    config,
    signals: backtestSignals,
    dataAvailability,
    metricsByCohort,
    selectionLift,
    scoreBuckets,
    confidenceBuckets,
    chaseRiskBuckets,
    portfolioResults,
    assumptions: buildAssumptions(config),
  };
}
