// Phase 7 §5/§15, refactored by Phase 7.1 §4/§5/§6/§9/§10 — gathers the
// best CURRENTLY-available intelligence for a live Scout signal, feeding
// the exact same SmartSelectionInputs shape Phase 5/6 already use.
// Historical lookahead restrictions do NOT apply here — a live, current
// observation is exactly the right one for a live decision. Every
// provider call is timeout-bounded and degrades to null (never
// fabricated) rather than blocking the pipeline.
//
// Phase 7.1 §4 — parallel fan-out (the core change from Phase 7): Phase 7
// ran DexScreener, then (conditionally) the on-chain price fallback, then
// TokenAnalysisService — three sequential awaits whose worst-case
// latencies stack. Phase 7's live verification measured TokenAnalysisService
// alone hitting its full 4-second budget on every real signal (see
// docs/LIVE_INTELLIGENCE.md's latency investigation), meaning the
// sequential total could exceed 3x that. Independent data sources have no
// reason to wait on each other, so everything below fans out via a single
// `Promise.all` and shares ONE bounded decision deadline (§6) — the
// gather's worst-case wall-clock time is now bounded by the SLOWEST
// concurrent branch, not their sum.
//
// Phase 7.1 §5 — tier model (evidence-based, not copied from the brief's
// example — see docs/LIVE_INTELLIGENCE.md for the investigation behind
// these tier assignments):
//   TIER 0 (no I/O):        Scout message text -> walletAssociations.
//   TIER 1 (fast, critical): current price/liquidity (on-chain-first,
//                            DexScreener concurrently — see
//                            currentPriceResolver.ts) and fast token
//                            metadata (a single batched RPC read).
//   TIER 2/3 (slow, optional): deployment info (binary-search over chain
//                            history) and holder distribution
//                            (Blockscout) — see tokenAnalysisService.ts's
//                            `getSlowTokenInfo`. Bounded by the SAME
//                            shared deadline; if it doesn't finish in
//                            time, those fields are simply left
//                            unavailable — never blocks TIER 1's result.
//
// Phase 7.1 (this pass) — wires the remaining Phase 4 analyzers that are
// technically feasible live, reusing them exactly as Phase 4/5 built them
// (no scoring-logic duplication, no invented values):
//   - contractFeatures: TIER 1 — a single `eth_getCode` read, no history
//     search, no dependency on anything else. Always attempted.
//   - tokenAge: free — a pure computation over `tokenContractInfo.deployedAt`
//     once the slow token tier resolves it (often it won't in time; then
//     this honestly reports UNKNOWN, exactly like a missing deployment date
//     always has).
//   - liquidityAnalysis: free — a pure computation over pools/price data
//     already fetched for TIER 1. No `previous` snapshot exists for a
//     signal we're seeing for the first time, so trend is honestly
//     "first known reading", not fabricated stability.
//   - momentum: free — a pure computation over the single current-price
//     observation already fetched. For a fresh signal this correctly
//     reports every historical field as unavailable (insufficient
//     history) rather than inventing a trend from one data point.
//   - marketFlow: TIER 2/3, best-effort — requires genuinely NEW I/O
//     (pool discovery -> recent swaps -> quote-token decimals) that only
//     exists today for Uniswap-V3-shaped pools via the generic
//     `PoolDataProvider` interface; a Pons curve or Uniswap V4 token has
//     no equivalent swap-fetch wiring yet (their swap event shapes are
//     provider-specific — see docs/LIVE_INTELLIGENCE.md), so this
//     legitimately comes back UNAVAILABLE for those venues, not broken.
//   - deployerAnalysis: post-merge, best-effort — needs `deployerAddress`
//     (from the slow token tier, which per Phase 7 evidence frequently
//     doesn't resolve within budget) and whatever swaps marketFlow
//     fetched; returns UNAVAILABLE quickly (no extra RPC calls) when
//     deployerAddress isn't known, per the analyzer's own existing
//     early-return.
//
// Deliberately NOT wired, with reasons (see docs/LIVE_INTELLIGENCE.md):
//   - entryQuality: needs a price "at signal time" distinct from
//     "current" — Scout's EARLY_CALL message never carries a price, so
//     the only candidate for "at signal time" IS the current observation
//     we just fetched. Setting both to the same value would always
//     produce priceSincePct=0, which isn't real evidence — it's a
//     fabricated non-signal. Genuinely meaningful only once a real time
//     gap exists (a later PERFORMANCE_UPDATE, or position monitoring,
//     which already has its own exit-condition logic).
//   - holderConcentration beyond what TokenAnalysisService's slow tier
//     already covers, anomalyFindings, poolQuality, and full
//     wallet-performance/relationship intelligence: unchanged from
//     before this pass — SmartSelectionInputs receives null/[] for these,
//     exactly like Phase 6.6's honestly-partial historical
//     reconstructions. Smart Selection is explicitly designed to handle
//     this (score excludes missing groups; confidence reflects the gap).

