import { test } from "node:test";
import assert from "node:assert/strict";
import { processRawMessage } from "./signalProcessor.js";
import { PaperPortfolio } from "./paperPortfolio.js";
import { SmartSelectionEngine } from "../scoring/smartSelectionEngine.js";
import { SMART_SELECTION_V1_CONFIG } from "../scoring/smartSelectionConfig.js";
import type { PoolDataProvider } from "../market-data/poolDataProvider.js";
import type { MarketDataProvider } from "../market-data/marketDataProvider.js";
import type { HistoricalPriceProvider, HistoricalCandle } from "../backtesting/historicalPriceProvider.js";
import type { TokenIntelligenceProvider } from "../token-analysis/tokenAnalysisService.js";
import type { RawScoutMessage } from "../ingestion/types.js";
import type { PaperPortfolioConfig, PoolInfo, ProviderResult, TokenContractInfo, TokenMarketData } from "../types/domain.js";

const CHAIN_ID = 4663;

// A permissive Smart Selection config so this file tests signalProcessor's WIRING
// (lifecycle, dedup, paper entry) rather than re-testing real threshold math
// (already covered extensively in src/scoring's own tests).
const PERMISSIVE_ENGINE_CONFIG = {
  ...SMART_SELECTION_V1_CONFIG,
  thresholds: { watch: 0, tradeCandidate: 0 },
  minimumConfidenceForTradeCandidate: 0,
  minimumDataQualityForTradeCandidate: "UNAVAILABLE" as const,
  highChaseRiskCapsDecisionAt: "TRADE_CANDIDATE" as const,
};

const RESTRICTIVE_ENGINE_CONFIG = {
  ...SMART_SELECTION_V1_CONFIG,
  thresholds: { watch: 101, tradeCandidate: 101 }, // unreachable — always IGNORE
};

const WATCH_ENGINE_CONFIG = {
  ...SMART_SELECTION_V1_CONFIG,
  thresholds: { watch: 0, tradeCandidate: 101 }, // watch trivially reachable, tradeCandidate unreachable -> always WATCH at worst
};

function rawMessage(overrides: Partial<RawScoutMessage> = {}): RawScoutMessage {
  return {
    id: "5001",
    channel: "scoutrobinhood",
    postedAt: "2026-09-06T12:00:00.000Z",
    text: "🚨 EARLY CALL — $TEST · robinhood\n💰 called at $10k\n\n⚠️ dyor, nfa",
    buttons: [{ text: "DexS", url: "https://dexscreener.com/robinhood/0xeb1898a0d496000506a2799e1b4077776497fd29" }],
    ...overrides,
  };
}

function performanceUpdateMessage(): RawScoutMessage {
  return {
    id: "5002",
    channel: "scoutrobinhood",
    postedAt: "2026-09-06T12:00:00.000Z",
    text: "🔥 $TEST hit 3X\ncalled $10k → $30k\npeak since the call · dyor",
    buttons: [],
  };
}

function poolProvider(): PoolDataProvider {
  return {
    name: "fake-pool",
    async discoverPools(): Promise<ProviderResult<PoolInfo[]>> {
      return { status: "ok", data: [], unavailable: [], errors: [] };
    },
    async getRecentSwaps() {
      return { status: "unavailable", data: null, unavailable: ["swaps"], errors: [] };
    },
  };
}

function geckoProvider(): HistoricalPriceProvider {
  return { name: "geckoterminal", async getCandles(): Promise<ProviderResult<HistoricalCandle[]>> { return { status: "unavailable", data: null, unavailable: ["candles"], errors: [] }; } };
}

const marketData: TokenMarketData = {
  chainId: CHAIN_ID,
  contractAddress: "0xeb1898a0d496000506a2799e1b4077776497fd29",
  observedAt: "t",
  priceUsd: 0.05,
  marketCapUsd: 50000,
  liquidityUsd: 10000,
  volumeUsd24h: 2000,
  pools: [],
  source: "dexscreener",
};

function dexScreener(): MarketDataProvider {
  return { name: "dexscreener", async getMarketData(): Promise<ProviderResult<TokenMarketData>> { return { status: "ok", data: marketData, unavailable: [], errors: [] }; } };
}

const tokenInfo: TokenContractInfo = { chainId: CHAIN_ID, contractAddress: "0xeb1898a0d496000506a2799e1b4077776497fd29", name: "Test", symbol: "TEST", decimals: 18 };

function tokenAnalysis(): TokenIntelligenceProvider {
  return {
    async getTokenIntelligence(): Promise<ProviderResult<TokenContractInfo>> { return { status: "ok", data: tokenInfo, unavailable: [], errors: [] }; },
    async getFastTokenInfo(): Promise<ProviderResult<TokenContractInfo>> { return { status: "ok", data: tokenInfo, unavailable: [], errors: [] }; },
    async getSlowTokenInfo() { return {}; },
  };
}

