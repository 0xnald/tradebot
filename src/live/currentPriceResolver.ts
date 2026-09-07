// Phase 7 §5/§6/§11 — resolves the current price for a Scout token RIGHT
// NOW, for a live trading decision. Unlike src/backtesting's historical
// reconstruction, lookahead restrictions do not apply here — the current,
// live observation IS the correct one for a live decision. Never a
// silent fallback to a stale cached value — an unavailable result is
// always reported as such.
//
// Phase 7.1 §4/§10: on-chain reconstruction and DexScreener are
// INDEPENDENT data sources (neither needs the other to run), so they're
// fetched CONCURRENTLY, not as a sequential try-then-fallback chain like
// Phase 7 originally had it. That sequential order meant every fresh,
// pre-graduation Pons curve token — exactly the freshest, most
// time-critical kind of Scout call — paid DexScreener's full timeout
// first (DexScreener can't see a pre-graduation curve at all, so it was
// guaranteed to be wasted latency) before ever trying the on-chain path
// that actually had the answer. On-chain is preferred when both resolve
// (§10: it's the more immediate, most-authoritative source and doesn't
// depend on third-party indexing lag), but both provider-call summaries
// are always recorded for latency analytics regardless of which "wins".

import { resolveMarketVenue, type OnChainReconstructionDeps } from "../backtesting/venueResolver.js";
import { withTimeout, TimeoutError } from "../shared/withTimeout.js";
import type { PoolDataProvider } from "../market-data/poolDataProvider.js";
import type { PonsV2LaunchDataProvider } from "../market-data/ponsV2Provider.js";
import type { MarketDataProvider } from "../market-data/marketDataProvider.js";
import type { HistoricalPriceProvider } from "../backtesting/historicalPriceProvider.js";
import type { DataQualityState, LiveProviderCallSummary, MarketVenueType } from "../types/domain.js";

export interface CurrentPriceResolverDeps {
  poolDataProvider: PoolDataProvider;
  ponsV2Provider?: PonsV2LaunchDataProvider;
  marketDataProvider: MarketDataProvider;
  geckoTerminalProvider: HistoricalPriceProvider;
  onChain?: OnChainReconstructionDeps;
  chainId: number;
  /** Per-tier timeout — a slow provider must never block the live decision. */
  timeoutMs?: number;
  /** Injectable clock — defaults to the real current time. Keeps this module deterministically testable. */
  now?: () => Date;
}

export interface CurrentPriceResult {
  priceUsd: number | null;
  liquidityUsd: number | null;
  source: string | null;
  dataQuality: DataQualityState;
  observedAt: string;
  venueType: MarketVenueType;
  venueIdentifier: string | null;
  providerCalls: LiveProviderCallSummary[];
}

const DEFAULT_TIMEOUT_MS = 4000;

interface ResolvedTierPrice {
  priceUsd: number;
  liquidityUsd: number | null;
  source: string | null;
}

/**
 * Exported for src/live/liveIntelligenceGatherer.ts (Phase 7.1 §4/§10):
 * the gatherer wants its OWN full-market-snapshot DexScreener call (pools/
 * volume/marketCap, not just price) running concurrently alongside this
 * on-chain tier, rather than going through `resolveCurrentPrice` (which
 * would fire a second, redundant, price-only DexScreener call). Reusing
 * this function instead of re-implementing venue resolution keeps there
 * being exactly one place that knows how to do it.
 */
/**
 * The whole operation — venue resolution AND the subsequent candle fetch —
 * is wrapped in ONE `withTimeout` here, not just the candle fetch. Real
 * live-verification evidence (Phase 7.1 final validation) found
 * `resolveMarketVenue`'s own Uniswap-V3 candidate-pool-probing loop (see
 * venueResolver.ts) can make several sequential provider calls — one per
 * discovered candidate pool — with no aggregate bound of its own. Timing
 * only the candle fetch left that loop able to run for an unbounded time
 * BEFORE the "shared decision deadline" even started counting, which is
 * exactly the kind of latency-budget gap Phase 7.1 §6 was supposed to
 * close. Wrapping the whole thing is what actually makes "one shared
 * bounded deadline" true.
 */
