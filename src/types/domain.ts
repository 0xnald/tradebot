// Scout Alpha domain types.
//
// These are shared data contracts only — no business logic lives here.
// Every module in this system should agree on these shapes rather than
// inventing its own ad-hoc structures for the same concepts.

export type TradingMode = "paper" | "live";

/**
 * Phase 7 — the live Scout signal lifecycle, granular enough to measure
 * real per-stage latency (see src/live/latencyMetrics.ts). Superseded the
 * original 8-stage placeholder enum, which nothing in the codebase ever
 * produced or consumed. `REJECTED` is terminal and can follow any stage
 * (duplicate, stale, ineligible, or a hard-blocked Smart Selection result).
 */
export type LiveSignalLifecycleStage =
  | "RECEIVED"
  | "PARSED"
  | "VALIDATED"
  | "REJECTED"
  | "INTELLIGENCE_STARTED"
  | "INTELLIGENCE_COMPLETED"
  | "SCORING_STARTED"
  | "SCORING_COMPLETED"
  | "PAPER_DECISION"
  | "PAPER_ENTRY"
  | "PAPER_POSITION_OPEN"
  | "PAPER_POSITION_CLOSED";

/**
 * What kind of post this is, per Scout's own two observed message templates
 * (see src/signal-parsing/README.md for how these were derived from the
 * real public channel). "UNKNOWN" means the text didn't match either.
 */
export type ScoutMessageType = "EARLY_CALL" | "PERFORMANCE_UPDATE" | "UNKNOWN";

/** How much of a signal's expected structure was actually recovered. */
export type ParseConfidence = "high" | "partial" | "low";

/**
 * One line from an "EARLY CALL" post's live-buys section. The wallet is
 * exactly what Scout shows — a truncated string like "0x3430…c941" — NOT a
 * usable full address. Full-address wallet identity is out of scope for
 * Phase 1; see src/wallet-intelligence.
 */
export interface ScoutLiveBuy {
  walletTruncated: string;
  badge: "elite" | "good";
  amountUsd: number;
}

/**
 * A raw opportunity lead captured from a signal source (e.g. Scout).
 *
 * This represents what Scout reported — nothing more. It must never carry
 * our own trading judgement (no buy/sell, expected profit, smart score, AI
 * confidence, or position size — those belong to later modules such as
 * scoring/risk/paper-trading).
 *
 * Every field below other than the identity/provenance block and `rawText`
 * is optional and is only set when Scout's message actually contained it.
 * Notably: Scout's message TEXT never contains a contract address or a full
 * wallet address — `contractAddress` here is recovered from the message's
 * linked buttons (DexScreener/GMGN/etc.), which is still Scout-supplied
 * data, just not in the text body.
 */
export interface ScoutSignal {
  // --- Identity / provenance (always present) ---
  /** Stable, dedupe-safe id: `${source}:${sourceMessageId}`. */
  id: string;
  source: string; // e.g. "telegram:scoutrobinhood"
  sourceMessageId: string;
  messageUrl?: string;
  /** When OUR system captured this message (not when Scout posted it). */
  receivedAt: string; // ISO 8601 timestamp
  /** The message's own timestamp, if the source provides one. */
  postedAt?: string;

  // --- Classification ---
  messageType: ScoutMessageType;

  // --- What Scout's message says about the token (only if present) ---
  tokenSymbol?: string;
  /** Verbatim chain/network name as written by Scout, e.g. "robinhood". Not a chainId — no chain-name-to-id mapping is applied here. */
  chainRaw?: string;
  /** Recovered from linked buttons, not message text. See class doc above. */
  contractAddress?: string;
  /** Reserved for a later module to populate once chain-name resolution exists. Never set by the Phase 1 parser. */
  chainId?: number;
  dexName?: string;
  dexSlug?: string;
  /** The "called at $X" / first "called $A → …" figure, in USD. */
  calledValueUsd?: number;
  marketCapUsd?: number;
  liquidityUsd?: number;
  liquidityPct?: number;
  buyTaxPct?: number;
  sellTaxPct?: number;
  ageSeconds?: number;
  ageRaw?: string;
  holderCount?: number;
  volume24hUsd?: number;
  swapCount5m?: number;
  dexScreenerVerified?: boolean;
  eliteHolderCount?: number;
  goodHolderCount?: number;
  liveBuys?: ScoutLiveBuy[];

  // --- Performance-update-specific (only present on that message type) ---
  multiplier?: number;
  peakValueUsd?: number;

  // --- Always preserved ---
  rawText: string;
  /** Every button URL on the message, unmodified. */
  links?: string[];

  // --- Parsing meta (about the parse itself, not a trading judgement) ---
  parseConfidence: ParseConfidence;
  parseWarnings: string[];
}

/**
 * Contract-level facts about a token, independent of Scout's claims.
 *
 * Populated in Phase 2 by `src/token-analysis` from a mix of direct
 * on-chain reads (name/symbol/decimals/totalSupply/deploymentBlock/
 * deployerAddress — all obtainable from the chain alone, see
 * docs/DATA_SOURCES.md §5) and, where available, an indexer for
 * `holderCount`/`topHolderConcentrationPct` (not obtainable from the chain
 * alone without indexing every Transfer event). `isHoneypot`/tax fields
 * are not populated by anything in Phase 2 — no honeypot-checking provider
 * has been researched or verified yet.
 */
export interface TokenContractInfo {
  chainId: number;
  contractAddress: string;
  name?: string;
  symbol?: string;
  decimals?: number;
  /** Raw total supply as a decimal string (bigint-safe — never a JS number). */
  totalSupplyRaw?: string;
  /** ISO 8601 timestamp of the deployment block. */
  deployedAt?: string;
  deploymentBlock?: number;
  deployerAddress?: string;
  isHoneypot?: boolean;
  buyTaxBps?: number;
  sellTaxBps?: number;
  holderCount?: number;
  topHolderConcentrationPct?: number;
}

/**
 * A single DEX pool associated with a token, from either an on-chain
 * discovery (Uniswap V3 factory) or a third-party indexer (DexScreener).
 */
export interface PoolInfo {
  chainId: number;
  poolAddress: string;
  /** e.g. "uniswap-v3-onchain" or "dexscreener" — see `source` on the parent result for the authoritative provenance of any given field. */
  dexId: string;
  tokenAddress: string;
  quoteTokenAddress: string;
  quoteTokenSymbol?: string;
  /** Uniswap V3 fee tier in its native units (e.g. 500 = 0.05%), when known. */
  feeTier?: number;
  liquidityUsd?: number | null;
  priceUsd?: number | null;
  source: string;
}

export type SwapSide = "BUY" | "SELL" | "UNKNOWN";

/**
 * A single decoded swap. `side` is only ever "BUY" or "SELL" when it can be
 * determined which token in the pool is the one of interest (via the
 * pool's own `token0`/`token1`) — otherwise it's "UNKNOWN". Never guessed.
 */
export interface SwapRecord {
  chainId: number;
  poolAddress: string;
  transactionHash: string;
  blockNumber: number;
  timestamp?: string;
  /** The transaction sender, if observable from the log context. */
  trader?: string;
  /** Signed raw amount (bigint-safe string) of the token of interest. */
  tokenAmount: string;
  /** Signed raw amount (bigint-safe string) of the quote token. */
  quoteAmount: string;
  side: SwapSide;
  source: string;
}

/** A point-in-time liquidity reading, meant to be compared against later ones. */
export interface LiquiditySnapshot {
  chainId: number;
  poolAddress: string;
  observedAt: string;
  liquidityUsd: number | null;
  source: string;
}

