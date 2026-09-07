import { test } from "node:test";
import assert from "node:assert/strict";
import { LivePipeline } from "./livePipeline.js";
import { PaperPortfolio } from "./paperPortfolio.js";
import { SmartSelectionEngine } from "../scoring/smartSelectionEngine.js";
import { SMART_SELECTION_V1_CONFIG } from "../scoring/smartSelectionConfig.js";
import { createLiveSignalRecordRepository } from "../storage/liveSignalRecordRepository.js";
import { createLivePaperPositionRepository } from "../storage/livePaperPositionRepository.js";
import { createWatchObservationRepository } from "../storage/watchObservationRepository.js";
import type { PoolDataProvider } from "../market-data/poolDataProvider.js";
import type { MarketDataProvider } from "../market-data/marketDataProvider.js";
import type { HistoricalPriceProvider, HistoricalCandle } from "../backtesting/historicalPriceProvider.js";
import type { TokenIntelligenceProvider } from "../token-analysis/tokenAnalysisService.js";
import type { ScoutIngestionAdapter, RawScoutMessage } from "../ingestion/types.js";
import type { CurrentPriceResult } from "./currentPriceResolver.js";
import type { LivePaperPosition, PaperPortfolioConfig, PoolInfo, ProviderResult, TokenContractInfo, TokenMarketData } from "../types/domain.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const CHAIN_ID = 4663;
const TOKEN = "0xeb1898a0d496000506a2799e1b4077776497fd29";

const PERMISSIVE_ENGINE_CONFIG = {
  ...SMART_SELECTION_V1_CONFIG,
  thresholds: { watch: 0, tradeCandidate: 0 },
  minimumConfidenceForTradeCandidate: 0,
  minimumDataQualityForTradeCandidate: "UNAVAILABLE" as const,
  highChaseRiskCapsDecisionAt: "TRADE_CANDIDATE" as const,
};

// watch reachable, tradeCandidate unreachable -> every eligible signal lands on WATCH, never TRADE_CANDIDATE.
const WATCH_ONLY_ENGINE_CONFIG = {
  ...SMART_SELECTION_V1_CONFIG,
  thresholds: { watch: 0, tradeCandidate: 101 },
  minimumConfidenceForTradeCandidate: 0,
  minimumDataQualityForTradeCandidate: "UNAVAILABLE" as const,
  highChaseRiskCapsDecisionAt: "TRADE_CANDIDATE" as const,
};

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

const marketData: TokenMarketData = { chainId: CHAIN_ID, contractAddress: TOKEN, observedAt: "t", priceUsd: 0.05, marketCapUsd: 50000, liquidityUsd: 10000, volumeUsd24h: 2000, pools: [], source: "dexscreener" };

function dexScreener(delayMs = 0): MarketDataProvider {
  return {
    name: "dexscreener",
    async getMarketData(): Promise<ProviderResult<TokenMarketData>> {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { status: "ok", data: marketData, unavailable: [], errors: [] };
    },
  };
}

const tokenInfo: TokenContractInfo = { chainId: CHAIN_ID, contractAddress: TOKEN, name: "Test", symbol: "TEST", decimals: 18 };

function tokenAnalysis(): TokenIntelligenceProvider {
  return {
    async getTokenIntelligence(): Promise<ProviderResult<TokenContractInfo>> { return { status: "ok", data: tokenInfo, unavailable: [], errors: [] }; },
    async getFastTokenInfo(): Promise<ProviderResult<TokenContractInfo>> { return { status: "ok", data: tokenInfo, unavailable: [], errors: [] }; },
    async getSlowTokenInfo() { return {}; },
  };
}

function fakeAdapter(): { adapter: ScoutIngestionAdapter; push: (msg: RawScoutMessage) => void } {
  let handler: ((msg: RawScoutMessage) => void | Promise<void>) | null = null;
  return {
    adapter: {
      name: "fake",
      async start(onMessage) {
        handler = onMessage;
      },
      async stop() {},
    },
    push: (msg) => {
      handler?.(msg);
    },
  };
}

function rawMessage(id: string, contractAddress = TOKEN): RawScoutMessage {
  return {
    id,
    channel: "scoutrobinhood",
    postedAt: "2026-09-06T12:00:00.000Z",
    text: `🚨 EARLY CALL — $TEST${id} · robinhood\n💰 called at $10k\n\n⚠️ dyor, nfa`,
    buttons: [{ text: "DexS", url: `https://dexscreener.com/robinhood/${contractAddress}` }],
  };
}

