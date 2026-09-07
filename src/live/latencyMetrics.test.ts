import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLatencyStats, buildLatencyReport } from "./latencyMetrics.js";
import type { LiveSignalRecord, LifecycleEvent } from "../types/domain.js";

test("computeLatencyStats returns all-null for an empty sample", () => {
  const stats = computeLatencyStats([]);
  assert.equal(stats.count, 0);
  assert.equal(stats.averageMs, null);
  assert.equal(stats.medianMs, null);
  assert.equal(stats.p95Ms, null);
  assert.equal(stats.maxMs, null);
});

test("computeLatencyStats computes average/median/max for a simple sample", () => {
  const stats = computeLatencyStats([100, 200, 300]);
  assert.equal(stats.count, 3);
  assert.equal(stats.averageMs, 200);
  assert.equal(stats.medianMs, 200);
  assert.equal(stats.maxMs, 300);
});

test("computeLatencyStats computes median correctly for an even-sized sample", () => {
  const stats = computeLatencyStats([100, 200, 300, 400]);
  assert.equal(stats.medianMs, 250);
});

test("computeLatencyStats computes a plausible p95 for a larger sample", () => {
  const values = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
  const stats = computeLatencyStats(values);
  assert.equal(stats.p95Ms, 95);
  assert.equal(stats.maxMs, 100);
});

function event(stage: LifecycleEvent["stage"], timestamp: string, durationMsSincePrevious: number | null = null): LifecycleEvent {
  return { signalId: "s1", stage, timestamp, durationMsSincePrevious, status: "OK" };
}

function record(events: LifecycleEvent[], providerCalls: LiveSignalRecord["providerCalls"] = []): LiveSignalRecord {
  return {
    signalId: "s1",
    source: "telegram:scoutrobinhood",
    sourceMessageId: "1",
    tokenSymbol: "TEST",
    contractAddress: "0xabc",
    scoutTimestamp: "2026-09-06T12:00:00.000Z",
    receivedAt: "2026-09-06T12:00:00.100Z",
    events,
    currentStage: events[events.length - 1]?.stage ?? "RECEIVED",
    rejectionReason: null,
    venueType: null,
    marketDataQuality: "PARTIAL",
    smartSelectionResultId: null,
    overallScore: null,
    confidence: null,
    confidenceBreakdown: null,
    dataQuality: null,
    decision: null,
    paperPositionId: null,
    providerCalls,
  };
}

test("buildLatencyReport computes scoutToPaperEntry from RECEIVED to PAPER_ENTRY", () => {
  const records = [
    record([event("RECEIVED", "2026-09-06T12:00:00.000Z"), event("PAPER_ENTRY", "2026-09-06T12:00:02.000Z", 2000)]),
  ];
  const report = buildLatencyReport(records);
  assert.equal(report.scoutToPaperEntry.count, 1);
  assert.equal(report.scoutToPaperEntry.averageMs, 2000);
});

test("buildLatencyReport excludes records that never reached PAPER_ENTRY from that metric", () => {
  const records = [
    record([event("RECEIVED", "2026-09-06T12:00:00.000Z"), event("REJECTED", "2026-09-06T12:00:00.500Z", 500)]),
  ];
  const report = buildLatencyReport(records);
  assert.equal(report.scoutToPaperEntry.count, 0);
});

test("buildLatencyReport computes scoutToDecision independently of scoutToPaperEntry", () => {
  const records = [
    record([
      event("RECEIVED", "2026-09-06T12:00:00.000Z"),
      event("PAPER_DECISION", "2026-09-06T12:00:01.000Z", 1000),
    ]),
  ];
  const report = buildLatencyReport(records);
  assert.equal(report.scoutToDecision.count, 1);
  assert.equal(report.scoutToDecision.averageMs, 1000);
  assert.equal(report.scoutToPaperEntry.count, 0);
});

test("buildLatencyReport buckets stage-transition durations by transition label", () => {
  const records = [
    record([
      event("RECEIVED", "2026-09-06T12:00:00.000Z"),
      event("PARSED", "2026-09-06T12:00:00.100Z", 100),
      event("VALIDATED", "2026-09-06T12:00:00.300Z", 200),
    ]),
  ];
  const report = buildLatencyReport(records);
  assert.equal(report.byStageTransition["RECEIVED->PARSED"].averageMs, 100);
  assert.equal(report.byStageTransition["PARSED->VALIDATED"].averageMs, 200);
});

test("buildLatencyReport buckets provider-call durations by provider name across records", () => {
  const records = [
    record([event("RECEIVED", "2026-09-06T12:00:00.000Z")], [{ provider: "pons-v2-onchain", status: "OK", durationMs: 120 }]),
    record([event("RECEIVED", "2026-09-06T12:00:00.000Z")], [{ provider: "pons-v2-onchain", status: "OK", durationMs: 80 }]),
  ];
  const report = buildLatencyReport(records);
  assert.equal(report.byProvider["pons-v2-onchain"].count, 2);
  assert.equal(report.byProvider["pons-v2-onchain"].averageMs, 100);
});

test("buildLatencyReport handles an empty record set without throwing", () => {
  const report = buildLatencyReport([]);
  assert.equal(report.sampleCount, 0);
  assert.equal(report.scoutToPaperEntry.count, 0);
});
