// npm run live
//
// Phase 7 — the live Scout -> real-time intelligence -> Smart Selection ->
// paper trading entrypoint. Read-only + paper-simulation only: makes
// on-chain reads and public API calls, and simulates paper trades — NEVER
// signs, broadcasts, or touches a real wallet.
//
// Live vs. replay (Phase 7 §22): if TELEGRAM_API_ID/API_HASH/SESSION_STRING
// are configured, this connects to the real Scout Robinhood channel and
// listens for new messages as they arrive (event-driven, not polling). If
// not, it REPLAYS the real captured fixture — clearly logged as replay so
// it's never confused with a live run — so this command always works.
//
// Runs until SIGINT/SIGTERM (Ctrl+C), then prints a final report and exits
// cleanly.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../src/shared/logger.js";
import { FixtureFileAdapter } from "../src/ingestion/fixtureFileAdapter.js";
import { TelegramMtprotoAdapter } from "../src/ingestion/telegramMtprotoAdapter.js";
import { RobinhoodChainClient } from "../src/blockchain/robinhoodChainClient.js";
import { loadChainConfigFromEnv, loadLogChainConfigFromEnv, loadPrimaryRpcCapabilities, describeRpcEndpointSafely } from "../src/blockchain/chainConfig.js";
import { BlockTimestampResolver } from "../src/blockchain/blockTimestampResolver.js";
import { BlockTimeEstimator } from "../src/blockchain/blockTimeEstimator.js";
import { wrapChainClientWithRpcControl } from "../src/blockchain/instrumentedChainClient.js";
import { getGlobalRpcLimiter } from "../src/blockchain/rpcConcurrencyLimiter.js";
import { getGlobalRpcCallLog } from "../src/blockchain/rpcInstrumentation.js";
import { UniswapV3PoolProvider } from "../src/market-data/uniswapV3PoolProvider.js";
import { PonsV2Provider } from "../src/market-data/ponsV2Provider.js";
import { CachingPonsV2Provider } from "../src/market-data/cachingPonsV2Provider.js";
import { DexScreenerMarketDataProvider } from "../src/market-data/dexScreenerMarketDataProvider.js";
import { GeckoTerminalHistoricalPriceProvider } from "../src/backtesting/geckoTerminalHistoricalPriceProvider.js";
import { BlockscoutHolderDataProvider } from "../src/token-analysis/blockscoutHolderDataProvider.js";
import { TokenAnalysisService } from "../src/token-analysis/tokenAnalysisService.js";
import { SmartSelectionEngine } from "../src/scoring/smartSelectionEngine.js";
import { SMART_SELECTION_V1_CONFIG } from "../src/scoring/smartSelectionConfig.js";
import { PaperPortfolio } from "../src/live/paperPortfolio.js";
import { LivePipeline } from "../src/live/livePipeline.js";
import { buildLatencyReport } from "../src/live/latencyMetrics.js";
import { formatStatusView } from "../src/live/statusView.js";
import { createLiveSignalRecordRepository, DEFAULT_LIVE_SIGNAL_RECORDS_PATH } from "../src/storage/liveSignalRecordRepository.js";
import { createLivePaperPositionRepository, DEFAULT_LIVE_PAPER_POSITIONS_PATH } from "../src/storage/livePaperPositionRepository.js";
import { createWatchObservationRepository, DEFAULT_WATCH_OBSERVATIONS_PATH } from "../src/storage/watchObservationRepository.js";
import type { ScoutIngestionAdapter } from "../src/ingestion/types.js";
import type { LiveSignalRecord, PaperPortfolioConfig } from "../src/types/domain.js";

/**
 * Phase 7.4 §20 — a concise per-eligible-call status line. PERFORMANCE_UPDATE and other non-EARLY_CALL
 * messages get a one-line note instead (they never originate a decision — see the Scout-only-origin
 * invariant in ARCHITECTURE.md). Never prints anything that could expose a secret — everything here
 * comes from the already-public Scout message and this system's own computed decision.
 */
