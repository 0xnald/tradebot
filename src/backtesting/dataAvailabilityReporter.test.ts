import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDataAvailabilityReport } from "./dataAvailabilityReporter.js";
import type { BacktestOutcome, BacktestPosition, BacktestSignal } from "../types/domain.js";

function signal(id: string, dataQuality: BacktestSignal["dataQuality"], unavailableFields: string[]): BacktestSignal {
  return {
    signalId: id,
    source: "telegram:scoutrobinhood",
    sourceMessageId: id,
    contractAddress: "0xabc",
    tokenSymbol: "TEST",
    signalTimestamp: "2026-09-04T20:00:00.000Z",
    decisionTimestamp: "2026-09-04T20:00:00.000Z",
    reconstructedFields: [],
    unavailableFields,
    lookaheadViolations: [],
    dataQuality,
  };
}

function position(id: string, entryDataQuality: BacktestPosition["entryDataQuality"]): BacktestPosition {
  return {
    signalId: id,
    signalTimestamp: "t",
    decisionTimestamp: "t",
    entryTimestamp: entryDataQuality === "KNOWN" ? "t" : null,
    entryDelayMinutes: entryDataQuality === "KNOWN" ? 0 : null,
    entryPriceUsd: entryDataQuality === "KNOWN" ? 1 : null,
    entryPriceSource: entryDataQuality === "KNOWN" ? "fake" : null,
    entryDataQuality,
    positionSizeUsd: entryDataQuality === "KNOWN" ? 100 : null,
    feesUsd: entryDataQuality === "KNOWN" ? 1 : null,
    slippagePct: 1,
  };
}

function outcome(id: string, hasValidExit: boolean): BacktestOutcome {
  return {
    signalId: id,
    hasValidEntry: true,
    hasValidExit,
    maxFavorableExcursionPct: null,
    maxAdverseExcursionPct: null,
    returnsByHorizon: [],
    takeProfitResult: null,
    stopLossResult: null,
    finalReturnPct: hasValidExit ? 5 : null,
    finalExitTimestamp: hasValidExit ? "t" : null,
    finalExitPriceUsd: hasValidExit ? 1 : null,
    candleOrderingAmbiguous: false,
    dataQuality: hasValidExit ? "KNOWN" : "UNAVAILABLE",
    notes: [],
  };
}

test("counts usable signals as those not fully UNAVAILABLE", () => {
  const signals = [signal("1", "PARTIAL", ["holderConcentration"]), signal("2", "UNAVAILABLE", ["marketSnapshot"])];
  const report = buildDataAvailabilityReport(signals, [], []);
  assert.equal(report.datasetSize, 2);
  assert.equal(report.usableSignals, 1);
});

test("tallies missingByField across the whole dataset", () => {
  const signals = [
    signal("1", "PARTIAL", ["holderConcentration", "liquidityAnalysis"]),
    signal("2", "PARTIAL", ["holderConcentration"]),
  ];
  const report = buildDataAvailabilityReport(signals, [], []);
  assert.equal(report.missingByField.holderConcentration, 2);
  assert.equal(report.missingByField.liquidityAnalysis, 1);
});

test("counts complete feature reconstructions only when a signal has zero unavailable fields", () => {
  const signals = [signal("1", "KNOWN", []), signal("2", "PARTIAL", ["holderConcentration"])];
  const report = buildDataAvailabilityReport(signals, [], []);
  assert.equal(report.completeFeatureReconstructionCount, 1);
});

test("counts valid entries and exits from positions/outcomes, not from signal dataQuality", () => {
  const signals = [signal("1", "PARTIAL", []), signal("2", "PARTIAL", [])];
  const positions = [position("1", "KNOWN"), position("2", "UNAVAILABLE")];
  const outcomes = [outcome("1", true)];
  const report = buildDataAvailabilityReport(signals, positions, outcomes);
  assert.equal(report.validEntryCount, 1);
  assert.equal(report.validExitCount, 1);
});

test("handles an empty dataset without throwing and says so in notes", () => {
  const report = buildDataAvailabilityReport([], [], []);
  assert.equal(report.datasetSize, 0);
  assert.equal(report.usableSignals, 0);
  assert.ok(report.notes.some((n) => n.includes("empty")));
});

test("flags when no signal achieved a complete feature reconstruction", () => {
  const signals = [signal("1", "PARTIAL", ["holderConcentration"]), signal("2", "PARTIAL", ["liquidityAnalysis"])];
  const report = buildDataAvailabilityReport(signals, [], []);
  assert.ok(report.notes.some((n) => n.includes("no verified historical point-in-time source")));
});