import type { Address } from "viem";
import { withTimeout, TimeoutError } from "../shared/withTimeout.js";
import { buildDataQualitySummary } from "../shared/dataQuality.js";
import { buildScoutWalletAssociations } from "../wallet-intelligence/scoutWalletAssociationBuilder.js";
import type { CurrentPriceResolverDeps, CurrentPriceResult } from "./currentPriceResolver.js";
import type { RobinhoodChainClient } from "../blockchain/robinhoodChainClient.js";
import { loadPrimaryRpcCapabilities, type RpcProviderCapabilities } from "../blockchain/chainConfig.js";
import { resolveMarketContextOnce, estimateRecentBlockWindow, CURVE_LOOKBACK_MINUTES, GRADUATION_MARGIN_MINUTES, type ResolvedMarketContext } from "./resolvedMarketContext.js";
import { PonsCurveMarketReader } from "../market-data/ponsCurveMarketReader.js";
import { UniswapV4FlowReader } from "../market-data/uniswapV4FlowReader.js";
import { OnChainUniswapV3PriceProvider } from "../backtesting/onChainUniswapV3PriceProvider.js";
import { TieredHistoricalPriceProvider } from "../backtesting/tieredHistoricalPriceProvider.js";
import { convertToUsd } from "../backtesting/quoteAssetUsdPricing.js";
import { LiquidityAnalyzer } from "../market-data/liquidityAnalyzer.js";
import { MarketFlowAnalyzer } from "../market-data/marketFlowAnalyzer.js";
import { MomentumAnalyzer, type PriceObservation } from "../market-data/momentumAnalyzer.js";
import { ContractFeatureAnalyzer } from "../token-analysis/contractFeatureAnalyzer.js";
import { DeployerAnalyzer } from "../token-analysis/deployerAnalyzer.js";
import { computeTokenAge } from "../token-analysis/tokenAgeAnalyzer.js";
import type { MarketDataProvider } from "../market-data/marketDataProvider.js";
import type { TokenIntelligenceProvider } from "../token-analysis/tokenAnalysisService.js";
import type { SmartSelectionInputs } from "../scoring/smartSelectionEngine.js";
import type {
  ContractFeatureDetection,
  DataQualityField,
  DataQualityState,
  DeployerAnalysis,
  LiquidityAnalysis,
  LiveProviderCallSummary,
  MarketFlowAnalysis,
  MomentumAnalysis,
  PoolInfo,
  ScoutSignal,
  SignalMarketSnapshot,
  SwapRecord,
  TokenAge,
  TokenContractInfo,
} from "../types/domain.js";

export interface LiveIntelligenceDeps extends CurrentPriceResolverDeps {
  marketDataProvider: MarketDataProvider;
  tokenAnalysisService: TokenIntelligenceProvider;
  /**
   * Phase 7.1 §6 — a single bounded decision deadline shared by every
   * concurrent branch below (price resolution's two tiers, fast token
   * metadata, slow token enrichment). Default chosen from Phase 7's real
   * live-verification evidence (docs/LIVE_INTELLIGENCE.md): the old
   * sequential path spent its entire 4-second-per-step budget on
   * TokenAnalysisService alone on every real signal, so 4000ms is kept as
   * a conservative initial default here too — but now it bounds the
   * WHOLE gather (all branches run concurrently), not one step out of
   * three sequential ones, which is already a substantial latency
   * improvement even without retuning the number itself. Revisit once
   * real live latency data exists for the fanned-out version.
   */
  timeoutMs?: number;
  /**
   * Phase 7.2 §11/§13 investigation: an optional SEPARATE budget for the
   * Pons-aware chain (`resolvePonsAwareMarketData`), tried at 7000ms
   * (vs. the shared 4000ms) after directly profiling the Pons lookup
   * alone at up to ~4.9s in isolation (`scripts/profileScoutSignals.ts`).
   * Live-verified and found NOT to help: under real concurrent load (this
   * chain runs alongside 4 other RPC-heavy branches for the same signal,
   * across up to `maxConcurrentSignals` signals at once, all against the
   * same unauthenticated public RPC), the chain still hit `TIMEOUT` on
   * 7/7 real signals even at 7000ms — while raising `scout signal ->
   * decision` latency from ~4s to ~7s for zero completion-rate gain. Left
   * unset (falls back to the shared `timeoutMs`) per the explicit
   * instruction not to sacrifice correctness for an arbitrary number: a
   * bigger number that doesn't fix the actual bottleneck (RPC contention
   * under concurrent load, not under-provisioning) is exactly that. See
   * `docs/LIVE_INTELLIGENCE.md` §4 for the full finding — the real fix is
   * likely RPC-contention-aware concurrency control or a
   * higher-throughput RPC provider, neither implemented here.
   */
  ponsAwareTimeoutMs?: number;
  /**
   * Phase 7.3 §4 — an optional, separately RPC-priority-tagged chain
   * client for contract-feature detection (MEDIUM priority: valuable but
   * not on the critical price/venue path). Falls back to
   * `onChain.chainClient` when not supplied, so every existing test and
   * caller that doesn't care about priority differentiation is
   * unaffected. See `src/blockchain/instrumentedChainClient.ts` /
   * `rpcConcurrencyLimiter.ts` — passing a wrapped client here is what
   * actually applies the priority; passing the raw client is equivalent
   * to "no RPC concurrency control," exactly as before Phase 7.3.
   */
  mediumPriorityChainClient?: RobinhoodChainClient;
  /** Phase 7.3 §4 — same idea, LOW priority, for deployer enrichment (the least time-critical live RPC work — §4's explicit example). Falls back to `onChain.chainClient` when not supplied. */
  lowPriorityChainClient?: RobinhoodChainClient;
  /**
   * Phase 7.4 §2/§10/§11 — a client pointed at the PUBLIC LOG RPC role,
   * used ONLY for the Pons curve/V4 bounded event-history (`eth_getLogs`)
   * fetches when their range exceeds the PRIMARY provider's known cap (see
   * `chooseRpcForLogQuery`). Falls back to `onChain.chainClient` when not
   * supplied, so every existing test/caller that doesn't set up hybrid
   * routing is unaffected (single-provider behavior, exactly as before
   * Phase 7.4).
   */
  logChainClient?: RobinhoodChainClient;
  /** Phase 7.4 §5 — the PRIMARY provider's known eth_getLogs range cap, used by the hybrid routing decision. Defaults to `loadPrimaryRpcCapabilities()` (reads `ROBINHOOD_PRIMARY_MAX_GETLOGS_RANGE`) when not supplied. */
  primaryRpcCapabilities?: RpcProviderCapabilities;
  /** Injectable clock — defaults to the real current time. Threading this through (rather than calling `new Date()` internally) keeps this module deterministically testable and keeps every timestamp aligned with the caller's own clock (e.g. the decision timestamp Smart Selection is evaluated against). */
  now?: () => Date;
}

