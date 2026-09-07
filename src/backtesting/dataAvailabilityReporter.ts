// Phase 6 §11 — the honesty backbone: exactly how much of the dataset was
// actually backtestable, broken down by which historical fact was missing.
// Never rounds up, never implies more coverage than what was actually
// reconstructed.

import type { BacktestOutcome, BacktestPosition, BacktestSignal, DataAvailabilityReport } from "../types/domain.js";

export function buildDataAvailabilityReport(
  signals: BacktestSignal[],
  positions: BacktestPosition[],
  outcomes: BacktestOutcome[],
): DataAvailabilityReport {
  const datasetSize = signals.length;
  const usableSignals = signals.filter((s) => s.dataQuality !== "UNAVAILABLE").length;
  const completeFeatureReconstructionCount = signals.filter((s) => s.unavailableFields.length === 0).length;
  const validEntryCount = positions.filter((p) => p.entryDataQuality === "KNOWN").length;
  const validExitCount = outcomes.filter((o) => o.hasValidExit).length;

  const missingByField: Record<string, number> = {};
  for (const signal of signals) {
    for (const field of signal.unavailableFields) {
      missingByField[field] = (missingByField[field] ?? 0) + 1;
    }
  }

  const notes: string[] = [];
  if (datasetSize === 0) {
    notes.push("Dataset is empty — no signals were evaluated.");
  } else {
    const usablePct = (usableSignals / datasetSize) * 100;
    notes.push(`${usableSignals}/${datasetSize} signals (${usablePct.toFixed(1)}%) had at least a reconstructed price and are not fully UNAVAILABLE.`);
    if (completeFeatureReconstructionCount === 0) {
      notes.push(
        "No signal had a fully-complete SmartSelectionInputs reconstruction — liquidity, holder distribution, contract features, deployer analysis, and wallet performance have no verified historical point-in-time source for this dataset (see docs/BACKTESTING.md). Smart Selection scores computed here are based on a materially incomplete feature set compared to a live run.",
      );
    }
    if (validEntryCount < datasetSize) {
      notes.push(`${datasetSize - validEntryCount}/${datasetSize} signals had no valid simulated entry price (no pool resolved, or no historical candle within the configured entry delay).`);
    }
    if (validExitCount < validEntryCount) {
      notes.push(`${validEntryCount - validExitCount}/${validEntryCount} signals with a valid entry still had no valid exit/outcome (insufficient candle coverage after entry).`);
    }
  }

  return {
    datasetSize,
    usableSignals,
    completeFeatureReconstructionCount,
    validEntryCount,
    validExitCount,
    missingByField,
    notes,
  };
}