function logScoutStatusLine(record: LiveSignalRecord): void {
  if (record.rejectionReason === "PERFORMANCE_UPDATE_NOT_A_CALL") {
    console.log(`[SCOUT] performance update for a prior call (message ${record.sourceMessageId}) — not a new opportunity, ignored`);
    return;
  }
  if (!record.decision) {
    console.log(`[SCOUT] ${record.tokenSymbol ?? "?"} — not eligible (${record.rejectionReason ?? record.currentStage})`);
    return;
  }
  const receivedEvent = record.events.find((e) => e.stage === "RECEIVED");
  const decisionEvent = record.events.find((e) => e.stage === "PAPER_DECISION");
  const latencyMs = receivedEvent && decisionEvent ? new Date(decisionEvent.timestamp).getTime() - new Date(receivedEvent.timestamp).getTime() : null;
  const flowField = record.dataQuality?.fields.find((f) => f.field === "marketFlow");
  console.log(
    [
      "[SCOUT]",
      `token: ${record.tokenSymbol ?? "?"}`,
      `received: ${record.receivedAt}`,
      `venue: ${record.venueType ?? "UNKNOWN"}`,
      `price: ${record.decisionPriceUsd !== null ? `$${record.decisionPriceUsd}` : "n/a"}`,
      `flow: ${flowField?.state ?? "n/a"}`,
      `confidence: ${record.confidence ?? "n/a"}`,
      `score: ${record.overallScore ?? "n/a"}`,
      `decision: ${record.decision}`,
      `latency: ${latencyMs ?? "n/a"}ms`,
      `paper_position: ${record.paperPositionId ?? "none"}`,
    ].join("  "),
  );
}

const logger = createLogger("live-scout");
const SOURCE = "telegram:scoutrobinhood";

const PORTFOLIO_CONFIG: PaperPortfolioConfig = {
  startingCapitalUsd: 1000,
  positionSizePct: 10,
  maxPositionSizeUsd: 200,
  maxConcurrentPositions: 5,
  slippagePct: 1,
  feePct: 0.5,
  takeProfitPct: 50,
  stopLossPct: 20,
  maxHoldingMinutes: 240,
  liquidityEmergencyExitUsd: 500,
  // Simulation parameters only — not tuned/optimized in this phase (Phase 7 §9/§14).
  maxSignalAgeSecondsForEntry: 120,
  priceStalenessSeconds: 60,
};

// Phase 7.3 §2/§17 — configurable so the same real fixture can be run under the 3 load conditions
// the phase asks for (one signal alone, many signals but SIGNAL_PROCESSING_CONCURRENCY=1, normal
// concurrency) without editing code. Deliberately a SEPARATE control from ROBINHOOD_RPC_MAX_CONCURRENCY.
const MAX_CONCURRENT_SIGNALS = process.env.SIGNAL_PROCESSING_CONCURRENCY ? Math.max(1, Number(process.env.SIGNAL_PROCESSING_CONCURRENCY) || 5) : 5;
const POSITION_POLL_INTERVAL_MS = 30_000;
const PROVIDER_TIMEOUT_MS = 4000;

function resolveAdapter(): { adapter: ScoutIngestionAdapter; isReplay: boolean } {
  const { TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION_STRING, SCOUT_TELEGRAM_CHANNEL } = process.env;

  if (TELEGRAM_API_ID && TELEGRAM_API_HASH && TELEGRAM_SESSION_STRING) {
    logger.info("Telegram credentials found — connecting to the LIVE Scout Robinhood channel");
    return {
      adapter: new TelegramMtprotoAdapter({
        apiId: Number(TELEGRAM_API_ID),
        apiHash: TELEGRAM_API_HASH,
        sessionString: TELEGRAM_SESSION_STRING,
        channelUsername: SCOUT_TELEGRAM_CHANNEL ?? "scoutrobinhood",
      }),
      isReplay: false,
    };
  }

  logger.info("no Telegram credentials configured — REPLAYING the captured real Scout fixture (not live ingestion)");
  const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "ingestion", "fixtures", "scoutrobinhood-2026-09-04.raw.json");
  return { adapter: new FixtureFileAdapter({ filePath: fixturePath, delayMs: 200 }), isReplay: true };
}

