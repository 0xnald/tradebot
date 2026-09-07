// Phase 6 / 6.6 — historical reconstruction of SmartSelectionInputs for one
// real Scout signal. This is the honesty-critical piece: every field is
// either (a) genuinely derivable from the historical message/pool identity
// itself (never lookahead — these facts existed at decision time by
// construction), (b) reconstructed from a verified historical data source
// and passed through LookaheadGuard, or (c) left null/empty and recorded
// as unavailable. Nothing here ever substitutes a current/live value for a
// historical one.
//
// Phase 6.6 added: on-chain event reconstruction (tried before
// GeckoTerminal — see venueResolver.ts/tieredHistoricalPriceProvider.ts)
// and a full MarketResolutionTrace per signal so exactly why a signal was
// or wasn't backtestable is auditable, not just "unavailable."

import { buildDataQualitySummary } from "../shared/dataQuality.js";
import { buildScoutWalletAssociations } from "../wallet-intelligence/scoutWalletAssociationBuilder.js";
import { LookaheadGuard } from "./lookaheadGuard.js";
import { resolveMarketVenue, type OnChainReconstructionDeps } from "./venueResolver.js";
import type { PoolDataProvider } from "../market-data/poolDataProvider.js";
import type { PonsV2LaunchDataProvider } from "../market-data/ponsV2Provider.js";
import type { HistoricalPriceProvider } from "./historicalPriceProvider.js";
import type { SmartSelectionInputs } from "../scoring/smartSelectionEngine.js";
import type {
  BacktestSignal,
  DataQualityField,
  DataQualityState,
  MarketReconstructionFailureReason,
  MarketResolutionTrace,
  ReconstructionMethod,
  ScoutSignal,
  SignalMarketSnapshot,
} from "../types/domain.js";

export interface SignalReconstructionDeps {
  poolDataProvider: PoolDataProvider;
  /**
   * Optional — when omitted, Pons V2 launches (bonding curve pre-graduation,
   * Uniswap V4 post-graduation) are invisible to `poolDataProvider`'s
   * Uniswap-V3-only discovery and will correctly end up UNAVAILABLE rather
   * than silently misidentified. See docs/DATA_SOURCES.md §7.
   */
  ponsV2Provider?: PonsV2LaunchDataProvider;
  /** The GeckoTerminal-tier fallback — always required, used as the last resort behind on-chain reconstruction. */
  historicalPriceProvider: HistoricalPriceProvider;
  /** Optional — when present, on-chain event reconstruction is attempted before GeckoTerminal for every venue (see docs/BACKTESTING.md's reconstruction hierarchy). Omit to reproduce pre-6.6, GeckoTerminal-only behavior exactly. */
  onChainReconstruction?: OnChainReconstructionDeps;
  chainId: number;
}

export interface SignalReconstructionResult {
  backtestSignal: BacktestSignal;
  smartSelectionInputs: SmartSelectionInputs;
  /**
   * Null when no venue could be resolved, or none had any historical
   * trading data — entry/exit simulation is then structurally UNAVAILABLE
   * for this signal. Despite the name, this may be a real DEX pool
   * address, a Pons V2 bonding curve's own contract address, or a computed
   * Uniswap V4 PoolId.
   */
  poolAddress: string | null;
  /**
   * The per-signal price provider (on-chain tier(s) + GeckoTerminal
   * fallback, in that documented order) — pass this to entrySimulator/
   * exitOutcomeSimulator for this signal instead of the raw shared
   * GeckoTerminal provider, so entry/exit simulation benefits from the
   * same reconstruction hierarchy as the decision-time price.
   */
  historicalPriceProvider: HistoricalPriceProvider;
}

/** Fields that can never be reconstructed historically for this dataset — see docs/BACKTESTING.md §"Data coverage". Always unavailable, never attempted. */
const STRUCTURALLY_UNAVAILABLE_FIELDS = [
  "tokenContractInfo",
  "contractFeatures",
  "tokenAge",
  "liquidityAnalysis",
  "marketFlow",
  "momentum",
  "entryQuality",
  "anomalyFindings",
  "holderConcentration",
  "deployerAnalysis",
  "poolQuality",
  "walletQualityByAddress",
  "walletRelationships",
  "marketSnapshot.liquidityUsd",
  "marketSnapshot.volumeUsd24h",
  "marketSnapshot.marketCapUsd",
  "marketSnapshot.pools",
  "marketSnapshot.recentFlow",
  "marketSnapshot.tokenAge",
  "marketSnapshot.holderInfo",
];

