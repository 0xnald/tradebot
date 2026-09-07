import { test } from "node:test";
import assert from "node:assert/strict";
import { formatStatusView } from "./statusView.js";
import type { LivePaperPosition, LiveSignalRecord } from "../types/domain.js";

function record(overrides: Partial<LiveSignalRecord> = {}): LiveSignalRecord {
  return {
    signalId: "s1",
    source: "telegram:scoutrobinhood",
    sourceMessageId: "1",
    tokenSymbol: "TEST",
    contractAddress: "0xabc",
    scoutTimestamp: "2026-09-06T12:00:00.000Z",
    receivedAt: "2026-09-06T12:00:00.100Z",
    events: [
      { signalId: "s1", stage: "RECEIVED", timestamp: "2026-09-06T12:00:00.100Z", durationMsSincePrevious: null, status: "OK" },
      { signalId: "s1", stage: "PAPER_ENTRY", timestamp: "2026-09-06T12:00:02.100Z", durationMsSincePrevious: 2000, status: "OK" },
    ],
    currentStage: "PAPER_ENTRY",
    rejectionReason: null,
    venueType: "PONS_V2_CURVE",
    marketDataQuality: "PARTIAL",
    smartSelectionResultId: "r1",
    overallScore: 82,
    confidence: 40,
    confidenceBreakdown: null,
    dataQuality: null,
    decision: "TRADE_CANDIDATE",
    paperPositionId: "pos-1",
    providerCalls: [],
    ...overrides,
  };
}

function position(overrides: Partial<LivePaperPosition> = {}): LivePaperPosition {
  return {
    id: "pos-1",
    signalId: "s1",
    contractAddress: "0xabc",
    chainId: 4663,
    tokenSymbol: "TEST",
    execution: {
      positionId: "pos-1",
      signalId: "s1",
      contractAddress: "0xabc",
      chainId: 4663,
      entryTimestamp: "t",
      entryPriceUsd: 0.05,
      entryPriceSource: "dexscreener",
      entryDataQuality: "KNOWN",
      positionSizeUsd: 100,
      slippagePct: 1,
      feePct: 0.5,
      feesUsd: 0.5,
      tokenAmount: 1980,
      quoteAmountUsd: 100,
    },
    status: "OPEN",
    takeProfitPct: 50,
    stopLossPct: 20,
    maxHoldingMinutes: 60,
    latestSnapshot: null,
    closedAt: null,
    exitPriceUsd: null,
    exitReason: null,
    realizedPnlUsd: null,
    realizedReturnPct: null,
    ...overrides,
  };
}

const EMPTY_STATS = { received: 0, processed: 0, ignored: 0, watch: 0, tradeCandidates: 0, paperEntries: 0, failures: 0 };

test("renders the listener status line", () => {
  const view = formatStatusView({ listenerStatus: "CONNECTED", stats: EMPTY_STATS, recentRecords: [], openPositions: [], recentClosedPositions: [] });
  assert.ok(view.includes("LIVE SCOUT LISTENER: CONNECTED"));
});

test("renders a recent signal with its token, decision, and latency", () => {
  const view = formatStatusView({ listenerStatus: "CONNECTED", stats: EMPTY_STATS, recentRecords: [record()], openPositions: [], recentClosedPositions: [] });
  assert.ok(view.includes("TEST"));
  assert.ok(view.includes("TRADE_CANDIDATE"));
  assert.ok(view.includes("2000")); // RECEIVED -> PAPER_ENTRY latency
});

test("renders an open position with entry/current/PnL", () => {
  const snapshot = { positionId: "pos-1", observedAt: "t", priceUsd: 0.06, priceSource: "dexscreener", priceDataQuality: "KNOWN" as const, pnlUsd: 20, returnPct: 20, maxFavorableExcursionPct: 20, maxAdverseExcursionPct: 0, ageSeconds: 120, liquidityUsd: 5000, marketStatus: "ACTIVE" as const };
  const view = formatStatusView({ listenerStatus: "CONNECTED", stats: EMPTY_STATS, recentRecords: [], openPositions: [position({ latestSnapshot: snapshot })], recentClosedPositions: [] });
  assert.ok(view.includes("$0.05"));
  assert.ok(view.includes("$0.06"));
  assert.ok(view.includes("$20.00"));
});

test("renders a recently-closed position with its exit reason", () => {
  const closed = position({ status: "CLOSED", exitPriceUsd: 0.1, exitReason: "TAKE_PROFIT", realizedReturnPct: 50 });
  const view = formatStatusView({ listenerStatus: "CONNECTED", stats: EMPTY_STATS, recentRecords: [], openPositions: [], recentClosedPositions: [closed] });
  assert.ok(view.includes("TAKE_PROFIT"));
  assert.ok(view.includes("50.0%"));
});

test("renders the summary counters", () => {
  const view = formatStatusView({
    listenerStatus: "REPLAY",
    stats: { received: 5, processed: 4, ignored: 1, watch: 1, tradeCandidates: 2, paperEntries: 2, failures: 0 },
    recentRecords: [],
    openPositions: [],
    recentClosedPositions: [],
  });
  assert.ok(view.includes("received=5"));
  assert.ok(view.includes("paper entries=2"));
  assert.ok(view.includes("LIVE SCOUT LISTENER: REPLAY"));
});

test("handles a completely empty state without throwing", () => {
  const view = formatStatusView({ listenerStatus: "DISCONNECTED", stats: EMPTY_STATS, recentRecords: [], openPositions: [], recentClosedPositions: [] });
  assert.ok(view.includes("DISCONNECTED"));
});
