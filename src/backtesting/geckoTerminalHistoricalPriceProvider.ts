// Real historical OHLCV from GeckoTerminal's public API — verified live on
// 2026-09-05 against a real Scout-called token's actual pool, returning
// genuine minute candles from right after the real Scout call timestamp.
// No API key required or used. See docs/BACKTESTING.md for the full
// verification record and the documented (not independently load-tested)
// ~30 req/min free-tier rate limit this provider conservatively respects
// via a concurrency cap and caching.

import { fetchJson } from "../shared/fetchJson.js";
import { isGeckoTerminalPoolIdentifier } from "./geckoTerminalPoolIdentifier.js";
import { TtlCache } from "../shared/ttlCache.js";
import { ConcurrencyLimiter } from "../shared/concurrencyLimiter.js";
import type { ProviderResult } from "../types/domain.js";
import type { CandleTimeframe, HistoricalCandle, HistoricalPriceProvider } from "./historicalPriceProvider.js";

const DEFAULT_BASE_URL = "https://api.geckoterminal.com/api/v2";
/** Candles for a settled historical period never change — safe to cache for a while. */
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 2;

/** Robinhood Chain's GeckoTerminal network slug — confirmed live 2026-09-05, see docs/BACKTESTING.md. */
const CHAIN_ID_TO_GECKOTERMINAL_NETWORK: Record<number, string> = { 4663: "robinhood" };

interface GeckoTerminalOhlcvResponse {
  data?: {
    attributes?: {
      ohlcv_list?: [number, number, number, number, number, number][];
    };
  };
}

export interface GeckoTerminalHistoricalPriceProviderOptions {
  baseUrl?: string;
  cacheTtlMs?: number;
  maxConcurrentRequests?: number;
}

export class GeckoTerminalHistoricalPriceProvider implements HistoricalPriceProvider {
  readonly name = "geckoterminal";
  #baseUrl: string;
  #cache: TtlCache<ProviderResult<HistoricalCandle[]>>;
  #limiter: ConcurrencyLimiter;
  #ttlMs: number;

  constructor(options: GeckoTerminalHistoricalPriceProviderOptions = {}) {
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.#ttlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.#cache = new TtlCache(this.#ttlMs);
    this.#limiter = new ConcurrencyLimiter(options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS);
  }

  async getCandles(
    chainId: number,
    poolAddress: string,
    beforeTimestamp: string,
    timeframe: CandleTimeframe,
    aggregate: number,
    limit: number,
  ): Promise<ProviderResult<HistoricalCandle[]>> {
    const network = CHAIN_ID_TO_GECKOTERMINAL_NETWORK[chainId];
    if (!network) {
      return {
        status: "error",
        data: null,
        unavailable: ["candles"],
        errors: [{ message: `no GeckoTerminal network mapping for chainId ${chainId}`, provider: this.name }],
      };
    }
    if (!isGeckoTerminalPoolIdentifier(poolAddress)) {
      return {
        status: "error",
        data: null,
        unavailable: ["candles"],
        errors: [{ message: `invalid pool identifier (must be a 20-byte address or a 32-byte Uniswap V4 PoolId): ${poolAddress}`, provider: this.name }],
      };
    }

    const beforeUnix = Math.floor(new Date(beforeTimestamp).getTime() / 1000);
    if (Number.isNaN(beforeUnix)) {
      return {
        status: "error",
        data: null,
        unavailable: ["candles"],
        errors: [{ message: `invalid beforeTimestamp: ${beforeTimestamp}`, provider: this.name }],
      };
    }

    const cacheKey = `${network}:${poolAddress.toLowerCase()}:${timeframe}:${aggregate}:${beforeUnix}:${limit}`;
    return this.#cache.getOrCompute(
      cacheKey,
      () => this.#limiter.run(() => this.#fetch(network, poolAddress, beforeUnix, timeframe, aggregate, limit)),
      this.#ttlMs,
    );
  }

  async #fetch(
    network: string,
    poolAddress: string,
    beforeUnix: number,
    timeframe: CandleTimeframe,
    aggregate: number,
    limit: number,
  ): Promise<ProviderResult<HistoricalCandle[]>> {
    const url = `${this.#baseUrl}/networks/${network}/pools/${poolAddress}/ohlcv/${timeframe}?aggregate=${aggregate}&before_timestamp=${beforeUnix}&limit=${limit}`;
    const response = await fetchJson<GeckoTerminalOhlcvResponse>(url);

    if (!response.ok) {
      return { status: "error", data: null, unavailable: ["candles"], errors: [{ message: response.error, provider: this.name }] };
    }

    const rawList = response.data.data?.attributes?.ohlcv_list ?? [];
    if (rawList.length === 0) {
      return { status: "unavailable", data: null, unavailable: ["candles"], errors: [] };
    }

    // GeckoTerminal returns newest-first — normalize to oldest-first for the exit simulator.
    const candles: HistoricalCandle[] = [...rawList]
      .reverse()
      .map(([ts, open, high, low, close, volume]) => ({
        timestamp: new Date(ts * 1000).toISOString(),
        openUsd: open,
        highUsd: high,
        lowUsd: low,
        closeUsd: close,
        volumeUsd: volume,
      }));

    return { status: "ok", data: candles, unavailable: [], errors: [] };
  }
}
