// npm run live:status
//
// Phase 7.4 §27 — a point-in-time snapshot of the persisted live pipeline
// state: connection/mode of the most recent records, signal counts,
// decision distribution, open/completed paper positions, latency, and
// provider failure counts. Reads the SAME NDJSON files `npm run live`
// writes — safe to run alongside a live process (read-only) or after it
// has stopped. Separates REPLAY from LIVE explicitly (§29) — never mixes
// the two in one count.

import { createLiveSignalRecordRepository } from "../src/storage/liveSignalRecordRepository.js";
import { createLivePaperPositionRepository } from "../src/storage/livePaperPositionRepository.js";
import { buildLatencyReport } from "../src/live/latencyMetrics.js";
import type { LiveSignalRecord } from "../src/types/domain.js";

function summarizeMode(records: LiveSignalRecord[], label: string): void {
  const eligible = records.filter((r) => r.decision !== null);
  const ignore = records.filter((r) => r.decision === "IGNORE").length;
  const watch = records.filter((r) => r.decision === "WATCH").length;
  const tradeCandidate = records.filter((r) => r.decision === "TRADE_CANDIDATE").length;
  const latency = buildLatencyReport(records);
  const failures = records.flatMap((r) => r.providerCalls).filter((c) => c.status === "ERROR" || c.status === "TIMEOUT");

  console.log(`\n=== ${label} ===`);
  console.log(`  signals received: ${records.length}`);
  console.log(`  eligible calls: ${eligible.length} (IGNORE=${ignore} WATCH=${watch} TRADE_CANDIDATE=${tradeCandidate})`);
  console.log(`  decision latency: median=${latency.scoutToDecision.medianMs?.toFixed(0) ?? "n/a"}ms p95=${latency.scoutToDecision.p95Ms?.toFixed(0) ?? "n/a"}ms (n=${latency.scoutToDecision.count})`);
  console.log(`  provider failures: ${failures.length} (${JSON.stringify(failures.reduce((acc: Record<string, number>, c) => { acc[`${c.provider}:${c.status}`] = (acc[`${c.provider}:${c.status}`] ?? 0) + 1; return acc; }, {}))})`);
}

async function main(): Promise<void> {
  const signalRecordRepository = createLiveSignalRecordRepository();
  const paperPositionRepository = createLivePaperPositionRepository();

  const allRecords = await signalRecordRepository.list();
  const liveRecords = allRecords.filter((r) => r.mode === "LIVE");
  const replayRecords = allRecords.filter((r) => r.mode === "REPLAY");

  const positions = await paperPositionRepository.list();
  const open = positions.filter((p) => p.status === "OPEN");
  const closed = positions.filter((p) => p.status === "CLOSED");

  console.log("Scout Alpha — live pipeline status (from persisted data; this script does not itself hold a live connection)");
  summarizeMode(liveRecords, "LIVE (genuine Scout activity)");
  summarizeMode(replayRecords, "REPLAY (fixture — never combined with LIVE stats above)");

  console.log(`\n=== Paper positions ===`);
  console.log(`  open: ${open.length}`);
  console.log(`  closed: ${closed.length}`);
  if (open.length > 0) {
    for (const p of open) console.log(`    ${p.tokenSymbol ?? p.contractAddress} entry=${p.execution.entryPriceUsd}`);
  }
}

main().catch((error) => {
  console.error("live:status failed", error);
  process.exitCode = 1;
});