export interface LiveIntelligenceResult {
  inputs: SmartSelectionInputs;
  currentPrice: CurrentPriceResult;
  marketDataQuality: DataQualityState;
  providerCalls: LiveProviderCallSummary[];
}

const DEFAULT_TIMEOUT_MS = 4000;

function unavailablePrice(observedAt: string): CurrentPriceResult {
  return { priceUsd: null, liquidityUsd: null, source: null, dataQuality: "UNAVAILABLE", observedAt, venueType: "UNKNOWN", venueIdentifier: null, providerCalls: [] };
}

interface DexSnapshotOutcome {
  snapshot: SignalMarketSnapshot | null;
  call: LiveProviderCallSummary;
}

async function fetchDexScreenerSnapshot(scoutSignal: ScoutSignal, contractAddress: string, deps: LiveIntelligenceDeps, timeoutMs: number, now: Date): Promise<DexSnapshotOutcome> {
  const startedAt = Date.now();
  try {
    const marketData = await withTimeout(deps.marketDataProvider.getMarketData(deps.chainId, contractAddress), timeoutMs, "DexScreener market data");
    const call: LiveProviderCallSummary = { provider: deps.marketDataProvider.name, status: marketData.status === "ok" ? "OK" : "SKIPPED", durationMs: Date.now() - startedAt };

    if (marketData.status !== "ok" || !marketData.data) return { snapshot: null, call };

    const fields: DataQualityField[] = [
      { field: "priceUsd", state: marketData.data.priceUsd !== null ? "KNOWN" : "UNAVAILABLE" },
      { field: "liquidityUsd", state: marketData.data.liquidityUsd !== null ? "KNOWN" : "UNAVAILABLE" },
      { field: "volumeUsd24h", state: marketData.data.volumeUsd24h !== null ? "KNOWN" : "UNAVAILABLE" },
      { field: "marketCapUsd", state: marketData.data.marketCapUsd !== null ? "KNOWN" : "UNAVAILABLE" },
    ];
    return {
      snapshot: {
        signalId: scoutSignal.id,
        chainId: deps.chainId,
        contractAddress,
        capturedAt: now.toISOString(),
        priceUsd: marketData.data.priceUsd,
        liquidityUsd: marketData.data.liquidityUsd,
        volumeUsd24h: marketData.data.volumeUsd24h,
        marketCapUsd: marketData.data.marketCapUsd,
        pools: marketData.data.pools,
        recentFlow: null,
        tokenAge: null,
        holderInfo: null,
        dataQuality: buildDataQualitySummary(fields, now),
      },
      call,
    };
  } catch (error) {
    return {
      snapshot: null,
      call: { provider: deps.marketDataProvider.name, status: error instanceof TimeoutError ? "TIMEOUT" : "ERROR", durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) },
    };
  }
}

interface FastTokenOutcome {
  data: TokenContractInfo | null;
  call: LiveProviderCallSummary;
}

async function fetchFastTokenInfo(contractAddress: string, deps: LiveIntelligenceDeps, timeoutMs: number): Promise<FastTokenOutcome> {
  const startedAt = Date.now();
  try {
    const result = await withTimeout(deps.tokenAnalysisService.getFastTokenInfo(contractAddress), timeoutMs, "fast token metadata");
    return { data: result.data, call: { provider: "token-analysis-service:fast", status: result.status === "ok" ? "OK" : "SKIPPED", durationMs: Date.now() - startedAt } };
  } catch (error) {
    return {
      data: null,
      call: { provider: "token-analysis-service:fast", status: error instanceof TimeoutError ? "TIMEOUT" : "ERROR", durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) },
    };
  }
}

interface SlowTokenOutcome {
  data: Partial<TokenContractInfo>;
  call: LiveProviderCallSummary;
}

async function fetchSlowTokenInfo(contractAddress: string, deps: LiveIntelligenceDeps, timeoutMs: number): Promise<SlowTokenOutcome> {
  const startedAt = Date.now();
  try {
    const result = await withTimeout(deps.tokenAnalysisService.getSlowTokenInfo(contractAddress), timeoutMs, "slow token enrichment (deployment + holders)");
    const gotAnything = Object.values(result).some((v) => v !== undefined);
    return { data: result, call: { provider: "token-analysis-service:slow", status: gotAnything ? "OK" : "SKIPPED", durationMs: Date.now() - startedAt } };
  } catch (error) {
    return {
      data: {},
      call: { provider: "token-analysis-service:slow", status: error instanceof TimeoutError ? "TIMEOUT" : "ERROR", durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) },
    };
  }
}