export interface HolderInfo {
  address: string;
  /** Raw balance as a decimal string (bigint-safe). */
  balanceRaw: string;
  percentageOfSupply?: number;
}

/**
 * Holder distribution is NOT obtainable from the chain alone (it requires
 * indexing every Transfer event since deployment) — see
 * docs/DATA_SOURCES.md §5. This is always sourced from an indexer
 * (`HolderDataProvider`), and every field may be absent if that indexer is
 * unavailable — see `unavailableReason`.
 */
export interface HolderDistribution {
  chainId: number;
  contractAddress: string;
  observedAt: string;
  totalHolders: number | null;
  topHolders: HolderInfo[];
  topHolderConcentrationPct: number | null;
  deployerHolding?: HolderInfo;
  source: string;
  unavailableReason?: string;
}

/**
 * Normalized market data for a token at a point in time.
 *
 * `marketCapUsd` is NEVER computed locally from total supply — it's only
 * ever a pass-through of a provider's own figure (see the "Do not fabricate
 * market cap" requirement and docs/DATA_SOURCES.md §4). If no provider has
 * a figure, it's `null` with `marketCapUnavailableReason` explaining why.
 *
 * `buyCount24h`/`sellCount24h` are trade COUNTS, not dollar volumes — no
 * verified provider in this phase separates volume by side, so a
 * `buyVolumeUsd`/`sellVolumeUsd` field is deliberately not included rather
 * than approximated from counts.
 */
export interface TokenMarketData {
  chainId: number;
  contractAddress: string;
  observedAt: string;
  priceUsd: number | null;
  marketCapUsd: number | null;
  marketCapUnavailableReason?: string;
  fdvUsd?: number | null;
  liquidityUsd: number | null;
  volumeUsd24h: number | null;
  buyCount24h?: number;
  sellCount24h?: number;
  tradeCount24h?: number;
  priceChangePct1h?: number | null;
  priceChangePct6h?: number | null;
  priceChangePct24h?: number | null;
  pools: PoolInfo[];
  source: string;
}

/**
 * Uniform envelope every Phase 2 provider returns instead of throwing on a
 * partial or total failure — see the "ERROR HANDLING" requirement. A
 * provider method should only reject/throw for a programmer error (e.g.
 * malformed input); any real-world failure (network error, unexpected
 * response shape, upstream 4xx/5xx) becomes an entry in `errors` and the
 * corresponding field(s) listed in `unavailable`, never a fabricated value.
 */
export interface ProviderResult<T> {
  status: "ok" | "partial" | "unavailable" | "error";
  data: T | null;
  unavailable: string[];
  errors: { message: string; provider?: string }[];
}

/** Our own independently-derived assessment of a wallet's quality. */
export interface WalletProfile {
  address: string;
  winRatePct?: number;
  historicalPnlUsd?: number;
  avgEntryQualityScore?: number;
  isKnownCoordinatedCluster?: boolean;
}

// ---------------------------------------------------------------------
// Wallet intelligence (Phase 3). See src/wallet-intelligence/README.md
// and docs/WALLET_DATA_SOURCES.md for how these are actually populated
// and their real-world limitations.
// ---------------------------------------------------------------------

export type WalletDiscoverySource =
  | "scout-message-text" // a truncated string only — never promoted to `address`
  | "scout-message-buttons" // a full address found in a linked button URL
  | "on-chain-swap" // observed directly as a Swap event's transaction sender
  | "manual";

/**
 * A wallet is only ever "high" confidence when a full, unambiguous address
 * was directly observed (a button URL or an on-chain event) — never
 * inferred or correlated from a partial match. "unresolved" means we only
 * have a truncated/partial identifier and no full address — this is the
 * expected, honest outcome for every wallet mentioned in a real Scout
 * message today (see docs/WALLET_DATA_SOURCES.md §1).
 */
export type WalletIdentityConfidence = "unresolved" | "low" | "medium" | "high";

export interface WalletIdentity {
  chainId: number;
  /** The resolved full address. Undefined when confidence is "unresolved". */
  address?: string;
  /** The truncated string as originally observed, if that's all we have (e.g. "0x3430…c941"). */
  truncatedAddress?: string;
  discoverySource: WalletDiscoverySource;
  discoveredAt: string;
  confidence: WalletIdentityConfidence;
  label?: string;
  /** e.g. signal ids, button URLs, transaction hashes — whatever evidence backs this identity. */
  sourceReferences: string[];
}

/**
 * A single normalized trade. Direction uses the same BUY/SELL/UNKNOWN
 * convention as Phase 2's SwapRecord (see `classifySide` there) — never
 * guessed. USD/price/liquidity fields are `null`, not fabricated, when no
 * verified historical source provides them — see
 * docs/WALLET_DATA_SOURCES.md §3. This is the normal case for the one
 * verified provider in this phase (on-chain swaps have no historical price
 * attached).
 */
export interface WalletTrade {
  chainId: number;
  walletAddress: string;
  /** Null only if the source block's timestamp genuinely couldn't be read — never fabricated (e.g. never epoch-0). Always sort by `blockNumber`, not this, when timestamp may be missing. */
  timestamp: string | null;
  /** Always available directly from the log — the reliable chronological sort key, independent of the timestamp lookup above. */
  blockNumber: number;
  transactionHash: string;
  tokenAddress: string;
  poolAddress: string;
  direction: SwapSide;
  /** Signed raw amount (bigint-safe string) of the token. */
  tokenAmountRaw: string;
  /** Signed raw amount (bigint-safe string) of the quote token. */
  quoteAmountRaw: string;
  approxUsdValue: number | null;
  tokenPriceUsdAtTrade: number | null;
  liquidityUsdAtTrade: number | null;
  marketCapUsdAtTrade: number | null;
  source: string;
}

/**
 * Explicit trade-outcome definitions (do not use an ad-hoc definition
 * elsewhere in the codebase):
 *
 * - WIN: a BUY was matched to a later SELL (see the FIFO matching in
 *   `walletTradeMatcher.ts`) and both have a known USD value, with
 *   exitUsd > entryUsd (pnlUsd > 0).
 * - LOSS: same as WIN but pnlUsd <= 0. Breakeven (pnlUsd === 0) counts as
 *   a LOSS by this definition — it did not produce a profit. This is a
 *   deliberate, documented choice, not a silent default.
 * - OPEN: a BUY exists with no matching SELL found in the available data
 *   — the position may still be held. Never treated as a loss or a win.
 * - UNKNOWN: either the direction of the entry/exit couldn't be
 *   classified, or a match was found but a required USD value is missing
 *   (so PnL genuinely cannot be computed) — distinct from OPEN, where no
 *   exit exists at all.
 */
export type TradeOutcomeStatus = "WIN" | "LOSS" | "OPEN" | "UNKNOWN";

export interface WalletRoundTrip {
  chainId: number;
  walletAddress: string;
  tokenAddress: string;
  /**
   * Both are optional because reality isn't always a clean pair: a SELL
   * with no preceding observed BUY (e.g. the wallet acquired the token
   * outside the pools we searched) has `exitTrade` only, and a
   * direction-`UNKNOWN` trade that could be matched as neither a BUY nor a
   * SELL is recorded with `entryTrade` only, regardless of position. Never
   * fabricate the missing side.
   */
  entryTrade?: WalletTrade;
  exitTrade?: WalletTrade;
  entryUsdValue: number | null;
  exitUsdValue: number | null;
  pnlUsd: number | null;
  roiPct: number | null;
  holdingSeconds: number | null;
  status: TradeOutcomeStatus;
}

/**
 * One performance window (lifetime, 30-day, or 7-day). `null` when there
 * isn't enough data to compute a given statistic — never a fabricated 0.
 * See `walletPerformanceAnalyzer.ts` for the exact minimum-sample rules.
 */
