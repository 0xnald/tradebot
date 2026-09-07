// Holder distribution from Robinhood Chain's official Blockscout instance.
//
// VERIFIED (2026-09-05, see docs/DATA_SOURCES.md §3): the token-info
// endpoint works (confirmed against the real WETH token) but is
// intermittently gated by a Cloudflare bot-challenge from this
// environment, and the holders-list endpoint specifically failed 3/3
// attempts. Treat this provider as real-but-unreliable: every caller must
// handle "error"/"partial" results, not just "ok".

import { isAddress } from "viem";
import { fetchJson } from "../shared/fetchJson.js";
import { TtlCache } from "../shared/ttlCache.js";
import type { HolderDistribution, HolderInfo, ProviderResult } from "../types/domain.js";
import type { GetHolderDistributionOptions, HolderDataProvider } from "./holderDataProvider.js";

const DEFAULT_BASE_URL = "https://robinhoodchain.blockscout.com";
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_TOP_N = 10;

interface BlockscoutTokenInfo {
  holders_count?: string;
  total_supply?: string | null;
  decimals?: string | null;
}

interface BlockscoutHolderItem {
  address: { hash: string };
  value: string;
}

interface BlockscoutHoldersPage {
  items: BlockscoutHolderItem[];
}

export interface BlockscoutHolderDataProviderOptions {
  baseUrl?: string;
  cacheTtlMs?: number;
}

export class BlockscoutHolderDataProvider implements HolderDataProvider {
  readonly name = "blockscout";
  #baseUrl: string;
  #ttlMs: number;
  #cache: TtlCache<ProviderResult<HolderDistribution>>;

  constructor(options: BlockscoutHolderDataProviderOptions = {}) {
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.#ttlMs = options.cacheTtlMs ?? DEFAULT_TTL_MS;
    this.#cache = new TtlCache(this.#ttlMs);
  }

  async getHolderDistribution(
    chainId: number,
    contractAddress: string,
    options: GetHolderDistributionOptions = {},
  ): Promise<ProviderResult<HolderDistribution>> {
    if (!isAddress(contractAddress)) {
      return {
        status: "error",
        data: null,
        unavailable: ["totalHolders", "topHolders", "topHolderConcentrationPct"],
        errors: [{ message: `invalid contract address: ${contractAddress}`, provider: this.name }],
      };
    }

    const topN = options.topN ?? DEFAULT_TOP_N;
    const cacheKey = `${chainId}:${contractAddress.toLowerCase()}:${topN}:${options.deployerAddress ?? ""}`;
    return this.#cache.getOrCompute(
      cacheKey,
      () => this.#fetch(chainId, contractAddress, topN, options.deployerAddress),
      this.#ttlMs,
    );
  }

  async #fetch(
    chainId: number,
    contractAddress: string,
    topN: number,
    deployerAddress?: string,
  ): Promise<ProviderResult<HolderDistribution>> {
    const errors: { message: string; provider?: string }[] = [];
    const unavailable: string[] = [];

    const tokenInfoResult = await fetchJson<BlockscoutTokenInfo>(`${this.#baseUrl}/api/v2/tokens/${contractAddress}`);
    const holdersResult = await fetchJson<BlockscoutHoldersPage>(
      `${this.#baseUrl}/api/v2/tokens/${contractAddress}/holders`,
    );

    if (!tokenInfoResult.ok) {
      errors.push({ message: `token info: ${tokenInfoResult.error}`, provider: this.name });
      unavailable.push("totalHolders");
    }
    if (!holdersResult.ok) {
      errors.push({ message: `holders list: ${holdersResult.error}`, provider: this.name });
      unavailable.push("topHolders", "topHolderConcentrationPct");
    }

    if (!tokenInfoResult.ok && !holdersResult.ok) {
      return { status: "error", data: null, unavailable, errors };
    }

    const totalHolders =
      tokenInfoResult.ok && tokenInfoResult.data.holders_count
        ? Number(tokenInfoResult.data.holders_count)
        : null;

    const totalSupply =
      tokenInfoResult.ok && tokenInfoResult.data.total_supply ? BigInt(tokenInfoResult.data.total_supply) : null;

    let topHolders: HolderInfo[] = [];
    let topHolderConcentrationPct: number | null = null;
    let deployerHolding: HolderInfo | undefined;

    if (holdersResult.ok) {
      const items = holdersResult.data.items ?? [];
      topHolders = items.slice(0, topN).map((item) => ({
        address: item.address.hash,
        balanceRaw: item.value,
        percentageOfSupply:
          totalSupply && totalSupply > 0n ? (Number(BigInt(item.value)) / Number(totalSupply)) * 100 : undefined,
      }));

      if (totalSupply && totalSupply > 0n && topHolders.length > 0) {
        const topSum = topHolders.reduce((sum, holder) => sum + BigInt(holder.balanceRaw), 0n);
        topHolderConcentrationPct = (Number(topSum) / Number(totalSupply)) * 100;
      }

      if (deployerAddress) {
        const match = items.find((item) => item.address.hash.toLowerCase() === deployerAddress.toLowerCase());
        if (match) {
          deployerHolding = {
            address: match.address.hash,
            balanceRaw: match.value,
            percentageOfSupply:
              totalSupply && totalSupply > 0n ? (Number(BigInt(match.value)) / Number(totalSupply)) * 100 : undefined,
          };
        }
      }
    }

    const data: HolderDistribution = {
      chainId,
      contractAddress,
      observedAt: new Date().toISOString(),
      totalHolders,
      topHolders,
      topHolderConcentrationPct,
      deployerHolding,
      source: this.name,
      unavailableReason: unavailable.length > 0 ? unavailable.join(", ") + " unavailable — see errors" : undefined,
    };

    return {
      status: errors.length > 0 ? "partial" : "ok",
      data,
      unavailable,
      errors,
    };
  }
}