interface ContractFeaturesOutcome {
  data: ContractFeatureDetection | null;
  call: LiveProviderCallSummary;
}

async function fetchContractFeatures(contractAddress: string, deps: LiveIntelligenceDeps, timeoutMs: number): Promise<ContractFeaturesOutcome> {
  const chainClient = deps.mediumPriorityChainClient ?? deps.onChain?.chainClient;
  if (!chainClient) return { data: null, call: { provider: "contract-feature-analyzer", status: "SKIPPED", durationMs: 0 } };

  const startedAt = Date.now();
  try {
    const analyzer = new ContractFeatureAnalyzer({ chainClient });
    const result = await withTimeout(analyzer.analyze(contractAddress as Address), timeoutMs, "contract feature detection");
    return { data: result, call: { provider: "contract-feature-analyzer", status: "OK", durationMs: Date.now() - startedAt } };
  } catch (error) {
    return {
      data: null,
      call: { provider: "contract-feature-analyzer", status: error instanceof TimeoutError ? "TIMEOUT" : "ERROR", durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) },
    };
  }
}

interface PonsAwarePrice {
  priceUsd: number | null;
  priceInQuote: number | null;
  liquidityUsd: number | null;
  source: string | null;
}

interface PonsAwareOutcome {
  context: ResolvedMarketContext | null;
  price: PonsAwarePrice | null;
  flow: MarketFlowAnalysis | null;
  swaps: SwapRecord[];
  /** Only observations with a real USD price (via `convertToUsd`) — MomentumAnalyzer's PriceObservation type requires `priceUsd: number`, so a non-USD-quoted Pons token contributes zero extra observations here (§18: never redesign momentum's contract). */
  usdPriceObservations: PriceObservation[];
  calls: LiveProviderCallSummary[];
  notes: string[];
}

/**
 * Phase 7.2 §3-§10 — resolves the market venue ONCE (§10, via
 * `resolveMarketContextOnce`) and dispatches to a venue-specific fast path:
 * a confirmed Pons V2 curve or graduated-to-V4 token goes straight to its
 * dedicated reader (§7/§8), never through a generic multi-candidate V3
 * discovery loop. A non-Pons token still gets the V3 path (§9), but now
 * reuses the SAME pool `resolveMarketContextOnce` already discovered while
 * determining the venue, instead of Phase 7.1's separate
 * `resolveOnChainPriceTier` + V3-only `fetchMarketFlow`, each of which
 * used to independently rediscover it (both retired by this function).
 *
 * The WHOLE chain (context resolution -> venue-specific reads) is wrapped
 * in one `withTimeout` — the same fix Phase 7.1's final verification
 * found necessary for the old `resolveOnChainPriceTier` (a multi-step
 * chain timed only at its last step could exceed the shared deadline
 * before the timeout wrapper even starts counting).
 */
