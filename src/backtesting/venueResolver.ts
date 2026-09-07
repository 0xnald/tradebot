// Phase 6.6 — resolves which on-chain venue a Scout-called token actually
// trades on AS OF a given decision timestamp, and builds the tiered
// historical price provider (on-chain event reconstruction first,
// GeckoTerminal fallback second — see tieredHistoricalPriceProvider.ts)
// for it.
//
// The critical correctness rule (Phase 6.6 §7): a graduated Pons V2
// launch's CURRENT phase is NOT enough to pick a venue for a HISTORICAL
// decision. A launch graduated at time G; a decision at time D < G must
// resolve to the pre-graduation curve (the V4 pool didn't exist yet at D),
// even though the launch shows as graduated TODAY. Only D >= G resolves to
// the V4 pool. This is enforced by comparing `decisionTimestamp` against
// the launch's real on-chain `graduationTimestamp` (from the actual
// CurveCompleted event), never against `phase` alone.

import { getAddress } from "viem";
import { getCachedTokenMetadata } from "../shared/tokenMetadataCache.js";
import type { RobinhoodChainClient } from "../blockchain/robinhoodChainClient.js";
import type { BlockTimestampResolver } from "../blockchain/blockTimestampResolver.js";
import type { BlockTimeEstimator } from "../blockchain/blockTimeEstimator.js";
import type { PoolDataProvider } from "../market-data/poolDataProvider.js";
import type { PonsV2LaunchDataProvider } from "../market-data/ponsV2Provider.js";
import { UNISWAP_V4_ADDRESSES } from "../blockchain/chainConfig.js";
import { OnChainPonsCurvePriceProvider } from "./onChainPonsCurvePriceProvider.js";
import { OnChainUniswapV4PriceProvider } from "./onChainUniswapV4PriceProvider.js";
import { OnChainUniswapV3PriceProvider } from "./onChainUniswapV3PriceProvider.js";
import { TieredHistoricalPriceProvider, type PriceProviderTier } from "./tieredHistoricalPriceProvider.js";
import type { HistoricalPriceProvider } from "./historicalPriceProvider.js";
import type { MarketVenueType } from "../types/domain.js";

export interface OnChainReconstructionDeps {
  chainClient: RobinhoodChainClient;
  blockTimestampResolver: BlockTimestampResolver;
  blockTimeEstimator: BlockTimeEstimator;
}

export interface VenueResolverDeps {
  poolDataProvider: PoolDataProvider;
  ponsV2Provider?: PonsV2LaunchDataProvider;
  geckoTerminalProvider: HistoricalPriceProvider;
  onChain?: OnChainReconstructionDeps;
  chainId: number;
}

export interface VenueResolution {
  venueType: MarketVenueType;
  identifier: string | null;
  ponsPhase: string | null;
  graduationTimestamp: string | null;
  usedPreGraduationVenue: boolean | null;
  /** True when an on-chain reconstruction tier could actually be built for this venue (decimals resolved, quote asset known) — false means only GeckoTerminal was attempted. */
  onChainTierAvailable: boolean;
  provider: HistoricalPriceProvider;
  notes: string[];
}

async function tokenDecimals(chainClient: RobinhoodChainClient, token: string): Promise<number | null> {
  try {
    // Phase 7.1 §24 — decimals are time-independent (never vary by decision timestamp), so caching
    // here is safe for both live and historical callers of this shared resolver. See tokenMetadataCache.ts.
    const meta = await getCachedTokenMetadata(chainClient, getAddress(token) as `0x${string}`);
    return meta.decimals;
  } catch {
    return null;
  }
}

