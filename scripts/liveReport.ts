// npm run live:report
//
// Phase 7.4 §28 — summarizes ACCUMULATED LIVE observation evidence: the
// data future strategy decisions should be based on, never mixed with
// REPLAY fixture runs (§29 — every record's `mode` field is checked
// explicitly). Read-only.

import { createLiveSignalRecordRepository } from "../src/storage/liveSignalRecordRepository.js";
import { createLivePaperPositionRepository } from "../src/storage/livePaperPositionRepository.js";
import { createWatchObservationRepository } from "../src/storage/watchObservationRepository.js";
import { buildLatencyReport, computeLatencyStats } from "../src/live/latencyMetrics.js";
import type { LiveSignalRecord, SmartSelectionDecision } from "../src/types/domain.js";

function average(values: number[]): number | null {
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

async function main(): Promise<void> {
  const allRecords = await createLiveSignalRecordRepository().list();
  const liveRecords = allRecords.filter((r) => r.mode === "LIVE");
  const replaySkipped = allRecords.length - liveRecords.length;

  const positions = await createLivePaperPositionRepository().list();
  const observations = await createWatchObservationRepository().list();

  console.log("Scout Alpha — LIVE observation report");
  console.log(`(${replaySkipped} REPLAY record(s) excluded — this report covers genuine LIVE Scout activity only)\n`);

  console.log(`New real Scout calls (EARLY_CALL, eligible): ${liveRecords.filter((r) => r.decision !== null).length}`);

  const byDecision: Record<string, LiveSignalRecord[]> = { IGNORE: [], WATCH: [], TRADE_CANDIDATE: [] };
  for (const r of liveRecords) if (r.decision) byDecision[r.decision].push(r);
  console.log(`Decision distribution: IGNORE=${byDecision.IGNORE.length} WATCH=${byDecision.WATCH.length} TRADE_CANDIDATE=${byDecision.TRADE_CANDIDATE.length}`);

  const confidences = liveRecords.map((r) => r.confidence).filter((c): c is number => c !== null);
  console.log(`Average confidence: ${average(confidences)?.toFixed(1) ?? "n/a"} (n=${confidences.length})`);

  const latency = buildLatencyReport(liveRecords);
  console.log(`Decision latency: median=${latency.scoutToDecision.medianMs?.toFixed(0) ?? "n/a"}ms p95=${latency.scoutToDecision.p95Ms?.toFixed(0) ?? "n/a"}ms (n=${latency.scoutToDecision.count})`);

  const flowStates = liveRecords.map((r) => r.dataQuality?.fields.find((f) => f.field === "marketFlow")?.state ?? "n/a");
  const flowCounts = flowStates.reduce((acc: Record<string, number>, s) => { acc[s] = (acc[s] ?? 0) + 1; return acc; }, {});
  console.log(`Market-flow availability: ${JSON.stringify(flowCounts)}`);

  const venueCounts = liveRecords.reduce((acc: Record<string, number>, r) => { const v = r.venueType ?? "n/a"; acc[v] = (acc[v] ?? 0) + 1; return acc; }, {});
  console.log(`Venue distribution: ${JSON.stringify(venueCounts)}`);

  const paperEntries = liveRecords.filter((r) => r.paperPositionId !== null).length;
  console.log(`Paper entries: ${paperEntries}`);

  const failureCounts = liveRecords.flatMap((r) => r.providerCalls).filter((c) => c.status === "ERROR" || c.status === "TIMEOUT").reduce((acc: Record<string, number>, c) => {
    acc[`${c.provider}:${c.status}`] = (acc[`${c.provider}:${c.status}`] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`Provider failure counts: ${JSON.stringify(failureCounts)}`);

  console.log(`\n--- Post-decision observation outcomes (WATCH/TRADE_CANDIDATE) ---`);
  const byDecisionType: Record<SmartSelectionDecision, string[]> = { IGNORE: [], WATCH: [], TRADE_CANDIDATE: [] };
  for (const r of liveRecords) if (r.decision && (r.decision === "WATCH" || r.decision === "TRADE_CANDIDATE")) byDecisionType[r.decision].push(r.signalId);

  for (const decision of ["WATCH", "TRADE_CANDIDATE"] as const) {
    const signalIds = new Set(byDecisionType[decision]);
    const relevantObservations = observations.filter((o) => signalIds.has(o.signalId));
    const byHorizon = relevantObservations.reduce((acc: Record<string, number[]>, o) => {
      const label = o.horizonLabel ?? "unlabeled";
      if (o.returnFromDecisionPct !== null) (acc[label] ??= []).push(o.returnFromDecisionPct);
      return acc;
    }, {});
    console.log(`  ${decision}: ${signalIds.size} signal(s) tracked, ${relevantObservations.length} observation(s)`);
    for (const [horizon, returns] of Object.entries(byHorizon)) {
      const stats = computeLatencyStats(returns); // reused purely for median/avg/p95 math, not a latency value here
      console.log(`    +${horizon}: avg return=${stats.averageMs?.toFixed(2) ?? "n/a"}% median=${stats.medianMs?.toFixed(2) ?? "n/a"}% (n=${stats.count})`);
    }
  }

  const openPositions = positions.filter((p) => p.status === "OPEN").length;
  const closedPositions = positions.filter((p) => p.status === "CLOSED");
  const returns = closedPositions.map((p) => p.realizedReturnPct).filter((r): r is number => r !== null);
  console.log(`\nPaper positions: ${openPositions} open, ${closedPositions.length} closed (avg realized return: ${average(returns)?.toFixed(2) ?? "n/a"}%)`);

  console.log(`\nThis report is the evidence base for any future strategy modification — no threshold or Smart Selection change should be made without it.`);
}

main().catch((error) => {
  console.error("live:report failed", error);
  process.exitCode = 1;
});