async function resolvePonsAwareMarketData(scoutSignal: ScoutSignal, contractAddress: string, deps: LiveIntelligenceDeps, timeoutMs: number, now: Date): Promise<PonsAwareOutcome> {
  const onChain = deps.onChain;
  if (!onChain) {
    // No chain client configured for on-chain reads at all — nothing this function does is possible;
    // the caller falls back to the existing V3/DexScreener path, unaffected.
    return { context: null, price: null, flow: null, swaps: [], usdPriceObservations: [], calls: [], notes: [] };
  }

  const startedAt = Date.now();
  try {
    return await withTimeout(
      (async (): Promise<PonsAwareOutcome> => {
        const context = await resolveMarketContextOnce(
          contractAddress,
          scoutSignal.postedAt ?? scoutSignal.receivedAt,
          { chainClient: onChain.chainClient, blockTimeEstimator: onChain.blockTimeEstimator, ponsV2Provider: deps.ponsV2Provider, poolDataProvider: deps.poolDataProvider, chainId: deps.chainId },
          now,
        );
        const calls: LiveProviderCallSummary[] = [];

        if (context.venueType === "PONS_V2_CURVE" && context.identifier && context.quoteTokenAddress && context.tokenDecimals != null && context.quoteTokenDecimals != null) {
          const reader = new PonsCurveMarketReader({
            chainClient: onChain.chainClient,
            logChainClient: deps.logChainClient ?? onChain.chainClient,
            primaryCapabilities: deps.primaryRpcCapabilities ?? loadPrimaryRpcCapabilities(),
            blockTimestampResolver: onChain.blockTimestampResolver,
          });
          const window = await estimateRecentBlockWindow(onChain.blockTimeEstimator, onChain.chainClient, scoutSignal.postedAt ?? scoutSignal.receivedAt, CURVE_LOOKBACK_MINUTES, now);
          const flowStart = Date.now();
          const [flowResult, liquidityResult] = await Promise.all([
            reader.getRecentFlow(deps.chainId, context.identifier, context.quoteTokenAddress, context.tokenDecimals, context.quoteTokenDecimals, window.fromBlock, window.toBlock, now),
            reader.getReserveLiquidity(context.identifier, context.quoteTokenAddress, context.quoteTokenDecimals),
          ]);
          calls.push({ provider: "pons-curve-reader:flow", status: flowResult.dataQuality === "KNOWN" ? "OK" : "SKIPPED", durationMs: Date.now() - flowStart });
          calls.push({ provider: "pons-curve-reader:liquidity", status: liquidityResult.dataQuality === "KNOWN" ? "OK" : "SKIPPED", durationMs: 0 });

          const latest = flowResult.priceObservations[flowResult.priceObservations.length - 1] ?? null;
          const priceUsd = latest ? convertToUsd(latest.priceInQuote, context.quoteTokenAddress) : null;
          // Each observation keeps its OWN real trade timestamp (never `now`) — MomentumAnalyzer
          // computes time-based intervals (1m/5m/15m/...), which would collapse to nothing useful
          // if every point claimed to have been observed at the same instant.
          const usdPriceObservations: PriceObservation[] = [];
          for (const obs of flowResult.priceObservations) {
            if (!obs.timestamp) continue; // timestamp genuinely unresolved for this block — excluded, not guessed
            const usd = convertToUsd(obs.priceInQuote, context.quoteTokenAddress);
            if (usd !== null) usdPriceObservations.push({ observedAt: obs.timestamp, priceUsd: usd });
          }

          return {
            context,
            price: latest ? { priceUsd, priceInQuote: latest.priceInQuote, liquidityUsd: liquidityResult.liquidityUsd, source: "pons-v2-curve" } : null,
            flow: flowResult.marketFlow,
            swaps: flowResult.swaps,
            usdPriceObservations,
            calls,
            notes: [...context.notes, ...flowResult.notes, ...liquidityResult.notes],
          };
        }

        if (context.venueType === "PONS_V2_V4_POOL" && context.identifier && context.poolManagerAddress && context.quoteTokenAddress && context.tokenDecimals != null && context.quoteTokenDecimals != null && context.tokenIsCurrency0 !== null) {
          const reader = new UniswapV4FlowReader({
            chainClient: onChain.chainClient,
            logChainClient: deps.logChainClient ?? onChain.chainClient,
            primaryCapabilities: deps.primaryRpcCapabilities ?? loadPrimaryRpcCapabilities(),
            blockTimestampResolver: onChain.blockTimestampResolver,
          });
          const anchor = context.graduationTimestamp ?? scoutSignal.postedAt ?? scoutSignal.receivedAt;
          const window = await estimateRecentBlockWindow(onChain.blockTimeEstimator, onChain.chainClient, anchor, GRADUATION_MARGIN_MINUTES, now);
          const flowStart = Date.now();
          const flowResult = await reader.getRecentFlow(
            deps.chainId,
            { poolManagerAddress: context.poolManagerAddress, poolId: context.identifier, quoteTokenAddress: context.quoteTokenAddress, tokenIsCurrency0: context.tokenIsCurrency0, tokenDecimals: context.tokenDecimals, quoteDecimals: context.quoteTokenDecimals },
            window.fromBlock,
            window.toBlock,
            now,
          );
          calls.push({ provider: "uniswap-v4-flow-reader", status: flowResult.dataQuality === "KNOWN" ? "OK" : "SKIPPED", durationMs: Date.now() - flowStart });

          // Each observation keeps its OWN real trade timestamp — see the identical note on the curve branch above.
          const usdPriceObservations: PriceObservation[] = [];
          for (const obs of flowResult.priceObservations) {
            if (!obs.timestamp) continue;
            const usd = convertToUsd(obs.priceInQuote, context.quoteTokenAddress);
            if (usd !== null) usdPriceObservations.push({ observedAt: obs.timestamp, priceUsd: usd });
          }

          return {
            context,
            price: flowResult.latestPriceInQuote !== null ? { priceUsd: flowResult.latestPriceUsd, priceInQuote: flowResult.latestPriceInQuote, liquidityUsd: null, source: "uniswap-v4-onchain" } : null,
            flow: flowResult.marketFlow,
            swaps: flowResult.swaps,
            usdPriceObservations,
            calls,
            notes: [...context.notes, ...flowResult.notes],
          };
        }

        // §9 — the existing V3 path is preserved, but now reuses the pool THIS function already
        // discovered while resolving the venue (context.v3Pools), instead of a second, independent
        // `discoverPools` call the way the old (removed) `fetchMarketFlow` used to make.
        if (context.venueType === "UNISWAP_V3_POOL" && context.v3Pools.length > 0 && context.tokenDecimals != null && context.quoteTokenDecimals != null && context.tokenIsCurrency0 !== null && context.identifier && context.quoteTokenAddress) {
          const pool = context.v3Pools[0];
          let price: PonsAwarePrice | null = null;
          try {
            // Same tiering Phase 7.1 relied on for V3 (on-chain event reconstruction first, since
            // it's ground truth with no indexer dependency; GeckoTerminal second) — just built
            // directly from the pool this function already resolved, not rediscovered.
            const onChainV3Provider = new OnChainUniswapV3PriceProvider({
              chainClient: onChain.chainClient,
              blockTimestampResolver: onChain.blockTimestampResolver,
              blockTimeEstimator: onChain.blockTimeEstimator,
              poolAddress: context.identifier,
              quoteTokenAddress: context.quoteTokenAddress,
              tokenIsToken0: context.tokenIsCurrency0,
              token0Decimals: context.tokenIsCurrency0 ? context.tokenDecimals : context.quoteTokenDecimals,
              token1Decimals: context.tokenIsCurrency0 ? context.quoteTokenDecimals : context.tokenDecimals,
            });
            const tiered = new TieredHistoricalPriceProvider([
              { name: "onchain-uniswap-v3", provider: onChainV3Provider },
              { name: "geckoterminal", provider: deps.geckoTerminalProvider },
            ]);
            const priceStart = Date.now();
            const candles = await tiered.getCandles(deps.chainId, context.identifier, now.toISOString(), "minute", 1, 1);
            const winningTier = tiered.lastLookup?.winningTier ?? null;
            calls.push({ provider: winningTier ?? "tiered-uniswap-v3", status: candles.status === "ok" ? "OK" : "SKIPPED", durationMs: Date.now() - priceStart });
            if (candles.status === "ok" && candles.data && candles.data.length > 0) {
              const latest = candles.data[candles.data.length - 1];
              price = { priceUsd: latest.closeUsd, priceInQuote: null, liquidityUsd: pool.liquidityUsd ?? null, source: winningTier };
            }
          } catch (error) {
            calls.push({ provider: "tiered-uniswap-v3", status: error instanceof TimeoutError ? "TIMEOUT" : "ERROR", durationMs: 0, error: error instanceof Error ? error.message : String(error) });
          }

          let flow: MarketFlowAnalysis | null = null;
          let swaps: SwapRecord[] = [];
          try {
            const flowStart = Date.now();
            const swapsResult = await deps.poolDataProvider.getRecentSwaps(pool);
            if (swapsResult.status === "ok" && swapsResult.data) {
              swaps = swapsResult.data;
              const analyzer = new MarketFlowAnalyzer();
              flow = analyzer.analyze(deps.chainId, pool.poolAddress, swaps, context.quoteTokenDecimals, now);
            }
            calls.push({ provider: "market-flow-analyzer", status: flow ? "OK" : "SKIPPED", durationMs: Date.now() - flowStart });
          } catch (error) {
            calls.push({ provider: "market-flow-analyzer", status: "ERROR", durationMs: 0, error: error instanceof Error ? error.message : String(error) });
          }

          return { context, price, flow, swaps, usdPriceObservations: [], calls, notes: context.notes };
        }

        // Not a Pons token and no V3 pool discovered — nothing more this function can safely
        // determine; the caller still has DexScreener running concurrently as the last resort.
        return { context, price: null, flow: null, swaps: [], usdPriceObservations: [], calls, notes: context.notes };
      })(),
      timeoutMs,
      "Pons-aware market context resolution + price/flow",
    );
  } catch (error) {
    return {
      context: null,
      price: null,
      flow: null,
      swaps: [],
      usdPriceObservations: [],
      calls: [{ provider: "pons-aware-market-data", status: error instanceof TimeoutError ? "TIMEOUT" : "ERROR", durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) }],
      notes: [],
    };
  }
}

