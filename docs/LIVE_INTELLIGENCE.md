# Live Intelligence — Phase 7.1 / Phase 7.2

Phase 7 proved the live architecture works (real Scout → real intelligence
→ real Smart Selection scoring → paper trading, zero fabricated data,
zero real transactions). It also surfaced three concrete problems: (1) a
latent NaN/Infinity correctness bug in scoring, (2) `TokenAnalysisService`
consistently timing out at its full 4-second budget on every real signal,
and (3) live intelligence gathering was much narrower than what Smart
Selection's 9 feature groups actually expect, and ran its provider calls
**sequentially**, meaning one slow provider could consume the entire
latency budget before the next was even attempted.

Phase 7.1 fixed the NaN bug, the `TokenAnalysisService` timeout, and
switched the gatherer to a concurrent fan-out. Its own live verification
then found that generic on-chain venue resolution and market-flow both
timed out on every real signal (7/7 each) — the coverage matrix below
records BOTH the Phase 7.1 state and the Phase 7.2 fix for the rows that
changed. Phase 7.2's objective was "complete the missing live market
intelligence for Pons V2 curve and graduated V4 Scout tokens, and reduce
unnecessary latency obtaining it" — never to manufacture a trade or hit a
target confidence number (see §5 below for the real before/after
verification).

This document covers §1 (the coverage matrix), §2 (the tier model), §3
(the bounded decision deadline), §4 (Phase 7.2's shared market context and
venue-specific fast paths), and §5 (Phase 7.2's live verification
results). See `docs/LIVE_PIPELINE.md` for the NaN fix writeup and the
overall pipeline architecture, `docs/DATA_SOURCES.md` for the underlying
provider details, and `docs/ROBINHOOD_MARKET_DISCOVERY.md` for why the
Phase 7.2 readers are deliberately separate from the historical/backtesting
on-chain providers they're modeled on.

## §1 — Feature-group coverage matrix

One row per Smart Selection feature group (`src/scoring/featureGroupScorers.ts`).
"Critical" here means one of the confidence engine's three explicitly-checked
critical features (`liquidity`, `contractFeatures`, `holderData` — see
`confidenceEngine.ts`'s `criticalFeaturesAvailable`), not just "has a
nonzero group weight" (shown separately, since every group with weight > 0
does affect the score when available).

