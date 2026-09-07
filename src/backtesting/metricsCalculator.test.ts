import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeBacktestMetrics,
  computeSelectionLift,
  computeScoreBuckets,
  computeConfidenceBuckets,
  computeChaseRiskBuckets,
  extractReturnPct,
  type BacktestRecord,
} from "./metricsCalculator.js";
import type { BacktestOutcome, SmartSelectionDecision, ChaseRiskClassification } from "../types/domain.js";

function outcome(finalReturnPct: number | null, opts: Partial<BacktestOutcome> = {}): BacktestOutcome {
  return {
    signalId: "sig",
    hasValidEntry: finalReturnPct !== null,
    hasValidExit: finalReturnPct !== null,
    maxFavorableExcursionPct: null,
    maxAdverseExcursionPct: null,
    returnsByHorizon: finalReturnPct !== null ? [{ horizon: "5m", returnPct: finalReturnPct, priceUsd: 1, observedAt: "t", dataQuality: "KNOWN" }] : [],
    takeProfitResult: null,
    stopLossResult: null,
    finalReturnPct,
    finalExitTimestamp: finalReturnPct !== null ? "t" : null,
    finalExitPriceUsd: finalReturnPct !== null ? 1 : null,
    candleOrderingAmbiguous: false,
    dataQuality: finalReturnPct !== null ? "KNOWN" : "UNAVAILABLE",
    notes: [],
    ...opts,
  };
}

function record(
  signalId: string,
  decision: SmartSelectionDecision,
  finalReturnPct: number | null,
  opts: { overallScore?: number; confidence?: number; chaseRisk?: ChaseRiskClassification; decisionTimestamp?: string } = {},
): BacktestRecord {
  return {
    signalId,
    decisionTimestamp: opts.decisionTimestamp ?? new Date(Date.UTC(2026, 8, 4, 20, Number.parseInt(signalId, 10) || 0)).toISOString(),
    decision,
    overallScore: opts.overallScore ?? 50,
    confidence: opts.confidence ?? 50,
    chaseRisk: opts.chaseRisk ?? "LOW_CHASE_RISK",
    outcome: outcome(finalReturnPct),
  };
}

test("extractReturnPct('final') requires hasValidExit, never returns a value for an incomplete outcome", () => {
  assert.equal(extractReturnPct(outcome(5), "final"), 5);
  assert.equal(extractReturnPct(outcome(null), "final"), null);
});

test("extractReturnPct(horizon) only accepts a KNOWN-quality horizon return", () => {
  const o = outcome(5);
  o.returnsByHorizon = [{ horizon: "5m", returnPct: 5, priceUsd: 1, observedAt: "t", dataQuality: "PARTIAL" }];
  assert.equal(extractReturnPct(o, "5m"), null);
});

test("RAW_SCOUT_BASELINE cohort includes every eligible signal regardless of decision", () => {
  const records: BacktestRecord[] = [
    record("1", "TRADE_CANDIDATE", 10),
    record("2", "WATCH", -5),
    record("3", "IGNORE", -20),
  ];
  const metrics = computeBacktestMetrics(records, "RAW_SCOUT_BASELINE", "final");
  assert.equal(metrics.totalSignals, 3);
  assert.equal(metrics.usableSignals, 3);
});

test("TRADE_CANDIDATE cohort only includes signals Smart Selection actually chose", () => {
  const records: BacktestRecord[] = [
    record("1", "TRADE_CANDIDATE", 10),
    record("2", "WATCH", -5),
    record("3", "IGNORE", -20),
  ];
  const metrics = computeBacktestMetrics(records, "TRADE_CANDIDATE", "final");
  assert.equal(metrics.totalSignals, 1);
  assert.equal(metrics.averageReturnPct, 10);
});

