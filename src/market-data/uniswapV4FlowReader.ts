// Phase 7.2 §5/§6 — live recent-flow (and, incidentally, current-price
// observations for momentum) extraction for a graduated Pons V2 token's
// Uniswap V4 pool, filtered to its specific PoolId. Deliberately separate
// from src/backtesting/onChainUniswapV4PriceProvider.ts for the same
// reason as ponsCurveMarketReader.ts: that provider is correctly
// USD-gated for historical candle comparability; this one always returns
// quote-denominated values and layers on USD only when a trustworthy
// conversion exists (§17).
//
// §6 — direction classification. Uniswap V4's Swap event reports
// `amount0`/`amount1` as the POOL's own balance delta (standard Uniswap
// convention, unchanged in V4): negative means that currency left the
// pool (a trader received it — a BUY of that currency), positive means it
// entered the pool (a trader paid it in — a SELL of that currency). This
// module only knows how to look at the Scout TOKEN's own amount sign,
// relative to whether the token is currency0 or currency1 for this pool
// (`tokenIsCurrency0`, resolved once by whoever built the
// ResolvedMarketContext — see resolvedMarketContext.ts). Zero or missing
// amounts, or a boundary case this module isn't confident about, resolve
// to UNKNOWN — direction is never guessed to "improve" apparent coverage
// (§6's explicit instruction).
//
// §12 — the caller supplies fromBlock/toBlock (a bounded, ideally
// launch/graduation-anchored window); this module does not choose it.

import { fetchLogsHybrid } from "../blockchain/hybridLogFetcher.js";
import { convertToUsd } from "../backtesting/quoteAssetUsdPricing.js";
import { priceOfTokenInQuote } from "../backtesting/sqrtPriceX96.js";
import { UNISWAP_V4_SWAP_EVENT } from "./uniswapV4Abi.js";
import { MarketFlowAnalyzer } from "./marketFlowAnalyzer.js";
import type { RobinhoodChainClient } from "../blockchain/robinhoodChainClient.js";
import type { BlockTimestampResolver } from "../blockchain/blockTimestampResolver.js";
import { loadPrimaryRpcCapabilities, type RpcProviderCapabilities } from "../blockchain/chainConfig.js";
import type { RpcProviderRole } from "../blockchain/rpcRouting.js";
import type { DataQualityState, FlowCompleteness, MarketFlowAnalysis, SwapRecord, SwapSide } from "../types/domain.js";

const MAX_SPLIT_DEPTH = 3;

export interface UniswapV4FlowReaderOptions {
  chainClient: RobinhoodChainClient;
  blockTimestampResolver: BlockTimestampResolver;
  /** Phase 7.4 §11 — a separate client used ONLY for the V4 Swap event fetch when the requested range exceeds `primaryCapabilities`'s known cap. Defaults to `chainClient`. */
  logChainClient?: RobinhoodChainClient;
  /** Phase 7.4 §5 — `chainClient`'s known eth_getLogs range cap. Defaults to `loadPrimaryRpcCapabilities()`. */
  primaryCapabilities?: RpcProviderCapabilities;
}

export interface V4FlowContext {
  poolManagerAddress: string;
  poolId: string;
  quoteTokenAddress: string;
  tokenIsCurrency0: boolean;
  tokenDecimals: number;
  quoteDecimals: number;
}

export interface V4FlowResult {
  marketFlow: MarketFlowAnalysis | null;
  swaps: SwapRecord[];
  priceObservations: { blockNumber: number; timestamp: string | undefined; priceInQuote: number }[];
  latestPriceInQuote: number | null;
  latestPriceUsd: number | null;
  unknownDirectionCount: number;
  dataQuality: DataQualityState;
  /** Phase 7.4 §14 — honest completeness of the underlying Swap-event fetch. */
  flowCompleteness: FlowCompleteness;
  /** Phase 7.4 §9/§11 — which provider role actually served the Swap-event fetch. */
  providerRole: RpcProviderRole;
  notes: string[];
}

/** §6: classifies direction purely from the sign of the Scout token's own amount — UNKNOWN whenever that's not safely determinable. */
function classifyDirection(amount0: bigint, amount1: bigint, tokenIsCurrency0: boolean): SwapSide {
  const tokenAmount = tokenIsCurrency0 ? amount0 : amount1;
  if (tokenAmount === 0n) return "UNKNOWN"; // no observable change in the token's own balance — cannot safely classify
  return tokenAmount < 0n ? "BUY" : "SELL"; // negative: token left the pool to the trader (bought); positive: token entered the pool (sold)
}

export class UniswapV4FlowReader {
  #chainClient: RobinhoodChainClient;
  #logChainClient: RobinhoodChainClient;
  #primaryCapabilities: RpcProviderCapabilities;
  #blockTimestampResolver: BlockTimestampResolver;

  constructor(options: UniswapV4FlowReaderOptions) {
    this.#chainClient = options.chainClient;
    this.#logChainClient = options.logChainClient ?? options.chainClient;
    this.#primaryCapabilities = options.primaryCapabilities ?? loadPrimaryRpcCapabilities();
    this.#blockTimestampResolver = options.blockTimestampResolver;
  }