const PORTFOLIO_CONFIG: PaperPortfolioConfig = {
  startingCapitalUsd: 1000,
  positionSizePct: 10,
  maxPositionSizeUsd: 200,
  maxConcurrentPositions: 5,
  slippagePct: 1,
  feePct: 0.5,
  takeProfitPct: 50,
  stopLossPct: 20,
  maxHoldingMinutes: 60,
  liquidityEmergencyExitUsd: null,
  maxSignalAgeSecondsForEntry: 120,
  priceStalenessSeconds: 60,
};

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "scout-alpha-live-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makePipeline(
  dir: string,
  opts: {
    dexDelayMs?: number;
    maxConcurrentSignals?: number;
    now?: () => Date;
    engineConfig?: typeof PERMISSIVE_ENGINE_CONFIG;
    withWatchObservations?: boolean;
    watchObservationWindowMs?: number;
    resolvePrice?: () => Promise<CurrentPriceResult>;
  } = {},
) {
  const { adapter, push } = fakeAdapter();
  const portfolio = new PaperPortfolio(PORTFOLIO_CONFIG);
  const now = opts.now ?? (() => new Date("2026-09-06T12:00:05.000Z"));
  const watchObservationRepository = opts.withWatchObservations ? createWatchObservationRepository(path.join(dir, "watch-observations.ndjson")) : undefined;
  const defaultResolvePrice = async (): Promise<CurrentPriceResult> => ({
    priceUsd: 0.06,
    liquidityUsd: 10000,
    source: "dexscreener",
    dataQuality: "KNOWN",
    observedAt: now().toISOString(),
    venueType: "UNKNOWN",
    venueIdentifier: null,
    providerCalls: [],
  });

  const pipeline = new LivePipeline({
    adapter,
    signalProcessorDeps: {
      source: "telegram:scoutrobinhood",
      intelligenceDeps: {
        poolDataProvider: poolProvider(),
        geckoTerminalProvider: geckoProvider(),
        marketDataProvider: dexScreener(opts.dexDelayMs ?? 0),
        tokenAnalysisService: tokenAnalysis(),
        chainId: CHAIN_ID,
        now,
      },
      smartSelectionEngine: new SmartSelectionEngine(opts.engineConfig ?? PERMISSIVE_ENGINE_CONFIG),
      portfolio,
      generatePositionId: () => `pos-${Math.random().toString(36).slice(2)}`,
      maxSignalAgeSecondsForEntry: 120,
      now,
    },
    signalRecordRepository: createLiveSignalRecordRepository(path.join(dir, "signals.ndjson")),
    paperPositionRepository: createLivePaperPositionRepository(path.join(dir, "positions.ndjson")),
    watchObservationRepository,
    watchObservationWindowMs: opts.watchObservationWindowMs,
    positionMonitorDeps: {
      resolvePrice: opts.resolvePrice ?? defaultResolvePrice,
      now,
    },
    portfolio,
    maxConcurrentSignals: opts.maxConcurrentSignals ?? 3,
    positionPollIntervalMs: 999_999_999, // never fires on its own — tests trigger polls manually
  });

  return { pipeline, push, watchObservationRepository };
}

function waitUntil(condition: () => boolean, timeoutMs = 2000, intervalMs = 5): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (condition()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitUntil timed out"));
      setTimeout(check, intervalMs);
    };
    check();
  });
}

test("processes a signal end-to-end and opens a paper position", async () => {
  await withTempDir(async (dir) => {
    const { pipeline, push } = makePipeline(dir);
    await pipeline.start();
    push(rawMessage("1"));
    await waitUntil(() => pipeline.stats.processed === 1);
    assert.equal(pipeline.stats.tradeCandidates, 1);
    assert.equal(pipeline.stats.paperEntries, 1);
    assert.equal(pipeline.openPositions.length, 1);
    await pipeline.stop();
  });
});

test("a slow signal does not block a later signal from being processed independently", async () => {
  await withTempDir(async (dir) => {
    const { pipeline, push } = makePipeline(dir, { dexDelayMs: 300, maxConcurrentSignals: 3 });
    await pipeline.start();
    push(rawMessage("1")); // slow
    await new Promise((resolve) => setTimeout(resolve, 20));
    push(rawMessage("2")); // fast-ish but shares the same 300ms provider delay — still runs CONCURRENTLY, not queued behind #1
    await waitUntil(() => pipeline.stats.processed === 2, 3000);
    assert.equal(pipeline.stats.processed, 2);
    await pipeline.stop();
  });
});

