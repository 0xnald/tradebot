// Phase 7.2 §10 — resolves which venue a Scout token trades on EXACTLY
// ONCE per signal, then hands every downstream intelligence provider
// (price, liquidity, flow, momentum) the SAME resolved context instead of
// each one independently re-discovering the market. Live-only —
// deliberately NOT shared with src/backtesting/venueResolver.ts, which
// must re-check a launch's phase/graduation fresh for every historical
// decision timestamp (Phase 6.6's correctness guarantee); a live call is
// always "as of right now", so resolving once per signal is safe here in
// a way it would not be there.
//
// §1 (unchanged invariant): this module only ever looks up a token Scout
// already named. It never scans Pons or Uniswap for opportunities — the
// contractAddress it's given always comes from a real Scout signal.
//
// §2's profiling (docs/LIVE_INTELLIGENCE.md) found the Pons lookup alone
// can take 300ms-5000ms, and that the OLD path additionally ran a full
// Uniswap V3 discovery even for confirmed Pons tokens (which always came
// back empty for the 3 real graduated-Pons signals profiled) — pure
// wasted latency. This module checks Pons once and only falls through to
// V3 discovery when the token is confirmed NOT a Pons launch.

import { getAddress } from "viem";
import { getCachedTokenMetadata } from "../shared/tokenMetadataCache.js";
import { PONS_ADDRESSES, UNISWAP_V4_ADDRESSES } from "../blockchain/chainConfig.js";
import type { RobinhoodChainClient } from "../blockchain/robinhoodChainClient.js";
import type { BlockTimeEstimator } from "../blockchain/blockTimeEstimator.js";
import type { PoolDataProvider } from "../market-data/poolDataProvider.js";
import type { PonsV2LaunchDataProvider } from "../market-data/ponsV2Provider.js";
import type { DataQualityState, MarketVenueType, PoolInfo } from "../types/domain.js";

export interface ResolvedMarketContextDeps {
  chainClient: RobinhoodChainClient;
  blockTimeEstimator: BlockTimeEstimator;
  ponsV2Provider?: PonsV2LaunchDataProvider;
  poolDataProvider: PoolDataProvider;
  chainId: number;
}

export interface ResolvedMarketContext {
  token: string;
  venueType: MarketVenueType;
  /** Pons's own lifecycle phase string, or null if not a Pons launch / unknown. */
  lifecyclePhase: string | null;
  /** Curve address (PONS_V2_CURVE) or PoolId (PONS_V2_V4_POOL) or pool address (UNISWAP_V3_POOL) — null if UNKNOWN. */
  identifier: string | null;
  poolManagerAddress: string | null;
  quoteTokenAddress: string | null;
  quoteTokenDecimals: number | null;
  tokenDecimals: number | null;
  tokenIsCurrency0: boolean | null;
  graduationTimestamp: string | null;
  /** All Uniswap V3 pools discovered directly for this token, when the venue is UNISWAP_V3_POOL (or Pons was unavailable) — preserves Phase 7.1's existing V3 path (§9). */
  v3Pools: PoolInfo[];
  observedAt: string;
  dataQuality: DataQualityState;
  notes: string[];
}

async function tokenDecimalsOrNull(chainClient: RobinhoodChainClient, address: string): Promise<number | null> {
  try {
    const meta = await getCachedTokenMetadata(chainClient, getAddress(address) as `0x${string}`);
    return meta.decimals;
  } catch {
    return null;
  }
}

/** A conservative recent-block margin for a token we're seeing for the first time — see §12: bounded, not a full-history scan. */
const CURVE_LOOKBACK_MINUTES = 180;
const GRADUATION_MARGIN_MINUTES = 5;

export interface RecentBlockWindow {
  fromBlock: bigint;
  toBlock: bigint;
}

/**
 * §12 — a small, relevant recent-block window, anchored to a real timestamp
 * (Scout's call time for a curve, or graduation for a V4 pool) rather than
 * an arbitrary "look back forever" scan.
 *
 * Phase 7.3B §C/§E — `toBlock` used to be unconditionally the LIVE chain
 * tip. For a genuinely live signal (anchor ≈ now) that's harmless — the two
 * are close together anyway. But every test/replay run processes REAL
 * captured Scout signals whose `anchorIso` is from whenever they were
 * originally posted, while `now` is the real wall-clock moment the replay
 * runs — days later. Anchoring `fromBlock` correctly but leaving `toBlock`
 * at the live tip made the window span that entire real-world gap (days,
 * not minutes): the exact mechanism behind Phase 7.3A's observed
 * ~2.19-million-block query for a nominal 180-minute lookback (measured
 * chain rate is a steady ~9.9 blocks/sec — see docs/RPC_PERFORMANCE.md — so
 * 180 real minutes is correctly ~107,000 blocks, not millions). `toBlock` is
 * now bounded to whichever is earlier: the live tip, or an estimate of the
 * anchor's own moment — so a live signal (anchor≈now) is unaffected, and a
 * historical/replayed one is correctly bounded near when it actually happened.
 */