export async function resolveMarketVenue(
  contractAddress: string,
  decisionTimestamp: string,
  deps: VenueResolverDeps,
): Promise<VenueResolution> {
  const decisionMs = new Date(decisionTimestamp).getTime();
  const notes: string[] = [];

  if (deps.ponsV2Provider) {
    const pons = await deps.ponsV2Provider.getLaunchInfo(contractAddress);
    if (pons.status === "ok" && pons.data) {
      const info = pons.data;
      const graduated = info.phase === "POOL_CREATED" || info.phase === "RESCUED";

      if (!graduated) {
        return buildResolution("PONS_V2_CURVE", info.curve, info.phase, null, null, notes, deps, {
          curveAddress: info.curve,
          tokenAddress: contractAddress,
          quoteTokenAddress: info.pairToken,
        });
      }

      if (info.graduationTimestamp === null) {
        notes.push("Pons V2 launch shows graduated, but its real CurveCompleted timestamp could not be found — cannot safely determine whether this decision predates graduation, so no venue is resolved (fail closed, never guessed).");
        return { venueType: "UNKNOWN", identifier: null, ponsPhase: info.phase, graduationTimestamp: null, usedPreGraduationVenue: null, onChainTierAvailable: false, provider: singleTier(deps.geckoTerminalProvider), notes };
      }

      const graduationMs = new Date(info.graduationTimestamp).getTime();
      const usedPreGraduationVenue = decisionMs < graduationMs;

      if (usedPreGraduationVenue) {
        notes.push(`Decision (${decisionTimestamp}) predates this launch's real graduation (${info.graduationTimestamp}) — correctly resolved to the pre-graduation curve, not the not-yet-existing V4 pool.`);
        return buildResolution("PONS_V2_CURVE", info.curve, info.phase, info.graduationTimestamp, true, notes, deps, {
          curveAddress: info.curve,
          tokenAddress: contractAddress,
          quoteTokenAddress: info.pairToken,
        });
      }

      return buildResolution("PONS_V2_V4_POOL", info.priceIdentifier, info.phase, info.graduationTimestamp, false, notes, deps, {
        poolId: info.priceIdentifier,
        tokenAddress: contractAddress,
        pairTokenAddress: info.pairToken,
      });
    }
  }

  // Not a Pons V2 launch (or Pons unavailable) — fall back to Uniswap V3 discovery.
  const discovery = await deps.poolDataProvider.discoverPools(contractAddress);
  if (discovery.data && discovery.data.length > 0) {
    for (const pool of discovery.data) {
      const resolution = await buildResolution("UNISWAP_V3_POOL", pool.poolAddress, null, null, null, notes, deps, {
        poolAddress: pool.poolAddress,
        tokenAddress: contractAddress,
        quoteTokenAddress: pool.quoteTokenAddress,
      });
      // Only accept this candidate pool if something actually produced data (on-chain or gecko) — otherwise try the next discovered pool.
      const probe = await resolution.provider.getCandles(deps.chainId, pool.poolAddress, decisionTimestamp, "minute", 1, 1);
      if (probe.status === "ok" && probe.data && probe.data.length > 0) {
        return resolution;
      }
    }
    notes.push(`${discovery.data.length} Uniswap V3 pool(s) discovered on-chain, but none produced any historical data from any tier.`);
  } else {
    notes.push("No venue discovered: not a Pons V1/V2 launch, and no Uniswap V3 pool found via the canonical factory across known quote tokens.");
  }

  return { venueType: "UNKNOWN", identifier: null, ponsPhase: null, graduationTimestamp: null, usedPreGraduationVenue: null, onChainTierAvailable: false, provider: singleTier(deps.geckoTerminalProvider), notes };
}

function singleTier(geckoTerminalProvider: HistoricalPriceProvider): HistoricalPriceProvider {
  return new TieredHistoricalPriceProvider([{ name: "geckoterminal", provider: geckoTerminalProvider }]);
}

interface CurveVenueContext {
  curveAddress: string;
  tokenAddress: string;
  quoteTokenAddress: string;
}
interface V4VenueContext {
  poolId: string;
  tokenAddress: string;
  pairTokenAddress: string;
}
interface V3VenueContext {
  poolAddress: string;
  tokenAddress: string;
  quoteTokenAddress: string;
}