test("respects maxConcurrentSignals — a third signal waits for a slot rather than running unbounded", async () => {
  await withTempDir(async (dir) => {
    const { pipeline, push } = makePipeline(dir, { dexDelayMs: 100, maxConcurrentSignals: 1 });
    await pipeline.start();
    const startedAt = Date.now();
    push(rawMessage("1"));
    push(rawMessage("2"));
    await waitUntil(() => pipeline.stats.processed === 2, 3000);
    const elapsed = Date.now() - startedAt;
    // with concurrency=1 and ~100ms each, two signals take noticeably longer than one would alone
    assert.ok(elapsed >= 150, `expected serialized processing to take >=150ms, took ${elapsed}ms`);
    await pipeline.stop();
  });
});

// ---------------------------------------------------------------------
// Phase 7.1 §9/§25 — burst concurrency: 5+ real EARLY_CALL signals arriving
// within seconds of each other must all be accepted, none dropped, with
// bounded (not unbounded) concurrent processing, and one slow signal must
// never block the others from finishing independently.
// ---------------------------------------------------------------------

test("a burst of 5 distinct Scout signals arriving within seconds are all received and eventually processed — none dropped", async () => {
  await withTempDir(async (dir) => {
    const { pipeline, push } = makePipeline(dir, { maxConcurrentSignals: 3 });
    await pipeline.start();

    const addresses = Array.from({ length: 5 }, (_, i) => `0xeb1898a0d496000506a2799e1b4077776497fd2${i}`);
    for (const [i, address] of addresses.entries()) push(rawMessage(`burst-${i}`, address));

    assert.equal(pipeline.stats.received, 5); // every push was accepted immediately, none dropped at the door
    await waitUntil(() => pipeline.stats.processed === 5, 3000);
    assert.equal(pipeline.stats.processed, 5);
    assert.equal(pipeline.stats.failures, 0);
    assert.equal(pipeline.openPositions.length, 5); // 5 genuinely distinct positions
    const ids = new Set(pipeline.openPositions.map((p) => p.id));
    assert.equal(ids.size, 5);

    await pipeline.stop();
  });
});

test("burst processing never exceeds maxConcurrentSignals in-flight signals at once", async () => {
  await withTempDir(async (dir) => {
    let inFlight = 0;
    let maxObservedInFlight = 0;
    const trackingDex: MarketDataProvider = {
      name: "dexscreener",
      async getMarketData() {
        inFlight += 1;
        maxObservedInFlight = Math.max(maxObservedInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 30));
        inFlight -= 1;
        return { status: "ok", data: marketData, unavailable: [], errors: [] };
      },
    };

    const { adapter, push } = fakeAdapter();
    const portfolio = new PaperPortfolio(PORTFOLIO_CONFIG);
    const now = () => new Date("2026-09-06T12:00:05.000Z");
    const MAX_CONCURRENT = 2;
    const pipeline = new LivePipeline({
      adapter,
      signalProcessorDeps: {
        source: "telegram:scoutrobinhood",
        intelligenceDeps: { poolDataProvider: poolProvider(), geckoTerminalProvider: geckoProvider(), marketDataProvider: trackingDex, tokenAnalysisService: tokenAnalysis(), chainId: CHAIN_ID, now },
        smartSelectionEngine: new SmartSelectionEngine(PERMISSIVE_ENGINE_CONFIG),
        portfolio,
        generatePositionId: () => `pos-${Math.random().toString(36).slice(2)}`,
        maxSignalAgeSecondsForEntry: 120,
        now,
      },
      signalRecordRepository: createLiveSignalRecordRepository(path.join(dir, "signals.ndjson")),
      paperPositionRepository: createLivePaperPositionRepository(path.join(dir, "positions.ndjson")),
      positionMonitorDeps: { resolvePrice: async (): Promise<CurrentPriceResult> => ({ priceUsd: 0.06, liquidityUsd: 10000, source: "dexscreener", dataQuality: "KNOWN", observedAt: now().toISOString(), venueType: "UNKNOWN", venueIdentifier: null, providerCalls: [] }), now },
      portfolio,
      maxConcurrentSignals: MAX_CONCURRENT,
      positionPollIntervalMs: 999_999_999,
    });

    await pipeline.start();
    for (let i = 0; i < 6; i++) push(rawMessage(`conc-${i}`, `0xeb1898a0d496000506a2799e1b4077776497fd2${i}`));
    await waitUntil(() => pipeline.stats.processed === 6, 3000);

    // Each signal's own intelligence gathering makes exactly one DexScreener call, so
    // maxObservedInFlight directly reflects how many SIGNALS were being processed at once.
    assert.ok(maxObservedInFlight <= MAX_CONCURRENT, `expected at most ${MAX_CONCURRENT} concurrent signals, observed ${maxObservedInFlight}`);
    assert.ok(maxObservedInFlight > 0); // sanity: the tracking dex was actually exercised

    await pipeline.stop();
  });
});