/**
 * Best-effort, specific attribution of why a market resolution failed to
 * produce a price — see the `MarketReconstructionFailureReason` doc
 * comment in domain.ts. Never falls back to a generic label when the
 * resolution trace already tells us more.
 */
function classifyFailure(
  venueType: MarketResolutionTrace["venueType"],
  onChainTierAvailable: boolean,
  attempts: string[],
  ponsPhase: string | null,
): MarketReconstructionFailureReason {
  if (venueType === "UNKNOWN") {
    // A Pons phase is only ever set alongside UNKNOWN when the launch graduated but its real
    // CurveCompleted timestamp couldn't be found (see venueResolver.ts) — a distinct, more
    // specific cause than "we never found any market at all."
    return ponsPhase !== null ? "MISSING_BLOCK_TIMESTAMP" : "MARKET_NOT_DISCOVERED";
  }

  const onChainAttempt = attempts.find((a) => a.startsWith("onchain-"));
  const geckoAttempt = attempts.find((a) => a.startsWith("geckoterminal:"));

  if (onChainAttempt?.endsWith(":error")) return "RPC_HISTORY_LIMITATION";

  if (onChainTierAvailable && onChainAttempt?.endsWith(":unavailable") && geckoAttempt?.endsWith(":unavailable")) {
    // We could search on-chain but found nothing at all near the decision time on EITHER source — most consistent with a very fresh market.
    return "HISTORICAL_DATA_TOO_FRESH";
  }

  if (!onChainTierAvailable && geckoAttempt?.endsWith(":unavailable")) {
    return venueType === "PONS_V2_CURVE" ? "CURVE_EXISTS_BUT_NO_INDEXER_DATA" : "POOL_EXISTS_BUT_NO_INDEXER_DATA";
  }

  return "MISSING_PRICE";
}

function reconstructionMethodFromTier(winningTier: string | null): ReconstructionMethod {
  if (!winningTier) return "UNKNOWN";
  if (winningTier.startsWith("onchain-")) return "ONCHAIN_EVENT";
  if (winningTier === "geckoterminal") return "GECKOTERMINAL";
  return "UNKNOWN";
}