const PORTFOLIO_CONFIG: PaperPortfolioConfig = {
  startingCapitalUsd: 1000,
  positionSizePct: 10,
  maxPositionSizeUsd: 200,
  maxConcurrentPositions: 3,
  slippagePct: 1,
  feePct: 0.5,
  takeProfitPct: 50,
  stopLossPct: 20,
  maxHoldingMinutes: 60,
  liquidityEmergencyExitUsd: null,
  maxSignalAgeSecondsForEntry: 120,
  priceStalenessSeconds: 60,
};

function baseDeps(overrides: Partial<Parameters<typeof processRawMessage>[1]> = {}) {
  const seen = new Set<string>();
  return {
    source: "telegram:scoutrobinhood",
    intelligenceDeps: {
      poolDataProvider: poolProvider(),
      geckoTerminalProvider: geckoProvider(),
      marketDataProvider: dexScreener(),
      tokenAnalysisService: tokenAnalysis(),
      chainId: CHAIN_ID,
    },
    smartSelectionEngine: new SmartSelectionEngine(PERMISSIVE_ENGINE_CONFIG),
    portfolio: new PaperPortfolio(PORTFOLIO_CONFIG),
    generatePositionId: () => "pos-1",
    isDuplicate: async (id: string) => seen.has(id),
    markProcessed: async (id: string) => {
      seen.add(id);
    },
    maxSignalAgeSecondsForEntry: 120,
    now: () => new Date("2026-09-06T12:00:05.000Z"),
    ...overrides,
  };
}

test("a fresh, eligible EARLY_CALL with a TRADE_CANDIDATE result opens a paper position", async () => {
  const deps = baseDeps();
  const record = await processRawMessage(rawMessage(), deps);
  assert.equal(record.decision, "TRADE_CANDIDATE");
  assert.ok(record.paperPositionId);
  assert.equal(record.currentStage, "PAPER_POSITION_OPEN");
  assert.equal(record.rejectionReason, null);
});

test("records every lifecycle stage in order for a successful paper entry", async () => {
  const deps = baseDeps();
  const record = await processRawMessage(rawMessage(), deps);
  assert.deepEqual(
    record.events.map((e) => e.stage),
    ["RECEIVED", "PARSED", "VALIDATED", "INTELLIGENCE_STARTED", "INTELLIGENCE_COMPLETED", "SCORING_STARTED", "SCORING_COMPLETED", "PAPER_DECISION", "PAPER_ENTRY", "PAPER_POSITION_OPEN"],
  );
});

test("a duplicate Scout message (same id processed twice) is ignored the second time", async () => {
  const deps = baseDeps();
  const first = await processRawMessage(rawMessage(), deps);
  const second = await processRawMessage(rawMessage(), deps);
  assert.equal(first.rejectionReason, null);
  assert.equal(second.rejectionReason, "DUPLICATE");
  assert.equal(second.paperPositionId, null);
});

test("a PERFORMANCE_UPDATE message is rejected and never reaches Smart Selection or paper trading", async () => {
  const deps = baseDeps();
  const record = await processRawMessage(performanceUpdateMessage(), deps);
  assert.equal(record.rejectionReason, "PERFORMANCE_UPDATE_NOT_A_CALL");
  assert.equal(record.decision, null);
  assert.equal(record.paperPositionId, null);
});

test("Phase 7.4 §29 regression: an early-rejected record (PERFORMANCE_UPDATE) still carries the caller's configured mode, not the default", async () => {
  const deps = baseDeps({ mode: "REPLAY" });
  const record = await processRawMessage(performanceUpdateMessage(), deps);
  assert.equal(record.mode, "REPLAY");
});

test("defaults to LIVE mode when the caller never specifies one", async () => {
  const deps = baseDeps();
  const record = await processRawMessage(performanceUpdateMessage(), deps);
  assert.equal(record.mode, "LIVE");
});

test("a message with no recoverable contract address is rejected before intelligence gathering", async () => {
  const deps = baseDeps();
  const record = await processRawMessage(rawMessage({ buttons: [] }), deps);
  assert.equal(record.rejectionReason, "MISSING_CONTRACT_ADDRESS");
  assert.equal(record.events.some((e) => e.stage === "INTELLIGENCE_STARTED"), false);
});

test("Smart Selection IGNORE never reaches paper trading", async () => {
  const deps = baseDeps({ smartSelectionEngine: new SmartSelectionEngine(RESTRICTIVE_ENGINE_CONFIG) });
  const record = await processRawMessage(rawMessage(), deps);
  assert.equal(record.decision, "IGNORE");
  assert.equal(record.rejectionReason, "IGNORED_BY_SMART_SELECTION");
  assert.equal(record.paperPositionId, null);
});