export interface WalletPerformanceWindow {
  windowLabel: "lifetime" | "30d" | "7d";
  computed: boolean;
  insufficientDataReason?: string;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  openTrades: number;
  unknownTrades: number;
  winRatePct: number | null;
  realizedPnlUsd: number | null;
  averageRoiPct: number | null;
  medianRoiPct: number | null;
  maxRoiPct: number | null;
  minRoiPct: number | null;
  averageHoldingSeconds: number | null;
  medianHoldingSeconds: number | null;
  averageEntryMarketCapUsd: number | null;
  medianEntryMarketCapUsd: number | null;
  averageEntryLiquidityUsd: number | null;
  uniqueTokenCount: number;
  uniqueTradingDayCount: number;
  longestWinStreak: number;
  longestLossStreak: number;
}

export interface WalletPerformanceSummary {
  chainId: number;
  walletAddress: string;
  computedAt: string;
  lifetime: WalletPerformanceWindow;
  last30d: WalletPerformanceWindow;
  last7d: WalletPerformanceWindow;
  /** 0..1 — see walletPerformanceAnalyzer.ts for the exact formula; explicitly documented, not hidden. */
  sampleSizeConfidence: number;
}

/**
 * Wallet-level FEATURES for a future scoring system — not a final trade
 * recommendation, and not the Smart Selection score (that's a later
 * phase). Any feature that can't be honestly computed from available data
 * is `null` and listed in `unavailableFeatures`, not approximated.
 */
export interface WalletQualityFeatures {
  chainId: number;
  walletAddress: string;
  computedAt: string;
  consistencyScore: number | null;
  profitabilityScore: number | null;
  earlyEntryScore: number | null;
  liquidityAwareScore: number | null;
  sampleSizeConfidence: number;
  recentPerformanceScore: number | null;
  copyabilityScore: number | null;
  riskScore: number | null;
  unavailableFeatures: string[];
}

/**
 * A behavioral correlation between two wallets — NOT an identity claim.
 * Always phrase findings as "possibly related"; never "same person/entity"
 * (see the repo-wide instruction on this). `evidence` is a plain-language
 * audit trail of what was actually observed.
 */
export interface WalletRelationshipSignal {
  chainId: number;
  walletA: string;
  walletB: string;
  computedAt: string;
  commonTokenCount: number;
  commonTokenOverlapRatio: number;
  synchronizedBuyCount: number;
  synchronizedBuyWindowSeconds: number;
  /** 0..1 heuristic combining the above — a behavioral signal, not a probability of shared ownership. */
  relationshipScore: number;
  possiblyRelated: boolean;
  evidence: string[];
}

/**
 * Links a wallet (resolved or not) to the Scout signal it was observed in.
 * Preserved for later cross-signal strategy evaluation (Phase 6/7) — this
 * phase only stores the association, it does not compute performance
 * across it.
 */
export interface ScoutWalletAssociation {
  id: string;
  scoutSignalId: string;
  chainId: number;
  wallet: WalletIdentity;
  badge?: "elite" | "good";
  amountUsdClaimed?: number;
  associationSource: string;
  confidence: WalletIdentityConfidence;
  observedAt: string;
  rawEvidence: string;
}

// ---------------------------------------------------------------------
// Smart Selection Engine (Phase 5). See docs/SMART_SELECTION.md for the
// full architecture, every formula, the documented initial weights, and
// what remains statistically unvalidated. This is the first phase that
// combines Scout + token + market + wallet intelligence into a
// TRADE_CANDIDATE decision — it still does not execute anything.
// ---------------------------------------------------------------------

/**
 * "TRADE_CANDIDATE" means the intelligence layer believes this opportunity
 * deserves to proceed to the risk/execution pipeline — it does NOT mean
 * anything was bought. Deliberately distinct from the Phase 0 placeholder
 * `TradeAction` ("BUY"/"WAIT"/"IGNORE"), which belongs to a later
 * risk/execution phase.
 */
export type SmartSelectionDecision = "IGNORE" | "WATCH" | "TRADE_CANDIDATE";

/**
 * One feature's contribution to a group score — always raw value,
 * normalized [0,1] value, weight, contribution (normalized*weight), and a
 * human-readable reason. `normalizedValue`/`contribution` are `null` (not
 * 0) when the underlying raw value is itself unavailable — see the
 * repo-wide "never convert missing data to zero" rule.
 */
export interface FeatureContribution {
  name: string;
  rawValue: unknown;
  normalizedValue: number | null;
  weight: number;
  contribution: number | null;
  reason: string;
  dataQuality: DataQualityState;
}

export type SmartSelectionFeatureGroupName =
  | "signalQuality"
  | "tokenQuality"
  | "liquidity"
  | "marketFlow"
  | "momentum"
  | "entryQuality"
  | "holderStructure"
  | "walletIntelligence"
  | "marketConditions";

/**
 * One feature group's rolled-up score. `groupScore` is `null` when NO
 * feature in the group was computable — that group is then excluded from
 * `overallScore` entirely (its weight is NOT redistributed as a penalty;
 * see docs/SMART_SELECTION.md's confidence-vs-score separation) and
 * instead reduces `confidence` via `SmartSelectionConfidence`.
 */
export interface FeatureGroupScore {
  group: SmartSelectionFeatureGroupName;
  features: FeatureContribution[];
  groupScore: number | null;
  groupWeight: number;
  dataQuality: DataQualityState;
}

export type ExpectedValueStatus = "UNKNOWN" | "HEURISTIC_POSITIVE" | "HEURISTIC_NEGATIVE";

/**
 * Deliberately NOT a real expected-value calculation — no probabilities or
 * dollar magnitudes are invented. `statisticallyValidated` is always
 * `false` in Phase 5; a real empirical model is Phase 6+ work (backtesting).
 */
export interface ExpectedValueEstimate {
  status: ExpectedValueStatus;
  statisticallyValidated: false;
  notes: string[];
}

export type ChaseRiskClassification = "LOW_CHASE_RISK" | "MEDIUM_CHASE_RISK" | "HIGH_CHASE_RISK" | "UNKNOWN";

export interface EntryChaseAssessment {
  level: ChaseRiskClassification;
  evidence: string[];
}

/** A single deterministic, documented hard-blocker check. Never overridable by an LLM — there is no LLM in this decision path at all. */
export interface HardBlockerReason {
  code: string;
  description: string;
}

export interface HardBlockerResult {
  blocked: boolean;
  reasons: HardBlockerReason[];
}

export type WalletEvidenceStatus = "UNRESOLVED" | "INSUFFICIENT_SAMPLE" | "AVAILABLE" | "UNAVAILABLE";

export interface IdentifiedWalletContribution {
  walletAddress: string;
  qualityFeatures: WalletQualityFeatures;
  /** Before any correlated-wallet discount. */
  baseWeight: number;
  /** After the correlated-wallet discount (see docs/SMART_SELECTION.md §11). Equal to baseWeight when the wallet isn't part of any possibly-related cluster. */
  adjustedWeight: number;
  compositeQualityScore: number | null;
}

/**
 * The wallet-intelligence group's full assessment. `status` explicitly
 * distinguishes "Scout's wallet mentions couldn't be resolved to real
 * addresses" (UNRESOLVED) from "resolved, but too little trade history to
 * trust" (INSUFFICIENT_SAMPLE) from "no wallets mentioned at all"
 * (UNAVAILABLE) from "usable" (AVAILABLE) — only AVAILABLE contributes a
 * non-null `walletScore`. Never substitutes Scout's own "elite"/"good"
 * labels for this.
 */