async function buildResolution(
  venueType: MarketVenueType,
  identifier: string | null,
  ponsPhase: string | null,
  graduationTimestamp: string | null,
  usedPreGraduationVenue: boolean | null,
  notes: string[],
  deps: VenueResolverDeps,
  context: CurveVenueContext | V4VenueContext | V3VenueContext,
): Promise<VenueResolution> {
  const tiers: PriceProviderTier[] = [];
  let onChainTierAvailable = false;

  if (deps.onChain && identifier) {
    const onChainProvider = await buildOnChainProvider(venueType, context, deps.onChain);
    if (onChainProvider) {
      tiers.push({ name: onChainProvider.name, provider: onChainProvider });
      onChainTierAvailable = true;
    }
  }
  tiers.push({ name: "geckoterminal", provider: deps.geckoTerminalProvider });

  return {
    venueType,
    identifier,
    ponsPhase,
    graduationTimestamp,
    usedPreGraduationVenue,
    onChainTierAvailable,
    provider: new TieredHistoricalPriceProvider(tiers),
    notes,
  };
}

async function buildOnChainProvider(
  venueType: MarketVenueType,
  context: CurveVenueContext | V4VenueContext | V3VenueContext,
  onChain: OnChainReconstructionDeps,
): Promise<HistoricalPriceProvider | null> {
  if (venueType === "PONS_V2_CURVE") {
    const { curveAddress, tokenAddress, quoteTokenAddress } = context as CurveVenueContext;
    const [tokenDec, quoteDec] = await Promise.all([
      tokenDecimals(onChain.chainClient, tokenAddress),
      tokenDecimals(onChain.chainClient, quoteTokenAddress),
    ]);
    if (tokenDec === null || quoteDec === null) return null;
    return new OnChainPonsCurvePriceProvider({
      chainClient: onChain.chainClient,
      blockTimestampResolver: onChain.blockTimestampResolver,
      blockTimeEstimator: onChain.blockTimeEstimator,
      curveAddress,
      quoteTokenAddress,
      tokenDecimals: tokenDec,
      quoteDecimals: quoteDec,
    });
  }
  if (venueType === "PONS_V2_V4_POOL") {
    const { poolId, tokenAddress, pairTokenAddress } = context as V4VenueContext;
    const tokenIsCurrency0 = BigInt(getAddress(tokenAddress)) < BigInt(getAddress(pairTokenAddress));
    const [decimalsToken, decimalsPair] = await Promise.all([
      tokenDecimals(onChain.chainClient, tokenAddress),
      tokenDecimals(onChain.chainClient, pairTokenAddress),
    ]);
    if (decimalsToken === null || decimalsPair === null) return null;
    const [currency0Decimals, currency1Decimals] = tokenIsCurrency0 ? [decimalsToken, decimalsPair] : [decimalsPair, decimalsToken];
    return new OnChainUniswapV4PriceProvider({
      chainClient: onChain.chainClient,
      blockTimestampResolver: onChain.blockTimestampResolver,
      blockTimeEstimator: onChain.blockTimeEstimator,
      poolManagerAddress: UNISWAP_V4_ADDRESSES.poolManager,
      poolId,
      quoteTokenAddress: pairTokenAddress,
      tokenIsCurrency0,
      currency0Decimals,
      currency1Decimals,
    });
  }
  if (venueType === "UNISWAP_V3_POOL") {
    const { poolAddress, tokenAddress, quoteTokenAddress } = context as V3VenueContext;
    const tokenIsToken0 = BigInt(getAddress(tokenAddress)) < BigInt(getAddress(quoteTokenAddress));
    const [decimalsToken, decimalsQuote] = await Promise.all([
      tokenDecimals(onChain.chainClient, tokenAddress),
      tokenDecimals(onChain.chainClient, quoteTokenAddress),
    ]);
    if (decimalsToken === null || decimalsQuote === null) return null;
    const [token0Decimals, token1Decimals] = tokenIsToken0 ? [decimalsToken, decimalsQuote] : [decimalsQuote, decimalsToken];
    return new OnChainUniswapV3PriceProvider({
      chainClient: onChain.chainClient,
      blockTimestampResolver: onChain.blockTimestampResolver,
      blockTimeEstimator: onChain.blockTimeEstimator,
      poolAddress,
      quoteTokenAddress,
      tokenIsToken0,
      token0Decimals,
      token1Decimals,
    });
  }
  return null;
}
