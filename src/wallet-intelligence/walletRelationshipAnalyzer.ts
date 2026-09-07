// Detects BEHAVIORAL correlation between two wallets from their trade
// history — never an identity claim. Always "possibly related", never
// "same person/entity" (see the repo-wide instruction on this). A simple
// feature model, deliberately not a graph database, per the Phase 3 brief.
//
// What's implemented: common-token overlap and synchronized-buy timing,
// both computable purely from WalletTrade data this phase already has.
// What's NOT implemented: common funding source / common deployer
// interactions — these would need an indexed wallet-transaction-history
// API (native ETH transfers aren't covered by eth_getLogs), which
// docs/WALLET_DATA_SOURCES.md documents as unverified in this phase. This
// is a stated limitation, not a silently skipped feature.

import { clamp01 } from "../shared/math.js";
import type { WalletRelationshipSignal, WalletTrade } from "../types/domain.js";

export interface WalletRelationshipAnalyzerOptions {
  /** How close two BUYs on the same token need to be to count as "synchronized". */
  synchronizedBuyWindowSeconds?: number;
  /** relationshipScore at/above this is reported as `possiblyRelated: true`. */
  possiblyRelatedThreshold?: number;
}

const DEFAULT_SYNCHRONIZED_BUY_WINDOW_SECONDS = 30;
const DEFAULT_POSSIBLY_RELATED_THRESHOLD = 0.5;
/** Arbitrary-but-stated: 5+ synchronized buys is treated as the strongest observed timing signal. */
const SYNCHRONIZED_BUY_SATURATION_COUNT = 5;

export class WalletRelationshipAnalyzer {
  #windowSeconds: number;
  #threshold: number;

  constructor(options: WalletRelationshipAnalyzerOptions = {}) {
    this.#windowSeconds = options.synchronizedBuyWindowSeconds ?? DEFAULT_SYNCHRONIZED_BUY_WINDOW_SECONDS;
    this.#threshold = options.possiblyRelatedThreshold ?? DEFAULT_POSSIBLY_RELATED_THRESHOLD;
  }

  analyzePair(
    chainId: number,
    walletA: string,
    tradesA: WalletTrade[],
    walletB: string,
    tradesB: WalletTrade[],
  ): WalletRelationshipSignal {
    const tokensA = new Set(tradesA.map((t) => t.tokenAddress));
    const tokensB = new Set(tradesB.map((t) => t.tokenAddress));
    const commonTokens = [...tokensA].filter((t) => tokensB.has(t));
    const unionSize = new Set([...tokensA, ...tokensB]).size;

    const commonTokenCount = commonTokens.length;
    const commonTokenOverlapRatio = unionSize > 0 ? commonTokenCount / unionSize : 0;

    const evidence: string[] = [];
    if (commonTokenCount > 0) {
      evidence.push(
        `${commonTokenCount} common token(s) traded by both wallets (overlap ratio ${(commonTokenOverlapRatio * 100).toFixed(1)}%)`,
      );
    }

    let synchronizedBuyCount = 0;
    for (const token of commonTokens) {
      const buysA = tradesA.filter((t) => t.tokenAddress === token && t.direction === "BUY" && t.timestamp);
      const buysB = tradesB.filter((t) => t.tokenAddress === token && t.direction === "BUY" && t.timestamp);

      for (const a of buysA) {
        for (const b of buysB) {
          const diffSeconds = Math.abs(new Date(a.timestamp as string).getTime() - new Date(b.timestamp as string).getTime()) / 1000;
          if (diffSeconds <= this.#windowSeconds) {
            synchronizedBuyCount += 1;
            evidence.push(
              `possibly-synchronized BUY on ${token}, ${diffSeconds.toFixed(1)}s apart (tx ${a.transactionHash} / ${b.transactionHash})`,
            );
          }
        }
      }
    }

    const syncComponent = clamp01(synchronizedBuyCount / SYNCHRONIZED_BUY_SATURATION_COUNT);
    const relationshipScore = clamp01(0.5 * commonTokenOverlapRatio + 0.5 * syncComponent);

    return {
      chainId,
      walletA,
      walletB,
      computedAt: new Date().toISOString(),
      commonTokenCount,
      commonTokenOverlapRatio,
      synchronizedBuyCount,
      synchronizedBuyWindowSeconds: this.#windowSeconds,
      relationshipScore,
      possiblyRelated: relationshipScore >= this.#threshold,
      evidence,
    };
  }

  /** Convenience for scanning every pair in a set of wallets. O(n^2) — fine for the small wallet sets this phase deals with; not built for a large graph. */
  analyzeAllPairs(
    chainId: number,
    walletTrades: Map<string, WalletTrade[]>,
  ): WalletRelationshipSignal[] {
    const wallets = [...walletTrades.keys()];
    const signals: WalletRelationshipSignal[] = [];

    for (let i = 0; i < wallets.length; i++) {
      for (let j = i + 1; j < wallets.length; j++) {
        const walletA = wallets[i];
        const walletB = wallets[j];
        signals.push(
          this.analyzePair(chainId, walletA, walletTrades.get(walletA) ?? [], walletB, walletTrades.get(walletB) ?? []),
        );
      }
    }

    return signals;
  }
}