export interface WalletSignalAssessment {
  status: WalletEvidenceStatus;
  identifiedWallets: IdentifiedWalletContribution[];
  relationshipSignals: WalletRelationshipSignal[];
  walletScore: number | null;
  notes: string[];
}

export interface MarketRegimeAssessment {
  /** Only "UNKNOWN" exists in Phase 5 — see docs/SMART_SELECTION.md §I. An interface stub, not a model. */
  regime: "UNKNOWN";
  notes: string[];
}

/** A confidence sub-component: what it measured, its value, its weight, and why. */
export interface ConfidenceComponent {
  name: string;
  value: number;
  weight: number;
  reason: string;
}

export interface ConfidenceBreakdown {
  overallConfidence: number;
  components: ConfidenceComponent[];
}

/**
 * Versioned, documented configuration — see docs/SMART_SELECTION.md.
 * INITIAL HEURISTIC WEIGHTS: chosen for transparency and plausibility, NOT
 * statistically optimized. They are temporary until backtesting (a later
 * phase) provides evidence to revise them.
 */
export interface SmartSelectionConfig {
  modelVersion: string;
  groupWeights: Record<SmartSelectionFeatureGroupName, number>;
  thresholds: { watch: number; tradeCandidate: number };
  minimumConfidenceForTradeCandidate: number;
  minimumDataQualityForTradeCandidate: DataQualityState;
  highChaseRiskCapsDecisionAt: SmartSelectionDecision;
  walletRelationshipIndependenceFactor: number;
  walletMinimumSampleSizeConfidence: number;
  hardBlockerThresholds: {
    minimumUsableLiquidityUsd: number;
    catastrophicLiquidityCollapsePct: number;
    staleCriticalDataSeconds: number;
    severeDeployerSupplySharePct: number;
  };
}

/** Every input this decision was actually based on — persisted for reproducibility and backtesting. Never a copy that silently drifts from what scoring actually used. */
export interface SmartSelectionFeatureSnapshot {
  scoutSignal: ScoutSignal;
  marketSnapshot: SignalMarketSnapshot | null;
  tokenContractInfo: TokenContractInfo | null;
  contractFeatures: ContractFeatureDetection | null;
  tokenAge: TokenAge | null;
  liquidityAnalysis: LiquidityAnalysis | null;
  marketFlow: MarketFlowAnalysis | null;
  momentum: MomentumAnalysis | null;
  entryQuality: EntryQualityFeatures | null;
  anomalyFindings: MarketAnomalyFindings | null;
  holderConcentration: HolderConcentrationBreakdown | null;
  deployerAnalysis: DeployerAnalysis | null;
  poolQuality: PoolQualityAssessment[];
  walletAssessment: WalletSignalAssessment;
  marketRegime: MarketRegimeAssessment;
  configVersion: string;
}

export interface SmartSelectionResult {
  id: string;
  signalId: string;
  chainId: number;
  contractAddress: string;
  computedAt: string;
  decision: SmartSelectionDecision;
  /** 0-100. Reproducible: the same feature snapshot always yields the same score — no randomness, no LLM. */
  overallScore: number;
  /** 0-100. How complete/fresh/reliable the evidence is — separate from what the evidence says. See docs/SMART_SELECTION.md §7. */
  confidence: number;
  confidenceBreakdown: ConfidenceBreakdown;
  expectedValue: ExpectedValueEstimate;
  chaseAssessment: EntryChaseAssessment;
  scoreBreakdown: FeatureGroupScore[];
  positiveFactors: string[];
  negativeFactors: string[];
  blockingFactors: string[];
  hardBlockers: HardBlockerResult;
  dataQuality: DataQualitySummary;
  featureSnapshot: SmartSelectionFeatureSnapshot;
  modelVersion: string;
}

// ---------------------------------------------------------------------
// Backtesting & Selection Validation (Phase 6). See docs/BACKTESTING.md
// for the full methodology, real data-coverage findings, and honest
// limitations. Core question: does Smart Selection actually improve on
// taking every raw Scout call? This module consumes the Phase 5
// SmartSelectionEngine as the single authoritative implementation — it
// never reimplements scoring.
// ---------------------------------------------------------------------

/**
 * A fact with a known "as of" time. The unit of lookahead-bias protection:
 * every historical feature fed into a backtested decision must be wrapped
 * in one of these so `LookaheadGuard` can verify `observedAt <=
 * decisionTimestamp` before admitting it — see
 * src/backtesting/lookaheadGuard.ts.
 */
export interface TimestampedObservation<T> {
  observedAt: string;
  value: T;
}

/** Recorded whenever a historical reconstruction attempted to use a fact observed after the decision boundary — it was excluded, not used. Existence of any entry here for a real run would indicate a lookahead-protection bug. */
export interface LookaheadViolation {
  field: string;
  observedAt: string;
  decisionTimestamp: string;
}

export type HistoricalHorizonLabel = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "24h";

/**
 * One dataset = one immutable, versioned collection of Scout signals to
 * backtest against. Versioned so a `BacktestRun` can always say exactly
 * which signals it evaluated.
 */
export interface BacktestDataset {
  id: string;
  createdAt: string;
  description: string;
  signalIds: string[];
  /** e.g. "real-scout-2026-09-04-fixtures" or "synthetic-v1" — never silently mixed. */
  source: "real" | "synthetic";
}

/**
 * A single historical Scout signal as reconstructed for backtesting — the
 * exact `SmartSelectionInputs`-shaped snapshot that was (or, honestly,
 * COULD NOT be) rebuilt using only facts observed at or before the
 * decision timestamp. This is what actually got fed to the real
 * `SmartSelectionEngine` — never regenerated after the fact.
 */
export interface BacktestSignal {
  signalId: string;
  source: string;
  sourceMessageId: string;
  contractAddress: string | null;
  tokenSymbol: string | null;
  signalTimestamp: string;
  decisionTimestamp: string;
  /** Which of the SmartSelectionInputs fields were actually reconstructed vs. left null for lack of a point-in-time observation. */
  reconstructedFields: string[];
  unavailableFields: string[];
  lookaheadViolations: LookaheadViolation[];
  dataQuality: DataQualityState;
  /** Phase 6.6 — full venue-resolution trace for this signal: which market was resolved, how, and why reconstruction succeeded or failed. Optional so pre-6.6 fixtures/tests remain valid. */
  marketResolution?: MarketResolutionTrace;
}

/** The real Phase 5 decision for a BacktestSignal — wraps the actual SmartSelectionResult, never a re-derived summary. */
export interface BacktestDecision {
  signalId: string;
  decisionTimestamp: string;
  smartSelectionResult: SmartSelectionResult;
}

/** Whether/when a TP or SL was actually observed to be hit — never assumed from incomplete data. */
export interface LevelHitResult {
  hit: boolean;
  hitAt: string | null;
  /** How many minutes after entry, if hit. */
  timeToHitMinutes: number | null;
  dataQuality: DataQualityState;
}

export interface HorizonReturn {
  horizon: HistoricalHorizonLabel;
  returnPct: number | null;
  priceUsd: number | null;
  observedAt: string | null;
  dataQuality: DataQualityState;
}

/**
 * The deterministic outcome simulation for one signal's modeled position —
 * independent of what Smart Selection actually decided, so the same
 * outcome can be cross-tabulated against IGNORE/WATCH/TRADE_CANDIDATE
 * after the fact (see docs/BACKTESTING.md for why this separation is the
 * clean way to compute selection lift).
 */
