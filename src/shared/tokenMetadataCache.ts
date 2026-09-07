// Phase 7.1 §24 — safe caching for genuinely immutable data. Token
// metadata (name/symbol/decimals/totalSupply) never changes for a given
// address once deployed — well, `totalSupply` technically can if a
// contract is mintable, but that's a rare enough edge case that a
// generous-but-bounded TTL (not literally infinite — see below) is the
// right trade-off, and this is explicitly NOT used for anything that
// changes on the timescale of a live trading decision (price, liquidity,
// recent flow — those must never be cached this way, see
// docs/LIVE_INTELLIGENCE.md's caching section).
//
// Deliberately NOT wired into src/backtesting/venueResolver.ts's own
// callers in a way that would affect historical correctness: this cache
// is keyed by (chainId, address) alone, with no decision-timestamp
// dimension — safe ONLY because token metadata has no time dimension to
// begin with (a token's decimals are the same whether asked about "now"
// or a historical timestamp). Never use this pattern for anything that
// DOES vary by decision timestamp.

import type { RobinhoodChainClient, TokenMetadataRaw } from "../blockchain/robinhoodChainClient.js";
import { TtlCache } from "./ttlCache.js";

// 24 hours: long enough to eliminate essentially all redundant metadata calls within a single
// process's lifetime, short enough that a long-running live process isn't permanently stuck with
// bad data in the theoretical case of a mintable token's totalSupply actually changing.
const TOKEN_METADATA_TTL_MS = 24 * 60 * 60 * 1000;

const cache = new TtlCache<TokenMetadataRaw>(TOKEN_METADATA_TTL_MS);

function cacheKey(chainId: number, address: string): string {
  return `${chainId}:${address.toLowerCase()}`;
}

/** Cached wrapper around `RobinhoodChainClient.getTokenMetadata` — see the module doc comment for why this is safe. */
export async function getCachedTokenMetadata(chainClient: Pick<RobinhoodChainClient, "chainId" | "getTokenMetadata">, address: `0x${string}`): Promise<TokenMetadataRaw> {
  return cache.getOrCompute(cacheKey(chainClient.chainId, address), () => chainClient.getTokenMetadata(address));
}

/** Test-only: clears the module-level cache so tests don't leak state into each other. */
export function clearTokenMetadataCache(): void {
  cache.clear();
}
