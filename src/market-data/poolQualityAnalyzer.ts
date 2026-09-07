// Per-pool quality assessment. Returns EVERY relevant pool — never
// silently picks "the best" one, per the Phase 4 brief ("Do not assume the
// highest-liquidity pool is automatically the best execution venue").
//
// Pool age reuses RobinhoodChainClient.getContractCreationInfo (Phase 2) —
// a Uniswap V3 pool is itself a contract, so the same binary-search
// deployment lookup already built for tokens works unchanged here. No new
// on-chain method needed.

import type { Address } from "viem";
import type { RobinhoodChainClient } from "../blockchain/robinhoodChainClient.js";
import type { PoolInfo, PoolQualityAssessment, SwapRecord } from "../types/domain.js";

export interface PoolQualityAnalyzerOptions {
  chainClient: RobinhoodChainClient;
}

export class PoolQualityAnalyzer {
  #chainClient: RobinhoodChainClient;

  constructor(options: PoolQualityAnalyzerOptions) {
    this.#chainClient = options.chainClient;
  }

  /** `recentSwaps`, if supplied, should already be scoped to this specific pool. */
  async assessPool(pool: PoolInfo, recentSwaps?: SwapRecord[]): Promise<PoolQualityAssessment> {
    const observedAt = new Date().toISOString();

    let poolAgeSeconds: number | null = null;
    try {
      const creationInfo = await this.#chainClient.getContractCreationInfo(pool.poolAddress as Address);
      if (creationInfo) {
        poolAgeSeconds = Math.max(0, (Date.now() - new Date(creationInfo.deploymentTimestamp).getTime()) / 1000);
      }
    } catch {
      poolAgeSeconds = null; // genuinely unknown — not fabricated as 0
    }

    const recentBuyCount = recentSwaps?.filter((s) => s.side === "BUY").length ?? null;
    const recentSellCount = recentSwaps?.filter((s) => s.side === "SELL").length ?? null;
    const recentSwapCount = recentSwaps ? recentSwaps.length : null;

    const knownFields = [poolAgeSeconds, recentSwapCount].filter((v) => v !== null).length;

    return {
      pool,
      observedAt,
      poolAgeSeconds,
      recentSwapCount,
      recentBuyCount,
      recentSellCount,
      dataQuality: knownFields === 2 ? "KNOWN" : knownFields === 0 ? "UNAVAILABLE" : "PARTIAL",
    };
  }

  /** Assesses every pool given — returns all of them, in the same order, never filtering down to "the best". */
  async assessAllPools(pools: PoolInfo[], swapsByPool?: Map<string, SwapRecord[]>): Promise<PoolQualityAssessment[]> {
    return Promise.all(pools.map((pool) => this.assessPool(pool, swapsByPool?.get(pool.poolAddress))));
  }
}