| Group (weight) | Expected input | Live source | Wired? | Typical latency | Critical? | Failure mode |
|---|---|---|---|---|---|---|
| **signalQuality** (8) | `ScoutSignal` (messageType, receivedAt, parseConfidence) | The Scout message itself — TIER 0, no I/O | **Yes** (always) | ~0ms | No | An unparseable `receivedAt` is UNAVAILABLE, not NaN (Phase 7.1 §2 fix) — the group still scores from `messageType`/`parseConfidence` |
| **tokenQuality** (12) | `TokenContractInfo` + `TokenAge` + `ContractFeatureDetection` + `DeployerAnalysis` | Fast metadata (batched RPC read, TIER 1) + `computeTokenAge` (free, pure) + `ContractFeatureAnalyzer` (single `eth_getCode` read, TIER 1) + `DeployerAnalyzer` (best-effort, needs a resolved `deployerAddress`) | **Yes** (fast metadata/features always; deployer/deployment-derived fields best-effort) | Fast metadata + features: low-hundreds of ms. Deployer: near-zero when `deployerAddress` unresolved (early-return, no RPC calls); a few hundred ms more when it is | Partially — `contractFeatures` IS one of the 3 critical features | RPC error/timeout on any sub-fetch degrades that field only; `weightedAverage` excludes it, never zeroes the group |
| **liquidity** (15) | `LiquidityAnalysis` + `PoolQualityAssessment[]` | `LiquidityAnalysis`: free, pure computation over the price/liquidity already resolved (DexScreener, or — Phase 7.2 — `PonsCurveMarketReader.getReserveLiquidity` for a confirmed curve token, a single direct quote-token balance read, no event scan). `PoolQualityAssessment[]`: NOT wired | Partial (`liquidityAnalysis` yes, `poolQuality` no — stays `[]`) | ~0ms additional for DexScreener's figure; one extra RPC call for the curve reserve read | **Yes** | No price/liquidity resolved from any tier → UNAVAILABLE, never fabricated; a curve's reserve is only surfaced as `liquidityUsd` when its quote asset is a recognized USD-stable — otherwise the USD field stays UNAVAILABLE even though a real quote-denominated reserve was read (see §4 below) |
| **marketFlow** (13) | `MarketFlowAnalysis` (from `SwapRecord[]` + quote-token decimals) | **Phase 7.1**: `PoolDataProvider.discoverPools` → `getRecentSwaps` → quote-token decimals — V3-pool-shaped only, timed out 7/7 in real verification. **Phase 7.2**: dispatched from the shared `ResolvedMarketContext` — `PonsCurveMarketReader.getRecentFlow` (curve) or `UniswapV4FlowReader.getRecentFlow` (graduated V4), both from ONE bounded event fetch that also feeds price/momentum; V3 path unchanged but now reuses the already-discovered pool instead of rediscovering it | **Yes for confirmed Pons tokens** (curve or V4); V3 unchanged (conditional on a discovered pool) | Bounded to the shared deadline; real verification still saw frequent timeouts on the actual event fetch itself (see §5) — wiring closed the venue-type gap, RPC latency for a real bounded log scan remains a separate, open cost | No | No trades in the bounded window (fresh token, quiet curve/pool) → UNAVAILABLE, honestly; Pons curve/V4 events that fail to decode are excluded, never guessed |
| **momentum** (10) | `MomentumAnalysis` (`PriceObservation[]`) | **Phase 7.1**: free, pure computation over the single current-price observation. **Phase 7.2**: when the Pons-aware reader found real recent CurveBuy/CurveSell or V4 Swap prices with a resolvable USD value, ALL of them (each with its own real trade timestamp) feed the SAME, unmodified `MomentumAnalyzer` — genuine multi-point momentum, not a redesign | **Yes** (richer for a USD-quoted Pons token with real trade history; single-observation fallback otherwise, unchanged) | ~0ms (reuses the marketFlow fetch's own observations) | No | A token with real trades but a non-USD-stable quote asset (§17) still can't contribute observations — `MomentumAnalyzer`'s contract requires `priceUsd`, so this falls back to the single-observation case, not a fabricated conversion |
| **entryQuality** (20) | `EntryQualityInputs` (price/liquidity/volume "at signal" vs "current") | **Not wired**, deliberately | **No** | n/a | No | Scout's EARLY_CALL message never carries a price, so the only candidate for "price at signal time" IS the current observation just fetched — setting both to the same value would always produce `priceSincePct = 0`, which is a fabricated non-signal, not real evidence. Genuinely meaningful only once a real time gap exists (a later PERFORMANCE_UPDATE, or position monitoring, which already has its own independent exit-condition logic in `paperPositionManager.ts`) |
| **holderStructure** (10) | `HolderConcentrationBreakdown` (top5/top10/largest-holder concentration, from `holderConcentrationAnalyzer.ts`) | **Not wired** — `TokenAnalysisService`'s slow tier does fetch `holderCount`/`topHolderConcentrationPct` from Blockscout, but that's a different, narrower shape than what this scorer expects, and isn't bridged into `HolderConcentrationBreakdown` | **No** (the raw scalars are fetched but not in the right shape — deliberately out of scope again in Phase 7.2, see its §20) | Would be bounded by the same slow-tier timeout if wired | **Yes** (`holderData` is a critical feature) | Currently always UNAVAILABLE live — an honest, documented gap, not a crash |
| **walletIntelligence** (12) | `ScoutWalletAssociation[]` + `WalletQualityFeatures` map + `WalletRelationshipSignal[]` | Wallet mentions parsed directly from the Scout message text (TIER 0, no I/O); full wallet performance/relationship data is Phase 3 scope, not part of Phase 7.1 | Partial (associations yes, quality/relationship data no) | ~0ms for associations | No | Unresolved/truncated wallet mentions are UNAVAILABLE or UNRESOLVED — never a fabricated score, per Phase 3's own established rule (see `walletIntelligenceScorer.ts`) |
| **marketConditions** (0) | `MarketRegimeAssessment` | `UnknownMarketRegimeProvider` — an intentional Phase 5 stub | Yes (trivially — always UNKNOWN) | ~0ms | No | Configured weight is 0; this group never affects the score. Documented as a stub since Phase 5, not new to this phase |

### Caveats on the matrix above

- **marketFlow's Phase 7.1 venue restriction is resolved by Phase 7.2's
  venue-specific readers**, but a residual limitation remains: those
  readers only run for a CONFIRMED Pons launch (curve or graduated). A
  token that's neither a Pons launch nor has a discoverable Uniswap V3
  pool (real examples from the profiled dataset: BUFO, one of the two CRC
  tokens — see `docs/DATA_SOURCES.md` §7) still has no flow source at
  all; DexScreener doesn't expose raw swap events, only aggregate
  price/liquidity. Not a new gap — the same 2 tokens were already
  unresolved for price/venue purposes in Phase 6.6.
- **holderStructure vs. TokenAnalysisService's holder fields are two
  different things that happen to share the word "holder".** Bridging
  them would mean either building a `HolderConcentrationBreakdown` out of
  Blockscout's coarser `totalHolders`/`topHolderConcentrationPct` (lossy —
  the analyzer wants top-5/top-10/largest-holder breakdowns, which
  Blockscout's summary endpoint doesn't provide) or fetching Blockscout's
  full holder list live (expensive, exactly the kind of Blockscout-heavy
  call §5/§18 says must never dominate latency). Left unwired rather than
  faked.