/**
 * Post-merge, not part of the main fan-out: needs `deployerAddress` (from
 * the slow token tier) and whatever swaps `fetchMarketFlow` found, so it
 * can only run after those resolve. When `deployerAddress` isn't known
 * (the common case per Phase 7 evidence — the slow tier often doesn't
 * finish in time), `DeployerAnalyzer.analyze` returns UNAVAILABLE
 * immediately with no RPC calls at all, so calling it unconditionally
 * here costs nothing in the common case and is bounded by its own short
 * timeout in the uncommon case where it does have real work to do.
 */
async function fetchDeployerAnalysis(
  contractAddress: string,
  deployerAddress: string | undefined,
  totalSupplyRaw: string | undefined,
  swaps: SwapRecord[],
  deps: LiveIntelligenceDeps,
  timeoutMs: number,
): Promise<{ data: DeployerAnalysis | null; call: LiveProviderCallSummary }> {
  const chainClient = deps.lowPriorityChainClient ?? deps.onChain?.chainClient;
  if (!chainClient) return { data: null, call: { provider: "deployer-analyzer", status: "SKIPPED", durationMs: 0 } };

  const startedAt = Date.now();
  try {
    const analyzer = new DeployerAnalyzer({ chainClient });
    const result = await withTimeout(
      analyzer.analyze(contractAddress as Address, deployerAddress ?? null, totalSupplyRaw ?? null, swaps),
      timeoutMs,
      "deployer analysis",
    );
    return { data: result, call: { provider: "deployer-analyzer", status: result.dataQuality === "UNAVAILABLE" ? "SKIPPED" : "OK", durationMs: Date.now() - startedAt } };
  } catch (error) {
    return {
      data: null,
      call: { provider: "deployer-analyzer", status: error instanceof TimeoutError ? "TIMEOUT" : "ERROR", durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) },
    };
  }
}

function computeLiquidityAnalysis(chainId: number, contractAddress: string, currentLiquidityUsd: number | null, observedAt: string, allPools: PoolInfo[]): LiquidityAnalysis {
  const analyzer = new LiquidityAnalyzer();
  // No `previous` snapshot exists for a signal we're seeing for the first time — passing null is the
  // honest "first known reading" case the analyzer already documents, never a fabricated STABLE trend.
  return analyzer.analyze(chainId, contractAddress, currentLiquidityUsd !== null ? { liquidityUsd: currentLiquidityUsd, observedAt } : null, null, null, allPools);
}

