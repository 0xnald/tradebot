// Phase 7 §20 — a plain-text CLI status view. No frontend, just enough to
// see the listener is alive and what it has actually done.

import type { LivePipelineStats } from "./livePipeline.js";
import type { LivePaperPosition, LiveSignalRecord } from "../types/domain.js";

export type ListenerStatus = "CONNECTED" | "DISCONNECTED" | "REPLAY";

export interface StatusViewInputs {
  listenerStatus: ListenerStatus;
  stats: LivePipelineStats;
  recentRecords: LiveSignalRecord[];
  openPositions: LivePaperPosition[];
  recentClosedPositions: LivePaperPosition[];
}

function fmtUsd(n: number | null): string {
  return n === null ? "n/a" : `$${n.toFixed(2)}`;
}

function fmtPct(n: number | null): string {
  return n === null ? "n/a" : `${n.toFixed(1)}%`;
}

export function formatStatusView(inputs: StatusViewInputs): string {
  const lines: string[] = [];
  const push = (line = "") => lines.push(line);

  push(`LIVE SCOUT LISTENER: ${inputs.listenerStatus}`);
  push();

  push(`Recent signals:`);
  push(`  ${"time".padEnd(24)} ${"token".padEnd(12)} ${"score".padEnd(6)} ${"conf".padEnd(6)} ${"decision".padEnd(16)} latency(ms)`);
  for (const record of inputs.recentRecords.slice(-10)) {
    const received = record.events.find((e) => e.stage === "RECEIVED");
    const entry = record.events.find((e) => e.stage === "PAPER_ENTRY");
    const latencyMs = received && entry ? new Date(entry.timestamp).getTime() - new Date(received.timestamp).getTime() : null;
    push(
      `  ${record.receivedAt.padEnd(24)} ${(record.tokenSymbol ?? "?").padEnd(12)} ${String(record.overallScore ?? "n/a").padEnd(6)} ${String(record.confidence ?? "n/a").padEnd(6)} ${(record.decision ?? record.rejectionReason ?? "?").padEnd(16)} ${latencyMs ?? "n/a"}`,
    );
  }
  push();

  push(`Open paper positions:`);
  push(`  ${"token".padEnd(12)} ${"entry".padEnd(10)} ${"current".padEnd(10)} ${"PnL".padEnd(10)} age(s)`);
  for (const position of inputs.openPositions) {
    const snapshot = position.latestSnapshot;
    push(
      `  ${(position.tokenSymbol ?? "?").padEnd(12)} ${fmtUsd(position.execution.entryPriceUsd).padEnd(10)} ${fmtUsd(snapshot?.priceUsd ?? null).padEnd(10)} ${fmtUsd(snapshot?.pnlUsd ?? null).padEnd(10)} ${snapshot ? Math.round(snapshot.ageSeconds) : "n/a"}`,
    );
  }
  push();

  push(`Recent closed paper trades:`);
  push(`  ${"token".padEnd(12)} ${"entry".padEnd(10)} ${"exit".padEnd(10)} ${"return".padEnd(10)} reason`);
  for (const position of inputs.recentClosedPositions.slice(-10)) {
    push(
      `  ${(position.tokenSymbol ?? "?").padEnd(12)} ${fmtUsd(position.execution.entryPriceUsd).padEnd(10)} ${fmtUsd(position.exitPriceUsd).padEnd(10)} ${fmtPct(position.realizedReturnPct).padEnd(10)} ${position.exitReason ?? "?"}`,
    );
  }
  push();

  push(`Summary:`);
  push(`  received=${inputs.stats.received} processed=${inputs.stats.processed} ignored=${inputs.stats.ignored} watch=${inputs.stats.watch}`);
  push(`  paper trade candidates=${inputs.stats.tradeCandidates} paper entries=${inputs.stats.paperEntries} failures=${inputs.stats.failures}`);

  return lines.join("\n");
}