export async function resolveOnChainPriceTier(
  contractAddress: string,
  nowIso: string,
  deps: CurrentPriceResolverDeps,
  timeoutMs: number,
): Promise<{ venue: Awaited<ReturnType<typeof resolveMarketVenue>>; price: ResolvedTierPrice | null; call: LiveProviderCallSummary }> {
  const startedAt = Date.now();
  // Used only if the timeout fires before venue resolution itself even completes — a genuinely
  // unknown venue, never a guess, consistent with every other "couldn't determine in time" case.
  const fallbackVenue: Awaited<ReturnType<typeof resolveMarketVenue>> = {
    venueType: "UNKNOWN",
    identifier: null,
    ponsPhase: null,
    graduationTimestamp: null,
    usedPreGraduationVenue: null,
    onChainTierAvailable: false,
    provider: deps.geckoTerminalProvider,
    notes: ["on-chain venue resolution did not complete within the shared decision deadline"],
  };

  try {
    return await withTimeout(
      (async () => {
        const venue = await resolveMarketVenue(contractAddress, nowIso, {
          poolDataProvider: deps.poolDataProvider,
          ponsV2Provider: deps.ponsV2Provider,
          geckoTerminalProvider: deps.geckoTerminalProvider,
          onChain: deps.onChain,
          chainId: deps.chainId,
        });

        if (!venue.identifier) {
          return { venue, price: null, call: { provider: "tiered-price", status: "SKIPPED" as const, durationMs: Date.now() - startedAt } };
        }

        const result = await venue.provider.getCandles(deps.chainId, venue.identifier, nowIso, "minute", 1, 1);
        const durationMs = Date.now() - startedAt;
        const lastLookup = "lastLookup" in venue.provider ? (venue.provider as any).lastLookup : null;
        const winningTier: string | null = lastLookup?.winningTier ?? null;
        const call: LiveProviderCallSummary = { provider: winningTier ?? "tiered-price", status: result.status === "ok" ? "OK" : "SKIPPED", durationMs };

        if (result.status === "ok" && result.data && result.data.length > 0) {
          const latest = result.data[result.data.length - 1];
          return { venue, price: { priceUsd: latest.closeUsd, liquidityUsd: null, source: winningTier }, call };
        }
        return { venue, price: null, call };
      })(),
      timeoutMs,
      "on-chain venue resolution + price",
    );
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    return {
      venue: fallbackVenue,
      price: null,
      call: { provider: "tiered-price", status: error instanceof TimeoutError ? "TIMEOUT" : "ERROR", durationMs, error: error instanceof Error ? error.message : String(error) },
    };
  }
}

async function resolveDexScreenerTier(contractAddress: string, deps: CurrentPriceResolverDeps, timeoutMs: number): Promise<{ price: ResolvedTierPrice | null; call: LiveProviderCallSummary }> {
  const startedAt = Date.now();
  try {
    const marketData = await withTimeout(deps.marketDataProvider.getMarketData(deps.chainId, contractAddress), timeoutMs, "DexScreener current price");
    const durationMs = Date.now() - startedAt;
    const call: LiveProviderCallSummary = { provider: deps.marketDataProvider.name, status: marketData.status === "ok" ? "OK" : "SKIPPED", durationMs };

    if (marketData.status === "ok" && marketData.data && marketData.data.priceUsd !== null) {
      return { price: { priceUsd: marketData.data.priceUsd, liquidityUsd: marketData.data.liquidityUsd, source: deps.marketDataProvider.name }, call };
    }
    return { price: null, call };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    return {
      price: null,
      call: { provider: deps.marketDataProvider.name, status: error instanceof TimeoutError ? "TIMEOUT" : "ERROR", durationMs, error: error instanceof Error ? error.message : String(error) },
    };
  }
}

export async function resolveCurrentPrice(contractAddress: string, deps: CurrentPriceResolverDeps): Promise<CurrentPriceResult> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const nowIso = (deps.now?.() ?? new Date()).toISOString();

  const [onChain, dex] = await Promise.all([
    resolveOnChainPriceTier(contractAddress, nowIso, deps, timeoutMs),
    resolveDexScreenerTier(contractAddress, deps, timeoutMs),
  ]);

  const providerCalls: LiveProviderCallSummary[] = [onChain.call, dex.call];
  const winner = onChain.price ?? dex.price;

  return {
    priceUsd: winner?.priceUsd ?? null,
    liquidityUsd: winner?.liquidityUsd ?? null,
    source: winner?.source ?? null,
    dataQuality: winner ? "KNOWN" : "UNAVAILABLE",
    observedAt: nowIso,
    venueType: onChain.venue.venueType,
    venueIdentifier: onChain.venue.identifier,
    providerCalls,
  };
}