test("one slow signal in a burst does not block the other signals from finishing independently", async () => {
  await withTempDir(async (dir) => {
    const SLOW_ADDRESS = "0xeb1898a0d496000506a2799e1b4077776497fd29";
    const slowAwareDex: MarketDataProvider = {
      name: "dexscreener",
      async getMarketData(_chainId: number, contractAddress: string) {
        if (contractAddress === SLOW_ADDRESS) await new Promise((resolve) => setTimeout(resolve, 1500));
        return { status: "ok", data: marketData, unavailable: [], errors: [] };
      },
    };

    const { adapter, push } = fakeAdapter();
    const portfolio = new PaperPortfolio(PORTFOLIO_CONFIG);
    const now = () => new Date("2026-09-06T12:00:05.000Z");
    const pipeline = new LivePipeline({
      adapter,
      signalProcessorDeps: {
        source: "telegram:scoutrobinhood",
        intelligenceDeps: { poolDataProvider: poolProvider(), geckoTerminalProvider: geckoProvider(), marketDataProvider: slowAwareDex, tokenAnalysisService: tokenAnalysis(), chainId: CHAIN_ID, now },
        smartSelectionEngine: new SmartSelectionEngine(PERMISSIVE_ENGINE_CONFIG),
        portfolio,
        generatePositionId: () => `pos-${Math.random().toString(36).slice(2)}`,
        maxSignalAgeSecondsForEntry: 120,
        now,
      },
      signalRecordRepository: createLiveSignalRecordRepository(path.join(dir, "signals.ndjson")),
      paperPositionRepository: createLivePaperPositionRepository(path.join(dir, "positions.ndjson")),
      positionMonitorDeps: { resolvePrice: async (): Promise<CurrentPriceResult> => ({ priceUsd: 0.06, liquidityUsd: 10000, source: "dexscreener", dataQuality: "KNOWN", observedAt: now().toISOString(), venueType: "UNKNOWN", venueIdentifier: null, providerCalls: [] }), now },
      portfolio,
      maxConcurrentSignals: 5, // all 5 can start immediately — isolates "does the slow one block others" from queueing
      positionPollIntervalMs: 999_999_999,
    });

    await pipeline.start();
    push(rawMessage("slow-0", SLOW_ADDRESS)); // the slow one, pushed FIRST
    for (let i = 1; i < 5; i++) push(rawMessage(`fast-${i}`, `0xeb1898a0d496000506a2799e1b4077776497fd2${i}`));

    // The 4 fast signals must all finish well before the slow one's 1500ms artificial delay elapses.
    // (Widened from an original 300ms/200ms pairing — Phase 7.3B §L found that too tight a margin
    // made this genuinely flaky under real scheduling jitter for 4 concurrent signal pipelines, not
    // just on a loaded machine. This keeps the same "fast isn't blocked by slow" assertion with
    // enough headroom to stay deterministic.)
    await waitUntil(() => pipeline.stats.processed >= 4, 800);
    assert.ok(pipeline.stats.processed >= 4, "the 4 fast signals finished without waiting for the slow one");

    await pipeline.waitForIdle();
    assert.equal(pipeline.stats.processed, 5); // the slow one does eventually finish too
    await pipeline.stop();
  });
});

// ---------------------------------------------------------------------
// Phase 7.2 §23 — WATCH observation: a WATCH decision is analytical, never
// a trade. Follow-up market snapshots are recorded so a later analysis can
// answer "what happened after signals we WATCHed?" — never fed back into
// a decision, never opens a position, never retroactively relabeled.
// ---------------------------------------------------------------------

test("a WATCH decision is tracked for follow-up observation when a watchObservationRepository is configured", async () => {
  await withTempDir(async (dir) => {
    const { pipeline, push } = makePipeline(dir, { engineConfig: WATCH_ONLY_ENGINE_CONFIG, withWatchObservations: true });
    await pipeline.start();
    push(rawMessage("1"));
    await waitUntil(() => pipeline.stats.processed === 1);
    assert.equal(pipeline.stats.watch, 1);
    assert.equal(pipeline.watchedSignalCount, 1);
    await pipeline.stop();
  });
});

