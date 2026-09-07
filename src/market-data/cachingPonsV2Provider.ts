// Phase 7.1 §24 — safe caching for Pons launch metadata, LIVE-ONLY.
//
// Deliberately NOT wired into src/backtesting/venueResolver.ts's shared
// resolution path: that function serves MULTIPLE DIFFERENT historical
// decision timestamps for the same token across one backtest run, and
// Phase 6.6's whole graduation-boundary correctness guarantee depends on
// re-checking the launch's real phase/graduationTimestamp fresh for each
// decision (a cached pre-graduation snapshot could wrongly serve a
// post-graduation decision). Caching is safe HERE only because a live
// process's every call is implicitly "as of right now" — there's no
// decision-timestamp dimension to get wrong.
//
// TTL is deliberately short (60s, not the 24h used for immutable token
// metadata — see tokenMetadataCache.ts): a launch's curve/pairToken
// identity is permanent, but its `phase`/`graduationTimestamp` transition
// exactly once, and a live position on an actively-graduating token
// should notice that within roughly one polling cycle (Phase 7's
// POSITION_POLL_INTERVAL_MS is 30s), not be stuck on a stale
// pre-graduation reading for arbitrarily long.

import type { PonsV2LaunchDataProvider, PonsV2LaunchInfo } from "./ponsV2Provider.js";
import type { ProviderResult } from "../types/domain.js";
import { TtlCache } from "../shared/ttlCache.js";

const DEFAULT_TTL_MS = 60_000;

export class CachingPonsV2Provider implements PonsV2LaunchDataProvider {
  readonly name: string;
  #inner: PonsV2LaunchDataProvider;
  #cache: TtlCache<ProviderResult<PonsV2LaunchInfo | null>>;

  constructor(inner: PonsV2LaunchDataProvider, ttlMs: number = DEFAULT_TTL_MS) {
    this.#inner = inner;
    this.name = `${inner.name}:cached`;
    this.#cache = new TtlCache(ttlMs);
  }

  async getLaunchInfo(tokenAddress: string): Promise<ProviderResult<PonsV2LaunchInfo | null>> {
    return this.#cache.getOrCompute(tokenAddress.toLowerCase(), () => this.#inner.getLaunchInfo(tokenAddress));
  }
}