function computeMomentum(chainId: number, contractAddress: string, priceUsd: number | null, observedAt: string, now: Date): MomentumAnalysis {
  const analyzer = new MomentumAnalyzer();
  const observations: PriceObservation[] = priceUsd !== null ? [{ observedAt, priceUsd }] : [];
  // A single observation (or none) correctly yields "insufficient history" for every interval field —
  // this is the analyzer's own documented behavior, not a workaround added here.
  return analyzer.analyze(chainId, contractAddress, observations, now);
}

export async function gatherLiveIntelligence(scoutSignal: ScoutSignal, deps: LiveIntelligenceDeps): Promise<LiveIntelligenceResult> {
  const gatherStartedAt = Date.now();
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const contractAddress = scoutSignal.contractAddress;
  const now = deps.now?.() ?? new Date();
  const nowIso = now.toISOString();

  // TIER 0 — no I/O, always available immediately.
  const walletAssociations = buildScoutWalletAssociations(scoutSignal);

  if (!contractAddress) {
    return {
      inputs: buildInputs(scoutSignal, null, null, walletAssociations),
      currentPrice: unavailablePrice(nowIso),
      marketDataQuality: "UNAVAILABLE",
      providerCalls: [],
    };
  }

  // Phase 7.1 §4 / Phase 7.2 §10 — every branch below is an independent data
  // source; fan out concurrently and let each one respect the SAME shared
  // deadline. `resolvePonsAwareMarketData` resolves the venue exactly ONCE
  // and covers price+flow for whichever venue it turns out to be (Pons
  // curve, Pons-graduated V4, or Uniswap V3) — see its own doc comment.
  const ponsAwareTimeoutMs = deps.ponsAwareTimeoutMs ?? timeoutMs;
  const [dexOutcome, ponsAware, fastToken, slowToken, contractFeaturesOutcome] = await Promise.all([
    fetchDexScreenerSnapshot(scoutSignal, contractAddress, deps, timeoutMs, now),
    resolvePonsAwareMarketData(scoutSignal, contractAddress, deps, ponsAwareTimeoutMs, now),
    fetchFastTokenInfo(contractAddress, deps, timeoutMs),
    fetchSlowTokenInfo(contractAddress, deps, timeoutMs),
    fetchContractFeatures(contractAddress, deps, timeoutMs),
  ]);

  const providerCalls: LiveProviderCallSummary[] = [dexOutcome.call, ...ponsAware.calls, fastToken.call, slowToken.call, contractFeaturesOutcome.call];

  const venueType = ponsAware.context?.venueType ?? "UNKNOWN";
  const venueIdentifier = ponsAware.context?.identifier ?? null;

  // §10 — prefer the venue-specific on-chain result when it resolved a price: it's the more
  // immediate, most-authoritative source (and the ONLY one that can see a pre-graduation Pons
  // curve at all) and doesn't depend on third-party indexing lag. Otherwise use DexScreener's
  // fuller snapshot (it carries volume/marketCap/pools the on-chain readers don't compute).
  let marketSnapshot: SignalMarketSnapshot | null = null;
  let currentPrice: CurrentPriceResult;

  if (ponsAware.price) {
    currentPrice = {
      priceUsd: ponsAware.price.priceUsd,
      liquidityUsd: ponsAware.price.liquidityUsd,
      source: ponsAware.price.source,
      dataQuality: "KNOWN",
      observedAt: nowIso,
      venueType,
      venueIdentifier,
      providerCalls: [],
    };
    // The on-chain readers don't compute volume/marketCap/pools — carry those over from
    // DexScreener's snapshot if it also succeeded, but always prefer the on-chain price/liquidity.
    marketSnapshot = {
      signalId: scoutSignal.id,
      chainId: deps.chainId,
      contractAddress,
      capturedAt: nowIso,
      priceUsd: ponsAware.price.priceUsd,
      liquidityUsd: ponsAware.price.liquidityUsd ?? dexOutcome.snapshot?.liquidityUsd ?? null,
      volumeUsd24h: dexOutcome.snapshot?.volumeUsd24h ?? null,
      marketCapUsd: dexOutcome.snapshot?.marketCapUsd ?? null,
      pools: dexOutcome.snapshot?.pools ?? [],
      recentFlow: null,
      tokenAge: null,
      holderInfo: null,
      dataQuality: buildDataQualitySummary(
        [
          { field: "priceUsd", state: ponsAware.price.priceUsd !== null ? "KNOWN" : "UNAVAILABLE" },
          { field: "liquidityUsd", state: ponsAware.price.liquidityUsd !== null || dexOutcome.snapshot?.liquidityUsd != null ? "KNOWN" : "UNAVAILABLE" },
          { field: "volumeUsd24h", state: dexOutcome.snapshot?.volumeUsd24h != null ? "KNOWN" : "UNAVAILABLE" },
          { field: "marketCapUsd", state: dexOutcome.snapshot?.marketCapUsd != null ? "KNOWN" : "UNAVAILABLE" },
        ],
        now,
      ),
    };
  } else if (dexOutcome.snapshot && dexOutcome.snapshot.priceUsd !== null) {
    marketSnapshot = dexOutcome.snapshot;
    currentPrice = {
      priceUsd: dexOutcome.snapshot.priceUsd,
      liquidityUsd: dexOutcome.snapshot.liquidityUsd,
      source: deps.marketDataProvider.name,
      dataQuality: "KNOWN",
      observedAt: nowIso,
      venueType,
      venueIdentifier,
      providerCalls: [dexOutcome.call],
    };
  } else {
    currentPrice = { ...unavailablePrice(nowIso), venueType, venueIdentifier };
  }

  // Merge fast (always attempted) + slow (best-effort) token info. A slow-tier
  // field simply stays undefined if the slow tier didn't finish in time or found nothing —
  // never fabricated, never blocking on the fast fields the decision actually needs.
  const tokenContractInfo: TokenContractInfo | null =
    fastToken.data || Object.values(slowToken.data).some((v) => v !== undefined)
      ? {
          chainId: deps.chainId,
          contractAddress,
          ...fastToken.data,
          ...slowToken.data,
        }
      : null;

  // Free, pure post-merge computations over data already fetched above — see the module doc comment.
  const tokenAge: TokenAge = computeTokenAge(tokenContractInfo?.deployedAt, now);
  const liquidityAnalysis: LiquidityAnalysis = computeLiquidityAnalysis(
    deps.chainId,
    contractAddress,
    currentPrice.liquidityUsd,
    nowIso,
    marketSnapshot?.pools ?? [],
  );
  // Phase 7.2 §18 — when the Pons-aware reader found real recent trade prices (curve or V4 swaps),
  // feed ALL of them into the existing, unmodified MomentumAnalyzer instead of just the single
  // current-price point — genuine multi-observation momentum for a token whose real trade history
  // happens to already exist, rather than an arbitrary redesign. Only observations with a real USD
  // price are usable (MomentumAnalyzer's contract requires priceUsd — see resolvePonsAwareMarketData's
  // doc comment); a non-USD-quoted Pons token naturally falls back to the single-observation case
  // below, exactly as before.
  const momentum: MomentumAnalysis =
    ponsAware.usdPriceObservations.length > 0
      ? new MomentumAnalyzer().analyze(deps.chainId, contractAddress, ponsAware.usdPriceObservations, now)
      : computeMomentum(deps.chainId, contractAddress, currentPrice.priceUsd, nowIso, now);

  // Post-merge, best-effort: only has real work to do when the slow token tier actually resolved a
  // deployerAddress in time — otherwise this is a near-zero-cost UNAVAILABLE result (see the function's
  // own doc comment). Bounded by a smaller slice of the shared budget since it runs AFTER the main fan-out.
  //
  // Phase 7.3 §18/§19 — deadline-aware: this is the lowest-priority, latest-starting piece of the
  // gather (it only runs after the whole main fan-out has already settled). If the fan-out itself
  // already consumed most of the shared budget, starting a NEW RPC-bound operation here would almost
  // certainly just time out anyway, having spent real RPC concurrency for nothing. Skip it
  // immediately in that case — recorded as DEADLINE_SKIPPED, distinct from TIMEOUT, so the two are
  // never conflated in the diagnostic summary (docs/RPC_PERFORMANCE.md).
  const remainingBudgetMs = timeoutMs - (Date.now() - gatherStartedAt);
  const MIN_USEFUL_DEPLOYER_BUDGET_MS = 500;
  const deployerOutcome =
    remainingBudgetMs < MIN_USEFUL_DEPLOYER_BUDGET_MS
      ? { data: null, call: { provider: "deployer-analyzer", status: "DEADLINE_SKIPPED" as const, durationMs: 0 } }
      : await fetchDeployerAnalysis(
          contractAddress,
          tokenContractInfo?.deployerAddress,
          tokenContractInfo?.totalSupplyRaw,
          ponsAware.swaps,
          deps,
          Math.max(1, Math.min(Math.floor(timeoutMs / 4), remainingBudgetMs)),
        );
  providerCalls.push(deployerOutcome.call);

  return {
    inputs: buildInputs(scoutSignal, marketSnapshot, tokenContractInfo, walletAssociations, {
      contractFeatures: contractFeaturesOutcome.data,
      tokenAge,
      liquidityAnalysis,
      marketFlow: ponsAware.flow,
      momentum,
      deployerAnalysis: deployerOutcome.data,
    }),
    currentPrice,
    marketDataQuality: marketSnapshot?.dataQuality.overall ?? "UNAVAILABLE",
    providerCalls,
  };
}

