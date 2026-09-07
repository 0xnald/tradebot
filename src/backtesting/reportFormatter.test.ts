import { test } from "node:test";
import assert from "node:assert/strict";
import { formatBacktestReport } from "./reportFormatter.js";
import type { BacktestRun } from "../types/domain.js";

function emptyRun(): BacktestRun {
  return {
    id: "run-1",
    runAt: "2026-09-05T00:00:00.000Z",
    datasetId: "ds-1",
    datasetSize: 0,
    signals: [],
    config: {
      configVersion: "v1",
      smartSelectionConfigVersion: "v1",
      maxEntryDelayMinutes: 5,
      slippagePct: 1,
      feePct: 0.5,
      horizons: ["5m"],
      takeProfitPct: null,
      stopLossPct: null,
      treatWatchAsTrade: false,
      portfolio: { startingCapitalUsd: 1000, positionSizePct: 10, maxConcurrentPositions: 3, allowCompounding: false, assumedHoldingPeriodMinutes: 60 },
    },
    dataAvailability: {
      datasetSize: 0,
      usableSignals: 0,
      completeFeatureReconstructionCount: 0,
      validEntryCount: 0,
      validExitCount: 0,
      missingByField: {},
      notes: ["Dataset is empty — no signals were evaluated."],
    },
    metricsByCohort: [],
    selectionLift: [],
    scoreBuckets: [],
    confidenceBuckets: [],
    chaseRiskBuckets: [],
    portfolioResults: [],
    assumptions: ["No signals were available."],
  };
}

test("formats a report for an empty run without throwing", () => {
  const report = formatBacktestReport(emptyRun());
  assert.ok(report.includes("SCOUT ALPHA"));
  assert.ok(report.includes("0 eligible signal"));
  assert.ok(report.includes("No lift computed."));
});

test("report is plain text with no marketing language markers", () => {
  const report = formatBacktestReport(emptyRun());
  assert.ok(!/amazing|guaranteed|profitable strategy/i.test(report));
});

test("includes a per-signal reconstruction trace showing venue, graduation state, and outcome", () => {
  const run = emptyRun();
  run.signals = [
    {
      signalId: "s1",
      source: "telegram:scoutrobinhood",
      sourceMessageId: "1",
      contractAddress: "0xabc",
      tokenSymbol: "THROBBIN",
      signalTimestamp: "t",
      decisionTimestamp: "t",
      reconstructedFields: [],
      unavailableFields: [],
      lookaheadViolations: [],
      dataQuality: "PARTIAL",
      marketResolution: {
        signalId: "s1",
        venueType: "PONS_V2_V4_POOL",
        venueIdentifier: "0xpoolid",
        graduationPhase: "POOL_CREATED",
        graduationTimestamp: "t",
        usedPreGraduationVenue: false,
        failureReason: null,
        reconstructionMethod: "ONCHAIN_EVENT",
        notes: [],
      },
    },
  ];
  const report = formatBacktestReport(run);
  assert.ok(report.includes("THROBBIN"));
  assert.ok(report.includes("PONS_V2_V4_POOL"));
  assert.ok(report.includes("POOL_CREATED"));
  assert.ok(report.includes("post-graduation"));
  assert.ok(report.includes("ONCHAIN_EVENT"));
});