test("computes win rate, expectancy, and profit factor correctly", () => {
  const records: BacktestRecord[] = [
    record("1", "TRADE_CANDIDATE", 20),
    record("2", "TRADE_CANDIDATE", -10),
    record("3", "TRADE_CANDIDATE", 30),
    record("4", "TRADE_CANDIDATE", -10),
  ];
  const metrics = computeBacktestMetrics(records, "TRADE_CANDIDATE", "final");
  assert.equal(metrics.winCount, 2);
  assert.equal(metrics.lossCount, 2);
  assert.equal(metrics.winRatePct, 50);
  assert.equal(metrics.averageWinnerPct, 25);
  assert.equal(metrics.averageLoserPct, -10);
  assert.equal(metrics.profitFactor, 50 / 20); // grossProfit 50 / grossLoss 20
});

test("an all-win dataset has null profitFactor-denominator behavior handled (no losses => profitFactor null)", () => {
  const records: BacktestRecord[] = [record("1", "TRADE_CANDIDATE", 5), record("2", "TRADE_CANDIDATE", 15)];
  const metrics = computeBacktestMetrics(records, "TRADE_CANDIDATE", "final");
  assert.equal(metrics.lossCount, 0);
  assert.equal(metrics.profitFactor, null);
  assert.equal(metrics.winRatePct, 100);
});

test("an all-loss dataset reports 0% win rate and a defined average loser", () => {
  const records: BacktestRecord[] = [record("1", "TRADE_CANDIDATE", -5), record("2", "TRADE_CANDIDATE", -15)];
  const metrics = computeBacktestMetrics(records, "TRADE_CANDIDATE", "final");
  assert.equal(metrics.winRatePct, 0);
  assert.equal(metrics.averageWinnerPct, null);
  assert.equal(metrics.averageLoserPct, -10);
});

test("a zero-trade cohort returns nulls rather than throwing or dividing by zero", () => {
  const records: BacktestRecord[] = [record("1", "WATCH", 10)];
  const metrics = computeBacktestMetrics(records, "TRADE_CANDIDATE", "final");
  assert.equal(metrics.totalSignals, 0);
  assert.equal(metrics.usableSignals, 0);
  assert.equal(metrics.winRatePct, null);
  assert.equal(metrics.averageReturnPct, null);
  assert.equal(metrics.maxDrawdownPct, null);
});

test("an incomplete dataset (some outcomes UNAVAILABLE) excludes them from usableSignals but keeps totalSignals", () => {
  const records: BacktestRecord[] = [
    record("1", "TRADE_CANDIDATE", 10),
    record("2", "TRADE_CANDIDATE", null),
    record("3", "TRADE_CANDIDATE", -5),
  ];
  const metrics = computeBacktestMetrics(records, "TRADE_CANDIDATE", "final");
  assert.equal(metrics.totalSignals, 3);
  assert.equal(metrics.usableSignals, 2);
});

test("maxDrawdownPct reflects the worst peak-to-trough decline in chronological order", () => {
  const records: BacktestRecord[] = [
    record("1", "TRADE_CANDIDATE", 10, { decisionTimestamp: "2026-09-04T20:00:00.000Z" }),
    record("2", "TRADE_CANDIDATE", -30, { decisionTimestamp: "2026-09-04T20:01:00.000Z" }),
    record("3", "TRADE_CANDIDATE", 5, { decisionTimestamp: "2026-09-04T20:02:00.000Z" }),
  ];
  const metrics = computeBacktestMetrics(records, "TRADE_CANDIDATE", "final");
  // cumulative: 10, -20, -15 ; peak: 10,10,10 ; drawdown: 0,-30,-25 => worst -30
  assert.equal(metrics.maxDrawdownPct, -30);
});