export async function estimateRecentBlockWindow(blockTimeEstimator: BlockTimeEstimator, chainClient: RobinhoodChainClient, anchorIso: string, marginMinutes: number, now: Date): Promise<RecentBlockWindow> {
  const anchorMs = new Date(anchorIso).getTime();
  const anchorIsValid = !Number.isNaN(anchorMs);
  const fromMs = anchorIsValid ? anchorMs - marginMinutes * 60_000 : now.getTime() - marginMinutes * 60_000;
  const toMs = anchorIsValid ? Math.min(anchorMs, now.getTime()) : now.getTime();

  const [fromEstimated, toEstimated, currentBlock] = await Promise.all([blockTimeEstimator.estimateBlockAt(fromMs), blockTimeEstimator.estimateBlockAt(toMs), chainClient.getBlockNumber()]);
  const toBlock = toEstimated < currentBlock ? toEstimated : currentBlock;
  return { fromBlock: fromEstimated > 0n ? fromEstimated : 0n, toBlock };
}

export async function resolveMarketContextOnce(
  contractAddress: string,
  scoutSignalTimeIso: string,
  deps: ResolvedMarketContextDeps,
  now: Date = new Date(),
): Promise<ResolvedMarketContext> {
  const observedAt = now.toISOString();
  const base = {
    token: contractAddress,
    poolManagerAddress: null,
    graduationTimestamp: null as string | null,
    v3Pools: [] as PoolInfo[],
    observedAt,
  };

  if (deps.ponsV2Provider) {
    const pons = await deps.ponsV2Provider.getLaunchInfo(contractAddress);
    if (pons.status === "ok" && pons.data) {
      const info = pons.data;
      const graduated = info.phase === "POOL_CREATED" || info.phase === "RESCUED";

      if (!graduated) {
        const [tokenDecimals, quoteTokenDecimals] = await Promise.all([tokenDecimalsOrNull(deps.chainClient, contractAddress), tokenDecimalsOrNull(deps.chainClient, info.pairToken)]);
        return {
          ...base,
          venueType: "PONS_V2_CURVE",
          lifecyclePhase: info.phase,
          identifier: info.curve,
          quoteTokenAddress: info.pairToken,
          quoteTokenDecimals,
          tokenDecimals,
          tokenIsCurrency0: null,
          dataQuality: tokenDecimals !== null && quoteTokenDecimals !== null ? "KNOWN" : "PARTIAL",
          notes: [`confirmed Pons V2 curve, phase=${info.phase}`],
        };
      }

      // Graduated: identifier is the V4 PoolId, priceIdentifierKind confirms it (never treated as an address — §5).
      const [tokenDecimals, quoteTokenDecimals] = await Promise.all([tokenDecimalsOrNull(deps.chainClient, contractAddress), tokenDecimalsOrNull(deps.chainClient, info.pairToken)]);
      const tokenIsCurrency0 = tokenDecimals !== null ? BigInt(getAddress(contractAddress)) < BigInt(getAddress(info.pairToken)) : null;
      return {
        ...base,
        venueType: "PONS_V2_V4_POOL",
        lifecyclePhase: info.phase,
        identifier: info.priceIdentifier,
        poolManagerAddress: UNISWAP_V4_ADDRESSES.poolManager,
        quoteTokenAddress: info.pairToken,
        quoteTokenDecimals,
        tokenDecimals,
        tokenIsCurrency0,
        graduationTimestamp: info.graduationTimestamp,
        dataQuality: tokenDecimals !== null && quoteTokenDecimals !== null ? "KNOWN" : "PARTIAL",
        notes: [`confirmed Pons V2 launch, graduated (phase=${info.phase}) to Uniswap V4`],
      };
    }
  }

  // Not a Pons V2 launch (or Pons unavailable) — fall through to Uniswap V3 discovery ONLY, no candidate-probing loop here
  // (that expensive part stays where price resolution actually needs it — see currentPriceResolver.ts's own tiered attempt).
  const discovery = await deps.poolDataProvider.discoverPools(contractAddress);
  const v3Pools = discovery.status === "ok" ? discovery.data ?? [] : [];
  if (v3Pools.length > 0) {
    const pool = v3Pools[0];
    const tokenDecimals = await tokenDecimalsOrNull(deps.chainClient, contractAddress);
    const quoteTokenDecimals = await tokenDecimalsOrNull(deps.chainClient, pool.quoteTokenAddress);
    return {
      ...base,
      venueType: "UNISWAP_V3_POOL",
      lifecyclePhase: null,
      identifier: pool.poolAddress,
      quoteTokenAddress: pool.quoteTokenAddress,
      quoteTokenDecimals,
      tokenDecimals,
      tokenIsCurrency0: tokenDecimals !== null ? BigInt(getAddress(contractAddress)) < BigInt(getAddress(pool.quoteTokenAddress)) : null,
      v3Pools,
      dataQuality: "PARTIAL",
      notes: [`not a Pons V2 launch — resolved via Uniswap V3 discovery (${v3Pools.length} pool(s) found)`],
    };
  }

  return {
    ...base,
    venueType: "UNKNOWN",
    lifecyclePhase: null,
    identifier: null,
    quoteTokenAddress: null,
    quoteTokenDecimals: null,
    tokenDecimals: null,
    tokenIsCurrency0: null,
    dataQuality: "UNAVAILABLE",
    notes: ["not a Pons V2 launch, and no Uniswap V3 pool discovered — venue genuinely unknown, not guessed"],
  };
}

export { PONS_ADDRESSES };
export { CURVE_LOOKBACK_MINUTES, GRADUATION_MARGIN_MINUTES };