## §2 — Tier model

Not copied from a generic brief — assigned from actually inspecting each
real provider's dependency shape and the Phase 7 live-verification
evidence (`TokenAnalysisService` alone hit its full 4-second budget on
every real signal; see `docs/LIVE_PIPELINE.md`).

- **TIER 0 — in-message, no I/O.** Wallet associations parsed from the
  Scout text; `messageType`/`parseConfidence`/`receivedAt`. Always
  available immediately, feeds signalQuality and part of
  walletIntelligence.
- **TIER 1 — fast, critical, always attempted.** Current price/liquidity
  (on-chain-first venue resolution running concurrently with DexScreener —
  see `currentPriceResolver.ts` and, for Pons tokens, §4's shared market
  context below), fast token metadata (one batched RPC read),
  contract-feature detection (one `eth_getCode` read). None of these
  depend on a chain-history search; all run inside the single shared
  `Promise.all` fan-out.
- **TIER 2/3 — slower, best-effort, bounded by the same shared
  deadline.** Deployment info (binary-search over chain history — the
  confirmed root cause of Phase 7's timeout, see §3's investigation
  writeup below), holder distribution (Blockscout — separately documented
  as unreliable/bot-gated), market flow (§4: Pons curve/V4 readers for a
  confirmed Pons token, the V3 path otherwise), deployer analysis (needs a
  resolved deployer address from the slow tier). None of these ever block
  TIER 1's result — a signal can reach a Smart Selection decision with
  every TIER 2/3 field UNAVAILABLE, and often will.

## §3 — Bounded decision deadline