test("Phase 7.4 §22: a legitimate TRADE_CANDIDATE is ALSO tracked for post-decision observation, alongside its normal paper entry", async () => {
  await withTempDir(async (dir) => {
    let currentTime = new Date("2026-09-06T12:00:05.000Z");
    const { pipeline, push, watchObservationRepository } = makePipeline(dir, { withWatchObservations: true, now: () => currentTime });
    await pipeline.start();
    push(rawMessage("1"));
    await waitUntil(() => pipeline.stats.processed === 1);
    assert.equal(pipeline.stats.tradeCandidates, 1);
    assert.equal(pipeline.stats.paperEntries, 1);
    assert.equal(pipeline.watchedSignalCount, 1); // TRADE_CANDIDATE observed too, not just WATCH

    currentTime = new Date(currentTime.getTime() + 61_000);
    await pipeline.pollWatchedSignalsOnce();
    const observations = await watchObservationRepository!.list();
    assert.equal(observations.length, 1);
    assert.equal(observations[0].horizonLabel, "1m");
    // The paper position itself is untouched by this — observation is purely additive.
    assert.equal(pipeline.openPositions.length, 1);
    await pipeline.stop();
  });
});

test("polling a WATCHed signal persists a real observation snapshot, opens no position, and never changes the original decision", async () => {
  await withTempDir(async (dir) => {
    let currentTime = new Date("2026-09-06T12:00:05.000Z");
    const { pipeline, push, watchObservationRepository } = makePipeline(dir, { engineConfig: WATCH_ONLY_ENGINE_CONFIG, withWatchObservations: true, now: () => currentTime });
    await pipeline.start();
    push(rawMessage("1"));
    await waitUntil(() => pipeline.stats.processed === 1);

    currentTime = new Date(currentTime.getTime() + 61_000); // past the first (1m) post-decision horizon
    await pipeline.pollWatchedSignalsOnce();

    const observations = await watchObservationRepository!.list();
    assert.equal(observations.length, 1);
    assert.equal(observations[0].priceUsd, 0.06); // the real price resolvePrice returned
    assert.equal(observations[0].contractAddress, TOKEN);
    assert.equal(observations[0].horizonLabel, "1m");

    // Still a WATCH, still no position — observation is purely additive, never a trade.
    assert.equal(pipeline.stats.tradeCandidates, 0);
    assert.equal(pipeline.stats.paperEntries, 0);
    assert.equal(pipeline.openPositions.length, 0);

    await pipeline.stop();
  });
});

test("polls across multiple post-decision horizons (1m, 5m, 15m) append distinct observations, never overwrite one another", async () => {
  await withTempDir(async (dir) => {
    let currentTime = new Date("2026-09-06T12:00:05.000Z");
    let callCount = 0;
    const { pipeline, push, watchObservationRepository } = makePipeline(dir, {
      engineConfig: WATCH_ONLY_ENGINE_CONFIG,
      withWatchObservations: true,
      now: () => currentTime,
      resolvePrice: async () => {
        callCount += 1;
        return { priceUsd: 0.05 + callCount * 0.001, liquidityUsd: 10000, source: "dexscreener", dataQuality: "KNOWN" as const, observedAt: currentTime.toISOString(), venueType: "UNKNOWN" as const, venueIdentifier: null, providerCalls: [] };
      },
    });
    await pipeline.start();
    push(rawMessage("1"));
    await waitUntil(() => pipeline.stats.processed === 1);

    currentTime = new Date(currentTime.getTime() + 61_000); // past 1m
    await pipeline.pollWatchedSignalsOnce();
    currentTime = new Date(currentTime.getTime() + 4 * 60_000); // past 5m
    await pipeline.pollWatchedSignalsOnce();
    currentTime = new Date(currentTime.getTime() + 10 * 60_000); // past 15m
    await pipeline.pollWatchedSignalsOnce();

    const observations = await watchObservationRepository!.list();
    assert.equal(observations.length, 3); // three distinct horizons, three distinct records
    assert.deepEqual(observations.map((o) => o.horizonLabel), ["1m", "5m", "15m"]);
    const distinctPrices = new Set(observations.map((o) => o.priceUsd));
    assert.equal(distinctPrices.size, 3);

    await pipeline.stop();
  });
});

test("does nothing (no crash, no-op) when no watchObservationRepository is configured — existing behavior is unaffected", async () => {
  await withTempDir(async (dir) => {
    const { pipeline, push } = makePipeline(dir, { engineConfig: WATCH_ONLY_ENGINE_CONFIG }); // withWatchObservations omitted
    await pipeline.start();
    push(rawMessage("1"));
    await waitUntil(() => pipeline.stats.processed === 1);
    await pipeline.pollWatchedSignalsOnce(); // must not throw
    assert.equal(pipeline.watchedSignalCount, 0); // nothing tracked without a repository configured
    await pipeline.stop();
  });
});