export interface BacktestOutcome {
  signalId: string;
  hasValidEntry: boolean;
  hasValidExit: boolean;
  maxFavorableExcursionPct: number | null;
  maxAdverseExcursionPct: number | null;
  returnsByHorizon: HorizonReturn[];
  takeProfitResult: LevelHitResult | null;
  stopLossResult: LevelHitResult | null;
  finalReturnPct: number | null;
  finalExitTimestamp: string | null;
  finalExitPriceUsd: number | null;
  /** True only when candle granularity can't establish whether TP or SL was hit first within the same candle — documented, never guessed. */
  candleOrderingAmbiguous: boolean;
  dataQuality: DataQualityState;
  notes: string[];
}

/** The modeled historical position — entry side of BacktestOutcome, tracked separately since entry can succeed even when later exit/outcome data is incomplete. */
export interface BacktestPosition {
  signalId: string;
  signalTimestamp: string;
  decisionTimestamp: string;
  entryTimestamp: string | null;
  entryDelayMinutes: number | null;
  entryPriceUsd: number | null;
  entryPriceSource: string | null;
  entryDataQuality: DataQualityState;
  positionSizeUsd: number | null;
  feesUsd: number | null;
  slippagePct: number;
}

export type BacktestCohort = "RAW_SCOUT_BASELINE" | "TRADE_CANDIDATE" | "WATCH";

/** One score or confidence bucket's aggregate stats — see docs/BACKTESTING.md §14. */
export interface BacktestBucketStats {
  bucketLabel: string;
  sampleCount: number;
  averageReturnPct: number | null;
  medianReturnPct: number | null;
  winRatePct: number | null;
  expectancyPct: number | null;
  averageConfidence: number | null;
  dataCompletenessPct: number;
}

/** Aggregate performance for one cohort (raw baseline / TRADE_CANDIDATE / WATCH), optionally scoped to one horizon. */
export interface BacktestMetrics {
  cohort: BacktestCohort;
  horizon: HistoricalHorizonLabel | "final";
  totalSignals: number;
  usableSignals: number;
  winCount: number;
  lossCount: number;
  winRatePct: number | null;
  lossRatePct: number | null;
  averageReturnPct: number | null;
  medianReturnPct: number | null;
  averageWinnerPct: number | null;
  averageLoserPct: number | null;
  expectancyPct: number | null;
  profitFactor: number | null;
  maxDrawdownPct: number | null;
  cumulativeReturnPct: number | null;
  bestTradePct: number | null;
  worstTradePct: number | null;
}

/** TRADE_CANDIDATE vs. raw-baseline comparison — the actual answer to "did Smart Selection help." */
export interface SelectionLiftReport {
  horizon: HistoricalHorizonLabel | "final";
  rawBaselineExpectancyPct: number | null;
  tradeCandidateExpectancyPct: number | null;
  watchExpectancyPct: number | null;
  expectancyLiftPct: number | null;
  winRateLiftPct: number | null;
  averageReturnLiftPct: number | null;
  downsideReductionPct: number | null;
  /** Of the raw-baseline signals that were actually profitable, what % did Smart Selection filter out (IGNORE/WATCH, not TRADE_CANDIDATE)? A real cost of using selection. */
  pctProfitableOpportunitiesFilteredOut: number | null;
  /** Of the raw-baseline signals that were actually losers, what % did Smart Selection correctly filter out? */
  pctBadOpportunitiesFilteredOut: number | null;
  sampleCount: number;
  /** Explicit, honest flag — never claim significance from a handful of signals. */
  statisticallyConvincing: boolean;
  statisticalCaveat: string;
}

/** WATCH is a counterfactual cohort, never auto-treated as a trade unless explicitly configured — see BacktestConfig.treatWatchAsTrade. */
export interface CounterfactualOutcome {
  signalId: string;
  cohort: BacktestCohort;
  outcome: BacktestOutcome;
}

/** Breaks missingness down by exactly which historical fact was unavailable — the honesty backbone of this whole phase. */
export interface DataAvailabilityReport {
  datasetSize: number;
  usableSignals: number;
  completeFeatureReconstructionCount: number;
  validEntryCount: number;
  validExitCount: number;
  missingByField: Record<string, number>;
  notes: string[];
}

export interface BacktestConfig {
  configVersion: string;
  smartSelectionConfigVersion: string;
  maxEntryDelayMinutes: number;
  slippagePct: number;
  feePct: number;
  horizons: HistoricalHorizonLabel[];
  takeProfitPct: number | null;
  stopLossPct: number | null;
  treatWatchAsTrade: boolean;
  portfolio: {
    startingCapitalUsd: number;
    positionSizePct: number;
    maxConcurrentPositions: number;
    allowCompounding: boolean;
    /** How long a position is assumed to occupy a capital slot — a documented simplification, not a real exit rule. */
    assumedHoldingPeriodMinutes: number;
  };
}

export interface EquityCurvePoint {
  timestamp: string;
  equityUsd: number;
  openPositions: number;
}

export interface PortfolioSimulationResult {
  cohort: BacktestCohort;
  startingCapitalUsd: number;
  endingCapitalUsd: number;
  realizedPnlUsd: number;
  peakEquityUsd: number;
  maxDrawdownPct: number;
  averageCapitalUtilizationPct: number;
  tradesTaken: number;
  tradesSkippedForCapitalConstraint: number;
  equityCurve: EquityCurvePoint[];
}

/** The full, persisted, reproducible result of one backtest run. */
export interface BacktestRun {
  id: string;
  runAt: string;
  datasetId: string;
  datasetSize: number;
  config: BacktestConfig;
  /** Phase 6.6 §16 — every signal's full reconstruction trace (Scout signal -> market resolver -> venue -> observation source), so any particular signal's backtestability can be inspected directly rather than only through aggregate stats. */
  signals: BacktestSignal[];
  dataAvailability: DataAvailabilityReport;
  metricsByCohort: BacktestMetrics[];
  selectionLift: SelectionLiftReport[];
  scoreBuckets: BacktestBucketStats[];
  confidenceBuckets: BacktestBucketStats[];
  chaseRiskBuckets: BacktestBucketStats[];
  portfolioResults: PortfolioSimulationResult[];
  assumptions: string[];
}

// ---------------------------------------------------------------------
// Historical Market Data Reliability & Reconstruction (Phase 6.6). See
// docs/BACKTESTING.md and docs/ROBINHOOD_MARKET_DISCOVERY.md. Answers one
// question: can we reconstruct what a market actually looked like at the
// exact moment Scout called a token, independently of delayed third-party
// indexing? Every type here exists to make that answer auditable —
// exactly which venue, which method, and (when reconstruction failed)
// exactly why, per signal.
// ---------------------------------------------------------------------

/** How a historical price/state observation was actually obtained — first-class, not inferred after the fact. */
export type ReconstructionMethod = "ONCHAIN_EVENT" | "ONCHAIN_STATE" | "INDEXER" | "GECKOTERMINAL" | "UNKNOWN";

/** Which on-chain venue a token's market actually is, once resolved. */
export type MarketVenueType = "PONS_V2_CURVE" | "PONS_V2_V4_POOL" | "UNISWAP_V3_POOL" | "UNKNOWN";

/**
 * Exact reason a historical observation could not be reconstructed —
 * deliberately specific so "data unavailable" is never a catch-all when
 * the real cause (no market ever existed vs. a market exists but no
 * indexer has it vs. an RPC limitation) is actually known.
 */
export type MarketReconstructionFailureReason =
  | "NO_MARKET"
  | "MARKET_NOT_DISCOVERED"
  | "POOL_EXISTS_BUT_NO_INDEXER_DATA"
  | "CURVE_EXISTS_BUT_NO_INDEXER_DATA"
  | "HISTORICAL_DATA_TOO_FRESH"
  | "RPC_HISTORY_LIMITATION"
  | "MISSING_BLOCK_TIMESTAMP"
  | "MISSING_SWAP_EVENTS"
  | "MISSING_PRICE"
  | "MISSING_LIQUIDITY"
  | "OTHER";