A single `timeoutMs` (default 4000ms, `LiveIntelligenceDeps.timeoutMs`)
is shared by every concurrent branch of the fan-out in
`liveIntelligenceGatherer.ts` — not a per-provider budget applied to a
sequential chain (Phase 7's original design), where the same 4000ms could
be spent three times over before a decision was even attempted. Because
every branch now runs concurrently, the gather's real worst-case
wall-clock time is bounded by the SLOWEST single branch, not their sum —
already a substantial latency improvement even before retuning the
number itself. `maxSignalAgeSecondsForEntry` (Phase 7's separate,
already-existing staleness gate, default 120s) is unrelated and
unchanged: this deadline bounds how long the GATHER itself may run per
signal, not how old a signal may be before Smart Selection sees it.

The 4000ms default is kept as an explicit, documented, initial
conservative starting point (matching Phase 7's own default) rather than
invented — it should be revisited once real live latency data exists for
the fanned-out version specifically (Phase 7's own measurement was for
the old sequential path and is no longer directly comparable).

### TokenAnalysisService timeout investigation (the "why" behind the fast/slow split)

Root-caused, not guessed: `TokenAnalysisService.getTokenIntelligence()`
originally ran three operations **sequentially** — chain metadata (fast),
`getContractCreationInfo()` (a binary search over `eth_getCode` across the
whole chain height, since the public Robinhood Chain RPC is NOT an
archive node — `~log2(current block height)` sequential RPC round trips,
plus a full block fetch with transactions and a receipt-scan loop), and
`getHolderDistribution()` (Blockscout, separately documented as
unreliable/Cloudflare-bot-gated). Any one of the latter two alone could
plausibly consume the full 4-second budget; running all three in sequence
made that a near-certainty, matching exactly what Phase 7's real
verification observed (avg 3923ms, max 4118ms, n=7 — i.e. essentially
every real signal hit the ceiling).

The fix was NOT "increase the timeout" (explicitly prohibited) — it was
architectural: `TokenAnalysisService` now exposes `getFastTokenInfo()`
(metadata only, no history search) and `getSlowTokenInfo()` (deployment +
holders, run concurrently with each other instead of sequentially, since
neither's result depends on the other in the fields `TokenContractInfo`
surfaces). The live gatherer calls both independently, each bounded by
the same shared deadline, so a slow deployment-block search can no longer
delay the fast metadata a decision actually needs.

## §4 — Phase 7.2: shared market context and venue-specific fast paths

Phase 7.1's `resolveOnChainPriceTier` re-ran full venue resolution
(Pons check, then — if not Pons — a Uniswap V3 discovery-and-probe loop)
EVERY time price was needed, and a separate `fetchMarketFlow` did its own
independent `discoverPools` call for flow. Profiling the 7 real eligible
signals directly (bypassing the live pipeline's own bounded timeout, to
see ground truth) found: 4 of 7 ARE real Pons V2 launches (THROBBIN,
one CRC, and Diem graduated to V4; BIOHACKING still pre-graduation on its
curve) — and the Pons lookup ALONE took up to ~4.9 seconds for a graduated
token, before any V3 discovery was even attempted. Running V3 discovery
*in addition to* that for a token already confirmed to be Pons-graduated
was pure wasted latency (it always found 0 pools for the 3 graduated
tokens profiled).

`src/live/resolvedMarketContext.ts`'s `resolveMarketContextOnce` fixes
this structurally: it checks Pons exactly once, and only falls through to
V3 discovery when the token is confirmed NOT a Pons launch. The resulting
`ResolvedMarketContext` (venue type, curve/PoolId/pool-address identifier,
quote token + decimals, `tokenIsCurrency0`, graduation timestamp, any
discovered V3 pools) is then reused by every downstream consumer in
`liveIntelligenceGatherer.ts`'s `resolvePonsAwareMarketData` — price,
liquidity, and flow all read from the SAME resolution, never
rediscovering the venue for each question separately.

Dispatch, once the venue is known:

- **PONS_V2_CURVE** → `PonsCurveMarketReader`: one bounded
  `CurveBuy`+`CurveSell` fetch produces BOTH the current price (the most
  recent trade's implied price) and the flow (`SwapRecord[]` fed into the
  existing `MarketFlowAnalyzer`) — no second fetch for the second
  question. Liquidity is a single direct `getTokenBalance` read on the
  curve's own quote-asset balance — no event scan needed at all.
- **PONS_V2_V4_POOL** (graduated) → `UniswapV4FlowReader`: one bounded
  `Swap` fetch filtered to the resolved `PoolId` (never confused with a
  contract address), producing flow and price observations from the same
  events. Direction is classified purely from the sign of the Scout
  token's own amount (`amount0` if `tokenIsCurrency0`, else `amount1`) —
  UNKNOWN whenever that's not safely determinable, never guessed.
- **UNISWAP_V3_POOL / UNKNOWN** → unchanged from Phase 7.1's intent (§9):
  the same `OnChainUniswapV3PriceProvider`-then-GeckoTerminal tiering,
  DexScreener fallback, and `getRecentSwaps`-based flow — just now
  consuming the pool `resolveMarketContextOnce` already found instead of
  discovering it again.

Both readers are deliberately separate from their backtesting
counterparts (`OnChainPonsCurvePriceProvider`,
`OnChainUniswapV4PriceProvider`) — see
`docs/ROBINHOOD_MARKET_DISCOVERY.md`'s Phase 7.2 section for why: the
historical providers are correctly gated to only produce a USD price for
a recognized USD-stable quote asset, which would silently discard ALL
evidence for a live decision on a tokenized-equity-quoted Pons token. The
live readers always return quote-denominated values and layer on USD only
when `convertToUsd` (unchanged) resolves one — never fabricated, per §17.

A second real gap was found and fixed during Phase 7.2's own
verification (not anticipated in the design above): the first
end-to-end run measured `scout signal -> decision` latency at ~9.3s,
nearly double the shared 4-second deadline. Cause: `resolveOnChainPriceTier`
only wrapped its final price-fetch step in `withTimeout`, not the venue
resolution before it — and that resolution's own Uniswap V3
candidate-pool-probing loop could make several sequential provider calls
with no aggregate bound. Fixed by wrapping the WHOLE chain (resolution +
venue-specific reads) in one `withTimeout` in `resolvePonsAwareMarketData`
— re-verified at median 4028ms, consistent with the documented deadline.
This is exactly the kind of gap only real network conditions surface, not
synthetic unit tests (their fake providers resolve instantly) — the
reason live/replay verification is a required step, not a formality.

## §5 — Phase 7.2 live verification results (honest, including a real negative finding)

Run against the same real captured fixture and real network endpoints as
§6 below, after the shared-context/fast-path work landed. Three separate
replay runs were made: two to investigate a timeout hypothesis (below),
one final run at the reverted, correct configuration.

| | Phase 7.1 baseline | Phase 7.2 (final configuration) |
|---|---|---|
| Confidence range | 15.2–53.5 | 30–53.5 (this run); the SAME real-network-variance caveat as Phase 7.1 applies — repeated runs land in a similar band, not an identical number |
| Decisions | 1× IGNORE / 6× WATCH (one run) | 0× IGNORE / 7× WATCH (this run) |
| `pons-aware-market-data` (venue resolution + reader dispatch) | n/a (didn't exist yet) | **TIMEOUT on 7/7 real signals, in every replay run performed** — see the negative finding below |
| Decision latency | avg 4178ms / median 4028ms / p95 5042ms | avg 4082ms / median 4013ms / p95 4377ms / max 4377ms (n=7) — essentially unchanged from Phase 7.1 |
| TRADE_CANDIDATE | 0 | 0 (never forced; `minimumConfidenceForTradeCandidate` stays 55, untouched) |
| Real transactions | 0 | 0 |

**The honest headline finding: in live-pipeline conditions, the new
Pons-aware chain did not complete in time for any of the 7 real signals,
in any of the three replay runs performed** — including one run where its
own timeout was deliberately raised from 4000ms to 7000ms specifically to
test whether it was simply under-provisioned. It was not: the 7000ms
attempt STILL timed out on 7/7 signals, while raising `scout signal ->
decision` latency from ~4.1s to ~7.1s for zero completion-rate gain. That
result was reverted (see `LiveIntelligenceDeps.ponsAwareTimeoutMs`'s doc
comment in `liveIntelligenceGatherer.ts` for the full account) rather
than kept, per the explicit instruction not to sacrifice correctness for
an arbitrary number — a bigger timeout that doesn't fix the actual
bottleneck is exactly that.

This is a real, root-caused (if not resolved) finding, not a wiring
failure: `scripts/profileScoutSignals.ts`, run standalone (one token at a
time, no concurrent load), measured the SAME Pons lookup completing in
300ms–4.9s. The live pipeline runs this chain CONCURRENTLY with 4 other
RPC-heavy branches for the same signal (DexScreener, fast/slow token
info, contract features), across up to 5 signals at once — all against
the same unauthenticated public RPC. The standalone script never
experiences that contention; the live pipeline always does. This strongly
suggests the actual bottleneck is **RPC-endpoint contention/rate-limiting
under concurrent load**, not an under-sized timeout or a design flaw in
`resolveMarketContextOnce`/the venue-specific readers themselves — both
of which are verified correct by 33+ deterministic unit tests using
instant fake providers (§4, `docs/ROBINHOOD_MARKET_DISCOVERY.md`).

Practical consequence: in these specific verification runs, live
decisions still fell back to DexScreener-sourced price (as in Phase 7.1)
because the Pons-specific readers didn't get the chance to complete — the
`venueType` field is `UNKNOWN` in every persisted `LiveSignalRecord` from
these runs, not the correctly-identified curve/V4 venue the standalone
script proves is achievable. The architecture is real and tested; it
simply hasn't been observed producing venue-specific data end-to-end
through the live pipeline under real network conditions yet. Candidate
fixes, none implemented here (out of this phase's scope per its own
"do not sacrifice correctness for an arbitrary number" instruction):
a higher-throughput/authenticated RPC provider, reducing intra-signal RPC
concurrency (e.g., sequencing the Pons-aware chain ahead of token
analysis rather than fully parallel), or capping cross-signal concurrency
specifically for RPC-heavy branches independent of `maxConcurrentSignals`.

## §6 — Phase 7.1 live/replay verification results (historical baseline)

Run against the real captured 2026-09-04 fixture, real RPC, real
DexScreener/GeckoTerminal, with a clean dedup slate (Phase 7's old
persisted signal records archived, not deleted, so this run reflects
fresh Phase 7.1 processing rather than being short-circuited by
duplicate-detection against old records). All 7 real eligible EARLY_CALL
signals (THROBBIN, BUFO, BABA, CRC ×2, Diem, BIOHACKING) were processed.

| | Phase 7 baseline | Phase 7.1 (this verification) |
|---|---|---|
| Confidence range | 15–37 | 15.2–53.5 |
| Decisions | 6× IGNORE, 1× WATCH (Diem, 37.5) | 1× IGNORE, 6× WATCH |
| TRADE_CANDIDATE | 0 | 0 (never forced; threshold stays 55, untouched) |
| Decision latency | not separately measured (sequential chain) | avg 4178ms, median 4028ms, p95 5042ms, max 5042ms (n=7) |
| Paper entries | 0 | 0 |
| Real transactions | 0 | 0 |

Higher confidence here reflects genuinely more available evidence per
signal (contract features, liquidity analysis, and momentum are now
computed on every signal; several signals additionally got fast token
metadata), not a threshold change — confirmed by re-reading the
per-signal `confidenceBreakdown.components` in
`data/live/signal-records.ndjson`, which show real completeness/critical-
feature-availability gains, not a formula change. **This does not mean
"more confidence is automatically success"**: the run also surfaced two
honest, real limitations, not concealed:

- **The on-chain price tier (`tiered-price`) timed out on all 7 signals**
  in this particular run — DexScreener's fallback covered 6 of 7 prices
  instead. This is a real finding, not a wiring bug: `resolveMarketVenue`
  (Uniswap V3 discovery + Pons check + decimals lookups) plus the
  subsequent tiered candle fetch, now correctly bounded end-to-end under
  ONE shared deadline (see the "bounded decision deadline" fix below),
  simply doesn't always finish within it on real network conditions for
  these specific tokens. §10's "prefer on-chain when it resolves" logic
  is correct as written; on-chain just doesn't always *get the chance* to
  resolve within budget in practice. Worth a longer, separately-tuned
  timeout for this specific tier in a later phase — not done here since
  Phase 7.1 explicitly prohibited raising timeouts as a first resort, and
  DexScreener's fallback already keeps price coverage high (6/7).
- **`market-flow-analyzer` timed out on all 7 signals** in this run (the
  two-step discover-pool-then-fetch-swaps chain, each capped at half the
  shared budget, didn't complete for any of the 7 real tokens tried).
  Combined with the documented Pons/V4 venue-shape gap (§1), market flow
  is currently more theoretical than practical for fresh, just-called
  tokens — an honest finding for follow-up, not a regression (it was
  entirely unwired, i.e. 0% coverage, before this phase).
- **`token-analysis-service:slow` no longer times out** (0/7 TIMEOUT,
  down from Phase 7's 7/7) — the fast/slow split fix worked as intended —
  but it also found no usable deployment/holder data for any of the 7
  real tokens this run (7/7 `SKIPPED`, meaning it completed within budget
  but both its internal deployment and holder lookups came back empty).
  Not investigated further in this phase; a real open question for
  whoever next touches `TokenAnalysisService` is whether that's these
  specific tokens genuinely having no discoverable data yet (very fresh
  launches) or a subtler provider issue.
- **`contract-feature-analyzer` succeeded on all 7 signals** (7/7 OK) —
  the cheapest, most reliable of the newly-wired groups, exactly as
  predicted from its single-RPC-call design.

### Bounded decision deadline — a real gap found and fixed during this verification

The first verification attempt measured `scout signal -> decision`
latency at avg 9333ms — more than double the nominal 4000ms shared
deadline. Investigating found `resolveOnChainPriceTier` only wrapped its
final `getCandles` call in `withTimeout`, not the `resolveMarketVenue()`
call before it — and `resolveMarketVenue`'s own Uniswap V3
candidate-pool-probing loop can make several sequential provider calls
(one full on-chain-then-GeckoTerminal attempt per discovered candidate
pool) with no aggregate bound of its own. Fixed by wrapping the WHOLE
operation (venue resolution AND the candle fetch) in one `withTimeout` in
`currentPriceResolver.ts`. Re-verified: avg dropped to 4178ms, median
4028ms — now genuinely consistent with the documented shared deadline.
This is the kind of gap that's only visible under real network
conditions, not synthetic tests (the deterministic unit tests use
instant fake providers, so they couldn't have caught it) — which is
exactly why Phase 7.1's live/replay verification step matters as more
than a formality.

## §6 — Phase 7.3 finding: the bottleneck was never (only) cross-signal contention

Full detail: `docs/RPC_PERFORMANCE.md`. Phase 7.2 hypothesized RPC
contention under concurrent replay load. Phase 7.3 built a real global
RPC concurrency limiter, request instrumentation, and — critically — a
**single-signal control test** (`scripts/singleSignalControl.ts`) that
runs each of the 4 real Pons signals individually through the exact
production `SignalProcessor`, with zero other signals competing for
anything. Result: venue resolution still failed to complete within the
4-second deadline, even alone, and raising the RPC concurrency ceiling
from 4 to 8 made no measurable difference (the limiter never needed more
than 4–6 slots regardless of the ceiling). This means concurrency was
never the dominant constraint — the actual bottleneck is a single,
necessary, bounded `eth_getLogs` call (fetching `CurveBuy`/`CurveSell`/
`Swap` events for flow) that is slow enough against the public RPC to
consume the whole remaining budget on its own, consistent with Phase
6.6's own earlier finding that a full-depth log-fetch cascade against a
busy pool measured 150+ seconds in the worst case. A real, separate
inefficiency WAS found and fixed along the way (`TokenAnalysisService`
fetching the same token's metadata a second time, uncached, duplicating
`resolveMarketContextOnce`'s own fetch — now shares one cache), cutting
RPC request count per signal from up to 19 to a consistent 4 — but this
did not change the outcome, confirming it was a secondary cost, not the
critical-path one.

## Phase 7.4 update — flow retrieval actually works now

The finding above (a slow/failing `eth_getLogs` call as the critical-path
bottleneck) was Phase 7.2/7.3's honest conclusion. Phase 7.3B/7.4 traced
that specific call all the way down: the authenticated RPC provider
configured for this project has a hard 10-block `eth_getLogs` cap (an
account/plan policy, confirmed by the provider's own error text — see
`docs/RPC_PERFORMANCE.md`), and a separate bug inflated the requested
range to ~2.19 million blocks for a nominal 180-minute lookback. Both are
now fixed: `resolveMarketContextOnce`'s block-window calculation is
corrected (~107,000 blocks for the real 180-minute curve lookback), and
`PonsCurveMarketReader`/`UniswapV4FlowReader` route their bounded
event-history fetch to whichever RPC provider role can actually serve
that range (`src/blockchain/rpcRouting.ts`) — never assuming the
authenticated endpoint can, never trying it first and falling back after
a predictable rejection.

Result, measured via `scripts/singleSignalControl.ts` (isolated, no
concurrency contention): Pons venue resolution went from 0/4 to **4/4**
known tokens, with the underlying `eth_getLogs` call succeeding cleanly.
A second, previously-invisible bottleneck was found once real trade data
started flowing through: resolving each trade's block timestamp
sequentially (`for...await`) rather than concurrently — fixed via
`Promise.all` (identical values, computed faster).

**Still open, honestly**: under the full 7-signal REPLAY (real concurrent
load, not the isolated single-signal case), venue resolution remains
inconsistent — the classification `readContract` call can queue behind
other concurrent RPC work long enough to miss the shared ~4-second
decision deadline. This is a distinct constraint from the transport
problem this phase fixed, and was not addressed here (see
`docs/RPC_PERFORMANCE.md` and the Phase 7.4 final report for the measured
numbers).

## Reference: existing types touched

`SmartSelectionInputs` (`src/scoring/smartSelectionEngine.ts`),
`ConfidenceBreakdown`/`ConfidenceComponent` (`src/types/domain.ts`,
computed by `confidenceEngine.ts`), `LiveSignalRecord` (extended in Phase
7.1 with `confidenceBreakdown`/`dataQuality` — see
`docs/LIVE_PIPELINE.md`'s §21 note).
