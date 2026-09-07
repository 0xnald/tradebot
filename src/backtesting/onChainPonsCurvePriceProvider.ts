// Phase 6.6 §6 — reconstructs historical price directly from a Pons V2
// bonding curve's own CurveBuy/CurveSell events. This is ground-truth
// trade data (an actual executed price at an actual block), not an
// indexer's derived candle — no GeckoTerminal dependency for this venue
// when it works. Only produces USD-denominated candles when the curve's
// quote asset is a recognized USD-stable token (see
// quoteAssetUsdPricing.ts); otherwise returns "unavailable" rather than
// silently presenting a non-USD ratio as if it were a USD price.

import type { RobinhoodChainClient } from "../blockchain/robinhoodChainClient.js";
import type { BlockTimestampResolver } from "../blockchain/blockTimestampResolver.js";
import type { BlockTimeEstimator } from "../blockchain/blockTimeEstimator.js";
import { fetchLogsWithAdaptiveChunking } from "../blockchain/logRangeChunking.js";
import { PONS_V2_CURVE_ABI } from "../market-data/ponsV2Abi.js";
import { convertToUsd } from "./quoteAssetUsdPricing.js";
import { bucketTradesIntoCandles, type RawTradePricePoint } from "./onChainCandleBucketing.js";
import type { CandleTimeframe, HistoricalCandle, HistoricalPriceProvider } from "./historicalPriceProvider.js";
import type { ProviderResult } from "../types/domain.js";

const TIMEFRAME_MS: Record<CandleTimeframe, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };
const BLOCK_SEARCH_MARGIN = 2_000n;
/**
 * Lower than fetchLogsWithAdaptiveChunking's own default (6). Measured
 * live: a busy curve's default-depth bisection cascade took 150+ seconds
 * against the public RPC (up to 64 sequential sub-queries) for what is
 * already meant to be a small, bounded time window. Failing fast at a
 * shallower depth and falling through to the GeckoTerminal tier is both
 * faster and gentler on a documented-rate-limited public endpoint.
 */
const MAX_SPLIT_DEPTH = 3;

export interface OnChainPonsCurvePriceProviderOptions {
  chainClient: RobinhoodChainClient;
  blockTimestampResolver: BlockTimestampResolver;
  blockTimeEstimator: BlockTimeEstimator;
  curveAddress: string;
  quoteTokenAddress: string;
  tokenDecimals: number;
  quoteDecimals: number;
}

export class OnChainPonsCurvePriceProvider implements HistoricalPriceProvider {
  readonly name = "onchain-pons-curve";
  #chainClient: RobinhoodChainClient;
  #blockTimestampResolver: BlockTimestampResolver;
  #blockTimeEstimator: BlockTimeEstimator;
  #curveAddress: string;
  #quoteTokenAddress: string;
  #tokenDecimals: number;
  #quoteDecimals: number;

  constructor(options: OnChainPonsCurvePriceProviderOptions) {
    this.#chainClient = options.chainClient;
    this.#blockTimestampResolver = options.blockTimestampResolver;
    this.#blockTimeEstimator = options.blockTimeEstimator;
    this.#curveAddress = options.curveAddress;
    this.#quoteTokenAddress = options.quoteTokenAddress;
    this.#tokenDecimals = options.tokenDecimals;
    this.#quoteDecimals = options.quoteDecimals;
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

      const [buys, sells] = await Promise.all([
        fetchLogsWithAdaptiveChunking(
          (from, to) => this.#chainClient.getLogs({ address: this.#curveAddress as `0x${string}`, event: PONS_V2_CURVE_ABI[0], fromBlock: from, toBlock: to }),
          fromBlock,
          toBlock,
          MAX_SPLIT_DEPTH,
        ),
        fetchLogsWithAdaptiveChunking(
          (from, to) => this.#chainClient.getLogs({ address: this.#curveAddress as `0x${string}`, event: PONS_V2_CURVE_ABI[1], fromBlock: from, toBlock: to }),
          fromBlock,
          toBlock,
          MAX_SPLIT_DEPTH,
        ),
      ]);

      const points: RawTradePricePoint[] = [];
      for (const log of buys as any[]) {
        const quoteIn = Number(log.args.quoteIn) / 10 ** this.#quoteDecimals;
        const tokensOut = Number(log.args.tokensOut) / 10 ** this.#tokenDecimals;
        if (!(tokensOut > 0) || !Number.isFinite(quoteIn)) continue; // guards zero, NaN (malformed log), and Infinity alike
        const timestamp = await this.#blockTimestampResolver.resolve(log.blockNumber);
        if (new Date(timestamp).getTime() > beforeMs) continue;
        points.push({ timestamp, priceUsd: quoteIn / tokensOut });
      }
      for (const log of sells as any[]) {
        const tokensIn = Number(log.args.tokensIn) / 10 ** this.#tokenDecimals;
        const quoteOut = Number(log.args.quoteOut) / 10 ** this.#quoteDecimals;
        if (!(tokensIn > 0) || !Number.isFinite(quoteOut)) continue;
        const timestamp = await this.#blockTimestampResolver.resolve(log.blockNumber);
        if (new Date(timestamp).getTime() > beforeMs) continue;
        points.push({ timestamp, priceUsd: quoteOut / tokensIn });
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