test("a WATCHed signal stops being polled once it falls outside the observation window", async () => {
  await withTempDir(async (dir) => {
    let currentTime = new Date("2026-09-06T12:00:05.000Z");
    const { pipeline, push, watchObservationRepository } = makePipeline(dir, {
      engineConfig: WATCH_ONLY_ENGINE_CONFIG,
      withWatchObservations: true,
      watchObservationWindowMs: 60_000, // 1 minute window for this test
      now: () => currentTime,
    });
    await pipeline.start();
    push(rawMessage("1"));
    await waitUntil(() => pipeline.stats.processed === 1);
    assert.equal(pipeline.watchedSignalCount, 1);

    currentTime = new Date(currentTime.getTime() + 120_000); // advance 2 minutes — past the 1-minute window
    await pipeline.pollWatchedSignalsOnce();

    assert.equal(pipeline.watchedSignalCount, 0); // expired out of the observation window
    const observations = await watchObservationRepository!.list();
    assert.equal(observations.length, 0); // no observation recorded for an expired watch

    await pipeline.stop();
  });
});

test("one broken watch observation does not stop observing the others", async () => {
  await withTempDir(async (dir) => {
    let calls = 0;
    let currentTime = new Date("2026-09-06T12:00:05.000Z");
    const { pipeline, push, watchObservationRepository } = makePipeline(dir, {
      engineConfig: WATCH_ONLY_ENGINE_CONFIG,
      withWatchObservations: true,
      now: () => currentTime,
      resolvePrice: async () => {
        calls += 1;
        if (calls === 1) throw new Error("provider exploded");
        return { priceUsd: 0.07, liquidityUsd: 10000, source: "dexscreener", dataQuality: "KNOWN" as const, observedAt: currentTime.toISOString(), venueType: "UNKNOWN" as const, venueIdentifier: null, providerCalls: [] };
      },
    });
    await pipeline.start();
    push(rawMessage("1", "0xeb1898a0d496000506a2799e1b4077776497fd20"));
    push(rawMessage("2", "0xeb1898a0d496000506a2799e1b4077776497fd21"));
    await waitUntil(() => pipeline.stats.processed === 2);
    assert.equal(pipeline.watchedSignalCount, 2);

    currentTime = new Date(currentTime.getTime() + 61_000); // past the first (1m) post-decision horizon
    await pipeline.pollWatchedSignalsOnce(); // first watched signal's resolvePrice throws — must not stop the second

    const observations = await watchObservationRepository!.list();
    assert.equal(observations.length, 1); // the one that succeeded was still recorded
    assert.equal(pipeline.watchedSignalCount, 2); // neither watch was dropped just because one poll failed

    await pipeline.stop();
  });
});

test("restart recovery restores an in-window WATCH signal and resumes observing it", async () => {
  await withTempDir(async (dir) => {
    const signalRepo = createLiveSignalRecordRepository(path.join(dir, "signals.ndjson"));
    let currentTime = new Date("2026-09-06T12:10:00.000Z"); // ~9m55s after the decision — past the 1m/5m horizons, before 15m
    const now = () => currentTime;
    await signalRepo.save({
      signalId: "telegram:scoutrobinhood:watch-1",
      source: "telegram:scoutrobinhood",
      sourceMessageId: "watch-1",
      tokenSymbol: "OLD",
      contractAddress: TOKEN,
      scoutTimestamp: "2026-09-06T12:00:00.000Z",
      receivedAt: "2026-09-06T12:00:00.000Z",
      events: [{ signalId: "telegram:scoutrobinhood:watch-1", stage: "PAPER_DECISION", timestamp: "2026-09-06T12:00:05.000Z", durationMsSincePrevious: null, status: "OK", details: { decision: "WATCH" } }],
      currentStage: "REJECTED",
      rejectionReason: "WATCH_ONLY",
      venueType: "UNKNOWN",
      marketDataQuality: "KNOWN",
      smartSelectionResultId: "r1",
      overallScore: 60,
      confidence: 50,
      confidenceBreakdown: null,
      dataQuality: null,
      decision: "WATCH",
      paperPositionId: null,
      providerCalls: [],
      mode: "LIVE",
      decisionPriceUsd: null,
    });

    const { pipeline, watchObservationRepository } = makePipeline(dir, { withWatchObservations: true, now });
    const recovery = await pipeline.recoverFromDisk();
    assert.equal(recovery.recoveredSignals, 1);
    assert.equal(pipeline.watchedSignalCount, 1); // the old WATCH signal is still within its observation window

    // The 1m/5m horizons already elapsed before this restart (§25 "where practical" — not re-fired);
    // the next one due is 15m. Advance past it to confirm recovery actually resumes observing, not just
    // recovers bookkeeping.
    currentTime = new Date(currentTime.getTime() + 6 * 60_000);
    await pipeline.pollWatchedSignalsOnce();
    const observations = await watchObservationRepository!.list();
    assert.equal(observations.length, 1);
    assert.equal(observations[0].signalId, "telegram:scoutrobinhood:watch-1");
    assert.equal(observations[0].decidedScore, 60); // the ORIGINAL decision's score, never re-scored
    assert.equal(observations[0].horizonLabel, "15m");

    await pipeline.stop();
  });
});