  async getRecentFlow(chainId: number, context: V4FlowContext, fromBlock: bigint, toBlock: bigint, now: Date = new Date()): Promise<V4FlowResult> {
    const notes: string[] = [];
    const outcome = await fetchLogsHybrid(
      { primary: this.#chainClient, log: this.#logChainClient },
      { address: context.poolManagerAddress as `0x${string}`, event: UNISWAP_V4_SWAP_EVENT, args: { id: context.poolId as `0x${string}` }, fromBlock, toBlock },
      { purpose: "UNISWAP_V4_FLOW", primaryCapabilities: this.#primaryCapabilities },
      MAX_SPLIT_DEPTH,
    );
    const providerRole = outcome.providerRole;

    if (outcome.status !== "OK") {
      const flowCompleteness: FlowCompleteness = outcome.status === "TIMED_OUT" ? "TIMED_OUT" : outcome.status === "UNAVAILABLE" ? "UNAVAILABLE" : "FAILED";
      return {
        marketFlow: null,
        swaps: [],
        priceObservations: [],
        latestPriceInQuote: null,
        latestPriceUsd: null,
        unknownDirectionCount: 0,
        dataQuality: "UNAVAILABLE",
        flowCompleteness,
        providerRole,
        notes: [`V4 Swap event fetch (${providerRole}) did not complete within the requested bounded window: ${outcome.reason ?? outcome.status}`],
      };
    }

    const logs: any[] = outcome.data;
    if (logs.length === 0) {
      return {
        marketFlow: null,
        swaps: [],
        priceObservations: [],
        latestPriceInQuote: null,
        latestPriceUsd: null,
        unknownDirectionCount: 0,
        dataQuality: "UNAVAILABLE",
        flowCompleteness: "AVAILABLE_FULL",
        providerRole,
        notes: ["no Swap events found for this PoolId within the bounded window"],
      };
    }

    logs.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber));

    // Phase 7.4 §12/§B — resolved CONCURRENTLY for the same reason as PonsCurveMarketReader: once
    // hybrid routing lets a busy pool's getLogs actually succeed, resolving each trade's timestamp
    // one at a time became the real bottleneck. BlockTimestampResolver de-duplicates concurrent
    // requests for the same block itself.
    const resolvedTimestamps = await Promise.all(
      logs.map(async (log) => {
        try {
          return await this.#blockTimestampResolver.resolve(BigInt(log.blockNumber));
        } catch {
          return undefined;
        }
      }),
    );

    const swaps: SwapRecord[] = [];
    const priceObservations: { blockNumber: number; timestamp: string | undefined; priceInQuote: number }[] = [];
    let unknownDirectionCount = 0;
    let latestPriceInQuote: number | null = null;

    logs.forEach((log, i) => {
      const amount0 = log.args?.amount0 as bigint | undefined;
      const amount1 = log.args?.amount1 as bigint | undefined;
      const sqrtPriceX96 = log.args?.sqrtPriceX96 as bigint | undefined;
      if (amount0 === undefined || amount1 === undefined) return; // malformed event — excluded, never guessed

      const side = classifyDirection(amount0, amount1, context.tokenIsCurrency0);
      if (side === "UNKNOWN") unknownDirectionCount += 1;

      const tokenAmountRaw = context.tokenIsCurrency0 ? amount0 : amount1;
      const quoteAmountRaw = context.tokenIsCurrency0 ? amount1 : amount0;
      const timestamp = resolvedTimestamps[i];

      swaps.push({
        chainId,
        poolAddress: context.poolId, // the PoolId, not a contract address — see the module doc comment; SwapRecord.poolAddress is just an opaque identifier string here
        transactionHash: log.transactionHash,
        blockNumber: Number(log.blockNumber),
        timestamp,
        trader: (log.args?.sender as string) ?? undefined,
        tokenAmount: (tokenAmountRaw < 0n ? -tokenAmountRaw : tokenAmountRaw).toString(),
        quoteAmount: (quoteAmountRaw < 0n ? -quoteAmountRaw : quoteAmountRaw).toString(),
        side,
        source: "uniswap-v4-onchain",
      });

      if (sqrtPriceX96 !== undefined) {
        const currency0Decimals = context.tokenIsCurrency0 ? context.tokenDecimals : context.quoteDecimals;
        const currency1Decimals = context.tokenIsCurrency0 ? context.quoteDecimals : context.tokenDecimals;
        const priceInQuote = priceOfTokenInQuote(sqrtPriceX96, context.tokenIsCurrency0, currency0Decimals, currency1Decimals);
        if (Number.isFinite(priceInQuote)) {
          priceObservations.push({ blockNumber: Number(log.blockNumber), timestamp, priceInQuote });
          latestPriceInQuote = priceInQuote;
        }
      }
    });

    if (unknownDirectionCount > 0) notes.push(`${unknownDirectionCount}/${logs.length} swap(s) had a zero token-side amount and could not be classified as BUY/SELL — reported as UNKNOWN, not guessed`);

    const analyzer = new MarketFlowAnalyzer();
    const marketFlow = swaps.length > 0 ? analyzer.analyze(chainId, context.poolId, swaps, context.quoteDecimals, now) : null;

    return {
      marketFlow,
      swaps,
      priceObservations,
      latestPriceInQuote,
      latestPriceUsd: convertToUsd(latestPriceInQuote, context.quoteTokenAddress),
      unknownDirectionCount,
      dataQuality: marketFlow ? "KNOWN" : "UNAVAILABLE",
      flowCompleteness: "AVAILABLE_FULL",
      providerRole,
      notes,
    };
  }
}
