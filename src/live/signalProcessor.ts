// Phase 7 — the per-signal pipeline: one raw Scout message in, one fully
// lifecycle-tracked LiveSignalRecord out. This is the ONLY path into
// Smart Selection and paper trading — see ARCHITECTURE.md's "Scout is the
// only strategy entry point" invariant. Runs independently per signal
// (the caller is responsible for bounded concurrency — see
// livePipeline.ts) so one slow/broken signal never blocks another.

import { parseScoutMessage } from "../signal-parsing/scoutMessageParser.js";
import { safeAgeSeconds } from "../scoring/normalization.js";
import { LifecycleTracker } from "./lifecycleTracker.js";
import { gatherLiveIntelligence, type LiveIntelligenceDeps } from "./liveIntelligenceGatherer.js";
import { openPaperPosition } from "./paperTradingEngine.js";
import type { PaperPortfolio } from "./paperPortfolio.js";
import type { SmartSelectionEngine } from "../scoring/smartSelectionEngine.js";
import type { RawScoutMessage } from "../ingestion/types.js";
import type { LivePaperPosition, LiveProviderCallSummary, LiveRunMode, LiveSignalRecord, ScoutSignal, SignalRejectionReason } from "../types/domain.js";

export interface SignalProcessorDeps {
  source: string;
  intelligenceDeps: LiveIntelligenceDeps;
  smartSelectionEngine: SmartSelectionEngine;
  portfolio: PaperPortfolio;
  generatePositionId: () => string;
  isDuplicate: (signalId: string) => Promise<boolean>;
  markProcessed: (signalId: string) => Promise<void>;
  maxSignalAgeSecondsForEntry: number;
  now?: () => Date;
  onPositionOpened?: (position: LivePaperPosition) => Promise<void>;
  /** Phase 7.4 §29 — REPLAY vs genuine LIVE Scout activity, persisted onto every record this call produces. Defaults to "LIVE" (matching every pre-Phase-7.4 caller, which never ran replay through this path — replay was always the ONLY mode `npm run live` used before real Telegram credentials existed). */
  mode?: LiveRunMode;
}

function buildRecord(
  tracker: LifecycleTracker,
  signal: { id: string; source: string; sourceMessageId: string; tokenSymbol: string | null; contractAddress: string | null; scoutTimestamp: string | null; receivedAt: string },
  overrides: Partial<LiveSignalRecord> = {},
): LiveSignalRecord {
  return {
    signalId: signal.id,
    source: signal.source,
    sourceMessageId: signal.sourceMessageId,
    tokenSymbol: signal.tokenSymbol,
    contractAddress: signal.contractAddress,
    scoutTimestamp: signal.scoutTimestamp,
    receivedAt: signal.receivedAt,
    events: tracker.events,
    currentStage: tracker.currentStage ?? "RECEIVED",
    rejectionReason: null,
    venueType: null,
    marketDataQuality: "UNAVAILABLE",
    smartSelectionResultId: null,
    overallScore: null,
    confidence: null,
    confidenceBreakdown: null,
    dataQuality: null,
    decision: null,
    paperPositionId: null,
    providerCalls: [],
    mode: "LIVE",
    decisionPriceUsd: null,
    ...overrides,
  };
}

function rejectionReasonForPaperTradeRejection(reason: string): SignalRejectionReason {
  if (reason === "MAX_CONCURRENT_POSITIONS") return "MAX_CONCURRENT_POSITIONS";
  if (reason === "INSUFFICIENT_CAPITAL") return "INSUFFICIENT_CAPITAL";
  return "OTHER";
}