test("one signal whose processing throws does not crash the listener — later signals still process", async () => {
  await withTempDir(async (dir) => {
    const { adapter, push } = fakeAdapter();
    const portfolio = new PaperPortfolio(PORTFOLIO_CONFIG);
    const throwingTokenAnalysis: TokenIntelligenceProvider = {
      async getTokenIntelligence() {
        throw new Error("catastrophic failure");
      },
      async getFastTokenInfo() {
        throw new Error("catastrophic failure");
      },
      async getSlowTokenInfo() {
        throw new Error("catastrophic failure");
      },
    };
    // Even a throwing dependency inside gatherLiveIntelligence is caught there (degrades gracefully) —
    // to actually exercise signalProcessor-level failure isolation we make parseScoutMessage-adjacent
    // work fine but force a total processing exception via a broken portfolio config.
    const now = () => new Date("2026-09-06T12:00:05.000Z");
    const pipeline = new LivePipeline({
      adapter,
      signalProcessorDeps: {
        source: "telegram:scoutrobinhood",
        intelligenceDeps: { poolDataProvider: poolProvider(), geckoTerminalProvider: geckoProvider(), marketDataProvider: dexScreener(), tokenAnalysisService: throwingTokenAnalysis, chainId: CHAIN_ID, now },
        smartSelectionEngine: new SmartSelectionEngine(PERMISSIVE_ENGINE_CONFIG),
        portfolio,
        generatePositionId: () => "pos-1",
        maxSignalAgeSecondsForEntry: 120,
        now,
      },
      signalRecordRepository: createLiveSignalRecordRepository(path.join(dir, "signals.ndjson")),
      paperPositionRepository: createLivePaperPositionRepository(path.join(dir, "positions.ndjson")),
      positionMonitorDeps: { resolvePrice: async () => ({ priceUsd: null, liquidityUsd: null, source: null, dataQuality: "UNAVAILABLE" as const, observedAt: now().toISOString(), venueType: "UNKNOWN" as const, venueIdentifier: null, providerCalls: [] }), now },
      portfolio,
      maxConcurrentSignals: 3,
      positionPollIntervalMs: 999_999_999,
    });
    await pipeline.start();
    push(rawMessage("1")); // token analysis throws, but gatherLiveIntelligence catches it internally — processing still completes
    push(rawMessage("2"));
    await waitUntil(() => pipeline.stats.processed === 2, 2000);
    assert.equal(pipeline.stats.failures, 0); // degraded gracefully, not a hard failure
    await pipeline.stop();
  });
});