/**
 * One fully-attributed historical observation. `priceInQuote` is the raw,
 * quote-asset-denominated price (always populated when any price is
 * known); `priceUsd` is populated only when the quote asset is a
 * recognized USD-stable asset — never guessed via a second historical
 * price hop. See docs/BACKTESTING.md's "USD conversion" note for exactly
 * which quote assets qualify.
 */
export interface HistoricalObservation {
  observedAt: string;
  blockNumber: number | null;
  transactionHash: string | null;
  source: string;
  venueType: MarketVenueType;
  marketIdentifier: string;
  token: string;
  quoteToken: string | null;
  priceInQuote: number | null;
  priceUsd: number | null;
  liquidity: number | null;
  dataQuality: DataQualityState;
  reconstructionMethod: ReconstructionMethod;
  notes: string[];
}

/**
 * The full audit trail for how one signal's market was resolved — Scout
 * signal -> market resolver -> venue -> historical observation source ->
 * entry -> exit -> outcome. Lets a reader inspect exactly why any
 * particular signal was or wasn't backtestable, per Phase 6.6 §16.
 */
export interface MarketResolutionTrace {
  signalId: string;
  venueType: MarketVenueType;
  venueIdentifier: string | null;
  /** The Pons V2 factory's own phase label at resolution time, if this is a Pons V2 token. */
  graduationPhase: string | null;
  /** The real on-chain timestamp of the CurveCompleted event, if the token has graduated — never "current" phase alone, which would risk using post-graduation venue data for a pre-graduation decision. */
  graduationTimestamp: string | null;
  /** True when decisionTimestamp < graduationTimestamp — the resolver correctly used the pre-graduation curve, not the not-yet-existing V4 pool. Null when not applicable (not a Pons V2 token, or never graduated). */
  usedPreGraduationVenue: boolean | null;
  failureReason: MarketReconstructionFailureReason | null;
  reconstructionMethod: ReconstructionMethod | null;
  notes: string[];
}

export interface ScoreBreakdown {
  signalId: string;
  computedAt: string;
  featureScores: Record<string, number>;
  llmAssistedNotes?: string;
  totalScore: number;
}

// ---------------------------------------------------------------------
// Token & Market Intelligence (Phase 4). See
// docs/TOKEN_MARKET_INTELLIGENCE.md for every feature's formula, data
// source, and documented thresholds/assumptions.
// ---------------------------------------------------------------------

/**
 * Explicit data-quality states, used everywhere in Phase 4 instead of
 * silently treating missing data as a default value:
 *
 * - KNOWN: the value was actually observed and is fresh.
 * - UNKNOWN: we don't and structurally can't establish this fact right
 *   now (e.g. a feature-detection check that found no evidence either way).
 * - UNAVAILABLE: no provider currently supplies this data at all (e.g. no
 *   historical price source — see docs/DATA_SOURCES.md / WALLET_DATA_SOURCES.md).
 * - STALE: the value was observed, but longer ago than a documented
 *   freshness threshold — see src/shared/freshness.ts.
 * - PARTIAL: some but not all of a composite value's inputs are known.
 *
 * Never convert any of these into a fabricated 0, false, or "unchanged".
 */
export type DataQualityState = "KNOWN" | "UNKNOWN" | "UNAVAILABLE" | "STALE" | "PARTIAL";

/** A single field's data-quality state plus why, when it isn't KNOWN. */
export interface DataQualityField {
  field: string;
  state: DataQualityState;
  reason?: string;
}

/**
 * Rolls a set of per-field quality states into one overall state — see
 * `src/shared/dataQuality.ts` for the exact precedence rule (documented,
 * not implicit).
 */
export interface DataQualitySummary {
  overall: DataQualityState;
  fields: DataQualityField[];
  observedAt: string;
}

/** A three-state detection result — never a boolean, so "not detected" can never be confused with "unknown". */
export type FeatureDetectionState = "detected" | "not_detected" | "unknown";

/**
 * Bytecode-selector-presence evidence for common risk-relevant contract
 * functions — NOT a safety verdict. `not_detected` means the corresponding
 * function selector(s) were not found in the deployed bytecode; it does
 * NOT mean the contract is safe (a proxy, an unusual signature, or an
 * indirect implementation could all produce a false `not_detected` — see
 * `detectionCaveat` and docs/TOKEN_MARKET_INTELLIGENCE.md).
 */
export interface ContractFeatureDetection {
  chainId: number;
  contractAddress: string;
  observedAt: string;
  mintFunctionDetected: FeatureDetectionState;
  burnFunctionDetected: FeatureDetectionState;
  pauseFunctionDetected: FeatureDetectionState;
  blacklistFunctionDetected: FeatureDetectionState;
  ownershipFunctionDetected: FeatureDetectionState;
  maxTransactionFunctionDetected: FeatureDetectionState;
  maxWalletFunctionDetected: FeatureDetectionState;
  feeOrTaxFunctionDetected: FeatureDetectionState;
  /** EIP-1967 proxy storage slot is non-zero — if true, selector detection above is unreliable (the real logic lives elsewhere). */
  proxyPatternDetected: FeatureDetectionState;
  bytecodeSizeBytes: number | null;
  detectionMethod: string;
  detectionCaveat: string;
}

export type TokenAgeCategory = "BRAND_NEW" | "VERY_NEW" | "NEW" | "ESTABLISHED" | "MATURE";

/**
 * Age category thresholds (documented, not arbitrary-and-hidden — see
 * `tokenAgeAnalyzer.ts`): BRAND_NEW < 10 min, VERY_NEW < 1 hour,
 * NEW < 24 hours, ESTABLISHED < 30 days, MATURE >= 30 days. Chosen to
 * match the observed reality that Scout calls tokens that are literally
 * minutes old (see src/ingestion/fixtures) — these bands are meaningful at
 * memecoin timescales, not generic.
 */
export interface TokenAge {
  deployedAt: string | null;
  ageSeconds: number | null;
  ageMinutes: number | null;
  ageHours: number | null;
  ageCategory: TokenAgeCategory | "UNKNOWN";
}

export type LiquidityTrend = "INCREASING" | "STABLE" | "DECREASING" | "LARGE_WITHDRAWAL" | "UNKNOWN";

export interface LiquidityAnalysis {
  chainId: number;
  poolAddress: string;
  observedAt: string;
  currentLiquidityUsd: number | null;
  previousLiquidityUsd: number | null;
  changeUsd: number | null;
  changePct: number | null;
  /** Change in `changePct` between this step and the prior step, when a 3rd snapshot is available — null otherwise. */
  accelerationPctPoints: number | null;
  trend: LiquidityTrend;
  topPoolLiquidityConcentrationPct: number | null;
  dataQuality: DataQualityState;
  notes: string[];
}

export interface MarketFlowAnalysis {
  chainId: number;
  poolAddress: string | "ALL_POOLS";
  observedAt: string;
  buyCount: number;
  sellCount: number;
  unknownCount: number;
  /** In quote-token units (NOT USD — no verified per-swap USD source exists, see docs/WALLET_DATA_SOURCES.md §3). */
  buyQuoteVolume: number | null;
  sellQuoteVolume: number | null;
  netQuoteFlow: number | null;
  buySellRatio: number | null;
  uniqueTraderCount: number | null;
  averageTradeSizeQuote: number | null;
  medianTradeSizeQuote: number | null;
  largeTradeCount: number;
  largeTradeThresholdQuote: number | null;
  recentTradeCount: number | null;
  recentWindowSeconds: number;
  dataQuality: DataQualityState;
  notes: string[];
}