test("Smart Selection WATCH never reaches paper trading (counterfactual only)", async () => {
  const deps = baseDeps({ smartSelectionEngine: new SmartSelectionEngine(WATCH_ENGINE_CONFIG) });
  const record = await processRawMessage(rawMessage(), deps);
  assert.equal(record.decision, "WATCH");
  assert.equal(record.rejectionReason, "WATCH_ONLY");
  assert.equal(record.paperPositionId, null);
});

test("a duplicate Scout message never opens a second paper position even if the first one already did", async () => {
  const deps = baseDeps();
  const first = await processRawMessage(rawMessage(), deps);
  assert.ok(first.paperPositionId);
  const openPositionsAfterFirst = deps.portfolio.openPositionCount;

  const second = await processRawMessage(rawMessage(), deps);
  assert.equal(second.paperPositionId, null);
  assert.equal(deps.portfolio.openPositionCount, openPositionsAfterFirst); // no second position opened
});

test("a stale signal (older than maxSignalAgeSecondsForEntry) is rejected right before paper entry, never traded", async () => {
  // 150s after postedAt: past the 120s Phase 7 staleness cutoff, but well under Smart Selection's own
  // 300s stale-market-data hard-blocker threshold — isolates the Phase 7 stale-SIGNAL check from Phase 5's
  // unrelated stale-DATA check.
  const deps = baseDeps({ now: () => new Date("2026-09-06T12:02:30.000Z") });
  const record = await processRawMessage(rawMessage(), deps);
  assert.equal(record.decision, "TRADE_CANDIDATE"); // Smart Selection still ran and decided
  assert.equal(record.rejectionReason, "STALE_SIGNAL");
  assert.equal(record.paperPositionId, null);
});

// Phase 7.1 — an unparseable Scout-provided postedAt must fail CLOSED (rejected) rather than silently
// being treated as "not stale" (which is what an unguarded NaN-age comparison would do — see
// docs/LIVE_PIPELINE.md's NaN-safety fix and normalization.ts's safeAgeSeconds).
test("a signal with an unparseable Scout-reported postedAt fails closed as STALE_SIGNAL rather than silently passing", async () => {
  const deps = baseDeps();
  const record = await processRawMessage(rawMessage({ postedAt: "not-a-real-timestamp" }), deps);
  assert.equal(record.rejectionReason, "STALE_SIGNAL");
  assert.equal(record.paperPositionId, null);
});

// Phase 7.1 §21 — confidence diagnostics: the EXISTING SmartSelectionResult.confidenceBreakdown/
// dataQuality must be surfaced onto every live record, not just the scalar score/confidence.
test("surfaces the existing confidenceBreakdown and dataQuality onto the live record for every scored signal", async () => {
  const deps = baseDeps();
  const record = await processRawMessage(rawMessage(), deps);
  assert.ok(record.confidenceBreakdown);
  assert.equal(typeof record.confidenceBreakdown?.overallConfidence, "number");
  assert.ok(record.confidenceBreakdown!.components.length > 0);
  assert.ok(record.confidenceBreakdown!.components.some((c) => c.name === "completeness"));
  assert.ok(record.dataQuality);
  assert.ok(record.dataQuality!.fields.length > 0);
});

test("a rejected-before-scoring signal (e.g. duplicate) has no confidence diagnostics to surface", async () => {
  const deps = baseDeps();
  await processRawMessage(rawMessage(), deps); // first time through, marks processed
  const record = await processRawMessage(rawMessage(), deps); // duplicate
  assert.equal(record.rejectionReason, "DUPLICATE");
  assert.equal(record.confidenceBreakdown, null);
  assert.equal(record.dataQuality, null);
});

test("no Scout signal -> no paper trade: an empty/rejected pipeline never calls onPositionOpened", async () => {
  let called = false;
  const deps = baseDeps({ onPositionOpened: async () => { called = true; } });
  await processRawMessage(performanceUpdateMessage(), deps);
  assert.equal(called, false);
});

test("calls onPositionOpened exactly once when a paper position is actually opened", async () => {
  let callCount = 0;
  const deps = baseDeps({ onPositionOpened: async () => { callCount += 1; } });
  await processRawMessage(rawMessage(), deps);
  assert.equal(callCount, 1);
});

test("a provider failure during intelligence gathering degrades gracefully rather than crashing the whole signal", async () => {
  const throwingDex: MarketDataProvider = { name: "dexscreener", async getMarketData() { throw new Error("boom"); } };
  const deps = baseDeps({ intelligenceDeps: { poolDataProvider: poolProvider(), geckoTerminalProvider: geckoProvider(), marketDataProvider: throwingDex, tokenAnalysisService: tokenAnalysis(), chainId: CHAIN_ID } });
  const record = await processRawMessage(rawMessage(), deps);
  // still reaches a decision — degraded market data, not a crash
  assert.ok(record.decision !== undefined);
  assert.equal(record.currentStage !== "RECEIVED", true);
});