export async function reconstructSignal(
  scoutSignal: ScoutSignal,
  deps: SignalReconstructionDeps,
): Promise<SignalReconstructionResult> {
  const decisionTimestamp = scoutSignal.postedAt ?? scoutSignal.receivedAt;
  const guard = new LookaheadGuard(decisionTimestamp);
  const contractAddress = scoutSignal.contractAddress ?? null;

  let poolAddress: string | null = null;
  let priceUsd: number | null = null;
  let priceProvider: HistoricalPriceProvider = deps.historicalPriceProvider;
  let marketResolution: MarketResolutionTrace;

  if (contractAddress) {
    const venue = await resolveMarketVenue(contractAddress, decisionTimestamp, {
      poolDataProvider: deps.poolDataProvider,
      ponsV2Provider: deps.ponsV2Provider,
      geckoTerminalProvider: deps.historicalPriceProvider,
      onChain: deps.onChainReconstruction,
      chainId: deps.chainId,
    });

    poolAddress = venue.identifier;
    priceProvider = venue.provider;

    // beforeTimestamp = decisionTimestamp exactly (no forward buffer): every provider's
    // "before" semantics already guarantee every returned candle satisfies
    // observedAt <= decisionTimestamp. An earlier version added a 60-second forward buffer
    // here, which could return a candle genuinely observed just AFTER decisionTimestamp —
    // correctly rejected by LookaheadGuard, but losing a legitimately-available
    // at-or-before-decision price for no benefit. Existence probing (venueResolver.ts) is a
    // separate concern and already used decisionTimestamp directly.
    if (poolAddress) {
      const candles = await priceProvider.getCandles(deps.chainId, poolAddress, decisionTimestamp, "minute", 1, 5);
      if (candles.status === "ok" && candles.data && candles.data.length > 0) {
        const mostRecent = candles.data[candles.data.length - 1];
        priceUsd = guard.admit("marketSnapshot.priceUsd", { observedAt: mostRecent.timestamp, value: mostRecent.openUsd });
      }
    }

    const lastLookup = "lastLookup" in priceProvider ? (priceProvider as any).lastLookup : null;
    const attempts: string[] = lastLookup?.attempts ?? [];
    const winningTier: string | null = lastLookup?.winningTier ?? null;

    marketResolution = {
      signalId: scoutSignal.id,
      venueType: venue.venueType,
      venueIdentifier: venue.identifier,
      graduationPhase: venue.ponsPhase,
      graduationTimestamp: venue.graduationTimestamp,
      usedPreGraduationVenue: venue.usedPreGraduationVenue,
      failureReason: priceUsd !== null ? null : classifyFailure(venue.venueType, venue.onChainTierAvailable, attempts, venue.ponsPhase),
      reconstructionMethod: priceUsd !== null ? reconstructionMethodFromTier(winningTier) : null,
      notes: venue.notes,
    };
  } else {
    marketResolution = {
      signalId: scoutSignal.id,
      venueType: "UNKNOWN",
      venueIdentifier: null,
      graduationPhase: null,
      graduationTimestamp: null,
      usedPreGraduationVenue: null,
      failureReason: "NO_MARKET",
      reconstructionMethod: null,
      notes: ["Signal carries no contract address — there is no token to resolve a market for."],
    };
  }

  const marketSnapshotFields: DataQualityField[] = [
    { field: "priceUsd", state: priceUsd !== null ? "KNOWN" : ("UNAVAILABLE" as DataQualityState) },
    { field: "liquidityUsd", state: "UNAVAILABLE" },
    { field: "volumeUsd24h", state: "UNAVAILABLE" },
    { field: "marketCapUsd", state: "UNAVAILABLE" },
    { field: "recentFlow", state: "UNAVAILABLE" },
    { field: "tokenAge", state: "UNAVAILABLE" },
    { field: "holderInfo", state: "UNAVAILABLE" },
  ];

  const marketSnapshot: SignalMarketSnapshot | null = contractAddress
    ? {
        signalId: scoutSignal.id,
        chainId: deps.chainId,
        contractAddress,
        capturedAt: decisionTimestamp,
        priceUsd,
        liquidityUsd: null,
        volumeUsd24h: null,
        marketCapUsd: null,
        pools: [],
        recentFlow: null,
        tokenAge: null,
        holderInfo: null,
        dataQuality: buildDataQualitySummary(marketSnapshotFields, new Date(decisionTimestamp)),
      }
    : null;

  const walletAssociations = buildScoutWalletAssociations(scoutSignal);

  const smartSelectionInputs: SmartSelectionInputs = {
    scoutSignal,
    marketSnapshot,
    tokenContractInfo: null,
    contractFeatures: null,
    tokenAge: null,
    liquidityAnalysis: null,
    marketFlow: null,
    momentum: null,
    entryQuality: null,
    anomalyFindings: null,
    holderConcentration: null,
    deployerAnalysis: null,
    poolQuality: [],
    walletAssociations,
    walletQualityByAddress: new Map(),
    walletRelationships: [],
  };

  const reconstructedFields = ["scoutSignal", "walletAssociations", ...(priceUsd !== null ? ["marketSnapshot.priceUsd"] : [])];
  const unavailableFields = [
    ...(contractAddress ? [] : ["marketSnapshot"]),
    ...(contractAddress && priceUsd === null ? ["marketSnapshot.priceUsd"] : []),
    ...STRUCTURALLY_UNAVAILABLE_FIELDS,
  ];

  const dataQuality: DataQualityState = priceUsd !== null ? "PARTIAL" : "UNAVAILABLE";

  const backtestSignal: BacktestSignal = {
    signalId: scoutSignal.id,
    source: scoutSignal.source,
    sourceMessageId: scoutSignal.sourceMessageId,
    contractAddress,
    tokenSymbol: scoutSignal.tokenSymbol ?? null,
    signalTimestamp: decisionTimestamp,
    decisionTimestamp,
    reconstructedFields,
    unavailableFields,
    lookaheadViolations: guard.violations,
    dataQuality,
    marketResolution,
  };

  return { backtestSignal, smartSelectionInputs, poolAddress, historicalPriceProvider: priceProvider };
}