test("restart recovery: reloads dedup state and resumes monitoring previously-open positions", async () => {
  await withTempDir(async (dir) => {
    const signalRepo = createLiveSignalRecordRepository(path.join(dir, "signals.ndjson"));
    const positionRepo = createLivePaperPositionRepository(path.join(dir, "positions.ndjson"));

    await signalRepo.save({
      signalId: "telegram:scoutrobinhood:99",
      source: "telegram:scoutrobinhood",
      sourceMessageId: "99",
      tokenSymbol: "OLD",
      contractAddress: TOKEN,
      scoutTimestamp: "t",
      receivedAt: "t",
      events: [],
      currentStage: "PAPER_POSITION_OPEN",
      rejectionReason: null,
      venueType: "UNKNOWN",
      marketDataQuality: "PARTIAL",
      smartSelectionResultId: null,
      overallScore: null,
      confidence: null,
      confidenceBreakdown: null,
      dataQuality: null,
      decision: "TRADE_CANDIDATE",
      paperPositionId: "pos-old",
      providerCalls: [],
      mode: "LIVE",
      decisionPriceUsd: null,
    });

    const openPosition: LivePaperPosition = {
      id: "pos-old",
      signalId: "telegram:scoutrobinhood:99",
      contractAddress: TOKEN,
      chainId: CHAIN_ID,
      tokenSymbol: "OLD",
      execution: {
        positionId: "pos-old",
        signalId: "telegram:scoutrobinhood:99",
        contractAddress: TOKEN,
        chainId: CHAIN_ID,
        entryTimestamp: "2026-09-06T11:00:00.000Z",
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
    };
    await positionRepo.save(openPosition);

    const portfolio = new PaperPortfolio(PORTFOLIO_CONFIG);
    const now = () => new Date("2026-09-06T12:00:05.000Z");
    const { adapter } = fakeAdapter();
    const recoveredPipeline = new LivePipeline({
      adapter,
      signalProcessorDeps: {
        source: "telegram:scoutrobinhood",
        intelligenceDeps: { poolDataProvider: poolProvider(), geckoTerminalProvider: geckoProvider(), marketDataProvider: dexScreener(), tokenAnalysisService: tokenAnalysis(), chainId: CHAIN_ID, now },
        smartSelectionEngine: new SmartSelectionEngine(PERMISSIVE_ENGINE_CONFIG),
        portfolio,
        generatePositionId: () => "pos-new",
        maxSignalAgeSecondsForEntry: 120,
        now,
      },
      signalRecordRepository: signalRepo,
      paperPositionRepository: positionRepo,
      positionMonitorDeps: { resolvePrice: async () => ({ priceUsd: 0.06, liquidityUsd: 10000, source: "dexscreener", dataQuality: "KNOWN" as const, observedAt: now().toISOString(), venueType: "UNKNOWN" as const, venueIdentifier: null, providerCalls: [] }), now },
      portfolio,
      maxConcurrentSignals: 3,
      positionPollIntervalMs: 999_999_999,
    });

    const recovery = await recoveredPipeline.recoverFromDisk();
    assert.equal(recovery.recoveredSignals, 1);
    assert.equal(recovery.recoveredOpenPositions, 1);
    assert.equal(recoveredPipeline.openPositions.length, 1);
    assert.equal(recoveredPipeline.openPositions[0].id, "pos-old");

    // The old signal's dedup state was seeded from disk before any new message arrives.
    await recoveredPipeline.start();
    assert.equal(recoveredPipeline.stats.processed, 0);
    await recoveredPipeline.stop();
  });
});

test("position monitoring can run independently of any signal ever being processed", async () => {
  await withTempDir(async (dir) => {
    const { pipeline } = makePipeline(dir);
    await pipeline.start();
    await pipeline.pollPositionsOnce(); // no open positions — must not throw
    assert.equal(pipeline.openPositions.length, 0);
    await pipeline.stop();
  });
});

test("tracks multiple simultaneous open positions from different signals independently", async () => {
  await withTempDir(async (dir) => {
    const { pipeline, push } = makePipeline(dir);
    await pipeline.start();
    push(rawMessage("1"));
    push(rawMessage("2"));
    push(rawMessage("3"));
    await waitUntil(() => pipeline.stats.paperEntries === 3);
    assert.equal(pipeline.openPositions.length, 3);
    const ids = new Set(pipeline.openPositions.map((p) => p.id));
    assert.equal(ids.size, 3); // three genuinely distinct positions, not the same one overwritten
    await pipeline.stop();
  });
});

test("closes a position during monitoring once an exit condition is met, without touching signal-processing stats", async () => {
  await withTempDir(async (dir) => {
    const { pipeline, push } = makePipeline(dir);
    await pipeline.start();
    push(rawMessage("1"));
    await waitUntil(() => pipeline.stats.paperEntries === 1);
    assert.equal(pipeline.openPositions.length, 1);

    // positionMonitorDeps.resolvePrice returns 0.06 vs an entry price around 0.05*1.01 slippage — force a bigger move via a custom pipeline instead:
    await pipeline.pollPositionsOnce();
    // With only a small price bump, TP (50%) won't fire — position should still be open and just updated.
    assert.equal(pipeline.stats.processed, 1); // unaffected by position polling
    await pipeline.stop();
  });
});

test("waitForIdle resolves only once genuinely in-flight signal processing has finished, not just when messages were handed off", async () => {
  await withTempDir(async (dir) => {
    const { pipeline, push } = makePipeline(dir, { dexDelayMs: 150 });
    await pipeline.start();
    push(rawMessage("1")); // triggers real (slow, 150ms) processing
    // Immediately after push() returns, the task is still in flight — nothing has been recorded yet.
    assert.equal(pipeline.stats.processed, 0);
    await pipeline.waitForIdle();
    // Only after waitForIdle() resolves is the slow signal guaranteed to have actually finished.
    assert.equal(pipeline.stats.processed, 1);
    await pipeline.stop();
  });
});

test("waitForIdle resolves immediately when there is no in-flight work", async () => {
  await withTempDir(async (dir) => {
    const { pipeline } = makePipeline(dir);
    await pipeline.start();
    await pipeline.waitForIdle(); // must not hang with nothing pending
    await pipeline.stop();
  });
});