export async function processRawMessage(raw: RawScoutMessage, deps: SignalProcessorDeps): Promise<LiveSignalRecord> {
  const receivedAt = deps.now?.() ?? new Date();
  const provisionalId = `${deps.source}:${raw.id}`;
  const tracker = new LifecycleTracker(provisionalId);
  tracker.record("RECEIVED", "OK", { at: receivedAt });

  const scoutSignal: ScoutSignal = parseScoutMessage(raw, deps.source);
  tracker.record("PARSED", "OK", { at: deps.now?.() ?? new Date() });

  const signalMeta = {
    id: scoutSignal.id,
    source: scoutSignal.source,
    sourceMessageId: scoutSignal.sourceMessageId,
    tokenSymbol: scoutSignal.tokenSymbol ?? null,
    contractAddress: scoutSignal.contractAddress ?? null,
    scoutTimestamp: scoutSignal.postedAt ?? null,
    receivedAt: receivedAt.toISOString(),
  };

  const reject = (reason: SignalRejectionReason): LiveSignalRecord => {
    tracker.record("REJECTED", "SKIPPED", { at: deps.now?.() ?? new Date(), details: { reason } });
    return buildRecord(tracker, signalMeta, { rejectionReason: reason, mode: deps.mode ?? "LIVE" });
  };

  if (scoutSignal.messageType === "PERFORMANCE_UPDATE") {
    return reject("PERFORMANCE_UPDATE_NOT_A_CALL");
  }
  if (scoutSignal.messageType !== "EARLY_CALL") {
    return reject("OTHER");
  }
  if (!scoutSignal.contractAddress) {
    return reject("MISSING_CONTRACT_ADDRESS");
  }
  if (await deps.isDuplicate(scoutSignal.id)) {
    return reject("DUPLICATE");
  }
  // Marked BEFORE heavy processing so a genuinely concurrent duplicate (the same message arriving twice
  // in quick succession) can't race past this check — see Phase 7 §13.
  await deps.markProcessed(scoutSignal.id);
  tracker.record("VALIDATED", "OK", { at: deps.now?.() ?? new Date() });

  tracker.record("INTELLIGENCE_STARTED", "OK", { at: deps.now?.() ?? new Date() });
  const intelligence = await gatherLiveIntelligence(scoutSignal, { ...deps.intelligenceDeps, now: deps.now });
  const providerCalls: LiveProviderCallSummary[] = intelligence.providerCalls;
  tracker.record("INTELLIGENCE_COMPLETED", "OK", { at: deps.now?.() ?? new Date(), details: { marketDataQuality: intelligence.marketDataQuality } });

  tracker.record("SCORING_STARTED", "OK", { at: deps.now?.() ?? new Date() });
  const decisionTime = deps.now?.() ?? new Date();
  const result = deps.smartSelectionEngine.evaluate(intelligence.inputs, decisionTime);
  tracker.record("SCORING_COMPLETED", "OK", {
    at: deps.now?.() ?? new Date(),
    details: { score: result.overallScore, confidence: result.confidence, decision: result.decision },
  });
  tracker.record("PAPER_DECISION", "OK", { at: deps.now?.() ?? new Date(), details: { decision: result.decision } });

  const baseRecordOverrides = {
    venueType: intelligence.currentPrice.venueType,
    marketDataQuality: intelligence.marketDataQuality,
    smartSelectionResultId: result.id,
    overallScore: result.overallScore,
    confidence: result.confidence,
    confidenceBreakdown: result.confidenceBreakdown,
    dataQuality: result.dataQuality,
    decision: result.decision,
    providerCalls,
    mode: deps.mode ?? "LIVE",
    decisionPriceUsd: intelligence.currentPrice.priceUsd,
  };

  if (result.decision !== "TRADE_CANDIDATE") {
    tracker.record("REJECTED", "SKIPPED", {
      at: deps.now?.() ?? new Date(),
      details: { reason: result.decision === "WATCH" ? "WATCH_ONLY" : "IGNORED_BY_SMART_SELECTION" },
    });
    return buildRecord(tracker, signalMeta, {
      ...baseRecordOverrides,
      rejectionReason: result.decision === "WATCH" ? "WATCH_ONLY" : "IGNORED_BY_SMART_SELECTION",
    });
  }

  // Stale-signal protection (§14) — checked right before committing capital, using the Scout-reported
  // call time so the measured age reflects the FULL real-world delay, not just our own processing time.
  // `scoutSignal.postedAt` comes from Scout's own (external, less-trusted) message metadata, unlike
  // internally self-generated timestamps — safeAgeSeconds (Phase 7.1 §2) never returns NaN for a
  // malformed value; an undeterminable age fails CLOSED (rejected) rather than silently passing
  // through as "not stale", matching this codebase's established "fail closed, never guessed" pattern
  // (see venueResolver.ts's graduation-timestamp-missing case).
  const decisionTimestamp = scoutSignal.postedAt ?? scoutSignal.receivedAt;
  const ageSeconds = safeAgeSeconds(decisionTimestamp, deps.now?.() ?? new Date());
  if (ageSeconds === null) {
    tracker.record("REJECTED", "SKIPPED", { at: deps.now?.() ?? new Date(), details: { reason: "STALE_SIGNAL", note: "signal age could not be determined (unparseable timestamp) — failing closed" } });
    return buildRecord(tracker, signalMeta, { ...baseRecordOverrides, rejectionReason: "STALE_SIGNAL" });
  }
  if (ageSeconds > deps.maxSignalAgeSecondsForEntry) {
    tracker.record("REJECTED", "SKIPPED", { at: deps.now?.() ?? new Date(), details: { reason: "STALE_SIGNAL", ageSeconds } });
    return buildRecord(tracker, signalMeta, { ...baseRecordOverrides, rejectionReason: "STALE_SIGNAL" });
  }

  const openResult = openPaperPosition(
    {
      signalId: scoutSignal.id,
      contractAddress: scoutSignal.contractAddress,
      chainId: deps.intelligenceDeps.chainId,
      tokenSymbol: scoutSignal.tokenSymbol ?? null,
      currentPrice: intelligence.currentPrice,
    },
    { portfolio: deps.portfolio, generatePositionId: deps.generatePositionId, now: deps.now },
  );

  if (openResult.status === "REJECTED") {
    const reason = openResult.reason === "PRICE_UNAVAILABLE" ? "MARKET_NOT_DISCOVERED" : rejectionReasonForPaperTradeRejection(openResult.reason);
    tracker.record("REJECTED", "SKIPPED", { at: deps.now?.() ?? new Date(), details: { reason } });
    return buildRecord(tracker, signalMeta, { ...baseRecordOverrides, rejectionReason: reason });
  }

  tracker.record("PAPER_ENTRY", "OK", { at: deps.now?.() ?? new Date(), details: { positionId: openResult.position.id } });
  tracker.record("PAPER_POSITION_OPEN", "OK", { at: deps.now?.() ?? new Date() });

  if (deps.onPositionOpened) await deps.onPositionOpened(openResult.position);

  return buildRecord(tracker, signalMeta, { ...baseRecordOverrides, paperPositionId: openResult.position.id });
}