async function main(): Promise<void> {
  const { adapter, isReplay } = resolveAdapter();

  // Phase 7.3A §1 — confirms which RPC endpoint is actually active WITHOUT ever printing the URL,
  // an API key, or any query parameter. `describeRpcEndpointSafely` only ever returns "public
  // Robinhood RPC (documented default)" or a bare hostname (with a suspicious-looking leading
  // subdomain label redacted) — see chainConfig.ts's doc comment for exactly what it will and won't
  // disclose.
  const rpcConfig = loadChainConfigFromEnv();
  logger.info("RPC endpoint", { provider: describeRpcEndpointSafely(rpcConfig.rpcUrl) });

  // Phase 7.4 §2 — the PUBLIC LOG RPC role, a second independently-configured endpoint used only for
  // bounded eth_getLogs event-history queries whose range exceeds the PRIMARY provider's known cap
  // (see chainConfig.ts's `loadLogChainConfigFromEnv`/`loadPrimaryRpcCapabilities` and
  // docs/RPC_PERFORMANCE.md). Logged the same safe way — never the raw URL.
  const logRpcConfig = loadLogChainConfigFromEnv();
  const primaryCapabilities = loadPrimaryRpcCapabilities();
  logger.info("log RPC endpoint", { provider: describeRpcEndpointSafely(logRpcConfig.rpcUrl), primaryMaxGetLogsRange: primaryCapabilities.maxGetLogsBlockRange ?? "unlimited" });

  const chainClient = new RobinhoodChainClient();
  const logChainClientRaw = new RobinhoodChainClient({ config: logRpcConfig });

  // Phase 7.3 §3/§4/§17/§22 — every RPC call the live path makes routes through ONE shared global
  // concurrency limiter (rpcConcurrencyLimiter.ts's `getGlobalRpcLimiter()`), reached via one of these
  // priority-tagged wrapper clients — NOT a separate limiter per analyzer. Priority reflects actual
  // decision value (§4): resolving a FRESH Scout call's venue/price/flow is CRITICAL (nothing else
  // matters if this doesn't complete); contract-feature detection is MEDIUM; deployer enrichment is
  // LOW (§4's own example). Position monitoring and WATCH observation are background re-checks of
  // ALREADY-decided signals — never a fresh decision — so both are LOW priority, ensuring neither can
  // ever consume RPC capacity a fresh Scout call needs (§22's explicit ordering). `as unknown as
  // RobinhoodChainClient` is the same structural-typing workaround this codebase already uses for
  // `RobinhoodChainClient`'s private fields in tests (see tokenAnalysisService.test.ts) — the wrapper
  // only ever adds instrumentation/throttling around read-only calls.
  const criticalChainClient = wrapChainClientWithRpcControl(chainClient, { caller: "fresh-signal:critical", priority: "CRITICAL", role: "PRIMARY" }) as unknown as RobinhoodChainClient;
  const mediumChainClient = wrapChainClientWithRpcControl(chainClient, { caller: "fresh-signal:medium", priority: "MEDIUM", role: "PRIMARY" }) as unknown as RobinhoodChainClient;
  const lowChainClient = wrapChainClientWithRpcControl(chainClient, { caller: "fresh-signal:low", priority: "LOW", role: "PRIMARY" }) as unknown as RobinhoodChainClient;
  const backgroundChainClient = wrapChainClientWithRpcControl(chainClient, { caller: "background:position+watch", priority: "LOW", role: "PRIMARY" }) as unknown as RobinhoodChainClient;

  // Phase 7.4 §7 — the LOG role gets its OWN wrapper instances (over the SEPARATE `logChainClientRaw`,
  // pointed at the log RPC endpoint) and its own global concurrency limiter (`getGlobalRpcLimiter("LOG")`,
  // reached automatically via `role: "LOG"` here) — never the PRIMARY limiter, so a large bounded flow
  // scan can never starve fresh-signal PRIMARY reads of concurrency slots, and vice versa.
  const logChainClient = wrapChainClientWithRpcControl(logChainClientRaw, { caller: "fresh-signal:log", priority: "CRITICAL", role: "LOG" }) as unknown as RobinhoodChainClient;
  const backgroundLogChainClient = wrapChainClientWithRpcControl(logChainClientRaw, { caller: "background:log", priority: "LOW", role: "LOG" }) as unknown as RobinhoodChainClient;

  const poolDataProvider = new UniswapV3PoolProvider({ chainClient: criticalChainClient });
  // Phase 7.1 §24 — a short-TTL cache (60s), live-only: safe here because every call is implicitly
  // "as of right now" (see cachingPonsV2Provider.ts for why this is NOT applied to the shared
  // backtesting venue resolver, where it would risk historical correctness).
  const ponsV2Provider = new CachingPonsV2Provider(new PonsV2Provider({ chainClient: criticalChainClient, logChainClient, primaryCapabilities }));
  const geckoTerminalProvider = new GeckoTerminalHistoricalPriceProvider();
  const marketDataProvider = new DexScreenerMarketDataProvider();
  const tokenAnalysisService = new TokenAnalysisService({ chainClient: mediumChainClient, holderProvider: new BlockscoutHolderDataProvider() });
  const onChainReconstruction = {
    chainClient: criticalChainClient,
    blockTimestampResolver: new BlockTimestampResolver(criticalChainClient),
    blockTimeEstimator: new BlockTimeEstimator(criticalChainClient),
  };

  // Background (position monitoring + WATCH observation) gets its OWN provider instances wrapping
  // the LOW-priority client — deliberately NOT sharing the fresh-signal path's `CachingPonsV2Provider`
  // instance, so a background re-check never appears to "jump the queue" via a cache warmed by a
  // higher-priority fresh call (a background poll that misses the cache just pays its own LOW-priority
  // cost, exactly as it should).
  const backgroundPoolDataProvider = new UniswapV3PoolProvider({ chainClient: backgroundChainClient });
  const backgroundPonsV2Provider = new CachingPonsV2Provider(new PonsV2Provider({ chainClient: backgroundChainClient, logChainClient: backgroundLogChainClient, primaryCapabilities }));
  const backgroundOnChainReconstruction = {
    chainClient: backgroundChainClient,
    blockTimestampResolver: new BlockTimestampResolver(backgroundChainClient),
    blockTimeEstimator: new BlockTimeEstimator(backgroundChainClient),
  };

  const portfolio = new PaperPortfolio(PORTFOLIO_CONFIG);
  const smartSelectionEngine = new SmartSelectionEngine(SMART_SELECTION_V1_CONFIG);

  const signalRecordRepository = createLiveSignalRecordRepository();
  const paperPositionRepository = createLivePaperPositionRepository();
  const watchObservationRepository = createWatchObservationRepository();

  logger.info("RPC concurrency control", {
    primaryMaxConcurrency: getGlobalRpcLimiter("PRIMARY").maxConcurrency,
    primarySource: process.env.ROBINHOOD_RPC_MAX_CONCURRENCY ? "ROBINHOOD_RPC_MAX_CONCURRENCY" : "default (see docs/RPC_PERFORMANCE.md)",
    logMaxConcurrency: getGlobalRpcLimiter("LOG").maxConcurrency,
    logSource: process.env.ROBINHOOD_LOG_RPC_MAX_CONCURRENCY ? "ROBINHOOD_LOG_RPC_MAX_CONCURRENCY" : "default (see docs/RPC_PERFORMANCE.md)",
  });

  const pipeline = new LivePipeline({
    adapter,
    signalProcessorDeps: {
      source: SOURCE,
      intelligenceDeps: {
        poolDataProvider,
        ponsV2Provider,
        geckoTerminalProvider,
        onChain: onChainReconstruction,
        marketDataProvider,
        tokenAnalysisService,
        chainId: chainClient.chainId,
        timeoutMs: PROVIDER_TIMEOUT_MS,
        mediumPriorityChainClient: mediumChainClient,
        lowPriorityChainClient: lowChainClient,
        logChainClient,
        primaryRpcCapabilities: primaryCapabilities,
      },
      smartSelectionEngine,
      portfolio,
      generatePositionId: () => crypto.randomUUID(),
      maxSignalAgeSecondsForEntry: PORTFOLIO_CONFIG.maxSignalAgeSecondsForEntry,
      // Phase 7.4 §29 — every record this run produces is tagged REPLAY or LIVE explicitly, so a
      // later report can never accidentally combine fixture-replay statistics with genuine Scout
      // activity.
      mode: isReplay ? "REPLAY" : "LIVE",
    },
    signalRecordRepository,
    paperPositionRepository,
    watchObservationRepository,
    positionMonitorDeps: {
      resolvePrice: async (contractAddress: string, chainId: number) => {
        const { resolveCurrentPrice } = await import("../src/live/currentPriceResolver.js");
        return resolveCurrentPrice(contractAddress, {
          poolDataProvider: backgroundPoolDataProvider,
          ponsV2Provider: backgroundPonsV2Provider,
          geckoTerminalProvider,
          onChain: backgroundOnChainReconstruction,
          marketDataProvider,
          chainId,
          timeoutMs: PROVIDER_TIMEOUT_MS,
        });
      },
    },
    portfolio,
    maxConcurrentSignals: MAX_CONCURRENT_SIGNALS,
    positionPollIntervalMs: POSITION_POLL_INTERVAL_MS,
    onRecordProcessed: logScoutStatusLine,
  });

  logger.info("starting live pipeline", { source: SOURCE, isReplay, portfolioConfig: PORTFOLIO_CONFIG, maxConcurrentSignals: MAX_CONCURRENT_SIGNALS, positionPollIntervalMs: POSITION_POLL_INTERVAL_MS });
  await pipeline.start();
  logger.info(isReplay ? "REPLAY mode — no live Telegram connection" : "LIVE — connected and listening for new Scout messages", {});

  const statusInterval = setInterval(() => {
    console.log("\n" + formatStatusView({
      listenerStatus: isReplay ? "REPLAY" : "CONNECTED",
      stats: pipeline.stats,
      recentRecords: pipeline.recentRecords,
      openPositions: pipeline.openPositions,
      recentClosedPositions: [],
    }) + "\n");
  }, 15_000);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(statusInterval);
    logger.info("shutting down...");
    await pipeline.stop();

    const finalRecords = await signalRecordRepository.list();
    const latencyReport = buildLatencyReport(finalRecords);

    console.log("\n" + formatStatusView({
      listenerStatus: "DISCONNECTED",
      stats: pipeline.stats,
      recentRecords: pipeline.recentRecords,
      openPositions: pipeline.openPositions,
      recentClosedPositions: [],
    }));
    console.log("\nLatency report:");
    console.log(`  scout signal -> paper entry: avg=${latencyReport.scoutToPaperEntry.averageMs?.toFixed(0) ?? "n/a"}ms median=${latencyReport.scoutToPaperEntry.medianMs?.toFixed(0) ?? "n/a"}ms p95=${latencyReport.scoutToPaperEntry.p95Ms?.toFixed(0) ?? "n/a"}ms max=${latencyReport.scoutToPaperEntry.maxMs?.toFixed(0) ?? "n/a"}ms (n=${latencyReport.scoutToPaperEntry.count})`);
    console.log(`  scout signal -> decision:    avg=${latencyReport.scoutToDecision.averageMs?.toFixed(0) ?? "n/a"}ms median=${latencyReport.scoutToDecision.medianMs?.toFixed(0) ?? "n/a"}ms p95=${latencyReport.scoutToDecision.p95Ms?.toFixed(0) ?? "n/a"}ms max=${latencyReport.scoutToDecision.maxMs?.toFixed(0) ?? "n/a"}ms (n=${latencyReport.scoutToDecision.count})`);
    for (const [provider, stats] of Object.entries(latencyReport.byProvider)) {
      console.log(`  provider ${provider}: avg=${stats.averageMs?.toFixed(0) ?? "n/a"}ms max=${stats.maxMs?.toFixed(0) ?? "n/a"}ms (n=${stats.count})`);
    }
    // Phase 7.3 §1 — the diagnostic summary the phase explicitly asks for: what RPC work actually
    // happened, per signal and per caller, with concurrency/timeout/dedup evidence. See
    // docs/RPC_PERFORMANCE.md for the methodology and the benchmark this feeds.
    const rpcSummary = getGlobalRpcCallLog().summarize();
    console.log("\nRPC diagnostic summary (Phase 7.3 §1):");
    console.log(`  total RPC requests: ${rpcSummary.totalRequests} (max concurrency observed: ${rpcSummary.maxConcurrencyObserved}, configured limit: ${getGlobalRpcLimiter().maxConcurrency})`);
    console.log(`  latency: avg=${rpcSummary.averageLatencyMs?.toFixed(0) ?? "n/a"}ms median=${rpcSummary.medianLatencyMs?.toFixed(0) ?? "n/a"}ms p95=${rpcSummary.p95LatencyMs?.toFixed(0) ?? "n/a"}ms`);
    console.log(`  timeouts=${rpcSummary.timeoutCount} errors=${rpcSummary.errorCount} cache hits=${rpcSummary.cacheHitCount}`);
    console.log(`  requests by caller: ${JSON.stringify(rpcSummary.requestsByCaller)}`);
    console.log(`  requests by method: ${JSON.stringify(rpcSummary.requestsByMethod)}`);
    console.log(`  requests by signal: ${JSON.stringify(rpcSummary.requestsBySignal)}`);
    if (rpcSummary.duplicateRequestGroups.length > 0) {
      console.log(`  duplicate/equivalent requests within the same signal: ${JSON.stringify(rpcSummary.duplicateRequestGroups)}`);
    } else {
      console.log(`  duplicate/equivalent requests within the same signal: none observed`);
    }

    console.log(`\nReal transactions sent: 0 (this system never signs or broadcasts — paper trading only)`);
    console.log(`Signal records: ${DEFAULT_LIVE_SIGNAL_RECORDS_PATH}`);
    console.log(`Paper positions: ${DEFAULT_LIVE_PAPER_POSITIONS_PATH}`);
    console.log(`Watch observations: ${DEFAULT_WATCH_OBSERVATIONS_PATH}`);

    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // For a replay run, there's no live connection to "stay open" for — the fixture adapter's own
  // start() resolves once every message has been HANDED OFF, but several of those (real EARLY_CALL
  // signals doing real network I/O) may still be in flight via the bounded-concurrency queue at that
  // point — a fast PERFORMANCE_UPDATE rejection finishes near-instantly while a real signal is still
  // resolving its venue/price/token info. Waiting for genuine idle here, not just "handed off," is
  // what makes the final report actually reflect every signal's real outcome.
  if (isReplay) {
    logger.info("replay messages fully handed off — waiting for any still-in-flight signal processing to finish...");
    await pipeline.waitForIdle();
    logger.info("replay complete — shutting down automatically (a live run stays connected until Ctrl+C)");
    await shutdown();
  }
  // For a live run, the process is kept alive by the still-active setInterval and the Telegram
  // client's own event loop — nothing here blocks; SIGINT/SIGTERM triggers the shutdown above.
}

main().catch((error) => {
  logger.error("live pipeline failed", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
