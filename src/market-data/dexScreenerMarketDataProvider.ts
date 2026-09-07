// Market data from DexScreener's public API — verified live and working
// against real Robinhood Chain data on 2026-09-05, see docs/DATA_SOURCES.md
// §4. No API key used or required for this endpoint.
//
// IMPORTANT: marketCapUsd is only ever a pass-through of DexScreener's own
// figure — never computed here from total supply. See the type doc comment
// on TokenMarketData and docs/DATA_SOURCES.md §4 for why.

import { isAddress } from "viem";
import { fetchJson } from "../shared/fetchJson.js";
import { TtlCache } from "../shared/ttlCache.js";
import type { PoolInfo, ProviderResult, TokenMarketData } from "../types/domain.js";
import type { MarketDataProvider } from "./marketDataProvider.js";

const DEFAULT_BASE_URL = "https://api.dexscreener.com";
const DEFAULT_TTL_MS = 30_000;

const MARKET_DATA_FIELDS = [
  "priceUsd",
  "marketCapUsd",
  "liquidityUsd",
  "volumeUsd24h",
  "pools",
  "priceChangePct1h",
  "priceChangePct6h",
  "priceChangePct24h",
];

/** Only the shape of DexScreener's response this project actually reads — not a full API type. */
interface DexScreenerPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; symbol?: string };
  quoteToken: { address: string; symbol?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  txns?: { h24?: { buys?: number; sells?: number } };
  priceChange?: { h1?: number; h6?: number; h24?: number };
  fdv?: number;
  marketCap?: number;
}

/** Robinhood Chain's DexScreener chain slug, per docs/DATA_SOURCES.md §4. */
const CHAIN_ID_TO_DEXSCREENER_SLUG: Record<number, string> = {
  4663: "robinhood",
};

export interface DexScreenerMarketDataProviderOptions {
  baseUrl?: string;
  cacheTtlMs?: number;
}

export class DexScreenerMarketDataProvider implements MarketDataProvider {
  readonly name = "dexscreener";
  #baseUrl: string;
  #cache: TtlCache<ProviderResult<TokenMarketData>>;
  #ttlMs: number;

  constructor(options: DexScreenerMarketDataProviderOptions = {}) {
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.#ttlMs = options.cacheTtlMs ?? DEFAULT_TTL_MS;
    this.#cache = new TtlCache(this.#ttlMs);
  }

  async getMarketData(chainId: number, contractAddress: string): Promise<ProviderResult<TokenMarketData>> {
    if (!isAddress(contractAddress)) {
      return {
        status: "error",
        data: null,
        unavailable: MARKET_DATA_FIELDS,
        errors: [{ message: `invalid contract address: ${contractAddress}`, provider: this.name }],
      };
    }

    const slug = CHAIN_ID_TO_DEXSCREENER_SLUG[chainId];
    if (!slug) {
      return {
        status: "error",
        data: null,
        unavailable: MARKET_DATA_FIELDS,
        errors: [{ message: `no DexScreener chain slug mapping for chainId ${chainId}`, provider: this.name }],
      };
    }

    const cacheKey = `${chainId}:${contractAddress.toLowerCase()}`;
    return this.#cache.getOrCompute(cacheKey, () => this.#fetch(chainId, contractAddress, slug), this.#ttlMs);
  }

  async #fetch(chainId: number, contractAddress: string, slug: string): Promise<ProviderResult<TokenMarketData>> {
    const url = `${this.#baseUrl}/token-pairs/v1/${slug}/${contractAddress}`;
    const response = await fetchJson<DexScreenerPair[]>(url);

    if (!response.ok) {
      return {
        status: "error",
        data: null,
        unavailable: MARKET_DATA_FIELDS,
        errors: [{ message: response.error, provider: this.name }],
      };
    }

    const pairs = Array.isArray(response.data) ? response.data : [];
    if (pairs.length === 0) {
      return {
        status: "unavailable",
        data: null,
        unavailable: MARKET_DATA_FIELDS,
        errors: [],
      };
    }

    const errors: { message: string; provider?: string }[] = [];
    const pools: PoolInfo[] = [];
    let liquidityTotal = 0;
    let volumeTotal = 0;
    let buyCountTotal = 0;
    let sellCountTotal = 0;
    let sawAnyLiquidity = false;
    let sawAnyVolume = false;

    for (const pair of pairs) {
      try {
        const liquidityUsd = typeof pair.liquidity?.usd === "number" ? pair.liquidity.usd : null;
        if (liquidityUsd !== null) {
          liquidityTotal += liquidityUsd;
          sawAnyLiquidity = true;
        }
        const volumeH24 = typeof pair.volume?.h24 === "number" ? pair.volume.h24 : null;
        if (volumeH24 !== null) {
          volumeTotal += volumeH24;
          sawAnyVolume = true;
        }
        buyCountTotal += pair.txns?.h24?.buys ?? 0;
        sellCountTotal += pair.txns?.h24?.sells ?? 0;

        pools.push({
          chainId,
          poolAddress: pair.pairAddress,
          dexId: pair.dexId,
          tokenAddress: contractAddress,
          quoteTokenAddress: pair.quoteToken.address,
          quoteTokenSymbol: pair.quoteToken.symbol,
          liquidityUsd,
          priceUsd: pair.priceUsd ? Number(pair.priceUsd) : null,
          source: this.name,
        });
      } catch (error) {
        errors.push({
          message: `skipped a malformed pair (${pair?.pairAddress ?? "unknown address"}): ${
            error instanceof Error ? error.message : String(error)
          }`,
          provider: this.name,
        });
      }
    }

    // The pool with the most liquidity is treated as the primary source for
    // single-value fields (price, market cap, price change) — a documented
    // convention, not an arbitrary pick: deeper liquidity means a more
    // reliable price.
    const primary = [...pairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];

    const marketCapUsd = typeof primary.marketCap === "number" ? primary.marketCap : null;

    const data: TokenMarketData = {
      chainId,
      contractAddress,
      observedAt: new Date().toISOString(),
      priceUsd: primary.priceUsd ? Number(primary.priceUsd) : null,
      marketCapUsd,
      marketCapUnavailableReason:
        marketCapUsd === null ? "DexScreener returned no marketCap figure for this token's pools" : undefined,
      fdvUsd: typeof primary.fdv === "number" ? primary.fdv : null,
      liquidityUsd: sawAnyLiquidity ? liquidityTotal : null,
      volumeUsd24h: sawAnyVolume ? volumeTotal : null,
      buyCount24h: buyCountTotal,
      sellCount24h: sellCountTotal,
      tradeCount24h: buyCountTotal + sellCountTotal,
      priceChangePct1h: primary.priceChange?.h1 ?? null,
      priceChangePct6h: primary.priceChange?.h6 ?? null,
      priceChangePct24h: primary.priceChange?.h24 ?? null,
      pools,
      source: this.name,
    };

    return {
      status: errors.length > 0 ? "partial" : "ok",
      data,
      unavailable: [],
      errors,
    };
  }
}