export interface MomentumAnalysis {
  chainId: number;
  contractAddress: string;
  observedAt: string;
  changePct1m: number | null;
  changePct5m: number | null;
  changePct15m: number | null;
  changePct30m: number | null;
  changePct1h: number | null;
  rateOfChangePctPerMinute: number | null;
  accelerationPctPoints: number | null;
  drawdownFromRecentHighPct: number | null;
  distanceFromRecentLowPct: number | null;
  volatilityPct: number | null;
  observationCount: number;
  dataQuality: DataQualityState;
  insufficientDataReason?: string;
}

export type VolumeAccelerationLevel = "LOW" | "MODERATE" | "HIGH" | "UNKNOWN";
export type ChaseRiskLevel = "LOW" | "ELEVATED" | "HIGH" | "UNKNOWN";

/** FEATURES only — never a buy/sell decision. See docs/TOKEN_MARKET_INTELLIGENCE.md for the disclosed chase-risk thresholds. */
export interface EntryQualityFeatures {
  signalId: string;
  chainId: number;
  contractAddress: string;
  computedAt: string;
  priceSincePct: number | null;
  marketCapSincePct: number | null;
  liquiditySincePct: number | null;
  volumeAcceleration: VolumeAccelerationLevel;
  distanceFromRecentHighPct: number | null;
  priceAccelerationPctPoints: number | null;
  chaseRisk: ChaseRiskLevel;
  liquidityDeteriorating: FeatureDetectionState;
  flowDeteriorating: FeatureDetectionState;
  dataQuality: DataQualityState;
  notes: string[];
}

export type AnomalyLevel = "NORMAL" | "UNUSUAL" | "HIGHLY_UNUSUAL" | "UNKNOWN";

/** Every threshold used is documented in docs/TOKEN_MARKET_INTELLIGENCE.md — `thresholds` restates them inline for auditability. */
export interface MarketAnomalyFindings {
  chainId: number;
  contractAddress: string;
  observedAt: string;
  volumeSpike: AnomalyLevel;
  liquidityRemoval: AnomalyLevel;
  buySellImbalance: AnomalyLevel;
  largeTradeAnomaly: AnomalyLevel;
  priceAcceleration: AnomalyLevel;
  transactionFrequency: AnomalyLevel;
  holderConcentrationChange: AnomalyLevel;
  overall: AnomalyLevel;
  evidence: string[];
  thresholds: Record<string, string>;
}

export interface HolderConcentrationBreakdown {
  chainId: number;
  contractAddress: string;
  observedAt: string;
  holderCount: number | null;
  top5ConcentrationPct: number | null;
  top10ConcentrationPct: number | null;
  largestHolderSharePct: number | null;
  deployerSharePct: number | null;
  /** Change vs. a previously stored HolderDistribution, only when one was supplied. */
  concentrationChangePct: number | null;
  dataQuality: DataQualityState;
}

export interface DeployerAnalysis {
  chainId: number;
  contractAddress: string;
  deployerAddress: string | null;
  observedAt: string;
  deployerNativeBalanceRaw: string | null;
  deployerTokenBalanceRaw: string | null;
  deployerTokenBalancePctOfSupply: number | null;
  /** From OUR OWN already-fetched swap data only — not a new indexer call. See docs/WALLET_DATA_SOURCES.md §2d for why full deployer history isn't available. */
  observedDeployerSwapCount: number | null;
  deployerFullHistoryAvailable: false;
  deployerFullHistoryUnavailableReason: string;
  dataQuality: DataQualityState;
  notes: string[];
}

export interface PoolQualityAssessment {
  pool: PoolInfo;
  observedAt: string;
  poolAgeSeconds: number | null;
  recentSwapCount: number | null;
  recentBuyCount: number | null;
  recentSellCount: number | null;
  dataQuality: DataQualityState;
}

/**
 * The market state at the moment a Scout signal was processed — captured
 * once and never overwritten (a later re-run creates a new snapshot
 * record, it doesn't mutate this one), so it can be compared against later
 * state for backtesting. This does NOT modify the original `ScoutSignal`.
 */
export interface SignalMarketSnapshot {
  signalId: string;
  chainId: number;
  contractAddress: string;
  capturedAt: string;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volumeUsd24h: number | null;
  marketCapUsd: number | null;
  pools: PoolInfo[];
  recentFlow: MarketFlowAnalysis | null;
  tokenAge: TokenAge | null;
  holderInfo: HolderDistribution | null;
  dataQuality: DataQualitySummary;
}

export type TradeAction = "BUY" | "WAIT" | "IGNORE";

/** The risk engine's ruling. Can veto regardless of score. */
export interface RiskDecision {
  signalId: string;
  vetoed: boolean;
  reason?: string;
  maxPositionSizeUsd?: number;
}

export interface TradeDecision {
  signalId: string;
  action: TradeAction;
  positionSizeUsd?: number;
  decidedAt: string;
  scoreBreakdown: ScoreBreakdown;
  riskDecision: RiskDecision;
}

export interface PaperPosition {
  id: string;
  signalId: string;
  tradingMode: TradingMode;
  contractAddress: string;
  chainId: number;
  entryPriceUsd: number;
  sizeUsd: number;
  openedAt: string;
  takeProfitPct?: number;
  stopLossPct?: number;
  trailingStopPct?: number;
  closedAt?: string;
  exitPriceUsd?: number;
}

export type ExitReason =
  | "TAKE_PROFIT"
  | "STOP_LOSS"
  | "TRAILING_STOP"
  | "MAX_HOLDING_TIME"
  | "LIQUIDITY_EMERGENCY"
  | "MANUAL"
  | "TIMEOUT";

export interface TradeResult {
  positionId: string;
  signalId: string;
  pnlUsd: number;
  pnlPct: number;
  holdingPeriodSeconds: number;
  exitReason: ExitReason;
}

// ---------------------------------------------------------------------
// Live Scout -> Paper Trading Pipeline (Phase 7). See
// docs/LIVE_PIPELINE.md. Core invariant, enforced structurally the same
// way as Phase 6's backtester: every type here traces back to a real
// ScoutSignal — market-intelligence providers (Pons, Uniswap, GeckoTerminal)
// take a token as input and never originate one. No live execution, wallet
// signing, or transaction broadcasting exists anywhere in this module —
// every trade here is `PAPER_*`, simulated only.
// ---------------------------------------------------------------------

/** One recorded transition in a signal's live lifecycle — the raw material for latency metrics and the observability record. */
export interface LifecycleEvent {
  signalId: string;
  stage: LiveSignalLifecycleStage;
  timestamp: string;
  /** null only for the very first event (RECEIVED) — every later stage has a previous one to measure from. */
  durationMsSincePrevious: number | null;
  status: "OK" | "ERROR" | "SKIPPED";
  error?: string;
  details?: Record<string, unknown>;
}

/** Which specific reason a signal never reached a paper entry — mirrors Phase 6.6's "no generic label when a specific one is known" rule. */
export type SignalRejectionReason =
  | "DUPLICATE"
  | "PERFORMANCE_UPDATE_NOT_A_CALL"
  | "MISSING_CONTRACT_ADDRESS"
  | "STALE_SIGNAL"
  | "MARKET_NOT_DISCOVERED"
  | "INTELLIGENCE_TIMEOUT"
  | "SCORING_ERROR"
  | "IGNORED_BY_SMART_SELECTION"
  | "WATCH_ONLY"
  | "MAX_CONCURRENT_POSITIONS"
  | "INSUFFICIENT_CAPITAL"
  | "OTHER";

