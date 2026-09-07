// Phase 7 §16 — aggregate latency statistics across many processed
// signals. The single most important number this produces is
// `scoutToPaperEntry`: Scout signal timestamp -> paper entry timestamp.

import type { LatencyStats, LifecycleEvent, LiveSignalLifecycleStage, LivePipelineLatencyReport, LiveSignalRecord } from "../types/domain.js";

export function computeLatencyStats(valuesMs: number[]): LatencyStats {
  if (valuesMs.length === 0) {
    return { count: 0, averageMs: null, medianMs: null, p95Ms: null, maxMs: null };
  }
  const sorted = [...valuesMs].sort((a, b) => a - b);
  const averageMs = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const mid = Math.floor(sorted.length / 2);
  const medianMs = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const p95Index = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
  const p95Ms = sorted[p95Index];
  const maxMs = sorted[sorted.length - 1];
  return { count: sorted.length, averageMs, medianMs, p95Ms, maxMs };
}

function eventTimestampMs(events: LifecycleEvent[], stage: LiveSignalLifecycleStage): number | null {
  const event = events.find((e) => e.stage === stage);
  return event ? new Date(event.timestamp).getTime() : null;
}

function stageTransitionLabel(from: LiveSignalLifecycleStage, to: LiveSignalLifecycleStage): string {
  return `${from}->${to}`;
}

export function buildLatencyReport(records: LiveSignalRecord[]): LivePipelineLatencyReport {
  const scoutToPaperEntryMs: number[] = [];
  const scoutToDecisionMs: number[] = [];
  const byStageTransitionMs = new Map<string, number[]>();
  const byProviderMs = new Map<string, number[]>();

  for (const record of records) {
    const receivedMs = eventTimestampMs(record.events, "RECEIVED");
    const paperEntryMs = eventTimestampMs(record.events, "PAPER_ENTRY");
    const decisionMs = eventTimestampMs(record.events, "PAPER_DECISION");

    if (receivedMs !== null && paperEntryMs !== null) scoutToPaperEntryMs.push(paperEntryMs - receivedMs);
    if (receivedMs !== null && decisionMs !== null) scoutToDecisionMs.push(decisionMs - receivedMs);

    for (let i = 1; i < record.events.length; i += 1) {
      const previous = record.events[i - 1];
      const current = record.events[i];
      if (current.durationMsSincePrevious === null) continue;
      const label = stageTransitionLabel(previous.stage, current.stage);
      const bucket = byStageTransitionMs.get(label) ?? [];
      bucket.push(current.durationMsSincePrevious);
      byStageTransitionMs.set(label, bucket);
    }

    for (const call of record.providerCalls) {
      const bucket = byProviderMs.get(call.provider) ?? [];
      bucket.push(call.durationMs);
      byProviderMs.set(call.provider, bucket);
    }
  }

  const byStageTransition: Record<string, LatencyStats> = {};
  for (const [label, values] of byStageTransitionMs) byStageTransition[label] = computeLatencyStats(values);

  const byProvider: Record<string, LatencyStats> = {};
  for (const [provider, values] of byProviderMs) byProvider[provider] = computeLatencyStats(values);

  return {
    generatedAt: new Date().toISOString(),
    sampleCount: records.length,
    scoutToPaperEntry: computeLatencyStats(scoutToPaperEntryMs),
    scoutToDecision: computeLatencyStats(scoutToDecisionMs),
    byStageTransition,
    byProvider,
  };
}
