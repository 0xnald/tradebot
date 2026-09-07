// Phase 6.6 §4 — reconstructs historical price directly from a Uniswap V3
// pool's own Swap events. Verified live during Phase 6.6: BABA's real V3
// pools had 335-4525 real swaps each, on-chain, even though GeckoTerminal
// returned no candle data for them within Phase 6.5's lookback window
// (docs/DATA_SOURCES.md §4) — this is the direct fix for that gap. Only
// produces USD-denominated candles when the pool's quote token is a
// recognized USD-stable asset.

import type { RobinhoodChainClient } from "../blockchain/robinhoodChainClient.js";
import type { BlockTimestampResolver } from "../blockchain/blockTimestampResolver.js";
import type { BlockTimeEstimator } from "../blockchain/blockTimeEstimator.js";
import { fetchLogsWithAdaptiveChunking } from "../blockchain/logRangeChunking.js";
import { UNISWAP_V3_SWAP_EVENT } from "../market-data/uniswapV3Abi.js";
import { convertToUsd } from "./quoteAssetUsdPricing.js";
import { priceOfTokenInQuote } from "./sqrtPriceX96.js";
import { bucketTradesIntoCandles, type RawTradePricePoint } from "./onChainCandleBucketing.js";
import type { CandleTimeframe, HistoricalCandle, HistoricalPriceProvider } from "./historicalPriceProvider.js";
import type { ProviderResult } from "../types/domain.js";

const TIMEFRAME_MS: Record<CandleTimeframe, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };
const BLOCK_SEARCH_MARGIN = 2_000n;
/** See onChainPonsCurvePriceProvider.ts's identical constant's doc comment — measured live, a busy pool's default-depth bisection cascade took 150+ seconds against the public RPC. */
const MAX_SPLIT_DEPTH = 3;

export interface OnChainUniswapV3PriceProviderOptions {
  chainClient: RobinhoodChainClient;
  blockTimestampResolver: BlockTimestampResolver;
  blockTimeEstimator: BlockTimeEstimator;
  poolAddress: string;
  quoteTokenAddress: string;
  tokenIsToken0: boolean;
  token0Decimals: number;
  token1Decimals: number;
}

export class OnChainUniswapV3PriceProvider implements HistoricalPriceProvider {
  readonly name = "onchain-uniswap-v3";
  #chainClient: RobinhoodChainClient;
  #blockTimestampResolver: BlockTimestampResolver;
  #blockTimeEstimator: BlockTimeEstimator;
  #poolAddress: string;
  #quoteTokenAddress: string;
  #tokenIsToken0: boolean;
  #token0Decimals: number;
  #token1Decimals: number;

  constructor(options: OnChainUniswapV3PriceProviderOptions) {
    this.#chainClient = options.chainClient;
    this.#blockTimestampResolver = options.blockTimestampResolver;
    this.#blockTimeEstimator = options.blockTimeEstimator;
    this.#poolAddress = options.poolAddress;
    this.#quoteTokenAddress = options.quoteTokenAddress;
    this.#tokenIsToken0 = options.tokenIsToken0;
    this.#token0Decimals = options.token0Decimals;
    this.#token1Decimals = options.token1Decimals;
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
          this.#chainClient.getLogs({ address: this.#poolAddress as `0x${string}`, event: UNISWAP_V3_SWAP_EVENT, fromBlock: from, toBlock: to }),
        fromBlock,
        toBlock,
        MAX_SPLIT_DEPTH,
      );

      const points: RawTradePricePoint[] = [];
      for (const log of swaps as any[]) {
        const sqrtPriceX96 = log.args.sqrtPriceX96 as bigint | undefined;
        if (typeof sqrtPriceX96 !== "bigint") continue; // malformed log — never coerced into a fabricated price
        const priceInQuote = priceOfTokenInQuote(sqrtPriceX96, this.#tokenIsToken0, this.#token0Decimals, this.#token1Decimals);
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
