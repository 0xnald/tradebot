// Phase 6.6 §8 — reconstructs historical price for a graduated Pons V2
// launch directly from Uniswap V4 PoolManager Swap events, filtered by
// the pool's PoolId (a bytes32, never treated as an address — see
// ponsV2Provider.ts). Verified live: a real graduated Pons pool emitted
// 715 real Swap events in a 12,000-block window right after graduation
// (docs/DATA_SOURCES.md §2). Only produces USD-denominated candles when
// the pool's quote currency is a recognized USD-stable token.

import type { RobinhoodChainClient } from "../blockchain/robinhoodChainClient.js";
import type { BlockTimestampResolver } from "../blockchain/blockTimestampResolver.js";
import type { BlockTimeEstimator } from "../blockchain/blockTimeEstimator.js";
import { fetchLogsWithAdaptiveChunking } from "../blockchain/logRangeChunking.js";
import { UNISWAP_V4_SWAP_EVENT } from "../market-data/uniswapV4Abi.js";
import { convertToUsd } from "./quoteAssetUsdPricing.js";
import { priceOfTokenInQuote } from "./sqrtPriceX96.js";
import { bucketTradesIntoCandles, type RawTradePricePoint } from "./onChainCandleBucketing.js";
import type { CandleTimeframe, HistoricalCandle, HistoricalPriceProvider } from "./historicalPriceProvider.js";
import type { ProviderResult } from "../types/domain.js";

const TIMEFRAME_MS: Record<CandleTimeframe, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };
const BLOCK_SEARCH_MARGIN = 2_000n;
/** See onChainPonsCurvePriceProvider.ts's identical constant's doc comment — measured live, a busy pool's default-depth bisection cascade took 150+ seconds against the public RPC. */
const MAX_SPLIT_DEPTH = 3;

export interface OnChainUniswapV4PriceProviderOptions {
  chainClient: RobinhoodChainClient;
  blockTimestampResolver: BlockTimestampResolver;
  blockTimeEstimator: BlockTimeEstimator;
  poolManagerAddress: string;
  /** The bytes32 PoolId — never a contract address. */
  poolId: string;
  quoteTokenAddress: string;
  tokenIsCurrency0: boolean;
  currency0Decimals: number;
  currency1Decimals: number;
}

export class OnChainUniswapV4PriceProvider implements HistoricalPriceProvider {
  readonly name = "onchain-uniswap-v4";
  #chainClient: RobinhoodChainClient;
  #blockTimestampResolver: BlockTimestampResolver;
  #blockTimeEstimator: BlockTimeEstimator;
  #poolManagerAddress: string;
  #poolId: string;
  #quoteTokenAddress: string;
  #tokenIsCurrency0: boolean;
  #currency0Decimals: number;
  #currency1Decimals: number;

  constructor(options: OnChainUniswapV4PriceProviderOptions) {
    this.#chainClient = options.chainClient;
    this.#blockTimestampResolver = options.blockTimestampResolver;
    this.#blockTimeEstimator = options.blockTimeEstimator;
    this.#poolManagerAddress = options.poolManagerAddress;
    this.#poolId = options.poolId;
    this.#quoteTokenAddress = options.quoteTokenAddress;
    this.#tokenIsCurrency0 = options.tokenIsCurrency0;
    this.#currency0Decimals = options.currency0Decimals;
    this.#currency1Decimals = options.currency1Decimals;
  }

  async getCandles(
    _chainId: number,
    _poolAddress: string,
    beforeTimestamp: string,
    timeframe: CandleTimeframe,
    aggregate: number,
    limit: number,
  ): Promise<ProviderResult<HistoricalCandle[]>> {
    const beforeMs = new Date(beforeTimestamp).getTime();
    if (Number.isNaN(beforeMs)) {
      return { status: "error", data: null, unavailable: ["candles"], errors: [{ message: `invalid beforeTimestamp: ${beforeTimestamp}`, provider: this.name }] };
    }
    if (!convertToUsd(1, this.#quoteTokenAddress)) {
      return { status: "unavailable", data: null, unavailable: ["candles"], errors: [] };
    }

    try {
      const windowMs = limit * TIMEFRAME_MS[timeframe] * aggregate;
      const toEstimated = await this.#blockTimeEstimator.estimateBlockAt(beforeMs);
      const fromEstimated = await this.#blockTimeEstimator.estimateBlockAt(beforeMs - windowMs);
      const fromBlock = fromEstimated > BLOCK_SEARCH_MARGIN ? fromEstimated - BLOCK_SEARCH_MARGIN : 0n;
      const toBlock = toEstimated + BLOCK_SEARCH_MARGIN;

      const swaps = await fetchLogsWithAdaptiveChunking(
        (from, to) =>
          this.#chainClient.getLogs({
            address: this.#poolManagerAddress as `0x${string}`,
            event: UNISWAP_V4_SWAP_EVENT,
            args: { id: this.#poolId as `0x${string}` },
            fromBlock: from,
            toBlock: to,
          }),
        fromBlock,
        toBlock,
        MAX_SPLIT_DEPTH,
      );

      const points: RawTradePricePoint[] = [];
      for (const log of swaps as any[]) {
        const sqrtPriceX96 = log.args.sqrtPriceX96 as bigint | undefined;
        if (typeof sqrtPriceX96 !== "bigint") continue; // malformed log — never coerced into a fabricated price
        const priceInQuote = priceOfTokenInQuote(sqrtPriceX96, this.#tokenIsCurrency0, this.#currency0Decimals, this.#currency1Decimals);
        if (!Number.isFinite(priceInQuote)) continue;
        const timestamp = await this.#blockTimestampResolver.resolve(log.blockNumber);
        if (new Date(timestamp).getTime() > beforeMs) continue;
        points.push({ timestamp, priceUsd: priceInQuote });
      }

      if (points.length === 0) {
        return { status: "unavailable", data: null, unavailable: ["candles"], errors: [] };
      }

      const candles = bucketTradesIntoCandles(points, timeframe, aggregate).slice(-limit);
      return { status: "ok", data: candles, unavailable: [], errors: [] };
    } catch (error) {
      return { status: "error", data: null, unavailable: ["candles"], errors: [{ message: error instanceof Error ? error.message : String(error), provider: this.name }] };
    }
  }
}