test("selection lift shows a positive expectancy lift when TRADE_CANDIDATE outperforms the raw baseline", () => {
  const records: BacktestRecord[] = [
    record("1", "TRADE_CANDIDATE", 30),
    record("2", "TRADE_CANDIDATE", 20),
    record("3", "IGNORE", -40),
    record("4", "WATCH", -10),
  ];
  const lift = computeSelectionLift(records, "final");
  assert.equal(lift.rawBaselineExpectancyPct, 0); // (30+20-40-10)/4 = 0
  assert.equal(lift.tradeCandidateExpectancyPct, 25); // (30+20)/2
  assert.equal(lift.expectancyLiftPct, 25);
  assert.equal(lift.statisticallyConvincing, false); // tiny sample
});

test("selection lift correctly counts filtered-out profitable and bad opportunities", () => {
  const records: BacktestRecord[] = [
    record("1", "TRADE_CANDIDATE", 30), // profitable, selected
    record("2", "IGNORE", 15), // profitable, filtered out
    record("3", "IGNORE", -25), // bad, correctly filtered out
    record("4", "TRADE_CANDIDATE", -5), // bad, NOT filtered out
  ];
  const lift = computeSelectionLift(records, "final");
  // profitable: signals 1,2 -> filtered out: signal 2 only => 50%
  assert.equal(lift.pctProfitableOpportunitiesFilteredOut, 50);
  // bad: signals 3,4 -> filtered out: signal 3 only => 50%
  assert.equal(lift.pctBadOpportunitiesFilteredOut, 50);
});

test("selection lift is statisticallyConvincing only once both cohorts clear the sample-size floor", () => {
  const records: BacktestRecord[] = Array.from({ length: 40 }, (_, i) =>
    record(`s${i}`, i < 35 ? "TRADE_CANDIDATE" : "IGNORE", i % 2 === 0 ? 10 : -5, {
      decisionTimestamp: new Date(2026, 8, 4, 20, i).toISOString(),
    }),
  );
  const lift = computeSelectionLift(records, "final", 30);
  assert.equal(lift.statisticallyConvincing, true);
});

test("score buckets aggregate by overallScore range and report data completeness", () => {
  const records: BacktestRecord[] = [
    record("1", "TRADE_CANDIDATE", 10, { overallScore: 15 }),
    record("2", "TRADE_CANDIDATE", 20, { overallScore: 22 }),
    record("3", "TRADE_CANDIDATE", null, { overallScore: 25 }),
  ];
  const buckets = computeScoreBuckets(records, "final");
  const lowBucket = buckets.find((b) => b.bucketLabel === "0-19");
  const midBucket = buckets.find((b) => b.bucketLabel === "20-29");
  assert.equal(lowBucket?.sampleCount, 1);
  assert.equal(lowBucket?.averageReturnPct, 10);
  assert.equal(midBucket?.sampleCount, 2);
  assert.equal(midBucket?.dataCompletenessPct, 50); // 1 of 2 has a usable outcome
});

test("confidence buckets use the same numeric ranges as score buckets", () => {
  const records: BacktestRecord[] = [record("1", "TRADE_CANDIDATE", 10, { confidence: 95 })];
  const buckets = computeConfidenceBuckets(records, "final");
  const topBucket = buckets.find((b) => b.bucketLabel === "90-100");
  assert.equal(topBucket?.sampleCount, 1);
});

test("chase-risk buckets group by classification, not by numeric range", () => {
  const records: BacktestRecord[] = [
    record("1", "TRADE_CANDIDATE", 10, { chaseRisk: "HIGH_CHASE_RISK" }),
    record("2", "TRADE_CANDIDATE", -5, { chaseRisk: "LOW_CHASE_RISK" }),
  ];
  const buckets = computeChaseRiskBuckets(records, "final");
  assert.equal(buckets.find((b) => b.bucketLabel === "HIGH_CHASE_RISK")?.sampleCount, 1);
  assert.equal(buckets.find((b) => b.bucketLabel === "LOW_CHASE_RISK")?.sampleCount, 1);
  assert.equal(buckets.find((b) => b.bucketLabel === "MEDIUM_CHASE_RISK")?.sampleCount, 0);
});