/** The full per-signal audit trail — Scout signal -> lifecycle -> decision -> paper entry (if any). One of these exists for every signal the live pipeline ever saw, successful or not. */
export interface LiveSignalRecord {
  signalId: string;
  source: string;
  sourceMessageId: string;
  tokenSymbol: string | null;
  contractAddress: string | null;
  scoutTimestamp: string | null;
  receivedAt: string;
  events: LifecycleEvent[];
  currentStage: LiveSignalLifecycleStage;
  rejectionReason: SignalRejectionReason | null;
  venueType: MarketVenueType | null;
  marketDataQuality: DataQualityState;
  smartSelectionResultId: string | null;
  overallScore: number | null;
  confidence: number | null;
  /**
   * Phase 7.1 §21 — surfaces the EXISTING `SmartSelectionResult.confidenceBreakdown`
   * (completeness/criticalFeatureAvailability/walletSampleSize/freshness
   * components — see confidenceEngine.ts) into every live record. This is
   * NOT a second confidence formula; it's the same engine's own already-
   * computed components, just persisted instead of discarded.
   */
  confidenceBreakdown: ConfidenceBreakdown | null;
  /**
   * Phase 7.1 §21 — surfaces the EXISTING `SmartSelectionResult.dataQuality`
   * (per-feature-group KNOWN/PARTIAL/UNAVAILABLE/STALE/UNKNOWN states — see
   * shared/dataQuality.ts) into every live record, alongside `providerCalls`
   * (per-PROVIDER OK/TIMEOUT/ERROR/SKIPPED outcomes) for the complementary
   * per-GROUP view.
   */
  dataQuality: DataQualitySummary | null;
  decision: SmartSelectionDecision | null;
  paperPositionId: string | null;
  /** One entry per external call made while processing this signal — the raw material for per-provider latency stats (Phase 7 §16). */
  providerCalls: LiveProviderCallSummary[];
}

/** Live provider-call timeout/degradation outcome — never a fabricated value, always an explicit status. */
export interface LiveProviderCallResult<T> {
  provider: string;
  /** Phase 7.3 §18 — `DEADLINE_SKIPPED` is distinct from `TIMEOUT`: the work was never even started because too little of the shared decision budget remained for it to plausibly finish, decided BEFORE spending any RPC capacity on it. `TIMEOUT` means the work started and ran out the clock; `SKIPPED` means an unconditional precondition was missing (e.g. no chain client configured) rather than a deadline judgment. */
  status: "OK" | "TIMEOUT" | "ERROR" | "SKIPPED" | "DEADLINE_SKIPPED";
  durationMs: number;
  data: T | null;
  error?: string;
}

/** The subset of a provider call worth persisting on the signal record for latency reporting — same fields as LiveProviderCallResult minus the (often large, already-consumed-elsewhere) data payload. */
export interface LiveProviderCallSummary {
  provider: string;
  /** Phase 7.3 §18 — `DEADLINE_SKIPPED` is distinct from `TIMEOUT`: the work was never even started because too little of the shared decision budget remained for it to plausibly finish, decided BEFORE spending any RPC capacity on it. `TIMEOUT` means the work started and ran out the clock; `SKIPPED` means an unconditional precondition was missing (e.g. no chain client configured) rather than a deadline judgment. */
  status: "OK" | "TIMEOUT" | "ERROR" | "SKIPPED" | "DEADLINE_SKIPPED";
  durationMs: number;
  error?: string;
}

export interface PaperPortfolioConfig {
  startingCapitalUsd: number;
  positionSizePct: number;
  maxPositionSizeUsd: number;
  maxConcurrentPositions: number;
  slippagePct: number;
  feePct: number;
  takeProfitPct: number | null;
  stopLossPct: number | null;
  maxHoldingMinutes: number | null;
  /** Emergency-exit trigger: close immediately if observed liquidity drops below this. Null disables the check (never treated as "no liquidity data" — see PaperPositionSnapshot.marketStatus for that). */
  liquidityEmergencyExitUsd: number | null;
  /** Stale-signal protection (Phase 7 §14) — a signal older than this at the moment of paper-entry decision is rejected, never traded. Not tuned/optimized in this phase. */
  maxSignalAgeSecondsForEntry: number;
  /** A price observation older than this is STALE, never silently treated as current. */
  priceStalenessSeconds: number;
}

/** The simulated execution details for one paper entry — the live-pipeline analogue of Phase 6's BacktestPosition, but for a real-time decision rather than a historical one. */
export interface PaperTradeExecution {
  positionId: string;
  signalId: string;
  contractAddress: string;
  chainId: number;
  entryTimestamp: string;
  entryPriceUsd: number;
  entryPriceSource: string;
  entryDataQuality: DataQualityState;
  positionSizeUsd: number;
  slippagePct: number;
  feePct: number;
  feesUsd: number;
  /** Token quantity simulated as acquired, net of slippage/fees. */
  tokenAmount: number;
  /** USD quote amount actually committed (positionSizeUsd, restated for clarity alongside tokenAmount). */
  quoteAmountUsd: number;
}

export type PaperMarketStatus = "ACTIVE" | "STALE_PRICE" | "NO_LIQUIDITY_DATA" | "UNKNOWN";

/** One point-in-time observation of an open paper position — this is what the position monitor produces on every poll, never retroactively edited. */
export interface PaperPositionSnapshot {
  positionId: string;
  observedAt: string;
  priceUsd: number | null;
  priceSource: string | null;
  priceDataQuality: DataQualityState;
  pnlUsd: number | null;
  returnPct: number | null;
  maxFavorableExcursionPct: number;
  maxAdverseExcursionPct: number;
  ageSeconds: number;
  liquidityUsd: number | null;
  marketStatus: PaperMarketStatus;
}

export interface LivePaperPosition {
  id: string;
  signalId: string;
  contractAddress: string;
  chainId: number;
  tokenSymbol: string | null;
  execution: PaperTradeExecution;
  status: "OPEN" | "CLOSED";
  takeProfitPct: number | null;
  stopLossPct: number | null;
  maxHoldingMinutes: number | null;
  latestSnapshot: PaperPositionSnapshot | null;
  closedAt: string | null;
  exitPriceUsd: number | null;
  exitReason: ExitReason | null;
  realizedPnlUsd: number | null;
  realizedReturnPct: number | null;
}

/**
 * Phase 7.2 §23 — a WATCH decision is analytical observation, NOT a
 * trade. This records subsequent real market snapshots for a signal
 * Smart Selection decided to WATCH, so a later analysis can answer "what
 * happened after signals we WATCHed?" without ever retroactively
 * relabeling a WATCH as a trade, opening a position for it, or feeding it
 * back into a decision.
 */
export interface WatchObservation {
  /** `${signalId}:${observedAt}` — each poll produces a new, distinct record, never overwritten. */
  id: string;
  signalId: string;
  contractAddress: string;
  tokenSymbol: string | null;
  /** When Smart Selection actually made the WATCH decision — fixed, never updated by later observations. */
  decidedAt: string;
  decidedScore: number | null;
  decidedConfidence: number | null;
  observedAt: string;
  priceUsd: number | null;
  liquidityUsd: number | null;
  venueType: MarketVenueType;
  dataQuality: DataQualityState;
}

export interface LatencyStats {
  count: number;
  averageMs: number | null;
  medianMs: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

/** The headline metric (Phase 7 §16): Scout signal timestamp -> paper entry timestamp, plus every intermediate stage and per-provider latency, so a slow stage or provider is directly identifiable rather than only visible as "the total is slow." */
export interface LivePipelineLatencyReport {
  generatedAt: string;
  sampleCount: number;
  scoutToPaperEntry: LatencyStats;
  scoutToDecision: LatencyStats;
  byStageTransition: Record<string, LatencyStats>;
  byProvider: Record<string, LatencyStats>;
}