function buildInputs(
  scoutSignal: ScoutSignal,
  marketSnapshot: SignalMarketSnapshot | null,
  tokenContractInfo: TokenContractInfo | null,
  walletAssociations: SmartSelectionInputs["walletAssociations"],
  wired: {
    contractFeatures: ContractFeatureDetection | null;
    tokenAge: TokenAge | null;
    liquidityAnalysis: LiquidityAnalysis | null;
    marketFlow: MarketFlowAnalysis | null;
    momentum: MomentumAnalysis | null;
    deployerAnalysis: DeployerAnalysis | null;
  } = { contractFeatures: null, tokenAge: null, liquidityAnalysis: null, marketFlow: null, momentum: null, deployerAnalysis: null },
): SmartSelectionInputs {
  return {
    scoutSignal,
    marketSnapshot,
    tokenContractInfo,
    contractFeatures: wired.contractFeatures,
    tokenAge: wired.tokenAge,
    liquidityAnalysis: wired.liquidityAnalysis,
    marketFlow: wired.marketFlow,
    momentum: wired.momentum,
    // Deliberately NOT wired — see the module doc comment for why.
    entryQuality: null,
    anomalyFindings: null,
    holderConcentration: null,
    deployerAnalysis: wired.deployerAnalysis,
    poolQuality: [],
    walletAssociations,
    walletQualityByAddress: new Map(),
    walletRelationships: [],
  };
}
